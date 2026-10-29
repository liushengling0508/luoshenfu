import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { resultSegments } from "./result-links";
import { parseMarkdown, type MdAlign, type MdBlock } from "./markdown-parse";

export interface MarkdownProps {
  content: string;
  notify: (message: string) => void;
  onOpen: (target: string) => void;
}

interface RenderContext { notify: (message: string) => void; onOpen: (target: string) => void }

// 会话消息按 Markdown 渲染：标题、表格、代码块、引用、列表都以结构化样式展示。
// 内容仍以原始 Markdown 保存在 event.content 里，右上角“复制”复制的是原文。
export function Markdown({ content, notify, onOpen }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const context = useMemo<RenderContext>(() => ({ notify, onOpen }), [notify, onOpen]);
  return <div className="md">{blocks.map((block, index) => renderBlock(block, `b${index}`, context))}</div>;
}

function renderBlock(block: MdBlock, key: string, ctx: RenderContext): ReactNode {
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      return <div key={key} className={`md-heading md-h${level}`}>{renderInline(block.text, ctx, key)}</div>;
    }
    case "paragraph":
      return <p key={key} className="md-p">{renderInline(block.text, ctx, key)}</p>;
    case "code":
      return <CodeBlock key={key} lang={block.lang} code={block.code} ctx={ctx} />;
    case "table":
      return <Table key={key} block={block} ctx={ctx} />;
    case "list":
      return <List key={key} block={block} ctx={ctx} />;
    case "quote":
      return <blockquote key={key} className="md-quote">{block.blocks.map((child, index) => renderBlock(child, `${key}-${index}`, ctx))}</blockquote>;
    case "hr":
      return <hr key={key} className="md-hr" />;
  }
}

function CodeBlock({ lang, code, ctx }: { lang: string; code: string; ctx: RenderContext }) {
  const label = lang === "mermaid" ? "mermaid 流程图源码" : (lang || "text");
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{label}</span>
        <button type="button" onClick={() => void navigator.clipboard.writeText(code).then(() => ctx.notify("代码已复制")).catch((error) => ctx.notify(error.message))}>复制</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function Table({ block, ctx }: { block: Extract<MdBlock, { type: "table" }>; ctx: RenderContext }) {
  return (
    <div className="md-table-wrap">
      <table>
        <thead><tr>{block.header.map((cell, index) => <th key={index} style={alignStyle(block.align[index])}>{renderInline(cell, ctx, `th${index}`)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={alignStyle(block.align[cellIndex])}>{renderInline(cell, ctx, `td${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function alignStyle(align: MdAlign): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}

function List({ block, ctx }: { block: Extract<MdBlock, { type: "list" }>; ctx: RenderContext }) {
  const items = block.items.map((item, index) => (
    <li key={index} className={item.checked === null ? undefined : "md-task"}>
      {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly />}
      <span>{renderInline(item.text, ctx, `li${index}`)}</span>
      {item.blocks.map((child, childIndex) => renderBlock(child, `li${index}-${childIndex}`, ctx))}
    </li>
  ));
  return block.ordered
    ? <ol className="md-list" start={block.start}>{items}</ol>
    : <ul className="md-list">{items}</ul>;
}

// 行内代码里如果整段就是链接或本机绝对路径，恢复成可点击的文件名/链接按钮。
function renderCode(code: string, ctx: RenderContext, key: string): ReactNode {
  const target = soleTarget(code);
  if (target) return <button key={key} type="button" className={`result-link ${target.type}`} title={target.target} onClick={() => ctx.onOpen(target.target)}>{target.text}</button>;
  return <code key={key} className="md-inline-code">{code}</code>;
}

function soleTarget(text: string): { type: "url" | "file"; target: string; text: string } | null {
  const parts = resultSegments(text.trim());
  if (!parts.length) return null;
  const first = parts[0];
  if (first.type === "text") return null;
  return { type: first.type, target: first.target, text: first.text };
}

// 不用 __ 与 _ 作为强调：文件名、变量名里的下划线太常见，误判会把完整路径拆断。
const INLINE = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]*)\]\(([^)\s]+)\)|\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g;

function renderInline(text: string, ctx: RenderContext, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let seq = 0;
  INLINE.lastIndex = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(...renderText(text.slice(cursor, index), ctx, `${key}-t${seq}`));
    seq += 1;
    const id = `${key}-i${seq}`;
    if (match[2] !== undefined) nodes.push(renderCode(match[2], ctx, id));
    else if (match[4] !== undefined) nodes.push(renderImage(match[3], match[4], ctx, id));
    else if (match[6] !== undefined) nodes.push(renderLink(match[5], match[6], ctx, id));
    else if (match[7] !== undefined) nodes.push(<strong key={id} className="md-strong md-em">{renderInline(match[7], ctx, id)}</strong>);
    else if (match[8] !== undefined) nodes.push(<strong key={id} className="md-strong">{renderInline(match[8], ctx, id)}</strong>);
    else if (match[9] !== undefined) nodes.push(<del key={id} className="md-del">{renderInline(match[9], ctx, id)}</del>);
    else if (match[10] !== undefined) nodes.push(<em key={id} className="md-em">{renderInline(match[10], ctx, id)}</em>);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(...renderText(text.slice(cursor), ctx, `${key}-tail`));
  return nodes;
}

// 纯文本片段继续沿用既有的裸链接/本地路径识别，保持“点一下就打开”的行为。
function renderText(text: string, ctx: RenderContext, key: string): ReactNode[] {
  return resultSegments(text).map((part, index) => part.type === "text"
    ? part.text
    : <button key={`${key}-${index}`} type="button" className={`result-link ${part.type}`} title={part.target} onClick={() => ctx.onOpen(part.target)}>{part.text}</button>);
}

function renderLink(label: string, url: string, ctx: RenderContext, key: string): ReactNode {
  const target = resultSegments(url).find((part) => part.type !== "text");
  const text = label || target?.text || url;
  if (!target) return <span key={key}>{text}</span>;
  return <button key={key} type="button" className={`result-link ${target.type}`} title={target.target} onClick={() => ctx.onOpen(target.target)}>{text}</button>;
}

// CSP 只允许 self/data/blob/本机，外链图片退化成可点击链接而不是加载失败的空图。
function renderImage(alt: string, url: string, ctx: RenderContext, key: string): ReactNode {
  if (/^(?:data:image\/|blob:)/i.test(url)) return <img key={key} className="md-image" src={url} alt={alt} />;
  return renderLink(alt || url, url, ctx, key);
}

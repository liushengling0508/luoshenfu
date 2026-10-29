// 会话消息的 Markdown 解析：只负责把原文拆成块结构，渲染交给 markdown.tsx。
// 刻意不引入第三方 Markdown 依赖，覆盖对话里真正会用到的语法子集。

export type MdAlign = "left" | "center" | "right" | null;

export interface MdListItem { text: string; checked: boolean | null; blocks: MdBlock[] }

export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "table"; align: MdAlign[]; header: string[]; rows: string[][] }
  | { type: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { type: "quote"; blocks: MdBlock[] }
  | { type: "hr" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].replace(/\t/g, "  ").length : 0;
}

function stripIndent(line: string, width: number): string {
  let consumed = 0;
  let index = 0;
  while (index < line.length && consumed < width) {
    const char = line[index];
    if (char === " ") { consumed += 1; index += 1; continue; }
    if (char === "\t") { consumed += 2; index += 1; continue; }
    break;
  }
  return line.slice(index);
}

// 拆一行表格；去掉首尾竖线后按 | 切分。
export function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
}

export function isTableDelimiter(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function isBlockStart(line: string, next?: string): boolean {
  if (HEADING.test(line) || HR.test(line) || FENCE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)) return true;
  return Boolean(next && line.includes("|") && isTableDelimiter(next));
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, 0, lines.length);
}

function parseBlocks(lines: string[], start: number, end: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let index = start;
  while (index < end) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const minLength = fence[1].length;
      const lang = (fence[2] || "").toLowerCase();
      const code: string[] = [];
      index += 1;
      while (index < end) {
        const close = lines[index].match(FENCE);
        if (close && close[1][0] === marker && close[1].length >= minLength) { index += 1; break; }
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2] }); index += 1; continue; }

    if (HR.test(line)) { blocks.push({ type: "hr" }); index += 1; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < end) {
        const quoted = lines[index].match(QUOTE);
        if (quoted) { inner.push(quoted[1]); index += 1; continue; }
        // 引用块里的懒续行：非空且不是新块起始时并入引用。
        if (lines[index].trim() && !isBlockStart(lines[index], lines[index + 1])) { inner.push(lines[index]); index += 1; continue; }
        break;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner, 0, inner.length) });
      continue;
    }

    const delimiter = lines[index + 1];
    if (delimiter !== undefined && line.includes("|") && isTableDelimiter(delimiter)) {
      const align: MdAlign[] = splitRow(delimiter).map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null);
      const header = splitRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < end && lines[index].trim() && lines[index].includes("|")) { rows.push(splitRow(lines[index])); index += 1; }
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const parsed = parseList(lines, index, end);
      blocks.push(parsed.list);
      index = parsed.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < end) {
      const current = lines[index];
      if (!current.trim()) break;
      if (paragraph.length && isBlockStart(current, lines[index + 1])) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function parseList(lines: string[], start: number, end: number): { list: Extract<MdBlock, { type: "list" }>; next: number } {
  const first = lines[start].match(LIST_ITEM);
  if (!first) throw new Error("parseList 必须从列表项开始");
  const baseIndent = indentWidth(lines[start]);
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: MdListItem[] = [];
  let index = start;

  while (index < end) {
    const line = lines[index];
    if (!line.trim()) {
      let probe = index + 1;
      while (probe < end && !lines[probe].trim()) probe += 1;
      if (probe < end && (indentWidth(lines[probe]) > baseIndent || (LIST_ITEM.test(lines[probe]) && indentWidth(lines[probe]) >= baseIndent))) { index = probe; continue; }
      break;
    }
    const item = line.match(LIST_ITEM);
    if (!item || indentWidth(line) !== baseIndent) break;
    const contentIndent = baseIndent + item[2].length + 1;
    const body: string[] = [item[3]];
    index += 1;
    // 收集本项的所有行：更深缩进的续行/子块都归它，直到同级或更浅的列表项。
    while (index < end) {
      const current = lines[index];
      const nextItem = current.match(LIST_ITEM);
      if (nextItem && indentWidth(current) <= baseIndent) break;
      if (!current.trim()) {
        let probe = index + 1;
        while (probe < end && !lines[probe].trim()) probe += 1;
        if (probe < end && (indentWidth(lines[probe]) > baseIndent || (LIST_ITEM.test(lines[probe]) && indentWidth(lines[probe]) > baseIndent))) { body.push(""); index = probe; continue; }
        break;
      }
      if (indentWidth(current) > baseIndent || nextItem) { body.push(stripIndent(current, contentIndent)); index += 1; continue; }
      break;
    }
    const task = body[0].match(TASK);
    const rest = body.slice(1).join("\n");
    items.push({
      text: task ? task[2] : body[0],
      checked: task ? task[1].toLowerCase() === "x" : null,
      blocks: rest.trim() ? parseMarkdown(rest) : [],
    });
  }

  return { list: { type: "list", ordered, start: startNumber, items }, next: index };
}

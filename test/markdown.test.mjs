import assert from "node:assert/strict";
import test from "node:test";
import { isTableDelimiter, parseMarkdown, splitRow } from "../web/src/markdown-parse.ts";

test("标题、分隔线与段落按块解析，段落保留内部换行", () => {
  const blocks = parseMarkdown("# 一级标题\n\n正文一行\n正文二行\n\n---\n");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "hr"]);
  assert.deepEqual(blocks[0], { type: "heading", level: 1, text: "一级标题" });
  assert.equal(blocks[1].text, "正文一行\n正文二行");
});

test("围栏代码块保留原始内容与语言标记", () => {
  const blocks = parseMarkdown("说明：\n\n```mermaid\ngraph TD\n  A --> B\n```\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "paragraph");
  assert.deepEqual(blocks[1], { type: "code", lang: "mermaid", code: "graph TD\n  A --> B" });
});

test("GFM 表格解析表头、对齐与数据行", () => {
  const blocks = parseMarkdown("| 来源 | 类型 |\n|:---|---:|\n| A | B |\n| C | D |\n");
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.type, "table");
  assert.deepEqual(table.header, ["来源", "类型"]);
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(table.rows, [["A", "B"], ["C", "D"]]);
});

test("无序列表识别任务勾选与嵌套子列表", () => {
  const blocks = parseMarkdown("- [x] 已完成\n- [ ] 待办\n  - 子项\n");
  assert.equal(blocks.length, 1);
  const list = blocks[0];
  assert.equal(list.type, "list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].checked, true);
  assert.equal(list.items[1].checked, false);
  assert.equal(list.items[0].blocks.length, 0);
  assert.equal(list.items[1].blocks[0].type, "list");
  assert.equal(list.items[1].blocks[0].items[0].text, "子项");
});

test("有序列表保留起始序号与各项文本", () => {
  const blocks = parseMarkdown("3. 三\n4. 四\n");
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, true);
  assert.equal(blocks[0].start, 3);
  assert.deepEqual(blocks[0].items.map((item) => item.text), ["三", "四"]);
});

test("引用块递归解析内部块", () => {
  const blocks = parseMarkdown("> 提醒：这里有问题\n>\n> - 一\n> - 二\n");
  assert.equal(blocks[0].type, "quote");
  assert.deepEqual(blocks[0].blocks.map((block) => block.type), ["paragraph", "list"]);
});

test("行内语法保留原文，交给渲染层处理", () => {
  const blocks = parseMarkdown("**加粗** 与 `code` 以及 [链接](https://example.com)\n");
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[0].text, "**加粗** 与 `code` 以及 [链接](https://example.com)");
});

test("表格辅助判定与行拆分稳定", () => {
  assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
  assert.equal(isTableDelimiter("| :--- | ---: |"), true);
  assert.equal(isTableDelimiter("| a | b |"), false);
  assert.equal(isTableDelimiter("---"), false);
});

test("空内容返回空块列表", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n\n"), []);
});

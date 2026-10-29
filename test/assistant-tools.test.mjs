import assert from "node:assert/strict";
import test from "node:test";
import { executeTool, toolDefs } from "../server/assistant-tools.mjs";

// 这些用例都刻意不碰网络、不碰屏幕：只验证"能安全拒绝"和纯本地的那些工具。

test("工具声明是 OpenAI 兼容格式，且名字唯一", () => {
  const names = new Set();
  for (const item of toolDefs) {
    assert.equal(item.type, "function");
    assert.match(item.function.name, /^[a-z_]+$/);
    assert.ok(item.function.description.length > 5, `${item.function.name} 缺少说明`);
    assert.equal(item.function.parameters.type, "object");
    assert.ok(!names.has(item.function.name), `工具名重复：${item.function.name}`);
    names.add(item.function.name);
  }
  // 用户明确要求"第一期就能操作电脑"，所以屏幕操作与命令行工具必须在内。
  for (const required of ["computer_screenshot", "computer_click", "computer_type", "run_shell", "open_target", "get_weather"]) {
    assert.ok(names.has(required), `缺少工具：${required}`);
  }
});

test("查时间不依赖网络", async () => {
  const result = await executeTool("get_current_time", {});
  assert.ok(result.text.length > 0);
  assert.equal(result.image, undefined);
});

test("破坏性命令在执行前就被拒绝", async () => {
  await assert.rejects(() => executeTool("run_shell", { command: "rm -rf /" }), /破坏系统/);
  await assert.rejects(() => executeTool("run_shell", { command: "sudo shutdown -h now" }), /破坏系统/);
  await assert.rejects(() => executeTool("run_shell", { command: "mkfs.ext4 /dev/disk2" }), /破坏系统/);
  await assert.rejects(() => executeTool("run_shell", { command: "   " }), /命令为空/);
});

test("未知工具与非法输入会被拒绝", async () => {
  await assert.rejects(() => executeTool("nope", {}), /未知工具/);
  await assert.rejects(() => executeTool("open_target", { target: "not-a-path" }), /本地绝对路径/);
  await assert.rejects(() => executeTool("open_target", { target: "ftp://example.com" }), /本地绝对路径/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcProcess } from "../server/json-rpc.mjs";

const echoServer = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id != null) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { method: message.method } }) + "\n");
  }
});
`;

test("启动失败后清理状态，重试不会误报 initialize 超时", async () => {
  const rpc = new JsonRpcProcess("/definitely/not/exist/luoshenfu-codex", ["app-server"], {});
  await assert.rejects(() => rpc.start(), (error) => error.code === "ENOENT");

  // 旧实现会保留失败的 child，下一次请求被写进不存在的进程，15 秒后才报 initialize timed out。
  const startedAt = Date.now();
  await assert.rejects(() => rpc.request("initialize", {}, 15_000), /runtime is not running/);
  assert.ok(Date.now() - startedAt < 1_000, "运行时未启动时应立即失败");

  await assert.rejects(() => rpc.start(), (error) => error.code === "ENOENT");
});

test("正常进程仍能完成 initialize 请求", async () => {
  const rpc = new JsonRpcProcess(process.execPath, ["--input-type=module", "-e", echoServer], {});
  try {
    await rpc.start();
    assert.deepEqual(await rpc.request("initialize", { protocolVersion: 1 }, 5_000), { method: "initialize" });
  } finally {
    await rpc.close();
  }
});

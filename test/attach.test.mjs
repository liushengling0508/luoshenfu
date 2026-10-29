import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 1x1 的合法 PNG，用来验证"按内容识别类型"这条路走得通。
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

async function waitForServer(baseUrl, token, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      // 端口可能被别的实例占用；用错误的令牌确认这确实是我们刚启动的那个。
      if (response.ok) {
        const probe = await fetch(`${baseUrl}/api/snapshot`, { headers: { "x-luoshenfu-token": "not-our-token" } });
        if (probe.status === 401) return true;
      }
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** 起一个隔离的本地服务：独立端口 + 独立数据目录，不碰正在运行的洛神赋。 */
async function withServer(run) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-attach-data-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-attach-work-"));
  const port = 47000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = "attach-test-token";
  const server = spawn(process.execPath, ["server/index.mjs", "--dev"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, LUOSHENFU_PORT: String(port), LUOSHENFU_TOKEN: token, LUOSHENFU_DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 启动失败时必须能看到原因，否则只能看到"测试超时"。
  let logs = "";
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    assert.ok(await waitForServer(baseUrl, token, Date.now() + 20_000), `本地服务未能启动。日志：\n${logs}`);
    const headers = { "content-type": "application/json", "x-luoshenfu-token": token };
    const project = await (await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "附件测试", workspace }) })).json();
    const task = await (await fetch(`${baseUrl}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ projectId: project.id, title: "发送图片", permission: "read-only" }) })).json();
    await run({ baseUrl, headers, token, project, task, workspace });
  } finally {
    server.kill("SIGTERM");
    // 进程若已退出，once("exit") 永远不会触发，必须加超时兜底。
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

test("attach_image 把本机图片挂到会话事件上，并可按界面用的接口取回", async () => {
  await withServer(async ({ baseUrl, headers, task, workspace }) => {
    // harness 的附件正是这种没有扩展名的内容哈希文件名：只看扩展名会判定失败。
    const image = path.join(workspace, "fbaf916c3d3bc39e1bbf0462a5d51223958ec5ff4b81cd9870777c8aa07de836");
    await writeFile(image, PNG);

    const response = await fetch(`${baseUrl}/api/mcp/attach_image`, {
      method: "POST",
      headers: { ...headers, "x-luoshenfu-task": task.id },
      body: JSON.stringify({ path: image, caption: "这是验证截图" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.match(result.shown, /^图片-\d{14}\.png$/);

    const detail = await (await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers })).json();
    const event = detail.events.at(-1);
    assert.equal(event.type, "message");
    assert.equal(event.role, "assistant");
    assert.equal(event.content, "这是验证截图");
    const attachment = event.raw.attachments[0];
    // 引用而非复制：存的必须是原路径，磁盘上不留第二份。
    assert.equal(attachment.path, image);
    assert.equal(attachment.mime, "image/png");

    // 界面就是通过这个接口取图的，字节必须与原文件完全一致。
    const fetched = await fetch(`${baseUrl}/api/events/${event.id}/attachments/0`, { headers });
    assert.equal(fetched.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG);
  });
});

test("attach_image 拒绝非图片、不存在的路径与超大文件", async () => {
  await withServer(async ({ baseUrl, headers, task, workspace }) => {
    const call = (body) => fetch(`${baseUrl}/api/mcp/attach_image`, {
      method: "POST",
      headers: { ...headers, "x-luoshenfu-task": task.id },
      body: JSON.stringify(body),
    });

    const text = path.join(workspace, "notes.txt");
    await writeFile(text, "这不是图片。");
    assert.equal((await call({ path: text })).status, 400);

    // 扩展名是 .png 但内容不是：必须按内容拒绝，否则界面会渲染成裂图。
    const fake = path.join(workspace, "fake.png");
    await writeFile(fake, "not a real png");
    assert.equal((await call({ path: fake })).status, 400);

    assert.equal((await call({ path: path.join(workspace, "missing.png") })).status, 400);

    const detail = await (await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers })).json();
    assert.equal(detail.events.length, 0, "被拒绝的请求不应写进会话");
  });
});

test("取不存在的附件只返回 404，不会拖垮本地服务", async () => {
  await withServer(async ({ baseUrl, headers }) => {
    // 这条路径以前会因为 async 调用漏写 await 而让整个服务进程崩溃：
    // reject 绕过 handler 的 try/catch，变成未处理的 Promise rejection。
    const response = await fetch(`${baseUrl}/api/events/999999/attachments/0`, { headers });
    assert.equal(response.status, 404);
    await response.json();
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200, "服务应当仍然存活");
  });
});

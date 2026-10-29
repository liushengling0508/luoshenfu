import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../server/database.mjs";
import { Runner } from "../server/runner.mjs";

// 1x1 的合法 PNG；任务说明附件与事件附件共用同一套存储，字节必须原样取回。
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

async function waitForServer(baseUrl, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      // 端口可能被别的实例占用；用错误令牌确认这确实是我们刚启动的那个。
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
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-task-attach-data-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-task-attach-work-"));
  const port = 49000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = "task-attach-test-token";
  const server = spawn(process.execPath, ["server/index.mjs", "--dev"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, LUOSHENFU_PORT: String(port), LUOSHENFU_TOKEN: token, LUOSHENFU_DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 启动失败时必须能看到原因，否则只能看到“测试超时”。
  let logs = "";
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    assert.ok(await waitForServer(baseUrl, Date.now() + 20_000), `本地服务未能启动。日志：\n${logs}`);
    const headers = { "content-type": "application/json", "x-luoshenfu-token": token };
    const project = await (await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "任务附件", workspace }) })).json();
    await run({ baseUrl, headers, project, workspace });
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

const createTask = (baseUrl, headers, body) => fetch(`${baseUrl}/api/tasks`, { method: "POST", headers, body: JSON.stringify(body) });
const patchTask = (baseUrl, headers, id, body) => fetch(`${baseUrl}/api/tasks/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });

test("任务说明里的图片随任务保存，界面能预览与另存", async () => {
  await withServer(async ({ baseUrl, headers, project, workspace }) => {
    const image = path.join(workspace, "需求图.png");
    await writeFile(image, PNG);

    const created = await (await createTask(baseUrl, headers, {
      projectId: project.id, title: "带图的说明", description: "按图实现", permission: "read-only",
      attachments: [{ path: image, name: "需求图.png", mime: "image/png" }],
    })).json();
    assert.equal(created.attachments.length, 1);
    assert.equal(created.attachments[0].path, image);

    const detail = await (await fetch(`${baseUrl}/api/tasks/${created.id}`, { headers })).json();
    assert.equal(detail.attachments[0].name, "需求图.png");

    // 界面就是通过这个接口取图的，字节必须与原文件完全一致。
    const fetched = await fetch(`${baseUrl}/api/tasks/${created.id}/attachments/0`, { headers });
    assert.equal(fetched.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG);

    const destination = path.join(workspace, "另存.png");
    const copied = await fetch(`${baseUrl}/api/tasks/${created.id}/attachments/0/copy`, { method: "POST", headers, body: JSON.stringify({ destination }) });
    assert.equal(copied.status, 200);
    assert.deepEqual(await readFile(destination), PNG);
  });
});

test("任务说明附件可以更新、清空，并拒绝不存在的文件", async () => {
  await withServer(async ({ baseUrl, headers, project, workspace }) => {
    const first = path.join(workspace, "第一张.png");
    const second = path.join(workspace, "第二张.png");
    await writeFile(first, PNG);
    await writeFile(second, PNG);

    const created = await (await createTask(baseUrl, headers, {
      projectId: project.id, title: "可更新的说明", permission: "read-only",
      attachments: [{ path: first, name: "第一张.png", mime: "image/png" }],
    })).json();

    const updated = await (await patchTask(baseUrl, headers, created.id, { attachments: [{ path: second, name: "第二张.png", mime: "image/png" }] })).json();
    assert.equal(updated.attachments[0].name, "第二张.png");

    const cleared = await (await patchTask(baseUrl, headers, created.id, { attachments: [] })).json();
    assert.deepEqual(cleared.attachments, []);
    assert.equal((await fetch(`${baseUrl}/api/tasks/${created.id}/attachments/0`, { headers })).status, 404);

    const rejected = await patchTask(baseUrl, headers, created.id, { attachments: [{ path: path.join(workspace, "不存在.png"), name: "不存在.png", mime: "image/png" }] });
    assert.equal(rejected.status, 400);
    // 被拒绝的更新不能污染已有任务。
    assert.deepEqual((await (await fetch(`${baseUrl}/api/tasks/${created.id}`, { headers })).json()).attachments, []);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200, "服务应当仍然存活");
  });
});

test("流程任务的说明图片复制到各阶段，根任务修改后同步", async () => {
  await withServer(async ({ baseUrl, headers, project, workspace }) => {
    const image = path.join(workspace, "流程需求.png");
    const next = path.join(workspace, "流程需求-v2.png");
    await writeFile(image, PNG);
    await writeFile(next, PNG);

    const created = await (await createTask(baseUrl, headers, {
      projectId: project.id, kind: "workflow", title: "带图流程", description: "三阶段共用同一份需求", permission: "read-only",
      attachments: [{ path: image, name: "流程需求.png", mime: "image/png" }],
    })).json();
    assert.equal(created.stages.length, 3);
    for (const stage of created.stages) assert.equal(stage.attachments[0].path, image);

    await patchTask(baseUrl, headers, created.root.id, { attachments: [{ path: next, name: "流程需求-v2.png", mime: "image/png" }] });
    const detail = await (await fetch(`${baseUrl}/api/tasks/${created.root.id}`, { headers })).json();
    for (const stage of detail.children) assert.equal(stage.attachments[0].path, next);
  });
});

test("执行任务时任务说明里的图片交给智能体，后续轮次不重复投递", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-task-attach-run-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-task-attach-run-work-"));
  const store = new Store(directory, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: directory, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  const calls = [];
  // 关掉 Worktree 隔离：这里只验证传给运行时的内容，不需要真实 git 仓库。
  runner.worktree.prepare = async () => ({ status: "disabled", path: null, branch: null, baseCommit: null, note: "测试关闭隔离" });
  runner.codex.startConversation = async (input) => {
    calls.push(input);
    return { externalId: "thread-1", turnId: "turn-1", completion: Promise.resolve({ stopReason: "end_turn" }) };
  };
  const wait = async (check) => { for (let index = 0; index < 200 && !check(); index += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
  try {
    const project = store.createProject({ name: "P", workspace });
    const image = path.join(workspace, "参考.png");
    await writeFile(image, PNG);
    const task = store.createStandalone({
      projectId: project.id, title: "按图实现", description: "按参考图实现界面", provider: "codex", permission: "workspace-write",
      attachments: [{ path: image, name: "参考.png", mime: "image/png" }],
    });

    await runner.runTask(task.id);
    await wait(() => store.lastRun(task.id)?.status === "completed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].attachments.map((item) => item.path), [image]);
    // 任务说明附件不能顶掉任务说明本身，否则智能体只收到一张图。
    assert.match(calls[0].message, /按参考图实现界面/);

    await runner.runTask(task.id, "继续");
    await wait(() => store.lastRun(task.id)?.status === "completed" && calls.length === 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].attachments, [], "已有会话时不再重复投递任务说明图片");
  } finally {
    await runner.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

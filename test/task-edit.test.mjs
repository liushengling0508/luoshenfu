import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-edit-data-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-edit-work-"));
  const port = 49000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = "task-edit-test-token";
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
    const project = await (await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "编辑测试", workspace }) })).json();
    const task = await (await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: project.id, title: "初始标题", description: "初始说明", permission: "read-only" }),
    })).json();
    await run({ baseUrl, headers, project, task });
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

test("任务标题与说明可以编辑并持久化", async () => {
  await withServer(async ({ baseUrl, headers, task }) => {
    const readDetail = async () => (await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers })).json();
    const patch = (body) => fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });

    const response = await patch({ title: "改好的标题", description: "改好的说明\n第二行" });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.title, "改好的标题");
    assert.equal(payload.description, "改好的说明\n第二行");
    assert.equal((await readDetail()).description, "改好的说明\n第二行", "说明必须真正落库");

    // 只改标题时不能顺手把说明抹掉。
    assert.equal((await patch({ title: "再改一次" })).status, 200);
    const onlyTitle = await readDetail();
    assert.equal(onlyTitle.title, "再改一次");
    assert.equal(onlyTitle.description, "改好的说明\n第二行");

    // 说明允许清空（这正是"删掉旧需求"的做法）。
    assert.equal((await patch({ description: "   " })).status, 200);
    assert.equal((await readDetail()).description, "");
  });
});

test("编辑任务时拒绝空标题与超长内容", async () => {
  await withServer(async ({ baseUrl, headers, task }) => {
    const patch = (body) => fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });

    assert.equal((await patch({ title: "   " })).status, 400);
    assert.equal((await patch({ title: "x".repeat(201) })).status, 400);
    assert.equal((await patch({ description: "x".repeat(20_001) })).status, 400);
    assert.equal((await patch({ description: 42 })).status, 400);

    // 被拒绝的请求不能留下半截改动。
    const detail = await (await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers })).json();
    assert.equal(detail.title, "初始标题");
    assert.equal(detail.description, "初始说明");
  });
});

test("流程任务改标题/说明会同步到各阶段", async () => {
  await withServer(async ({ baseUrl, headers, project }) => {
    const created = await (await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: project.id, kind: "workflow", title: "原始流程", description: "原始说明", permission: "read-only",
        stages: {
          design: { provider: "deepseek", model: "deepseek-design", effort: "high" },
          implementation: { provider: "codex", model: "gpt-build", effort: "medium" },
          verification: { provider: "deepseek", model: "deepseek-review", effort: "max" },
        },
      }),
    })).json();
    const rootId = created.root.id;
    const before = await (await fetch(`${baseUrl}/api/tasks/${rootId}`, { headers })).json();
    assert.deepEqual(before.children.map((stage) => stage.phase), ["design", "implementation", "verification"]);
    assert.deepEqual(before.children.map((stage) => stage.provider), ["deepseek", "codex", "deepseek"]);
    assert.deepEqual(before.children.map((stage) => stage.model), ["deepseek-design", "gpt-build", "deepseek-review"]);
    assert.ok(before.children.every((stage) => stage.description === "原始说明"));

    const response = await fetch(`${baseUrl}/api/tasks/${rootId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "新流程", description: "新说明" }),
    });
    assert.equal(response.status, 200);

    // 阶段说明是创建时从根任务复制的，改根任务必须一并更新，否则重新执行仍用旧文案。
    const after = await (await fetch(`${baseUrl}/api/tasks/${rootId}`, { headers })).json();
    assert.equal(after.title, "新流程");
    assert.equal(after.description, "新说明");
    assert.deepEqual(after.children.map((stage) => stage.title), ["新流程 · 设计", "新流程 · 实施", "新流程 · 验证"]);
    assert.ok(after.children.every((stage) => stage.description === "新说明"));
  });
});

test("尚未执行的独立任务可以保留原编号并转为流程任务", async () => {
  await withServer(async ({ baseUrl, headers, task }) => {
    const response = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        kind: "workflow",
        title: "升级后的流程",
        description: "沿用原任务并补充说明",
        stages: {
          design: { provider: "deepseek", model: "deepseek-design", effort: "high" },
          implementation: { provider: "codex", model: "gpt-build", effort: "medium" },
          verification: { provider: "deepseek", model: "deepseek-review", effort: "max" },
        },
      }),
    });
    const converted = await response.json();
    assert.equal(response.status, 200, JSON.stringify(converted));
    assert.equal(converted.id, task.id);
    assert.equal(converted.number, task.number);
    assert.equal(converted.is_root, 1);
    assert.equal(converted.provider, null);
    assert.deepEqual(converted.children.map((stage) => stage.phase), ["design", "implementation", "verification"]);
    assert.deepEqual(converted.children.map((stage) => stage.provider), ["deepseek", "codex", "deepseek"]);
    assert.deepEqual(converted.children.map((stage) => stage.model), ["deepseek-design", "gpt-build", "deepseek-review"]);
    assert.ok(converted.children.every((stage) => stage.description === "沿用原任务并补充说明"));
  });
});

test("非待执行独立任务不能转为流程任务", async () => {
  await withServer(async ({ baseUrl, headers, task }) => {
    await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "done" }) });
    const response = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ kind: "workflow" }),
    });
    assert.equal(response.status, 400);
    const unchanged = await (await fetch(`${baseUrl}/api/tasks/${task.id}`, { headers })).json();
    assert.equal(unchanged.is_root, 0);
    assert.equal(unchanged.children.length, 0);
  });
});

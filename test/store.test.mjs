import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexRuntime, readCodexRuntime } from "../server/codex.mjs";
import { DeepseekRuntime } from "../server/deepseek.mjs";
import { Store } from "../server/database.mjs";
import { Runner } from "../server/runner.mjs";
import { WorkbenchSync, parseWorkbenchMembers } from "../server/workbench.mjs";
import { validateComputerInput } from "../server/computer.mjs";
import { openArguments } from "../server/open-target.mjs";
import { resultSegments } from "../web/src/result-links.ts";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

test("concurrent Codex callers initialize one app-server connection", async () => {
  const runtime = new CodexRuntime({ mcp: {}, onEvent() {}, onApproval() {}, onExit() {} });
  let starts = 0;
  let initializes = 0;
  runtime.rpc = {
    async start() { starts += 1; },
    async request(method) { if (method === "initialize") initializes += 1; },
    notify() {},
  };
  await Promise.all([runtime.ready(), runtime.ready()]);
  assert.equal(starts, 1);
  assert.equal(initializes, 1);
});

test("account usage reads fresh values and Codex pushes quota changes", async () => {
  let changes = 0;
  let resetParams;
  const codex = new CodexRuntime({ mcp: {}, onEvent() {}, onApproval() {}, onExit() {}, onAccountChange() { changes += 1; } });
  codex.initialized = true;
  codex.rpc = { async request(method, params) {
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 25 } } };
    if (method === "account/rateLimitResetCredit/consume") { resetParams = params; return { outcome: "reset" }; }
  }, notify() {} };
  codex.modelCache = [{ id: "cached-model", name: "Cached Model" }];
  assert.equal((await codex.listModels())[0].id, "cached-model");
  assert.equal((await codex.getRateLimits()).rateLimits.primary.usedPercent, 25);
  assert.equal((await codex.consumeRateLimitReset("attempt-1", "credit-1")).outcome, "reset");
  assert.deepEqual(resetParams, { idempotencyKey: "attempt-1", creditId: "credit-1" });
  codex.handleNotification({ method: "account/rateLimits/updated", params: {} });
  assert.equal(changes, 1);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, async json() { return { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.34" }] }; } });
  try {
    const deepseek = new DeepseekRuntime({ resourceDirectory: "/tmp", dataDirectory: "/tmp", readKey: async () => "test-key", onEvent() {}, onApproval() {}, onExit() {}, mcp: {} });
    assert.equal((await deepseek.getBalance()).balance_infos[0].total_balance, "12.34");
  } finally { globalThis.fetch = originalFetch; }
});

test("runtime adapters forward effort, plan mode, and skills", async () => {
  const codexCalls = [];
  const codex = new CodexRuntime({ mcp: { codex: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  codex.initialized = true;
  codex.rpc = { async request(method, params) { codexCalls.push({ method, params }); if (method === "thread/start") return { thread: { id: "thread" } }; if (method === "turn/start") return { turn: { id: "turn" } }; }, notify() {} };
  await codex.startConversation({ task: { id: "task", workspace: "/tmp", model: "gpt-test", permission: "workspace-write" }, conversation: { runId: "run", reasoning_effort: "high" }, message: "hello", attachments: [{ path: "/tmp/image.png", name: "image.png", mime: "image/png" }, { path: "/tmp/notes.md", name: "notes.md", mime: "text/markdown" }], planMode: true, skill: { name: "demo", path: "/tmp/demo/SKILL.md" } });
  const turn = codexCalls.find((call) => call.method === "turn/start").params;
  assert.equal(turn.effort, "high");
  assert.equal(turn.collaborationMode.mode, "plan");
  assert.deepEqual(turn.input, [{ type: "text", text: "$demo hello", text_elements: [] }, { type: "localImage", path: "/tmp/image.png" }, { type: "mention", name: "notes.md", path: "/tmp/notes.md" }, { type: "skill", name: "demo", path: "/tmp/demo/SKILL.md" }]);

  await codex.startConversation({ task: { id: "task", workspace: "/tmp", model: "gpt-test", permission: "workspace-write" }, conversation: { external_id: "thread", runId: "run-2", reasoning_effort: "high" }, message: "implement", planMode: false });
  const defaultTurn = codexCalls.filter((call) => call.method === "turn/start").at(-1).params;
  assert.equal(defaultTurn.collaborationMode.mode, "default");

  const deepseekCalls = [];
  const deepseek = new DeepseekRuntime({ mcp: { deepseek: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  deepseek.modelCache = [{ id: "deepseek-v4-pro", name: "deepseek-v4-pro" }];
  deepseek.pool = async () => ({
    async request(method, params) {
      deepseekCalls.push({ method, params });
      if (method === "session/new") return { sessionId: "session", configOptions: [
        { id: "model", currentValue: '["deepseek","deepseek-v4-flash"]', options: [{ value: '["deepseek","deepseek-flash"]', name: "DeepSeek-V41-Flash" }, { value: '["deepseek","deepseek-v4-flash"]', name: "Deepseek-V4-Flash" }] },
        { id: "reasoning_effort", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "max", name: "Max" }] },
      ] };
      if (method === "session/set_config_option") return { configOptions: [] };
      return { stopReason: "end_turn" };
    },
  });
  await deepseek.startConversation({ task: { id: "task", workspace: "/tmp", model: null, permission: "workspace-write" }, conversation: { runId: "run", reasoning_effort: "max" }, message: "hello" });
  assert.equal(deepseekCalls.find((call) => call.method === "session/set_config_option" && call.params.configId === "model").params.value, '["deepseek","deepseek-flash"]');
  assert.equal(deepseekCalls.find((call) => call.method === "session/set_config_option" && call.params.configId === "reasoning_effort").params.value, "max");
  assert.equal(deepseek.modelCache.find((model) => model.id === "deepseek-flash").name, "Deepseek-V4.1-Flash");
  assert.equal(deepseek.modelCache.find((model) => model.id === "deepseek-flash").isDefault, true);
});

test("Codex resumes a persisted thread only once per app-server process", async () => {
  const calls = [];
  const codex = new CodexRuntime({ mcp: { codex: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  codex.modelCache = [{ id: "gpt-test", isDefault: true }];
  const runtimeExit = codex.rpc.options.onExit;
  codex.initialized = true;
  codex.rpc = {
    async start() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "turn/start") return { turn: { id: `turn-${calls.filter((call) => call.method === "turn/start").length}` } };
    },
    notify() {},
  };
  const task = { id: "task", workspace: "/tmp", model: null, permission: "workspace-write" };
  const first = await codex.startConversation({ task, conversation: { external_id: "thread", runId: "run-1" }, message: "first" });
  codex.handleNotification({ method: "turn/completed", params: { threadId: "thread", turn: { status: "completed" } } });
  await first.completion;
  const second = await codex.startConversation({ task, conversation: { external_id: "thread", runId: "run-2" }, message: "second" });
  codex.handleNotification({ method: "turn/completed", params: { threadId: "thread", turn: { status: "completed" } } });
  await second.completion;
  assert.equal(calls.filter((call) => call.method === "thread/resume").length, 1);

  runtimeExit(new Error("app-server restarted"));
  const third = await codex.startConversation({ task, conversation: { external_id: "thread", runId: "run-3" }, message: "third" });
  codex.handleNotification({ method: "turn/completed", params: { threadId: "thread", turn: { status: "completed" } } });
  await third.completion;
  assert.equal(calls.filter((call) => call.method === "thread/resume").length, 2);
});

test("Deepseek follow-ups reuse an active session and keep image input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-deepseek-"));
  const image = path.join(directory, "image.png");
  await writeFile(image, "image-bytes");
  const calls = [];
  const configOptions = [{
    id: "model",
    currentValue: '["deepseek","deepseek-flash"]',
    options: [{ value: '["deepseek","deepseek-flash"]', name: "DeepSeek-V41-Flash" }],
  }];
  const rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === "session/new") return { sessionId: "session", configOptions };
    if (method === "session/set_config_option") return { configOptions };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    throw new Error(`unexpected ${method}`);
  } };
  const deepseek = new DeepseekRuntime({ mcp: { deepseek: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  deepseek.pool = async () => rpc;
  const task = { id: "task", workspace: directory, model: "deepseek-flash", permission: "workspace-write" };
  try {
    const first = await deepseek.startConversation({ task, conversation: { runId: "run-1" }, message: "first" });
    await first.completion;
    const second = await deepseek.startConversation({ task, conversation: { external_id: "session", runId: "run-2" }, message: "识别下", attachments: [{ path: image, name: "image.png", mime: "image/png" }] });
    await second.completion;
    assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
    assert.equal(calls.filter((call) => call.method === "session/resume").length, 0);
    assert.deepEqual(calls.filter((call) => call.method === "session/prompt")[1].params.prompt, [
      { type: "text", text: "识别下" },
      { type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Deepseek ACP advertises image input from the 4.1 Flash route", () => {
  const root = process.cwd();
  const effective = composeEntries([
    loadOverlayPatches("test", path.join(root, "node_modules/@deepseek-ai/dsh-acp-app/cordis.patch.yml")),
    loadOverlayPatches("test", path.join(root, "server/deepseek-image.patch.yml")),
  ]);
  assert.deepEqual(effective.find((entry) => entry.id === "acp")?.config, { provider: "deepseek-official", model: "deepseek-flash" });
});

test("message attachments remain available to the conversation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-attachments-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Image", provider: "deepseek", permission: "workspace-write" });
    const item = { path: path.join(directory, "image.png"), name: "image.png", mime: "image/png" };
    const eventId = store.addEvent(task.id, null, { type: "message", role: "user", content: "识别图片", raw: { attachments: [item] } });
    assert.deepEqual(store.eventAttachment(eventId, 0), item);
    assert.equal(store.eventAttachment(eventId, 1), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex plan questions reach the UI and return the selected answer", async () => {
  let approval;
  const codex = new CodexRuntime({ mcp: {}, onEvent() {}, onApproval(value) { approval = value; }, onExit() {} });
  codex.contexts.set("thread", { taskId: "task", runId: "run" });
  const response = codex.handleRequest({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "thread", questions: [{ id: "city", header: "城市", question: "请选择城市", options: [{ label: "上海", description: "查询上海" }] }] } });
  assert.equal(approval.externalRequestId, "user-input:7");
  await codex.respondToApproval("user-input:7", { answers: { city: { answers: ["上海"] } } });
  assert.deepEqual(await response, { answers: { city: { answers: ["上海"] } } });
});

test("Computer Use rejects unsafe input before controlling the desktop", () => {
  assert.deepEqual(validateComputerInput("computer_click", { x: 99, y: 49 }, { width: 100, height: 50 }), { x: 99, y: 49 });
  assert.throws(() => validateComputerInput("computer_click", { x: 100, y: 1 }, { width: 100, height: 50 }), /超出/);
  assert.throws(() => validateComputerInput("computer_key", { key: "volume_up" }), /不支持/);
  assert.throws(() => validateComputerInput("computer_type", { text: "x".repeat(4001) }), /1-4000/);
});

test("execution results link web pages and reveal local files safely", () => {
  assert.deepEqual(resultSegments("参考 [官网](https://example.com/docs)，文件 `/Users/me/demo/App.tsx:12`。"), [
    { type: "text", text: "参考 " }, { type: "url", text: "官网", target: "https://example.com/docs" }, { type: "text", text: "，文件 " },
    { type: "file", text: "App.tsx", target: "/Users/me/demo/App.tsx" }, { type: "text", text: "。" },
  ]);
  assert.deepEqual(openArguments("https://example.com/docs"), ["https://example.com/docs"]);
  assert.deepEqual(openArguments("/Users/me/demo/App.tsx:12"), ["-R", "/Users/me/demo/App.tsx"]);
  assert.throws(() => openArguments("javascript:alert(1)"), /绝对路径/);
});

test("optional workbench sync creates one task and maps later status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-"));
  const store = new Store(directory);
  const calls = [];
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  sync.request = async (method, pathname, body) => {
    calls.push({ method, pathname, body });
    if (method === "GET") return { tasks: [] };
    return method === "POST" ? { task: { id: "dt_test" } } : { ok: true };
  };
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Sync me", permission: "workspace-write" });
    assert.equal(store.pendingWorkbenchSync().length, 0);
    store.enableWorkbenchSync(task.id, { projectId: "project-1", requirementId: "requirement-1", kind: "development" });
    await sync.sync();
    assert.equal(calls[0].body.project_id, "project-1");
    assert.equal(calls[0].body.requirement_id, "requirement-1");
    assert.equal(calls[0].body.kind, "development");
    assert.equal(calls[0].body.priority, "P2");
    store.updateTask(task.id, { status: "running" });
    await sync.sync();
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[1].body, { status: "doing" });
    store.updateTask(task.id, { title: "Updated title", description: "Updated detail" });
    await sync.sync();
    assert.equal(calls[2].body.title, "Updated title");
    assert.match(calls[2].body.detail, /Updated detail[\s\S]*洛神赋-ID:/);
    store.updateTask(task.id, { status: "canceled" });
    await sync.sync();
    assert.equal(calls.length, 3, "取消任务不得回写为开发台已完成");

    calls.length = 0;
    const uncertain = store.createStandalone({ projectId: project.id, title: "Recover me", description: "", permission: "workspace-write" });
    store.enableWorkbenchSync(uncertain.id);
    store.markWorkbenchSync(uncertain.id, { error: "创建结果待确认：timeout" });
    sync.request = async (method, pathname, body) => {
      calls.push({ method, pathname, body });
      return method === "GET" ? { tasks: [{ id: "dt_recovered", detail: `洛神赋-ID: ${uncertain.id}` }] } : { ok: true };
    };
    await sync.sync();
    assert.equal(calls[0].pathname, "/api/dev/tasks?status=todo");
    assert.equal(calls.some((call) => call.method === "POST"), false);
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench pull imports open tasks once and links existing ones", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-pull-"));
  const store = new Store(directory);
  let pulled = 0;
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key", onPulled: (result) => { pulled += result.created; } });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const linked = store.createStandalone({ projectId: project.id, title: "已同步任务", permission: "workspace-write" });
    store.linkWorkbenchTask(linked.id, "wb_linked", "todo");
    const marked = store.createStandalone({ projectId: project.id, title: "带标记任务", permission: "workspace-write" });
    const paths = [];
    sync.request = async (method, pathname) => {
      paths.push(pathname);
      if (pathname === "/api/dev/me") return { username: "tester", persona: "测试员" };
      return { tasks: [
        { id: "wb_new", title: "外部待办", detail: "需求第一行\n需求第二行", status: "todo", assignee: "tester", repo: "Demo" },
        { id: "wb_backlog", title: "外部未规划", detail: "", status: "backlog", assignee: "tester" },
        { id: "wb_chinese", title: "运营待办", detail: "", status: "待处理", assignee: "测试员" },
        { id: "wb_doing", title: "外部进行中", detail: "", status: "doing", assignee: "tester" },
        { id: "wb_other", title: "别人的任务", detail: "", status: "todo", assignee: "someone" },
        { id: "wb_linked", title: "已绑定", detail: "", status: "todo", assignee: "tester" },
        { id: "wb_marked", title: "标记关联", detail: `洛神赋-ID: ${marked.id}`, status: "backlog", assignee: "tester" },
        { id: "wb_archive", title: "归档写入中", detail: "归档来源：洛神赋对话 chat-1", status: "todo", assignee: "tester" },
      ] };
    };
    assert.equal(await sync.pullBound().catch((error) => error.message), "请先在设置中为 Lo查查工作台绑定项目");
    assert.deepEqual(paths, []);
    store.setSetting("workbench.projectId", project.id);
    const [result, concurrent] = await Promise.all([sync.pullBound(), sync.pullBound()]);
    // 待办列表走服务端「我 + 未开始」过滤，避免每次拉全量（实测全量 1MB+ / 1200 条）。
    assert.ok(paths.some((pathname) => pathname.includes("status=todo") && pathname.includes("assignee=tester")));
    assert.ok(!paths.includes("/api/dev/tasks"), "不应退回无参数全量");
    assert.equal(result.total, 5);
    assert.equal(result.created, 3);
    assert.equal(result.linked, 1);
    assert.equal(result.skipped, 1);
    assert.equal(concurrent, result);
    assert.equal(pulled, 3);
    const imported = store.tasks(project.id).find((item) => item.title === "外部待办");
    assert.ok(imported);
    assert.equal(imported.status, "todo");
    assert.equal(imported.project_id, project.id);
    assert.match(imported.description, /Lo查查工作台/);
    assert.doesNotMatch(imported.description, /洛神赋-ID/);
    assert.equal(store.workbenchTaskByExternal("wb_new").id, imported.id);
    assert.equal(store.workbenchTaskByExternal("wb_backlog").title, "外部未规划");
    assert.equal(store.workbenchTaskByExternal("wb_marked").id, marked.id);
    assert.equal(store.workbenchTaskByExternal("wb_linked").id, linked.id);
    // 中文「待处理」+ 中文负责人（persona）也要能拉取，运营任务常见的组合。
    assert.equal(store.workbenchTaskByExternal("wb_chinese").title, "运营待办");
    // 反向拉取的待办已与工作台对齐状态，不会再次被同步任务回写。
    assert.equal(store.pendingWorkbenchSync().length, 0);
    const again = await sync.pullBound();
    assert.equal(again.created, 0);
    assert.equal(again.linked, 0);
    assert.equal(again.skipped, 5);
    assert.equal(store.tasks(project.id).filter((item) => item.title === "外部待办").length, 1);
    // 拉取的任务默认 Deepseek + 运行时默认模型/Effort + 完全访问，之后必须能改成别的模型。
    assert.equal(imported.provider, "deepseek");
    assert.equal(imported.model, null);
    assert.equal(imported.reasoning_effort, null);
    assert.equal(imported.permission, "danger-full-access");
    store.updateTask(imported.id, { provider: "codex", model: "gpt-5.6-sol", reasoning_effort: "max" });
    const configured = store.task(imported.id);
    assert.equal(configured.provider, "codex");
    assert.equal(configured.model, "gpt-5.6-sol");
    assert.equal(configured.reasoning_effort, "max");
    // 执行权限同样要能在任务详情里修改。
    store.updateTask(imported.id, { permission: "workspace-write" });
    assert.equal(store.task(imported.id).permission, "workspace-write");
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench pull keeps identity fallback when /api/dev/me fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-identity-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    store.setSetting("workbench.projectId", project.id);
    store.setSetting("workbench.user", "tester");
    const paths = [];
    sync.request = async (method, pathname) => {
      paths.push(pathname);
      // 身份接口偶发失败：必须退回上次保存的登录名，只拉本人待办，不能全量放行。
      if (pathname === "/api/dev/me") throw new Error("工作台连接失败（502）");
      return { tasks: [
        { id: "wb_mine", title: "我的待办", status: "todo", assignee: "tester" },
        { id: "wb_other", title: "别人的待办", status: "todo", assignee: "someone" },
      ] };
    };
    const result = await sync.pullBound();
    assert.ok(paths.some((pathname) => pathname.includes("assignee=tester")));
    assert.equal(result.created, 1);
    assert.ok(store.workbenchTaskByExternal("wb_mine"));
    assert.equal(store.workbenchTaskByExternal("wb_other"), null);
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench pull imports nothing when identity is unknown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-noidentity-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    store.setSetting("workbench.projectId", project.id);
    store.setSetting("workbench.user", "");
    sync.request = async (method, pathname) => {
      if (pathname === "/api/dev/me") throw new Error("工作台连接失败（502）");
      return { tasks: [
        { id: "wb_other", title: "别人的待办", status: "todo", assignee: "someone" },
      ] };
    };
    const result = await sync.pullBound();
    assert.equal(result.created, 0);
    assert.equal(store.workbenchTaskByExternal("wb_other"), null);
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench sync re-links pulled tasks instead of recreating them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-relink-"));
  const store = new Store(directory);
  const calls = [];
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  sync.request = async (method, pathname) => { calls.push({ method, pathname }); return { ok: true }; };
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.importWorkbenchTask({
      projectId: project.id, title: "拉取任务",
      description: "来源：Lo查查工作台（dt_recover）\n\n正文", externalId: "dt_recover",
    });
    // 模拟关联记录被清掉、只剩任务说明里的来源行：同步时只能补关联，绝不能在建单接口上重来一次。
    store.db.prepare("UPDATE workbench_sync SET external_id=NULL, synced_status=NULL WHERE task_id=?").run(task.id);
    await sync.sync();
    assert.equal(calls.some((call) => call.method === "POST"), false);
    assert.deepEqual(calls, []);
    assert.equal(store.workbenchTaskByExternal("dt_recover").id, task.id);
    assert.equal(store.pendingWorkbenchSync().length, 0);
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("visible task numbers never return after deletion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-numbers-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const deleted = store.createStandalone({ projectId: project.id, title: "First", permission: "workspace-write" });
    store.deleteTask(deleted.id);
    assert.equal(store.createStandalone({ projectId: project.id, title: "Second", permission: "workspace-write" }).number, deleted.number + 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow advances once and delegation retries are idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-store-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const { root, stages } = store.createWorkflow({
      projectId: project.id, title: "Ship", permission: "workspace-write", autoExecute: true,
      stages: [
        { provider: "codex", phase: "design", model: "gpt-design", effort: "high" },
        { provider: "deepseek", phase: "implementation", model: "deepseek-build", effort: "max" },
        { provider: "codex", phase: "verification", model: "gpt-review", effort: "medium" },
      ],
    });
    assert.equal(stages.length, 3);
    assert.equal(stages[0].provider, "codex");
    assert.equal(stages[1].provider, "deepseek");
    assert.equal(stages[0].model, "gpt-design");
    assert.equal(stages[0].reasoning_effort, "high");
    assert.equal(stages[1].reasoning_effort, "max");
    assert.equal(stages.every((stage) => stage.auto_execute === 1 && stage.number < 0), true);
    assert.equal(store.createStandalone({ projectId: project.id, title: "Visible next", provider: "codex", permission: "workspace-write" }).number, root.number + 1);
    assert.equal(store.priorStageIncomplete(stages[1]), true);

    const conversation = store.conversation(stages[0], "codex", null, null);
    const updatedConversation = store.conversation(stages[0], "codex", "gpt-next", "ultra");
    assert.equal(updatedConversation.model, "gpt-next");
    assert.equal(updatedConversation.reasoning_effort, "ultra");
    const run = store.startRun(stages[0].id, conversation.id);
    assert.equal(store.task(root.id).status, "running");
    assert.equal(store.finishRun(run.id, "completed").id, stages[1].id);
    assert.equal(store.priorStageIncomplete(stages[1]), false);
    const completed = store.taskDetail(stages[0].id);
    assert.equal(completed.archived, 0);
    assert.ok(completed.duration_seconds >= 0);
    store.updateTask(stages[0].id, { status: "todo" });
    assert.equal(store.task(stages[0].id).status, "todo");
    store.updateTask(stages[0].id, { status: "done" });
    store.updateTask(stages[0].id, { archived: true, archived_at: new Date().toISOString() });
    assert.equal(store.taskDetail(stages[0].id).archived, 1);

    const first = store.createDelegatedTask(stages[0], { provider: "deepseek", title: "Child", description: "", idempotencyKey: "same" });
    const retry = store.createDelegatedTask(stages[0], { provider: "deepseek", title: "Duplicate", description: "", idempotencyKey: "same" });
    assert.equal(first.id, retry.id);
    store.enableWorkbenchSync(root.id);
    assert.equal(store.pendingWorkbenchSync()[0].id, root.id);
    store.enableWorkbenchSync(stages[0].id);
    store.addEvent(stages[0].id, run.id, { type: "message", role: "assistant", content: "done" });
    assert.equal(store.taskDetail(root.id).events.at(-1).content, "done");
    store.updateTask(root.id, { status: "done", archived: true, archived_at: new Date().toISOString() });
    assert.equal(store.archivePage(project.id).items[0].id, root.id);
    store.updateTask(root.id, { archived: false, archived_at: null });
    assert.equal(store.deleteTask(stages[0].id), 2);
    assert.equal(store.task(stages[0].id), undefined);
    assert.equal(store.task(first.id), undefined);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a workflow root runs every stage in order", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workflow-"));
  const store = new Store(directory);
  const runner = new Runner({ store, dataDirectory: directory, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const { root, stages } = store.createWorkflow({ projectId: project.id, title: "Ship", permission: "workspace-write", autoExecute: false, stages: [
      { provider: "codex", phase: "design", model: "gpt-design" },
      { provider: "deepseek", phase: "implementation", model: "deepseek-build" },
      { provider: "codex", phase: "verification", model: "gpt-review" },
    ] });
    const order = [];
    const start = async ({ task }) => { order.push(task.phase); return { externalId: `thread-${task.id}`, turnId: `turn-${task.id}`, completion: Promise.resolve({ stopReason: "end_turn", model: task.model, effort: "high" }) }; };
    runner.codex.startConversation = start;
    runner.deepseek.startConversation = start;
    assert.match(runner.defaultPrompt(stages[0]), /只产出设计方案，不做任何实施/);
    assert.match(runner.defaultPrompt(stages[0]), /block_task/);
    assert.match(runner.defaultPrompt(stages[1]), /只执行设计阶段已确定的方案/);
    assert.match(runner.defaultPrompt(stages[2]), /只验证实施结果是否符合设计阶段的验收标准/);
    await runner.runTask(root.id);
    for (let index = 0; index < 50 && !stages.every((stage) => store.task(stage.id).status === "done"); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, ["design", "implementation", "verification"]);
    // 三个阶段跑完后流程任务停在「待验证」，用户确认验收后才算完成。
    assert.equal(store.task(root.id).status, "in_review");
    assert.equal(stages.every((stage) => store.task(stage.id).status === "done"), true);
    store.updateTask(root.id, { status: "done" });
    assert.equal(store.task(root.id).status, "done");
  } finally {
    await runner.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("重跑已完成的阶段会重置后续阶段，严格重走设计→实施→验证", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workflow-rerun-"));
  const store = new Store(directory);
  const runner = new Runner({ store, dataDirectory: directory, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const { root, stages } = store.createWorkflow({ projectId: project.id, title: "Ship", permission: "workspace-write", autoExecute: false, stages: [
      { provider: "codex", phase: "design", model: "gpt-design" },
      { provider: "deepseek", phase: "implementation", model: "deepseek-build" },
      { provider: "codex", phase: "verification", model: "gpt-review" },
    ] });
    const order = [];
    const start = async ({ task }) => { order.push(task.phase); return { externalId: `thread-${task.id}`, turnId: `turn-${task.id}`, completion: Promise.resolve({ stopReason: "end_turn", model: task.model, effort: "high" }) }; };
    runner.codex.startConversation = start;
    runner.deepseek.startConversation = start;
    const waitForDone = async () => {
      for (let index = 0; index < 50 && !stages.every((stage) => store.task(stage.id).status === "done"); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(stages.every((stage) => store.task(stage.id).status === "done"), true);
    };
    await runner.runTask(root.id);
    await waitForDone();
    assert.deepEqual(order, ["design", "implementation", "verification"]);

    // 需求变更：手动重跑已完成的设计阶段，实施与验证必须回到待执行并重新走一遍。
    await runner.runTask(stages[0].id);
    assert.equal(store.task(stages[1].id).status, "todo");
    assert.equal(store.task(stages[2].id).status, "todo");
    await waitForDone();
    assert.deepEqual(order, ["design", "implementation", "verification", "design", "implementation", "verification"]);
    assert.equal(store.task(root.id).status, "in_review");
  } finally {
    await runner.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("messages sent during execution run next from the task queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-message-queue-"));
  const store = new Store(directory);
  const runner = new Runner({ store, dataDirectory: directory, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  let finishFirst;
  const messages = [];
  runner.deepseek.startConversation = async ({ message }) => {
    messages.push(message);
    const completion = messages.length === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : Promise.resolve({ stopReason: "end_turn" });
    return { externalId: "session", turnId: "session", completion };
  };
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Queue", provider: "deepseek", model: "deepseek-flash", permission: "workspace-write" });
    await runner.runTask(task.id, "first");
    const queued = runner.queueTask(task.id, "second");
    assert.equal(queued.queued, true);
    assert.equal(store.taskDetail(task.id).events.some((event) => event.id === queued.eventId && event.type === "queued_message"), true);
    finishFirst({ stopReason: "end_turn" });
    for (let index = 0; index < 50 && (messages.length < 2 || store.task(task.id).status !== "in_review"); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(messages, ["first", "second"]);
    assert.equal(store.queuedMessage(task.id), null);
  } finally {
    await runner.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Deepseek intervention cancels the current turn and runs that queued message first", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-intervention-"));
  const store = new Store(directory);
  const runner = new Runner({ store, dataDirectory: directory, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  let finishFirst;
  const messages = [];
  runner.deepseek.startConversation = async ({ message }) => {
    messages.push(message);
    return { externalId: "session", turnId: "session", completion: messages.length === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : Promise.resolve({ stopReason: "end_turn" }) };
  };
  runner.deepseek.cancel = async () => finishFirst({ stopReason: "cancelled" });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Intervene", provider: "deepseek", model: "deepseek-flash", permission: "workspace-write" });
    await runner.runTask(task.id, "first");
    runner.queueTask(task.id, "later");
    const urgent = runner.queueTask(task.id, "urgent");
    await runner.guideQueued(task.id, urgent.eventId);
    for (let index = 0; index < 80 && (messages.length < 3 || store.task(task.id).status !== "in_review"); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(messages, ["first", "urgent", "later"]);
  } finally {
    await runner.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex streaming text stays in one assistant message", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-stream-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Stream", provider: "codex", permission: "workspace-write" });
    const conversation = store.conversation(task, "codex", null, null);
    const run = store.startRun(task.id, conversation.id);
    store.addEvent(task.id, run.id, { type: "message", role: "assistant", content: "你", raw: { method: "item/agentMessage/delta", params: { delta: "你" } } });
    store.addEvent(task.id, run.id, { type: "message", role: "assistant", content: "好", raw: { method: "item/agentMessage/delta", params: { delta: "好" } } });
    assert.deepEqual(store.taskDetail(task.id).events.filter((event) => event.role === "assistant").map((event) => event.content), ["你好"]);
    store.addEvent(task.id, run.id, { type: "message", role: "assistant", content: "你好。", raw: { method: "item/completed", params: { item: { type: "agentMessage", text: "你好。" } } } });
    assert.deepEqual(store.taskDetail(task.id).events.filter((event) => event.role === "assistant").map((event) => event.content), ["你好。"]);
    store.addEvent(task.id, run.id, { type: "message", role: "assistant", content: "结", raw: { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } } });
    store.addEvent(task.id, run.id, { type: "message", role: "assistant", content: "论", raw: { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } } });
    assert.deepEqual(store.taskDetail(task.id).events.filter((event) => event.role === "assistant").map((event) => event.content), ["你好。", "结论"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("project chats stay off the board and archives are paged", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-lists-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const chat = store.createChat({ projectId: project.id, provider: "codex", effort: "high", permission: "danger-full-access" });
    assert.equal(chat.kind, "chat");
    assert.equal(chat.number, -1);
    store.addEvent(chat.id, null, { type: "message", role: "user", content: "hello" });
    for (let index = 0; index < 22; index += 1) {
      const task = store.createStandalone({ projectId: project.id, title: index === 7 ? "Special archive" : `Archive ${index}`, provider: "codex", model: "gpt-test", permission: "workspace-write" });
      store.updateTask(task.id, { status: "done", archived: true, archived_at: new Date(Date.now() + index).toISOString() });
    }
    assert.equal(store.tasks(project.id, false).length, 0);
    assert.equal(store.recentChats(project.id)[0].id, chat.id);
    for (let index = 0; index < 10; index += 1) {
      const nextChat = store.createChat({ projectId: project.id, provider: "codex", permission: "danger-full-access" });
      store.addEvent(nextChat.id, null, { type: "message", role: "user", content: `chat ${index}` });
    }
    const firstChatPage = store.chatPage(project.id, 1);
    assert.equal(firstChatPage.items.length, 5);
    assert.equal(firstChatPage.totalPages, 3);
    assert.equal(store.chatPage(project.id, 3).items.length, 1);
    assert.ok(firstChatPage.items.every((item, index, items) => !index || item.updated_at <= items[index - 1].updated_at));
    assert.equal(store.archiveCount(project.id), 22);
    assert.equal(store.archivePage(project.id, 1).items.length, 20);
    assert.equal(store.archivePage(project.id, 2).items.length, 2);
    assert.equal(store.archivePage(project.id, 1).totalPages, 2);
    assert.equal(store.archivePage(project.id, 1, "Special").total, 1);
    assert.equal(store.archivePage(project.id, 1, "DEM-008").total, 1);
    assert.equal(store.createStandalone({ projectId: project.id, title: "Next", provider: "codex", permission: "workspace-write" }).number, 23);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads the model and effort actually recorded by Codex", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-codex-runtime-"));
  try {
    const sessions = path.join(directory, "sessions", "2026", "09", "13");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "rollout-thread-1.jsonl"), `${JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-actual", effort: "high" } })}\n`);
    assert.deepEqual(readCodexRuntime("thread-1", "turn-1", directory), { model: "gpt-actual", effort: "high" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reply language defaults to Chinese and is forwarded to every runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-language-"));
  const store = new Store(directory);
  const runner = new Runner({ store, dataDirectory: directory, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  const calls = [];
  const start = async (input) => {
    calls.push(input);
    return { externalId: `id-${calls.length}`, turnId: `turn-${calls.length}`, completion: Promise.resolve({ stopReason: "end_turn" }) };
  };
  runner.codex.startConversation = start;
  runner.deepseek.startConversation = start;
  const settled = async (count, taskId) => { for (let index = 0; index < 80 && (calls.length < count || runner.isTaskActive(taskId)); index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Lang", provider: "codex", permission: "workspace-write" });
    assert.equal(runner.language(), "zh-CN");
    assert.match(runner.languageInstruction(), /简体中文/);

    await runner.runTask(task.id, "你好");
    await settled(1, task.id);
    assert.match(calls[0].instructions, /简体中文/);
    assert.equal(store.taskDetail(task.id).events.find((event) => event.role === "user").content, "你好");

    runner.setLanguage("en");
    assert.match(runner.languageInstruction(), /English/);
    await runner.runTask(task.id, "hello");
    await settled(2, task.id);
    assert.match(calls[1].instructions, /English/);

    runner.setLanguage("auto");
    assert.equal(runner.languageInstruction(), "");
    store.setSetting("agent.language", "unsupported");
    assert.equal(runner.language(), "zh-CN");
  } finally {
    await runner.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtimes prepend the requested language instruction to the message", async () => {
  const codexCalls = [];
  const codex = new CodexRuntime({ mcp: { codex: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  codex.initialized = true;
  codex.rpc = { async request(method, params) { codexCalls.push({ method, params }); if (method === "thread/start") return { thread: { id: "thread" } }; if (method === "turn/start") return { turn: { id: "turn" } }; }, notify() {} };
  await codex.startConversation({ task: { id: "task", workspace: "/tmp", model: "gpt-test", permission: "workspace-write" }, conversation: { runId: "run" }, message: "hello", instructions: "请用中文" });
  const turn = codexCalls.find((call) => call.method === "turn/start").params;
  assert.equal(turn.input[0].text, "请用中文\n\nhello");

  const deepseekCalls = [];
  const configOptions = [{ id: "model", currentValue: '["deepseek","deepseek-flash"]', options: [{ value: '["deepseek","deepseek-flash"]', name: "Deepseek-V4.1-Flash" }] }];
  const deepseek = new DeepseekRuntime({ mcp: { deepseek: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  deepseek.pool = async () => ({ async request(method, params) {
    deepseekCalls.push({ method, params });
    if (method === "session/new") return { sessionId: "session", configOptions };
    if (method === "session/set_config_option") return { configOptions };
    return { stopReason: "end_turn" };
  } });
  await deepseek.startConversation({ task: { id: "task", workspace: "/tmp", model: null, permission: "workspace-write" }, conversation: { runId: "run" }, message: "hello", instructions: "请用中文" });
  assert.equal(deepseekCalls.find((call) => call.method === "session/prompt").params.prompt[0].text, "请用中文\n\nhello");
});

test("流程根任务状态按各阶段真实状态回算，不会停在执行中", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-flow-status-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const { root, stages } = store.createWorkflow({
      projectId: project.id, title: "Ship", permission: "workspace-write", autoExecute: false,
      stages: [
        { provider: "codex", phase: "design" },
        { provider: "deepseek", phase: "implementation" },
        { provider: "codex", phase: "verification" },
      ],
    });
    const runStage = (stage, status = "completed") => {
      const conversation = store.conversation(stage, stage.provider, null, null);
      const run = store.startRun(stage.id, conversation.id);
      return store.finishRun(run.id, status);
    };

    runStage(stages[0]);
    assert.equal(store.task(root.id).status, "running");
    runStage(stages[1]);
    assert.equal(store.task(root.id).status, "in_review");
    runStage(stages[2], "failed");
    assert.equal(store.task(stages[2].id).status, "blocked");
    assert.equal(store.task(root.id).status, "blocked");

    // 重跑已完成的设计阶段：推进要跳过已完成的实施，根任务也不能停在执行中。
    runStage(stages[0]);
    assert.equal(store.task(stages[0].id).status, "done");
    assert.equal(store.task(root.id).status, "blocked");
    assert.equal(store.task(root.id).progress, 67);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench member list falls back to defaults and parses stored value", () => {
  assert.deepEqual(parseWorkbenchMembers(""), []);
  assert.deepEqual(parseWorkbenchMembers("not json"), []);
  assert.deepEqual(parseWorkbenchMembers(JSON.stringify([" boss ", "boss", "other-user"])), ["boss", "other-user"]);
});

test("workbench remove archives the external task and treats 404 as success", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-remove-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  const calls = [];
  try {
    sync.request = async (method, pathname, body) => { calls.push({ method, pathname, body }); return { ok: true }; };
    await sync.remove("dt_1");
    assert.deepEqual(calls[0], { method: "POST", pathname: "/api/dev/tasks/dt_1/archive", body: undefined });
    // 已经不存在（404）视为删除成功，避免本地任务永远删不掉。
    sync.request = async () => { throw new Error("工作台连接失败（404）"); };
    await sync.remove("dt_missing");
    sync.request = async () => { throw new Error("工作台连接失败（500）"); };
    await assert.rejects(() => sync.remove("dt_2"), /500/);
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench assign patches assignee for a linked task", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-assign-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  const calls = [];
  try {
    sync.request = async (method, pathname, body) => { calls.push({ method, pathname, body }); return { ok: true }; };
    await sync.assign("dt_9", "boss");
    assert.deepEqual(calls[0], { method: "PATCH", pathname: "/api/dev/tasks/dt_9", body: { assignee: "boss" } });
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench pull imports assigned issues and keeps them out of task sync", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-issue-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    store.setSetting("workbench.projectId", project.id);
    const routes = async (method, pathname) => {
      if (pathname === "/api/dev/me") return { username: "example-user", persona: "示例用户" };
      if (pathname === "/api/dev/issues") return { issues: [
        { id: "bug_confirmed", title: "示例更新问题", status: "confirmed", status_label: "已确认", module: "更新", severity: "P1", assignee: "example-user", task_id: null, steps: "示例复现步骤" },
        { id: "bug_fixing", title: "示例功能加载失败", status: "fixing", status_label: "修复中", assignee: "示例用户", task_id: null },
        { id: "bug_passed", title: "已测试通过", status: "passed", assignee: "example-user", task_id: null },
        { id: "bug_new", title: "未指派的问题", status: "new", assignee: "", task_id: null },
        { id: "bug_other", title: "别人的问题", status: "confirmed", assignee: "other-user", task_id: null },
        { id: "bug_converted", title: "已转任务的问题", status: "confirmed", assignee: "example-user", task_id: "dt_x" },
      ] };
      return { tasks: [] };
    };
    sync.request = routes;
    const result = await sync.pullBound();
    assert.equal(result.issues, 1);
    assert.equal(result.created, 1);
    // 只有「已确认」的问题会新建本地任务；fixing / passed / new 都不拉。
    assert.equal(store.workbenchTaskByExternal("bug_fixing"), null);
    const confirmed = store.workbenchTaskByExternal("bug_confirmed");
    assert.ok(confirmed);
    assert.equal(confirmed.title, "示例更新问题");
    assert.match(confirmed.description, /来源：Lo查查工作台问题（bug_confirmed）/);
    assert.match(confirmed.description, /模块：更新/);
    assert.match(confirmed.description, /复现步骤：/);
    // 问题关联必须带 issue 类型，否则任务同步会拿 bug_xxx 去 PATCH /api/dev/tasks。
    assert.deepEqual(store.workbenchLinks(confirmed.id), [{ external_id: "bug_confirmed", external_kind: "issue" }]);
    // 刚拉取时本地状态与开发台一致，不需要回写。
    assert.equal(store.pendingWorkbenchSync().length, 0);
    // 本地进入执行中，要把开发台问题改成「修复中」，且必须走 /issues 而不是 /tasks。
    const patches = [];
    sync.request = async (method, pathname, body) => { patches.push({ method, pathname, body }); return { ok: true }; };
    store.updateTask(confirmed.id, { status: "running" });
    assert.equal(store.pendingWorkbenchSync().length, 1);
    await sync.sync();
    assert.deepEqual(patches, [{ method: "PATCH", pathname: "/api/dev/issues/bug_confirmed", body: { status: "fixing" } }]);
    assert.equal(store.pendingWorkbenchSync().length, 0);
    // 状态没再变化时不重复回写。
    await sync.sync();
    assert.equal(patches.length, 1);
    // 阻塞不回写：开发台保持「修复中」，不会被改成别的状态。
    store.updateTask(confirmed.id, { status: "blocked" });
    await sync.sync();
    assert.equal(patches.length, 1);
    // 再次拉取不重复建单。
    sync.request = routes;
    const again = await sync.pullBound();
    assert.equal(again.created, 0);
    assert.equal(again.issues, 0);
    assert.equal(store.tasks(project.id).filter((item) => item.title === "示例更新问题").length, 1);
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench reopens a rejected issue and surfaces the failure note", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-reject-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    store.setSetting("workbench.projectId", project.id);
    let issueStatus = "confirmed";
    let timeline = [];
    sync.request = async (method, pathname) => {
      if (pathname === "/api/dev/me") return { username: "example-user", persona: "示例用户" };
      if (pathname === "/api/dev/issues") return { issues: [
        { id: "bug_rework", title: "搜索不明确", status: issueStatus, status_label: "已确认", assignee: "example-user", task_id: null, timeline },
      ] };
      return { tasks: [] };
    };
    await sync.pullBound();
    const task = store.workbenchTaskByExternal("bug_rework");
    assert.ok(task);
    store.updateTask(task.id, { status: "done" });
    // 开发台把问题测试打回：本地任务重新打开为待处理，并把打回说明写进描述。
    issueStatus = "rejected";
    timeline = [{ id: "ie_1", at: "2026-09-19T16:00:00+08:00", by: "邵莉", action: "更新问题", text: "状态：待测试 → 测试打回" }];
    const result = await sync.pullBound();
    assert.equal(result.reopened, 1);
    const reopened = store.task(task.id);
    assert.equal(reopened.status, "todo");
    assert.match(reopened.description, /【测试不通过】/);
    assert.match(reopened.description, /邵莉/);
    // 回流时已把本地状态对齐成待处理，不会再回写把「测试打回」改成「已确认」。
    assert.equal(store.pendingWorkbenchSync().length, 0);
    // 再拉一次不会重复追加打回说明。
    const again = await sync.pullBound();
    assert.equal(again.reopened, 0);
    assert.equal(store.task(task.id).description.split("【测试不通过】").length - 1, 1);
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dismissed workbench issues are not pulled again", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-dismiss-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    store.setSetting("workbench.projectId", project.id);
    store.dismissWorkbenchIssues(["bug_gone"]);
    assert.deepEqual(store.workbenchDismissedIssues(), ["bug_gone"]);
    sync.request = async (method, pathname) => {
      if (pathname === "/api/dev/me") return { username: "example-user", persona: "示例用户" };
      if (pathname === "/api/dev/issues") return { issues: [
        { id: "bug_gone", title: "删掉的问题", status: "confirmed", assignee: "example-user", task_id: null },
      ] };
      return { tasks: [] };
    };
    const result = await sync.pullBound();
    assert.equal(result.issues, 0);
    assert.equal(result.created, 0);
    assert.equal(store.workbenchTaskByExternal("bug_gone"), null);
    // 恢复后从忽略列表移除，下一次拉取会重新带入。
    const restored = store.restoreWorkbenchIssues(["bug_gone"]);
    assert.deepEqual(restored.dismissed, []);
    assert.deepEqual(store.workbenchDismissedIssues(), []);
    const retry = await sync.pullBound();
    assert.equal(retry.issues, 1);
    assert.equal(retry.created, 1);
    assert.ok(store.workbenchTaskByExternal("bug_gone"));
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench assign patches issues through the issue endpoint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-assign-issue-"));
  const store = new Store(directory);
  const sync = new WorkbenchSync({ store, readKey: async () => "test-key" });
  const calls = [];
  try {
    sync.request = async (method, pathname, body) => { calls.push({ method, pathname, body }); return { ok: true }; };
    await sync.assign("bug_1", "boss", "issue");
    assert.deepEqual(calls[0], { method: "PATCH", pathname: "/api/dev/issues/bug_1", body: { assignee: "boss" } });
    await sync.assign("dt_1", "boss");
    assert.deepEqual(calls[1], { method: "PATCH", pathname: "/api/dev/tasks/dt_1", body: { assignee: "boss" } });
  } finally {
    sync.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workbench external ids cover the task tree and skip unlinked tasks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workbench-ids-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const linked = store.createStandalone({ projectId: project.id, title: "linked", permission: "workspace-write" });
    store.enableWorkbenchSync(linked.id);
    store.markWorkbenchSync(linked.id, { externalId: "dt_tree", status: "todo" });
    assert.deepEqual(store.workbenchExternalIds(linked.id), ["dt_tree"]);
    const plain = store.createStandalone({ projectId: project.id, title: "plain", permission: "workspace-write" });
    assert.deepEqual(store.workbenchExternalIds(plain.id), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Deepseek 会话跟随工作目录切换，不再复用其它目录的外部会话", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-workspace-session-"));
  const store = new Store(directory);
  try {
    const project = store.createProject({ name: "Demo", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Ws", provider: "deepseek", permission: "workspace-write" });
    const worktree = path.join(directory, "worktrees", "wt");

    const inWorktree = store.conversation(task, "deepseek", null, null, "account-a", worktree);
    assert.equal(inWorktree.workspace, worktree);
    store.setConversationExternal(inWorktree.id, "session-in-worktree", null);

    // 同一个工作目录：继续复用，保留上下文。
    const same = store.conversation(task, "deepseek", null, null, "account-a", worktree);
    assert.equal(same.id, inWorktree.id);
    assert.equal(same.external_id, "session-in-worktree");

    // 关掉 Worktree 回到项目目录：必须换新会话，否则 harness 会拒绝续接。
    const direct = store.conversation(task, "deepseek", null, null, "account-a", directory);
    assert.notEqual(direct.id, inWorktree.id);
    assert.equal(direct.external_id, null);
    assert.equal(direct.workspace, directory);

    // 切回 Worktree 时优先复用工作目录一致的旧会话，避免白白丢上下文。
    const back = store.conversation(task, "deepseek", null, null, "account-a", worktree);
    assert.equal(back.id, inWorktree.id);
    assert.equal(back.external_id, "session-in-worktree");

    // 换账号仍然不能复用别人的会话。
    const otherAccount = store.conversation(task, "deepseek", null, null, "account-b", worktree);
    assert.notEqual(otherAccount.id, inWorktree.id);
    assert.equal(otherAccount.external_id, null);
    assert.equal(otherAccount.account_id, "account-b");

    // Codex 不绑定工作目录，保持原来的单会话复用行为。
    const codexFirst = store.conversation(task, "codex", null, null, null, worktree);
    const codexSecond = store.conversation(task, "codex", null, null, null, directory);
    assert.equal(codexSecond.id, codexFirst.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Deepseek resume 报工作目录不匹配时自动新建会话而不是失败", async () => {
  const calls = [];
  const configOptions = [{ id: "model", currentValue: '["deepseek","deepseek-flash"]', options: [{ value: '["deepseek","deepseek-flash"]', name: "Deepseek-V4.1-Flash" }] }];
  const runtime = new DeepseekRuntime({ mcp: { deepseek: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  runtime.pool = async () => ({ async request(method) {
    calls.push(method);
    if (method === "session/resume") throw new Error("Invalid params: session cwd does not match: /Users/demo/loquery");
    if (method === "session/new") return { sessionId: "session-new", configOptions };
    if (method === "session/set_config_option") return { configOptions };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  } });
  const started = await runtime.startConversation({
    task: { id: "task", workspace: "/Users/demo/loquery", model: null, permission: "danger-full-access" },
    conversation: { runId: "run", external_id: "session-old" },
    message: "hello",
  });
  assert.equal(started.restarted, true);
  assert.equal(started.externalId, "session-new");
  assert.deepEqual(calls, ["session/resume", "session/new", "session/set_config_option", "session/prompt"]);
});

test("Deepseek 内存中的会话换了工作目录后直接新建，不再命中旧目录", async () => {
  const calls = [];
  const configOptions = [{ id: "model", currentValue: '["deepseek","deepseek-flash"]', options: [{ value: '["deepseek","deepseek-flash"]', name: "Deepseek-V4.1-Flash" }] }];
  const runtime = new DeepseekRuntime({ mcp: { deepseek: () => ({}) }, onEvent() {}, onApproval() {}, onExit() {} });
  const rpc = { async request(method) {
    calls.push(method);
    if (method === "session/new") return { sessionId: `session-${calls.length}`, configOptions };
    if (method === "session/set_config_option") return { configOptions };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  } };
  runtime.pool = async () => rpc;
  const task = { id: "task", workspace: "/a", model: null, permission: "danger-full-access" };
  const first = await runtime.startConversation({ task, conversation: { runId: "run-1" }, message: "one" });
  const second = await runtime.startConversation({ task: { ...task, workspace: "/b" }, conversation: { runId: "run-2", external_id: first.externalId }, message: "two" });
  assert.equal(second.restarted, true);
  assert.notEqual(second.externalId, first.externalId);
  assert.equal(calls.includes("session/resume"), false);
});

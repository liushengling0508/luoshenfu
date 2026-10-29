import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/database.mjs";
import { Runner } from "../server/runner.mjs";
import { WorktreeManager, resolveWorktreeMode } from "../server/worktree.mjs";
import { fileDiff, inspectChanges, inspectRangeChanges, parseNumstatZ, parseStatusZ, restoreFiles } from "../server/git.mjs";
import { createRedactor, sanitizeLogText } from "../server/redact.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "洛神赋测试",
  GIT_AUTHOR_EMAIL: "test@luoshenfu.local",
  GIT_COMMITTER_NAME: "洛神赋测试",
  GIT_COMMITTER_EMAIL: "test@luoshenfu.local",
};

function git(cwd, args) {
  return execFileSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
}

async function tempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function gitProject(root, name = "project") {
  const project = path.join(root, name);
  await mkdir(project, { recursive: true });
  git(project, ["init", "-q"]);
  await writeFile(path.join(project, "a.txt"), "one\n");
  await writeFile(path.join(project, "b.txt"), "keep\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-q", "-m", "base"]);
  return project;
}

async function listing(directory) {
  return (await readdir(directory)).sort();
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

test("旧版本数据库可平滑迁移并保留原有数据", async () => {
  const directory = await tempRoot("luoshenfu-migrate-");
  const file = path.join(directory, "luoshenfu.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, project_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, phase TEXT NOT NULL, provider TEXT, model TEXT, reasoning_effort TEXT, permission TEXT NOT NULL, parent_id TEXT, root_id TEXT, sequence_index INTEGER, is_root INTEGER NOT NULL DEFAULT 0, auto_execute INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, external_turn_id TEXT, status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, ended_at TEXT, actual_model TEXT, actual_effort TEXT);
  `);
  legacy.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run("p1", "旧项目", "/tmp", "2020", "2020");
  legacy.prepare("INSERT INTO tasks (id,number,project_id,title,status,phase,permission,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("t1", 1, "p1", "旧任务", "todo", "standalone", "workspace-write", "2020", "2020");
  legacy.close();
  const store = new Store(directory, { secrets: [] });
  try {
    assert.equal(store.task("t1").title, "旧任务");
    assert.equal(store.task("t1").worktree_status, null);
    const runColumns = new Set(store.db.prepare("PRAGMA table_info(runs)").all().map((column) => column.name));
    assert.ok(runColumns.has("interrupt_reason") && runColumns.has("last_event_seq") && runColumns.has("resume_kind"));
    const taskColumns = new Set(store.db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
    assert.ok(taskColumns.has("worktree_path") && taskColumns.has("base_commit"));
    assert.equal(store.activities().items.length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Worktree 为每个根任务创建独立工作树且不污染原项目", async () => {
  const root = await tempRoot("luoshenfu-wt-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: ["launch-token"] });
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const first = store.createStandalone({ projectId: p.id, title: "First", provider: "codex", permission: "workspace-write" });
    const second = store.createStandalone({ projectId: p.id, title: "Second", provider: "codex", permission: "workspace-write" });
    const manager = new WorktreeManager({ store, dataDirectory: data });
    const infoA = await manager.prepare(store.task(first.id));
    const infoB = await manager.prepare(store.task(second.id));
    assert.equal(infoA.status, "active");
    assert.equal(infoB.status, "active");
    assert.notEqual(infoA.path, infoB.path);
    assert.match(infoA.branch, /^luoshenfu\/task-\d+-[0-9a-f]{8}$/);
    assert.ok(path.resolve(infoA.path).startsWith(path.resolve(data) + path.sep));
    assert.deepEqual(await listing(infoA.path), [".git", "a.txt", "b.txt"]);

    // 工作树内写入不会出现在原项目
    await writeFile(path.join(infoA.path, "a.txt"), "one\nchanged\n");
    await writeFile(path.join(infoA.path, "new.txt"), "new\n");
    assert.equal(await readFile(path.join(project, "a.txt"), "utf8"), "one\n");
    assert.equal(await exists(path.join(project, "new.txt")), false);

    // 复用：同一任务再次 prepare 不新建
    const again = await manager.prepare(store.task(first.id));
    assert.equal(again.path, infoA.path);
    const worktrees = git(project, ["worktree", "list", "--porcelain"]);
    assert.equal((worktrees.match(/^worktree /gm) || []).length, 3); // 原项目 + 两个任务

    // 含变更的工作树拒绝删除
    await assert.rejects(manager.remove(store.task(first.id)), /未撤销的变更/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("流程任务的设计、实施、验证复用同一个 Worktree", async () => {
  const root = await tempRoot("luoshenfu-wt-flow-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const { root: flow, stages } = store.createWorkflow({
      projectId: p.id, title: "Ship", permission: "workspace-write", autoExecute: false,
      stages: [{ provider: "codex", phase: "design" }, { provider: "deepseek", phase: "implementation" }, { provider: "codex", phase: "verification" }],
    });
    const manager = new WorktreeManager({ store, dataDirectory: data });
    const rootInfo = await manager.prepare(store.task(flow.id));
    const paths = [];
    for (const stage of stages) {
      const info = await manager.prepare(store.task(stage.id));
      paths.push(info.path);
      assert.equal(manager.workspaceFor(store.taskDetail(stage.id)), rootInfo.path);
    }
    assert.deepEqual(new Set([rootInfo.path, ...paths]).size, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("非 Git 项目与没有 HEAD 的仓库安全降级", async () => {
  const root = await tempRoot("luoshenfu-wt-degrade-");
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  try {
    const plain = path.join(root, "plain");
    await mkdir(plain, { recursive: true });
    const p1 = store.createProject({ name: "Plain", workspace: plain });
    const t1 = store.createStandalone({ projectId: p1.id, title: "Plain", permission: "workspace-write" });
    const manager = new WorktreeManager({ store, dataDirectory: data });
    const degraded = await manager.prepare(store.task(t1.id));
    assert.equal(degraded.status, "unavailable");
    assert.match(degraded.note, /不是 Git 仓库/);
    assert.equal(manager.workspaceFor(store.taskDetail(t1.id)), plain);

    const empty = path.join(root, "empty");
    await mkdir(empty, { recursive: true });
    git(empty, ["init", "-q"]);
    const p2 = store.createProject({ name: "Empty", workspace: empty });
    const t2 = store.createStandalone({ projectId: p2.id, title: "Empty", permission: "workspace-write" });
    const noHead = await manager.prepare(store.task(t2.id));
    assert.equal(noHead.status, "unavailable");
    assert.match(noHead.note, /HEAD/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Git 状态解析、Diff 与安全撤销（含未跟踪文件回收）", async () => {
  const root = await tempRoot("luoshenfu-git-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const task = store.createStandalone({ projectId: p.id, title: "Changes", permission: "workspace-write" });
    const manager = new WorktreeManager({ store, dataDirectory: data });
    const info = await manager.prepare(store.task(task.id));
    const worktree = info.path;

    await writeFile(path.join(worktree, "a.txt"), "one\nmodified\n");
    await writeFile(path.join(worktree, "added-tracked.txt"), "tracked add\n");
    git(worktree, ["add", "added-tracked.txt"]);
    await writeFile(path.join(worktree, "untracked.txt"), "untracked\n");
    await rm(path.join(worktree, "b.txt"));

    const changes = await inspectChanges(worktree, info.baseCommit);
    assert.equal(changes.available, true);
    const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]));
    assert.equal(byPath["a.txt"].status, "modified");
    assert.equal(byPath["a.txt"].unstaged, true);
    assert.equal(byPath["added-tracked.txt"].status, "added");
    assert.equal(byPath["added-tracked.txt"].staged, true);
    assert.equal(byPath["untracked.txt"].status, "untracked");
    assert.equal(byPath["untracked.txt"].additions, 1);
    assert.equal(byPath["b.txt"].status, "deleted");

    const diff = await fileDiff(worktree, info.baseCommit, "a.txt");
    assert.equal(diff.tracked, true);
    assert.match(diff.diff, /\+modified/);
    const untrackedDiff = await fileDiff(worktree, info.baseCommit, "untracked.txt");
    assert.equal(untrackedDiff.tracked, false);
    assert.match(untrackedDiff.diff, /\+untracked/);
    // 未跟踪文件的 Diff 必须显示相对路径，而不是又长又乱的绝对路径。
    assert.match(untrackedDiff.diff, /a\/untracked\.txt b\/untracked\.txt/);
    assert.equal(untrackedDiff.diff.includes(worktree), false);

    // 路径穿越必须被拒绝
    await assert.rejects(fileDiff(worktree, info.baseCommit, "../outside.txt"), /不在任务工作区内/);

    const recycleRoot = path.join(data, "recycle");
    const restored = await restoreFiles(worktree, info.baseCommit, ["a.txt", "b.txt"], { recycleRoot, taskId: task.id });
    assert.deepEqual(restored.map((item) => item.action), ["restored", "restored"]);
    assert.equal(await readFile(path.join(worktree, "a.txt"), "utf8"), "one\n");
    assert.equal(await readFile(path.join(worktree, "b.txt"), "utf8"), "keep\n");

    const staged = await restoreFiles(worktree, info.baseCommit, ["added-tracked.txt"], { recycleRoot, taskId: task.id });
    assert.equal(staged[0].action, "removed");
    assert.equal(await exists(path.join(worktree, "added-tracked.txt")), false);

    const recycled = await restoreFiles(worktree, info.baseCommit, ["untracked.txt"], { recycleRoot, taskId: task.id });
    assert.equal(recycled[0].action, "recycled");
    assert.equal(await exists(path.join(worktree, "untracked.txt")), false);
    assert.equal(await readFile(recycled[0].recoveredTo, "utf8"), "untracked\n");

    const after = await inspectChanges(worktree, info.baseCommit);
    assert.deepEqual(after.files, []);
    // 干净后允许移除
    assert.equal((await manager.remove(store.task(task.id))).status, "removed");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("状态与 numstat 的 NUL 解析保持稳定", () => {
  const status = parseStatusZ(" M a.txt\0A  b.txt\0?? c.txt\0");
  assert.deepEqual(status.map((entry) => [entry.index, entry.worktree, entry.path]), [[" ", "M", "a.txt"], ["A", " ", "b.txt"], ["?", "?", "c.txt"]]);
  const stats = parseNumstatZ("3\t1\ta.txt\0-\t-\timage.png\0");
  assert.deepEqual(stats.get("a.txt"), { additions: 3, deletions: 1, binary: false });
  assert.equal(stats.get("image.png").binary, true);
});

test("执行日志脱敏、二进制与超大内容安全表示、按游标分页", async () => {
  const directory = await tempRoot("luoshenfu-logs-");
  const store = new Store(directory, { secrets: ["launch-token-abcdef"] });
  try {
    const project = store.createProject({ name: "P", workspace: directory });
    const task = store.createStandalone({ projectId: project.id, title: "Logs", permission: "workspace-write" });
    const secretLog = store.addLog({ taskId: task.id, stream: "stderr", text: "Authorization: Bearer launch-token-abcdef\nDEEPSEEK_API_KEY=sk-abcdef123456\n完成" });
    assert.ok(secretLog);
    const page = store.logPage(task.id, {});
    assert.equal(page.items.length, 1);
    assert.ok(page.items[0].text.includes("[已脱敏]"));
    assert.equal(page.items[0].text.includes("sk-abcdef123456"), false);
    assert.equal(page.items[0].text.includes("launch-token-abcdef"), false);
    assert.equal(page.items[0].redacted, 1);

    store.addLog({ taskId: task.id, stream: "system", text: "a\u0000b" });
    store.addLog({ taskId: task.id, stream: "stdout", text: "x".repeat(6000) });
    const all = store.logPage(task.id, {});
    assert.match(all.items[1].text, /二进制/);
    assert.match(all.items[2].text, /本行过长已截断/);

    for (let index = 0; index < 10; index += 1) store.addLog({ taskId: task.id, stream: "stdout", text: `line-${index}` });
    const tail = store.logPage(task.id, { limit: 3 });
    assert.deepEqual(tail.items.map((item) => item.text), ["line-7", "line-8", "line-9"]);
    assert.equal(tail.hasMore, true);
    const older = store.logPage(task.id, { before: tail.oldest, limit: 3 });
    assert.deepEqual(older.items.map((item) => item.text), ["line-4", "line-5", "line-6"]);
    store.addLog({ taskId: task.id, stream: "stdout", text: "line-10" });
    const newer = store.logPage(task.id, { after: tail.newest });
    assert.deepEqual(newer.items.map((item) => item.text), ["line-10"]);

    const filtered = store.logPage(task.id, { streams: ["stderr"] });
    assert.equal(filtered.items.every((item) => item.stream === "stderr"), true);
    const searched = store.logPage(task.id, { query: "line-9" });
    assert.deepEqual(searched.items.map((item) => item.text), ["line-9"]);

    for (let index = 0; index < 3000; index += 1) store.addLog({ taskId: task.id, stream: index % 2 ? "stderr" : "stdout", text: `bulk-${index}` });
    const started = Date.now();
    const bulk = store.logPage(task.id, { limit: 300 });
    assert.equal(bulk.items.length, 300);
    assert.equal(bulk.items.at(-1).text, "bulk-2999");
    assert.ok(bulk.total >= 3000);
    assert.ok(Date.now() - started < 2000, "分页查询应保持快速");
    const ascending = bulk.items.every((item, index) => !index || item.seq > bulk.items[index - 1].seq);
    assert.equal(ascending, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("脱敏工具覆盖常见密钥与环境变量赋值", () => {
  const redactor = createRedactor({ secrets: ["custom-secret-value"] });
  const output = redactor.text("token=custom-secret-value\nAuthorization: Bearer abc123\nPASSWORD: hunter2\nsk-1234567890");
  assert.equal(output.includes("custom-secret-value"), false);
  assert.equal(output.includes("abc123"), false);
  assert.equal(output.includes("hunter2"), false);
  assert.equal(output.includes("sk-1234567890"), false);
  assert.match(sanitizeLogText("ok"), /^ok$/);
});

test("活动去重、已读与重启后的中断识别、审批失效", async () => {
  const root = await tempRoot("luoshenfu-recovery-");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  let store = new Store(data, { secrets: [] });
  let taskId;
  let approvalId;
  try {
    const project = store.createProject({ name: "P", workspace });
    const task = store.createStandalone({ projectId: project.id, title: "Recover", provider: "codex", permission: "workspace-write" });
    taskId = task.id;
    const conversation = store.conversation(task, "codex", null, null);
    const run = store.startRun(task.id, conversation.id);
    const approval = store.createApproval({ taskId: task.id, runId: run.id, provider: "codex", externalRequestId: "req-1", title: "允许？", detail: "{}", options: [] });
    approvalId = approval.id;

    const first = store.addActivity({ projectId: project.id, taskId: task.id, type: "task.completed", title: "完成", dedupeKey: `dup-${task.id}` });
    assert.ok(first);
    assert.equal(store.addActivity({ projectId: project.id, taskId: task.id, type: "task.completed", title: "完成", dedupeKey: `dup-${task.id}` }), null);
    assert.ok(store.addActivity({ projectId: project.id, taskId: task.id, type: "task.completed", title: "完成", dedupeKey: `dup2-${task.id}` }));
    assert.ok(store.unreadActivityCount() >= 2);
    store.readAllActivities();
    assert.equal(store.unreadActivityCount(), 0);
    // 清空已读只删除已读记录，未读活动必须保留。
    const keptUnread = store.addActivity({ projectId: project.id, taskId: task.id, type: "task.completed", title: "未读活动", dedupeKey: `keep-${task.id}` });
    const droppedRead = store.addActivity({ projectId: project.id, taskId: task.id, type: "task.completed", title: "已读活动", dedupeKey: `drop-${task.id}` });
    store.readActivity(droppedRead.id);
    assert.ok(store.clearReadActivities() >= 1);
    const remaining = store.activities().items;
    assert.equal(remaining.some((item) => item.id === droppedRead.id), false);
    assert.equal(remaining.some((item) => item.id === keptUnread.id), true);
    assert.ok(store.unreadActivityCount() >= 1);
    store.close();

    // 重启：遗留 running 变为 interrupted，任务标记阻塞，审批失效，并生成可恢复活动
    store = new Store(data, { secrets: [] });
    assert.equal(store.run(run.id).status, "interrupted");
    assert.match(store.run(run.id).interrupt_reason, /重启/);
    assert.equal(store.task(taskId).status, "blocked");
    assert.equal(store.approval(approvalId).status, "expired");
    const detail = store.taskDetail(taskId);
    assert.equal(detail.approvals.some((item) => item.id === approvalId && item.status === "expired"), true);
    assert.equal(store.activities().items.some((item) => item.type === "task.interrupted"), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("继续任务复用原会话且快速重复点击只启动一个进程", async () => {
  const root = await tempRoot("luoshenfu-resume-");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  let store = new Store(data, { secrets: [] });
  const runnerRef = { current: null };
  try {
    const project = store.createProject({ name: "P", workspace });
    const task = store.createStandalone({ projectId: project.id, title: "Resume", provider: "codex", permission: "workspace-write" });
    const conversation = store.conversation(task, "codex", null, null);
    store.setConversationExternal(conversation.id, "thread-1");
    store.startRun(task.id, conversation.id);
    store.close();
    store = new Store(data, { secrets: [] });

    const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
    runnerRef.current = runner;
    let starts = 0;
    let finish;
    runner.codex.startConversation = async () => {
      starts += 1;
      return { externalId: "thread-1", turnId: `turn-${starts}`, completion: new Promise((resolve) => { finish = resolve; }) };
    };
    const [settledA, settledB] = await Promise.allSettled([runner.resumeTask(task.id), runner.resumeTask(task.id)]);
    assert.equal([settledA, settledB].filter((item) => item.status === "fulfilled").length, 1);
    assert.equal([settledA, settledB].filter((item) => item.status === "rejected").length, 1);
    for (let index = 0; index < 50 && starts < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(starts, 1);
    const runs = store.db.prepare("SELECT * FROM runs WHERE task_id=? ORDER BY started_at").all(task.id);
    assert.equal(runs.filter((run) => run.status === "running").length, 1);
    assert.equal(runs.at(-1).resume_kind, "session");
    finish?.({ stopReason: "end_turn" });
    for (let index = 0; index < 50 && store.task(task.id).status !== "in_review"; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await runnerRef.current?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("删除任务时含变更的 Worktree 被保留，干净 Worktree 被移除", async () => {
  const root = await tempRoot("luoshenfu-release-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const task = store.createStandalone({ projectId: p.id, title: "Release", provider: "codex", permission: "workspace-write" });
    const info = await runner.prepareWorktree(task.id);
    assert.equal(info.status, "active");
    await writeFile(path.join(info.path, "a.txt"), "changed\n");
    const preserved = await runner.releaseWorktree(task.id);
    assert.equal(preserved.status, "preserved");
    assert.equal(await exists(info.path), true);

    await restoreFiles(info.path, info.baseCommit, ["a.txt"], { recycleRoot: path.join(data, "recycle"), taskId: task.id });
    const removed = await runner.releaseWorktree(task.id);
    assert.equal(removed.status, "removed");
    assert.equal(await exists(info.path), false);
  } finally {
    await runner.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("无外部会话时继续任务会生成安全的重新续跑提示", async () => {
  const root = await tempRoot("luoshenfu-rerun-");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  try {
    const store = new Store(data, { secrets: [] });
    const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
    try {
      const project = store.createProject({ name: "P", workspace });
      const task = store.createStandalone({ projectId: project.id, title: "Rerun", provider: "deepseek", permission: "workspace-write" });
      const conversation = store.conversation(task, "deepseek", null, null);
      const run = store.startRun(task.id, conversation.id);
      store.interruptRun(run.id, "服务重启");
      let captured = "";
      runner.deepseek.startConversation = async ({ message }) => { captured = message; return { externalId: "s", turnId: "s", completion: Promise.resolve({ stopReason: "end_turn" }) }; };
      const result = await runner.resumeTask(task.id);
      assert.equal(result.resumeKind, "rerun");
      for (let index = 0; index < 50 && !captured; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(captured, /重新续跑/);
      assert.match(captured, /不要重复执行可能产生副作用的命令/);
    } finally { await runner.close(); store.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("服务重启只接管已退出进程的执行，不误伤仍在运行的其它实例", async () => {
  const root = await tempRoot("luoshenfu-reconcile-");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    let store = new Store(data, { secrets: [] });
    const project = store.createProject({ name: "P", workspace });
    const task = store.createStandalone({ projectId: project.id, title: "Live", provider: "deepseek", permission: "workspace-write" });
    const conversation = store.conversation(task, "deepseek", null, null);
    const run = store.startRun(task.id, conversation.id);
    // 伪装成另一个仍在运行的洛神赋实例创建了该 run。
    store.db.prepare("UPDATE runs SET owner_pid=? WHERE id=?").run(alive.pid, run.id);
    store.close();

    // 新服务实例启动时不能接管这条执行。
    store = new Store(data, { secrets: [] });
    assert.equal(store.run(run.id).status, "running");
    assert.equal(store.task(task.id).status, "running");
    assert.equal(store.taskDetail(task.id).active_run_started_at, run.started_at);
    store.close();
  } finally {
    alive.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("其它实例误标 run 后，续跑中的消息仍进入队列并自愈执行状态", async () => {
  const root = await tempRoot("luoshenfu-orphan-");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = new Store(data, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  try {
    const project = store.createProject({ name: "P", workspace });
    const task = store.createStandalone({ projectId: project.id, title: "Orphan", provider: "deepseek", permission: "workspace-write" });
    const conversation = store.conversation(task, "deepseek", null, null);
    const run = store.startRun(task.id, conversation.id);
    // 本进程正在执行，但另一个实例把这条 run 误标为“服务重启后中断”。
    runner.active.set(task.id, { runtime: runner.deepseek, runId: run.id, externalId: null, turnId: null, permission: task.permission });
    store.interruptRun(run.id, "服务重启");
    assert.equal(store.run(run.id).status, "interrupted");
    assert.equal(runner.activeRunInfo(task.id).active, true);

    const queued = runner.queueTask(task.id, "运行中追加的消息");
    assert.equal(queued.queued, true);
    assert.equal(store.run(run.id).status, "running");
    assert.equal(store.run(run.id).interrupt_reason, null);
    const event = store.taskDetail(task.id).events.find((item) => item.type === "queued_message");
    assert.equal(event?.content, "运行中追加的消息");
  } finally { await runner.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Worktree 模式解析：任务级选择优先，其次全局默认", () => {
  assert.equal(resolveWorktreeMode(undefined, true), "isolate");
  assert.equal(resolveWorktreeMode(undefined, false), "direct");
  assert.equal(resolveWorktreeMode(true, false), "isolate");
  assert.equal(resolveWorktreeMode(false, true), "direct");
});

test("全局关闭隔离时任务默认直接使用原项目目录，任务级可覆盖", async () => {
  const root = await tempRoot("luoshenfu-mode-default-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  try {
    store.setSetting("worktree.enabled", "false");
    const p = store.createProject({ name: "P", workspace: project });
    const direct = store.createStandalone({ projectId: p.id, title: "Direct", provider: "codex", permission: "workspace-write", worktreeMode: resolveWorktreeMode(undefined, false) });
    assert.equal(direct.worktree_mode, "direct");
    const directInfo = await runner.prepareWorktree(direct.id);
    assert.equal(directInfo.status, "disabled");
    assert.equal(runner.worktree.workspaceFor(store.taskDetail(direct.id)), project);
    assert.equal(await exists(path.join(data, "worktrees")), false);

    const isolated = store.createStandalone({ projectId: p.id, title: "Isolated", provider: "codex", permission: "workspace-write", worktreeMode: resolveWorktreeMode(true, false) });
    assert.equal(isolated.worktree_mode, "isolate");
    const isolatedInfo = await runner.prepareWorktree(isolated.id);
    assert.equal(isolatedInfo.status, "active");
    assert.ok(isolatedInfo.path.startsWith(path.join(data, "worktrees")));
  } finally {
    await runner.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("可在隔离与直接使用之间切换，含变更时拒绝", async () => {
  const root = await tempRoot("luoshenfu-mode-switch-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const task = store.createStandalone({ projectId: p.id, title: "Switch", provider: "codex", permission: "workspace-write" });
    const info = await runner.prepareWorktree(task.id);
    assert.equal(info.status, "active");

    // 干净时切到 direct：移除工作树，执行目录回到原项目
    const direct = await runner.setWorktreeMode(task.id, "direct");
    assert.equal(direct.worktree_mode, "direct");
    assert.equal(direct.worktree_status, "disabled");
    assert.equal(await exists(info.path), false);
    assert.equal(runner.worktree.workspaceFor(store.taskDetail(task.id)), project);

    // 切回 isolate：重新创建，基准提交沿用任务最初记录
    const back = await runner.setWorktreeMode(task.id, "isolate");
    assert.equal(back.worktree_status, "active");
    assert.equal(back.base_commit, info.baseCommit);
    assert.equal(back.worktree_branch, info.branch);
    assert.equal(await exists(info.path), true);

    // 有变更时切 direct 被拒绝，模式保持 isolate
    await writeFile(path.join(info.path, "a.txt"), "changed\n");
    await assert.rejects(runner.setWorktreeMode(task.id, "direct"), /未撤销的变更/);
    assert.equal(store.task(task.id).worktree_mode, "isolate");
    assert.equal(store.task(task.id).worktree_status, "active");
  } finally {
    await runner.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("direct 与 isolate 两种模式下智能体的工作目录不同", async () => {
  const root = await tempRoot("luoshenfu-mode-cwd-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  const spaces = [];
  runner.codex.startConversation = async ({ task }) => { spaces.push(task.workspace); return { externalId: "thread", turnId: "turn", completion: Promise.resolve({ stopReason: "end_turn" }) }; };
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const isolated = store.createStandalone({ projectId: p.id, title: "Isolated", provider: "codex", permission: "workspace-write" });
    await runner.runTask(isolated.id, "hello");
    for (let index = 0; index < 50 && spaces.length < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const isolatedTask = store.taskDetail(isolated.id);
    assert.equal(spaces[0], isolatedTask.worktree_path);
    assert.notEqual(spaces[0], project);

    const direct = store.createStandalone({ projectId: p.id, title: "Direct", provider: "codex", permission: "workspace-write", worktreeMode: "direct" });
    await runner.runTask(direct.id, "hello");
    for (let index = 0; index < 50 && spaces.length < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(spaces[1], project);
    assert.equal(store.task(direct.id).worktree_status, "disabled");
  } finally {
    await runner.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("按执行批次区分每次改动，快照不污染工作区", async () => {
  const root = await tempRoot("luoshenfu-batches-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  const waitFor = async (check, label) => {
    for (let index = 0; index < 200; index += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    throw new Error(`等待超时：${label}`);
  };
  let round = 0;
  runner.codex.startConversation = async ({ task: current }) => {
    round += 1;
    await writeFile(path.join(current.workspace, `round-${round}.txt`), `round ${round}\n`);
    return { externalId: "thread", turnId: `turn-${round}`, completion: Promise.resolve({ stopReason: "end_turn" }) };
  };
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const task = store.createStandalone({ projectId: p.id, title: "Batches", provider: "codex", permission: "workspace-write" });
    const info = await runner.prepareWorktree(task.id);
    const worktree = info.path;

    await runner.runTask(task.id, "first");
    await waitFor(() => runner.changeBatches(task.id).length >= 1, "第一次执行快照");
    // 快照生成后，工作区里的改动仍然保留，没有被提交或清理
    assert.equal(await exists(path.join(worktree, "round-1.txt")), true);
    assert.equal(store.task(task.id).status, "in_review");

    await runner.runTask(task.id, "second");
    await waitFor(() => runner.changeBatches(task.id).length >= 2, "第二次执行快照");

    const batches = runner.changeBatches(task.id);
    assert.equal(batches.length, 2);
    const first = await inspectRangeChanges(worktree, batches[0].previous, batches[0].snapshot);
    assert.deepEqual(first.files.map((file) => file.path), ["round-1.txt"]);
    const second = await inspectRangeChanges(worktree, batches[1].previous, batches[1].snapshot);
    assert.deepEqual(second.files.map((file) => file.path), ["round-2.txt"]);

    // 「当前」视图仍然是相对任务基准的完整改动
    const current = await inspectChanges(worktree, info.baseCommit);
    assert.deepEqual(current.files.map((file) => file.path).sort(), ["round-1.txt", "round-2.txt"]);
  } finally {
    await runner.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Deepseek 流被中途掐断时会自动重连并在对话里显示重连状态", async () => {
  const root = await tempRoot("luoshenfu-reconnect-");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const waitFor = async (check, label) => {
    for (let index = 0; index < 200; index += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待超时：${label}`);
  };
  try {
    const store = new Store(data, { secrets: [] });
    const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {}, reconnectDelays: [10, 10] });
    try {
      const project = store.createProject({ name: "P", workspace });
      const task = store.createStandalone({ projectId: project.id, title: "Reconnect", provider: "deepseek", permission: "workspace-write" });
      const messages = [];
      runner.deepseek.startConversation = async ({ message }) => {
        messages.push(message);
        const completion = messages.length < 3
          ? Promise.reject(new Error("Internal error: turn failed: SSE stream ended without [DONE]"))
          : Promise.resolve({ stopReason: "end_turn" });
        return { externalId: "session-1", turnId: "session-1", completion };
      };
      const { runId } = await runner.runTask(task.id, "执行测试任务");
      await waitFor(() => store.run(runId)?.status !== "running", "自动重连后完成");
      assert.equal(store.run(runId).status, "completed");
      assert.equal(messages.length, 3);
      assert.match(messages[1], /网络中断/);
      const statuses = store.taskDetail(task.id).events.filter((event) => event.type === "status");
      assert.deepEqual(statuses.map((event) => event.title), ["连接中断，正在重连", "连接中断，正在重连", "连接已恢复"]);
    } finally { await runner.close(); store.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("自动重连耗尽后仍按失败处理，并说明重连次数", async () => {
  const root = await tempRoot("luoshenfu-reconnect-fail-");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  try {
    const store = new Store(data, { secrets: [] });
    const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {}, reconnectDelays: [10, 10] });
    try {
      const project = store.createProject({ name: "P", workspace });
      const task = store.createStandalone({ projectId: project.id, title: "ReconnectFail", provider: "deepseek", permission: "workspace-write" });
      let attempts = 0;
      runner.deepseek.startConversation = async () => {
        attempts += 1;
        return { externalId: "session-1", turnId: "session-1", completion: Promise.reject(new Error("Internal error: turn failed: SSE stream ended without [DONE]")) };
      };
      const { runId } = await runner.runTask(task.id, "执行测试任务");
      for (let index = 0; index < 200 && store.run(runId)?.status === "running"; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(store.run(runId).status, "failed");
      assert.equal(attempts, 3);
      assert.match(store.run(runId).error, /已自动重连 2 次仍未成功/);
    } finally { await runner.close(); store.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("流程阶段串行：其它阶段执行时不启动本阶段，自动推进保持幂等", async () => {
  const root = await tempRoot("luoshenfu-flow-lock-");
  const project = await gitProject(root);
  const data = path.join(root, "data");
  const store = new Store(data, { secrets: [] });
  const runner = new Runner({ store, dataDirectory: data, resourceDirectory: path.resolve("."), token: "test", baseUrl: "http://127.0.0.1", broadcast() {} });
  let started = 0;
  const start = async ({ task }) => {
    started += 1;
    return { externalId: `thread-${task.id}`, turnId: `turn-${task.id}`, completion: Promise.resolve({ stopReason: "end_turn" }) };
  };
  runner.codex.startConversation = start;
  runner.deepseek.startConversation = start;
  try {
    const p = store.createProject({ name: "P", workspace: project });
    const { stages } = store.createWorkflow({ projectId: p.id, title: "Flow", permission: "workspace-write", autoExecute: false, stages: [
      { provider: "codex", phase: "design" },
      { provider: "deepseek", phase: "implementation" },
      { provider: "codex", phase: "verification" },
    ] });
    store.updateTask(stages[0].id, { status: "done" });
    store.updateTask(stages[1].id, { status: "done" });
    // 验证阶段正在执行：实施阶段不允许再启动，自动推进同一个目标也必须跳过。
    const verificationConversation = store.conversation(stages[2], "codex", null, null);
    const verificationRun = store.startRun(stages[2].id, verificationConversation.id);
    runner.active.set(stages[2].id, { runtime: runner.codex, runId: verificationRun.id, permission: "workspace-write" });

    assert.equal(runner.treeBusyStage(store.task(stages[1].id))?.id, stages[2].id);
    await assert.rejects(runner.runTask(stages[1].id, "再改一次"), /正在执行/);
    runner.startNextStage(stages[2].id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(started, 0, "目标阶段已在执行时不应重复启动");

    // 后台执行的失败只落日志与错误事件，不再冒泡成未处理的 Promise 拒绝。
    runner.backgroundRun("测试后台失败", Promise.reject(new Error("boom")), { taskId: stages[1].id, runId: verificationRun.id });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const errors = store.taskDetail(stages[1].id, { eventLimit: 50 }).events.filter((event) => event.type === "error" && event.title === "测试后台失败");
    assert.equal(errors.length, 1);
    assert.match(errors[0].content, /boom/);

    // 验证阶段以失败收尾后处于阻塞：自动推进不该把它重新拉起来，要等用户显式「继续任务」。
    store.finishRun(verificationRun.id, "failed");
    runner.active.delete(stages[2].id);
    runner.startNextStage(stages[2].id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(started, 0, "阻塞中的阶段不应被自动推进");

    // 阶段恢复成「待执行」后，推进才真正启动，而且只启动一次。
    store.updateTask(stages[2].id, { status: "todo" });
    runner.startNextStage(stages[2].id);
    for (let index = 0; index < 200 && started < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(started, 1);
    // 等这一轮真正收尾，避免测试结束后还有异步写入碰到已关闭的数据库。
    for (let index = 0; index < 200 && runner.isTaskActive(stages[2].id); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await runner.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

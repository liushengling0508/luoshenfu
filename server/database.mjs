import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRedactor, sanitizeLogText } from "./redact.mjs";

const now = () => new Date().toISOString();

// 判断一条遗留 run 是否确实已经失去执行进程。同进程重建 Store（例如测试里模拟重启）也算遗留；
// 只有「另一个仍然存活的进程」持有它时才不能接管，避免把别处正在执行的任务误标为已中断。
function runAbandoned(run) {
  const pid = Number(run.owner_pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code !== "EPERM"; }
}

export class Store {
  constructor(dataDirectory, options = {}) {
    this.redactor = createRedactor({ secrets: options.secrets || [] });
    mkdirSync(dataDirectory, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDirectory, "luoshenfu.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL DEFAULT 'task',
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        phase TEXT NOT NULL, provider TEXT, model TEXT, reasoning_effort TEXT, permission TEXT NOT NULL,
        parent_id TEXT REFERENCES tasks(id), root_id TEXT REFERENCES tasks(id), sequence_index INTEGER,
        is_root INTEGER NOT NULL DEFAULT 0, auto_execute INTEGER NOT NULL DEFAULT 0,
        progress INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT,
        worktree_path TEXT, worktree_branch TEXT, base_commit TEXT, worktree_status TEXT, worktree_note TEXT, worktree_mode TEXT NOT NULL DEFAULT 'isolate',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL,
        external_id TEXT, model TEXT, reasoning_effort TEXT, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
        external_turn_id TEXT, status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, ended_at TEXT,
        actual_model TEXT, actual_effort TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0, interrupt_reason TEXT, resume_kind TEXT, snapshot_commit TEXT, owner_pid INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT,
        type TEXT NOT NULL, role TEXT, title TEXT, content TEXT NOT NULL DEFAULT '', raw_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT,
        seq INTEGER NOT NULL, stream TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info',
        text TEXT NOT NULL DEFAULT '', command TEXT, cwd TEXT, exit_code INTEGER,
        redacted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', dedupe_key TEXT NOT NULL UNIQUE,
        read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL REFERENCES tasks(id), child_task_id TEXT NOT NULL REFERENCES tasks(id),
        source_provider TEXT NOT NULL, target_provider TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(parent_task_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
        provider TEXT NOT NULL, external_request_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
        options_json TEXT, status TEXT NOT NULL, decision TEXT, created_at TEXT NOT NULL, decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_sync (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), external_id TEXT,
        synced_status TEXT, last_error TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS music_playlists (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS music_playlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT NOT NULL REFERENCES music_playlists(id),
        path TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deepseek_accounts (
        id TEXT PRIMARY KEY, alias TEXT NOT NULL, last_four TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_project_status ON tasks(project_id, status);
      CREATE INDEX IF NOT EXISTS event_task_id ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS run_log_task ON run_logs(task_id, id);
      CREATE INDEX IF NOT EXISTS run_log_run ON run_logs(run_id, id);
      CREATE INDEX IF NOT EXISTS activity_created ON activities(created_at DESC);
      CREATE INDEX IF NOT EXISTS music_item_playlist ON music_playlist_items(playlist_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS deepseek_account_alias ON deepseek_accounts(alias);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, started_at);
      CREATE INDEX IF NOT EXISTS task_root ON tasks(root_id);
      CREATE INDEX IF NOT EXISTS task_project_kind_updated ON tasks(project_id, kind, updated_at DESC);
    `);
    // conversations.account_id：记录该会话属于哪个 Deepseek 账号，切号后不会错误复用别人的外部会话。
    const conversationColumns = new Set(this.db.prepare("PRAGMA table_info(conversations)").all().map((column) => column.name));
    if (!conversationColumns.has("account_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN account_id TEXT");
    // conversations.workspace：记录该会话建立时的工作目录；harness 的会话与 cwd 绑定，换目录后不能续接。
    if (!conversationColumns.has("workspace")) this.db.exec("ALTER TABLE conversations ADD COLUMN workspace TEXT");
    const taskColumns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
    if (!taskColumns.has("reasoning_effort")) this.db.exec("ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT");
    if (!taskColumns.has("archived")) this.db.exec("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    if (!taskColumns.has("archived_at")) this.db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
    if (!taskColumns.has("kind")) this.db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
    if (!taskColumns.has("worktree_path")) this.db.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    if (!taskColumns.has("worktree_branch")) this.db.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    if (!taskColumns.has("base_commit")) this.db.exec("ALTER TABLE tasks ADD COLUMN base_commit TEXT");
    if (!taskColumns.has("worktree_status")) this.db.exec("ALTER TABLE tasks ADD COLUMN worktree_status TEXT");
    if (!taskColumns.has("worktree_note")) this.db.exec("ALTER TABLE tasks ADD COLUMN worktree_note TEXT");
    if (!taskColumns.has("worktree_mode")) this.db.exec("ALTER TABLE tasks ADD COLUMN worktree_mode TEXT NOT NULL DEFAULT 'isolate'");
    // 任务说明里的图片：跟任务本身走，不再是「只能发在聊天里」的输入。
    if (!taskColumns.has("attachments")) this.db.exec("ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    const nextNumber = Number(this.db.prepare("SELECT COALESCE(MAX(number), 0) + 1 n FROM tasks WHERE kind='task'").get().n);
    this.setSetting("task.nextNumber", Math.max(nextNumber, Number(this.setting("task.nextNumber", 1)) || 1));
    this.db.exec("CREATE INDEX IF NOT EXISTS task_project_archive ON tasks(project_id,kind,archived,archived_at DESC)");
    const runColumns = new Set(this.db.prepare("PRAGMA table_info(runs)").all().map((column) => column.name));
    if (!runColumns.has("actual_model")) this.db.exec("ALTER TABLE runs ADD COLUMN actual_model TEXT");
    if (!runColumns.has("actual_effort")) this.db.exec("ALTER TABLE runs ADD COLUMN actual_effort TEXT");
    if (!runColumns.has("last_event_seq")) this.db.exec("ALTER TABLE runs ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.has("interrupt_reason")) this.db.exec("ALTER TABLE runs ADD COLUMN interrupt_reason TEXT");
    if (!runColumns.has("resume_kind")) this.db.exec("ALTER TABLE runs ADD COLUMN resume_kind TEXT");
    if (!runColumns.has("snapshot_commit")) this.db.exec("ALTER TABLE runs ADD COLUMN snapshot_commit TEXT");
    if (!runColumns.has("owner_pid")) this.db.exec("ALTER TABLE runs ADD COLUMN owner_pid INTEGER");
    // workbench_sync.external_kind：区分关联的是开发台「任务」还是「问题」。
    // 问题必须走独立通道，否则任务同步循环会拿 bug_xxx 去 PATCH /api/dev/tasks 而持续报错。
    const workbenchColumns = new Set(this.db.prepare("PRAGMA table_info(workbench_sync)").all().map((column) => column.name));
    if (!workbenchColumns.has("external_kind")) this.db.exec("ALTER TABLE workbench_sync ADD COLUMN external_kind TEXT NOT NULL DEFAULT 'task'");
    if (!workbenchColumns.has("external_project_id")) this.db.exec("ALTER TABLE workbench_sync ADD COLUMN external_project_id TEXT");
    if (!workbenchColumns.has("external_requirement_id")) this.db.exec("ALTER TABLE workbench_sync ADD COLUMN external_requirement_id TEXT");
    if (!workbenchColumns.has("external_task_kind")) this.db.exec("ALTER TABLE workbench_sync ADD COLUMN external_task_kind TEXT");
    if (!workbenchColumns.has("synced_title")) {
      this.db.exec("ALTER TABLE workbench_sync ADD COLUMN synced_title TEXT");
      this.db.exec("UPDATE workbench_sync SET synced_title=(SELECT title FROM tasks WHERE tasks.id=workbench_sync.task_id)");
    }
    if (!workbenchColumns.has("synced_description")) {
      this.db.exec("ALTER TABLE workbench_sync ADD COLUMN synced_description TEXT");
      this.db.exec("UPDATE workbench_sync SET synced_description=(SELECT description FROM tasks WHERE tasks.id=workbench_sync.task_id)");
    }
    this.#reconcileInterrupted();
    // 中断清理后再回算一次所有流程的状态，修正历史上「没有阶段在执行、根任务却停在执行中」的残留。
    this.syncAllWorkflowStatuses();
  }

  // 服务启动时清理遗留的执行状态：只接管属于已退出进程的 run，标记为“已中断，可恢复”，
  // 绝不继续假装运行；仍在运行的其它实例（开发服务或未退出的旧 sidecar）保持原状。
  #reconcileInterrupted() {
    const stamp = now();
    const stale = this.db.prepare("SELECT id, task_id, conversation_id, owner_pid FROM runs WHERE status IN ('queued','running','waiting_approval')").all();
    if (!stale.length) return;
    const abandoned = stale.filter((run) => runAbandoned(run));
    if (!abandoned.length) return;
    const slots = abandoned.map(() => "?").join(",");
    const runIds = abandoned.map((run) => run.id);
    this.db.prepare(`UPDATE approvals SET status='expired', decision='expired' WHERE status='pending' AND run_id IN (${slots})`).run(...runIds);
    this.db.prepare(`UPDATE runs SET status='interrupted', error=?, interrupt_reason=?, ended_at=?
      WHERE id IN (${slots})`).run("本地服务已重启，原执行进程已不存在", "服务重启", stamp, ...runIds);
    for (const taskId of new Set(abandoned.map((run) => run.task_id))) {
      const stillActive = this.db.prepare("SELECT 1 FROM runs WHERE task_id=? AND status IN ('queued','running','waiting_approval') LIMIT 1").get(taskId);
      if (!stillActive) this.db.prepare("UPDATE tasks SET status='blocked', updated_at=? WHERE id=? AND status='running'").run(stamp, taskId);
    }
    for (const run of abandoned) {
      const task = this.db.prepare("SELECT id, project_id, title, kind FROM tasks WHERE id=?").get(run.task_id);
      if (!task || task.kind !== "task") continue;
      this.addActivity({
        projectId: task.project_id, taskId: task.id, type: "task.interrupted",
        title: `任务已中断，可恢复：${task.title}`,
        body: "本地服务重启，原执行进程已不存在，可在任务详情页继续任务。",
        dedupeKey: `${task.id}:interrupted:${run.id}`,
      });
    }
  }

  close() { this.db.close(); }
  nextNumber() { const value = Number(this.setting("task.nextNumber", 1)); this.setSetting("task.nextNumber", value + 1); return value; }
  nextHiddenNumber() { return Number(this.db.prepare("SELECT MIN(COALESCE(MIN(number), 0), 0) - 1 n FROM tasks").get().n); }

  createProject({ name, workspace }) {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(id, name.trim(), workspace, stamp, stamp);
    return this.project(id);
  }

  project(id) { return this.db.prepare("SELECT * FROM projects WHERE id=?").get(id); }
  projects() { return this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all(); }
  task(id) { return parseTask(this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id)); }

  /** 任务说明里的第 index 个附件；路径与事件附件一样由服务端自己保存或用户选定。 */
  taskAttachment(taskId, index) {
    const items = parseTask(this.task(taskId))?.attachments || [];
    return items[index] || null;
  }

  insertTask(input) {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare(`INSERT INTO tasks
      (id,number,project_id,kind,title,description,attachments,status,phase,provider,model,reasoning_effort,permission,parent_id,root_id,sequence_index,is_root,auto_execute,progress,unread,worktree_mode,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.kind === "chat" || input.hidden ? this.nextHiddenNumber() : this.nextNumber(), input.projectId, input.kind || "task", input.title.trim(), input.description?.trim() || "",
      JSON.stringify(Array.isArray(input.attachments) ? input.attachments : []),
      input.status || "todo", input.phase || "standalone", input.provider || null, input.model || null, input.effort || null,
      input.permission || "workspace-write", input.parentId || null, input.rootId || null,
      input.sequenceIndex ?? null, input.isRoot ? 1 : 0, input.autoExecute ? 1 : 0,
      input.progress || 0, 0, input.worktreeMode === "direct" ? "direct" : "isolate", stamp, stamp,
    );
    return this.task(id);
  }

  createStandalone(input) { return this.insertTask(input); }
  createChat(input) { return this.insertTask({ ...input, kind: "chat", title: "新会话", phase: "standalone", status: "todo" }); }

  createWorkflow(input) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const root = this.insertTask({ ...input, provider: null, model: null, effort: null, phase: "standalone", status: "todo", isRoot: true });
      const stages = input.stages.map((stage, sequenceIndex) => this.insertTask({
        ...input, ...stage, title: `${input.title} · ${{ design: "设计", implementation: "实施", verification: "验证" }[stage.phase]}`,
        parentId: root.id, rootId: root.id, sequenceIndex, autoExecute: true, hidden: true,
      }));
      this.db.exec("COMMIT");
      return { root, stages };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  convertStandaloneToWorkflow(id, changes, stages) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.task(id);
      if (!task || task.kind !== "task" || task.is_root || task.root_id || task.parent_id) throw new Error("只有独立任务可以转为流程任务");
      if (task.status !== "todo" || task.archived) throw new Error("只有尚未执行且未归档的独立任务可以转为流程任务");
      if (changes.status && changes.status !== "todo") throw new Error("转换流程任务时不能同时修改任务状态");
      if (this.db.prepare("SELECT 1 FROM runs WHERE task_id=? UNION ALL SELECT 1 FROM conversations WHERE task_id=? LIMIT 1").get(id, id)) throw new Error("已有执行记录的任务不能转为流程任务");

      this.updateTask(id, changes);
      this.db.prepare("UPDATE tasks SET is_root=1, provider=NULL, model=NULL, reasoning_effort=NULL, updated_at=? WHERE id=?").run(now(), id);
      const root = this.task(id);
      const children = stages.map((stage, sequenceIndex) => this.insertTask({
        projectId: root.project_id,
        kind: root.kind,
        title: `${root.title} · ${{ design: "设计", implementation: "实施", verification: "验证" }[stage.phase]}`,
        description: root.description,
        attachments: root.attachments,
        permission: root.permission,
        worktreeMode: root.worktree_mode,
        ...stage,
        parentId: root.id,
        rootId: root.id,
        sequenceIndex,
        autoExecute: true,
        hidden: true,
      }));
      this.db.exec("COMMIT");
      return { root: this.task(id), stages: children };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tasks(projectId, archived = null) {
    const clauses = ["t.kind='task'"];
    const params = [];
    if (projectId) { clauses.push("t.project_id=?"); params.push(projectId); }
    if (archived !== null) { clauses.push("t.archived=?"); params.push(archived ? 1 : 0); }
    return this.db.prepare(`SELECT t.*, p.name project_name, p.workspace,
      EXISTS(SELECT 1 FROM workbench_sync w WHERE w.task_id=t.id) workbench_sync,
      COALESCE((SELECT CAST(SUM((julianday(r.ended_at)-julianday(r.started_at))*86400) AS INTEGER) FROM runs r WHERE (r.task_id=t.id OR (t.is_root=1 AND r.task_id IN (SELECT id FROM tasks WHERE root_id=t.id))) AND r.ended_at IS NOT NULL),0) duration_seconds,
      (SELECT r.started_at FROM runs r WHERE (r.task_id=t.id OR (t.is_root=1 AND r.task_id IN (SELECT id FROM tasks WHERE root_id=t.id))) AND r.status IN ('running','waiting_approval') ORDER BY r.started_at DESC LIMIT 1) active_run_started_at
      FROM tasks t JOIN projects p ON p.id=t.project_id WHERE ${clauses.join(" AND ")}
      ORDER BY t.updated_at DESC`).all(...params).map(parseTask);
  }

  recentChats(projectId, limit = 6) {
    return this.chatPage(projectId, 1, limit).items;
  }

  chatPage(projectId, page = 1, pageSize = 5) {
    if (!projectId) return { items: [], page: 1, pageSize, total: 0, totalPages: 0 };
    const total = Number(this.db.prepare("SELECT COUNT(*) total FROM tasks t WHERE t.project_id=? AND t.kind='chat' AND EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id)").get(projectId).total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), totalPages);
    const items = this.db.prepare(`SELECT t.*, p.name project_name, p.workspace,
      0 workbench_sync,
      COALESCE((SELECT CAST(SUM((julianday(r.ended_at)-julianday(r.started_at))*86400) AS INTEGER) FROM runs r WHERE r.task_id=t.id AND r.ended_at IS NOT NULL),0) duration_seconds,
      (SELECT r.started_at FROM runs r WHERE r.task_id=t.id AND r.status IN ('queued','running','waiting_approval') ORDER BY r.started_at DESC LIMIT 1) active_run_started_at
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.project_id=? AND t.kind='chat' AND EXISTS(SELECT 1 FROM events e WHERE e.task_id=t.id)
      ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`).all(projectId, pageSize, (currentPage - 1) * pageSize).map(parseTask);
    return { items, page: currentPage, pageSize, total, totalPages: total ? totalPages : 0 };
  }

  archiveCount(projectId) {
    if (!projectId) return 0;
    return Number(this.db.prepare("SELECT COUNT(*) total FROM tasks WHERE project_id=? AND kind='task' AND root_id IS NULL AND archived=1").get(projectId).total);
  }

  archivePage(projectId, page = 1, query = "", pageSize = 20) {
    const keyword = String(query).trim().slice(0, 100);
    const clauses = ["t.project_id=?", "t.kind='task'", "t.root_id IS NULL", "t.archived=1"];
    const params = [projectId];
    if (keyword) {
      const needle = `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
      const taskNumber = keyword.match(/-(\d+)$/)?.[1];
      clauses.push(`(t.title LIKE ? ESCAPE '\\' OR COALESCE(t.model,'') LIKE ? ESCAPE '\\' OR COALESCE(t.provider,'') LIKE ? ESCAPE '\\' OR CAST(t.number AS TEXT) LIKE ? ESCAPE '\\'${taskNumber ? " OR t.number=?" : ""})`);
      params.push(needle, needle, needle, needle);
      if (taskNumber) params.push(Number(taskNumber));
    }
    const where = clauses.join(" AND ");
    const total = Number(this.db.prepare(`SELECT COUNT(*) total FROM tasks t WHERE ${where}`).get(...params).total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), totalPages);
    const items = this.db.prepare(`SELECT t.*, p.name project_name, p.workspace,
      EXISTS(SELECT 1 FROM workbench_sync w WHERE w.task_id=t.id) workbench_sync,
      COALESCE((SELECT CAST(SUM((julianday(r.ended_at)-julianday(r.started_at))*86400) AS INTEGER) FROM runs r WHERE (r.task_id=t.id OR (t.is_root=1 AND r.task_id IN (SELECT id FROM tasks WHERE root_id=t.id))) AND r.ended_at IS NOT NULL),0) duration_seconds,
      NULL active_run_started_at
      FROM tasks t JOIN projects p ON p.id=t.project_id WHERE ${where}
      ORDER BY COALESCE(t.archived_at,t.updated_at) DESC, t.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (currentPage - 1) * pageSize).map(parseTask);
    const summary = this.db.prepare(`SELECT COUNT(DISTINCT t.id) total,
      COALESCE(CAST(SUM(CASE WHEN r.ended_at IS NOT NULL THEN (julianday(r.ended_at)-julianday(r.started_at))*86400 ELSE 0 END) AS INTEGER),0) duration_seconds
      FROM tasks t LEFT JOIN runs r ON r.task_id=t.id OR (t.is_root=1 AND r.task_id IN (SELECT id FROM tasks WHERE root_id=t.id))
      WHERE t.project_id=? AND t.kind='task' AND t.root_id IS NULL AND t.archived=1`).get(projectId);
    return { items, page: currentPage, pageSize, total, totalPages: total ? totalPages : 0, summary: { total: Number(summary.total), durationSeconds: Number(summary.duration_seconds) } };
  }

  // options.eventLimit / beforeId 用于详情按需分页：默认返回全部（供内部调用），HTTP 层会传入上限。
  taskDetail(id, options = {}) {
    const task = parseTask(this.db.prepare(`SELECT t.*, p.name project_name, p.workspace,
      EXISTS(SELECT 1 FROM workbench_sync w WHERE w.task_id=t.id) workbench_sync,
      (SELECT w.external_id FROM workbench_sync w WHERE w.task_id=t.id) workbench_external_id,
      COALESCE((SELECT CAST(SUM((julianday(r.ended_at)-julianday(r.started_at))*86400) AS INTEGER) FROM runs r WHERE (r.task_id=t.id OR (t.is_root=1 AND r.task_id IN (SELECT id FROM tasks WHERE root_id=t.id))) AND r.ended_at IS NOT NULL),0) duration_seconds,
      (SELECT r.started_at FROM runs r WHERE (r.task_id=t.id OR (t.is_root=1 AND r.task_id IN (SELECT id FROM tasks WHERE root_id=t.id))) AND r.status IN ('queued','running','waiting_approval') ORDER BY r.started_at DESC LIMIT 1) active_run_started_at
      FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(id));
    if (!task) return null;
    const children = this.db.prepare("SELECT * FROM tasks WHERE parent_id=? ORDER BY sequence_index, created_at").all(id).map(parseTask);
    const ids = task.is_root ? [id, ...children.map((child) => child.id)] : [id];
    const slots = ids.map(() => "?").join(",");
    const eventLimit = Number.isInteger(options.eventLimit) && options.eventLimit > 0 ? Math.min(options.eventLimit, 2000) : null;
    const beforeId = Number.isInteger(options.beforeId) && options.beforeId > 0 ? options.beforeId : null;
    const eventClauses = [`e.task_id IN (${slots})`];
    const eventParams = [...ids];
    if (beforeId) { eventClauses.push("e.id<?"); eventParams.push(beforeId); }
    const eventSql = `SELECT e.*,t.provider provider FROM events e JOIN tasks t ON t.id=e.task_id WHERE ${eventClauses.join(" AND ")} ORDER BY e.id${eventLimit ? " DESC LIMIT ?" : ""}`;
    if (eventLimit) eventParams.push(eventLimit);
    let eventRows = this.db.prepare(eventSql).all(...eventParams);
    if (eventLimit) eventRows = eventRows.reverse();
    const oldestId = eventRows[0]?.id ?? null;
    const hasMore = Boolean(oldestId && this.db.prepare(`SELECT 1 FROM events WHERE task_id IN (${slots}) AND id<? LIMIT 1`).get(...ids, oldestId));
    return {
      ...task,
      events: compactEvents(eventRows.map(parseRaw)),
      eventsHasMore: hasMore,
      eventsOldestId: oldestId,
      approvals: this.db.prepare(`SELECT * FROM approvals WHERE task_id IN (${slots}) AND status IN ('pending','expired') ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at`).all(...ids).map(parseOptions),
      conversation: this.db.prepare(`SELECT * FROM conversations WHERE task_id IN (${slots}) ORDER BY updated_at DESC LIMIT 1`).get(...ids) || null,
      run: this.db.prepare(`SELECT * FROM runs WHERE task_id IN (${slots}) ORDER BY started_at DESC LIMIT 1`).get(...ids) || null,
      children,
    };
  }

  updateTask(id, changes) {
    const allowed = ["title", "description", "attachments", "status", "provider", "model", "reasoning_effort", "permission", "auto_execute", "progress", "unread", "archived", "archived_at", "worktree_mode"];
    const entries = Object.entries(changes).filter(([key]) => allowed.includes(key));
    if (!entries.length) return this.task(id);
    entries.push(["updated_at", now()]);
    this.db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`)
      .run(...entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value), id);
    return this.task(id);
  }

  deleteTask(id) {
    const ids = this.db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM tasks WHERE id=? UNION ALL SELECT tasks.id FROM tasks JOIN tree ON tasks.parent_id=tree.id
    ) SELECT id FROM tree`).all(id).map((item) => item.id);
    if (!ids.length) return 0;
    const slots = ids.map(() => "?").join(",");
    if (this.db.prepare(`SELECT 1 FROM runs WHERE task_id IN (${slots}) AND status IN ('queued','running','waiting_approval') LIMIT 1`).get(...ids)) throw new Error("执行中的任务不能删除，请先停止任务");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM approvals WHERE task_id IN (${slots})`).run(...ids);
      this.db.prepare(`DELETE FROM delegations WHERE parent_task_id IN (${slots}) OR child_task_id IN (${slots})`).run(...ids, ...ids);
      this.db.prepare(`DELETE FROM events WHERE task_id IN (${slots})`).run(...ids);
      this.db.prepare(`DELETE FROM run_logs WHERE task_id IN (${slots})`).run(...ids);
      this.db.prepare(`DELETE FROM activities WHERE task_id IN (${slots})`).run(...ids);
      this.db.prepare(`DELETE FROM runs WHERE task_id IN (${slots})`).run(...ids);
      this.db.prepare(`DELETE FROM conversations WHERE task_id IN (${slots})`).run(...ids);
      this.db.prepare(`DELETE FROM workbench_sync WHERE task_id IN (${slots})`).run(...ids);
      this.db.prepare(`DELETE FROM tasks WHERE id IN (${slots})`).run(...ids);
      this.db.exec("COMMIT");
      return ids.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  priorStageIncomplete(task) {
    if (!task.root_id || task.sequence_index == null || task.sequence_index === 0) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE root_id=? AND sequence_index<? AND status!='done' LIMIT 1")
      .get(task.root_id, task.sequence_index));
  }

  previousStageSummary(task) {
    if (!task.root_id || !task.sequence_index) return "";
    const previous = this.db.prepare("SELECT id,title FROM tasks WHERE root_id=? AND sequence_index=?").get(task.root_id, task.sequence_index - 1);
    if (!previous) return "";
    const events = this.db.prepare("SELECT content FROM events WHERE task_id=? AND type IN ('message','result') AND content!='' ORDER BY id DESC LIMIT 4").all(previous.id).reverse();
    return events.length ? `\n\n上一阶段「${previous.title}」结果：\n${events.map((item) => item.content).join("\n")}` : "";
  }

  // 按阶段取该阶段当前最新的产出，供下游阶段引用（例如验证阶段要拿设计阶段的验收标准当基准）。
  stageProduct(task, phase) {
    if (!task.root_id || !phase) return "";
    const stage = this.db.prepare("SELECT id,title FROM tasks WHERE root_id=? AND phase=?").get(task.root_id, phase);
    if (!stage) return "";
    const events = this.db.prepare("SELECT content FROM events WHERE task_id=? AND type IN ('message','result') AND content!='' ORDER BY id DESC LIMIT 4").all(stage.id).reverse();
    return events.length ? `\n\n「${stage.title}」阶段当前产出：\n${events.map((item) => item.content).join("\n")}` : "";
  }

  // 手动重跑一个已完成的流程阶段时，把它之后的阶段重置为待执行。
  // 需求变更后从设计阶段重新发起，必须严格重走「设计→实施→验证」，不能因为后续阶段历史上已完成就被自动推进跳过。
  resetFollowingStages(taskId) {
    const task = this.task(taskId);
    if (!task?.root_id || task.sequence_index == null) return 0;
    const info = this.db.prepare("UPDATE tasks SET status='todo', progress=0, updated_at=? WHERE root_id=? AND sequence_index>? AND status!='todo'")
      .run(now(), task.root_id, task.sequence_index);
    return info.changes;
  }

  // accountId 与 workspace 只对 Deepseek 有意义：
  // - 切账号后旧会话不能复用，否则会把 A 账号的上下文续到 B 账号上；
  // - harness 的会话与建立时的 cwd 绑定，工作目录变化后用旧 external_id 续接会被拒绝
  //   （session/resume 报 "session cwd does not match"）。所以这里优先复用「工作目录一致的最近会话」，
  //   找不到才新建，避免把整轮执行卡死；旧记录没有 workspace（迁移前建立）时无法判断，允许复用并由运行时兜底重建。
  conversation(task, provider, model, effort, accountId = null, workspace = null) {
    const rows = this.db.prepare("SELECT * FROM conversations WHERE task_id=? AND provider=? ORDER BY created_at DESC, rowid DESC").all(task.id, provider);
    const compatible = (row) => {
      if (provider !== "deepseek") return true;
      if (accountId && (row.account_id || null) !== accountId) return false;
      return !row.workspace || !workspace || row.workspace === workspace;
    };
    const existing = rows.find(compatible);
    if (existing) {
      this.db.prepare("UPDATE conversations SET model=?,reasoning_effort=?,updated_at=?,account_id=?,workspace=COALESCE(?,workspace) WHERE id=?")
        .run(model || null, effort || null, now(), accountId || existing.account_id || null, provider === "deepseek" ? workspace : null, existing.id);
      return this.db.prepare("SELECT * FROM conversations WHERE id=?").get(existing.id);
    }
    const id = randomUUID();
    const stamp = now();
    this.db.prepare("INSERT INTO conversations (id,task_id,provider,external_id,model,reasoning_effort,status,created_at,updated_at,account_id,workspace) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, task.id, provider, null, model || null, effort || null, "ready", stamp, stamp, accountId || null, provider === "deepseek" ? workspace : null);
    return this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
  }

  setConversationExternal(id, externalId, model) {
    this.db.prepare("UPDATE conversations SET external_id=?, model=COALESCE(?,model), updated_at=? WHERE id=?").run(externalId, model || null, now(), id);
  }

  startRun(taskId, conversationId, status = "running", resumeKind = null) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO runs (id,task_id,conversation_id,status,resume_kind,started_at,owner_pid) VALUES (?,?,?,?,?,?,?)").run(id, taskId, conversationId, status, resumeKind || null, now(), process.pid);
    this.updateTask(taskId, { status: "running", progress: 1 });
    const task = this.task(taskId);
    if (task?.root_id) this.updateTask(task.root_id, { status: task.phase === "verification" ? "in_review" : "running", progress: { design: 10, implementation: 40, verification: 75 }[task.phase] || 1 });
    return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  }

  activateRun(id) { this.db.prepare("UPDATE runs SET status='running', owner_pid=? WHERE id=?").run(process.pid, id); }
  // 本进程仍持有该 run 的执行、但数据库状态被其它实例误标为已结束时，恢复为执行中，让界面继续显示“模型执行中”。
  restoreRun(id) {
    const run = this.run(id);
    if (!run) return null;
    if (run.status === "running" && !run.ended_at && !run.interrupt_reason && !run.error) return run;
    this.db.prepare("UPDATE runs SET status='running', error=NULL, interrupt_reason=NULL, ended_at=NULL, owner_pid=? WHERE id=?").run(process.pid, id);
    const task = this.task(run.task_id);
    this.updateTask(run.task_id, { status: "running" });
    if (task?.root_id) {
      const root = this.task(task.root_id);
      if (root?.status === "blocked") this.updateTask(task.root_id, { status: task.phase === "verification" ? "in_review" : "running", progress: { design: 10, implementation: 40, verification: 75 }[task.phase] || 1 });
    }
    return this.run(id);
  }
  activeRun(taskId) { return this.db.prepare("SELECT * FROM runs WHERE task_id=? AND status IN ('queued','running','waiting_approval') ORDER BY started_at DESC LIMIT 1").get(taskId); }
  lastRun(taskId) { return this.db.prepare("SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId); }
  runs(taskId) { return this.db.prepare("SELECT * FROM runs WHERE task_id=? ORDER BY rowid ASC").all(taskId); }
  run(id) { return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id); }

  setRunResume(id, kind) { this.db.prepare("UPDATE runs SET resume_kind=? WHERE id=?").run(kind || null, id); }
  setRunSnapshot(id, commit) { this.db.prepare("UPDATE runs SET snapshot_commit=? WHERE id=?").run(commit || null, id); }

  // 该次执行之前最近一次成功的快照，用于计算「本次执行改了什么」。
  previousSnapshot(ownerId, runId) {
    const row = this.db.prepare(`SELECT r.snapshot_commit FROM runs r
      WHERE r.snapshot_commit IS NOT NULL AND r.rowid < (SELECT rowid FROM runs WHERE id=?)
        AND r.task_id IN (SELECT id FROM tasks WHERE id=? OR root_id=?)
      ORDER BY r.rowid DESC LIMIT 1`).get(runId, ownerId, ownerId);
    return row?.snapshot_commit || null;
  }

  // 根任务及其所有阶段的执行记录，用于按执行批次展示变更。
  taskRuns(taskId) {
    return this.db.prepare(`SELECT r.*, t.title task_title, t.phase task_phase FROM runs r JOIN tasks t ON t.id=r.task_id
      WHERE t.id=? OR t.root_id=? ORDER BY r.rowid ASC`).all(taskId, taskId);
  }

  interruptRun(id, reason) {
    const run = this.run(id);
    if (!run || run.status === "interrupted") return run;
    this.db.prepare("UPDATE runs SET status='interrupted', error=?, interrupt_reason=?, ended_at=? WHERE id=?").run(reason, reason, now(), id);
    return this.run(id);
  }

  setWorktree(taskId, fields) {
    this.db.prepare(`UPDATE tasks SET worktree_path=?, worktree_branch=?, base_commit=?, worktree_status=?, worktree_note=?, updated_at=? WHERE id=?`)
      .run(fields.worktree_path ?? null, fields.worktree_branch ?? null, fields.base_commit ?? null, fields.worktree_status ?? null, fields.worktree_note ?? null, now(), taskId);
    return this.task(taskId);
  }

  // 只更新隔离状态与说明，保留已记录的路径/分支/基准提交，便于之后重新启用。
  setWorktreeStatus(taskId, status, note = null) {
    this.db.prepare("UPDATE tasks SET worktree_status=?, worktree_note=?, updated_at=? WHERE id=?").run(status, note, now(), taskId);
    return this.task(taskId);
  }
  conversationById(id) { return this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id); }

  setRunExternal(id, turnId) { this.db.prepare("UPDATE runs SET external_turn_id=? WHERE id=?").run(turnId, id); }
  setRunRuntime(id, model, effort) { this.db.prepare("UPDATE runs SET actual_model=?,actual_effort=? WHERE id=?").run(model || null, effort || null, id); }

  finishRun(runId, status, error = null, advance = true) {
    const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
    if (!run) return null;
    this.db.prepare("UPDATE runs SET status=?, error=?, ended_at=? WHERE id=?").run(status, error, now(), runId);
    const task = this.task(run.task_id);
    // 执行成功后停在「待验证」，由用户验收确认后才算完成；流程阶段是内部步骤，直接标记完成，根任务状态交给 advanceWorkflow 决定。
    const taskStatus = status === "completed" ? (task?.root_id ? "done" : "in_review") : status === "canceled" ? "canceled" : "blocked";
    this.updateTask(run.task_id, { status: taskStatus, progress: status === "completed" ? 100 : 0 });
    if (task?.root_id && status !== "completed") this.updateTask(task.root_id, { status: "blocked" });
    return status === "completed" && advance ? this.advanceWorkflow(run.task_id) : null;
  }

  advanceWorkflow(taskId) {
    const task = this.task(taskId);
    if (!task?.root_id) return null;
    // 跳过已经完成的阶段：单个阶段可能被重跑，只按 sequence_index+1 推进会把流程卡在已完成的阶段上。
    const next = this.db.prepare("SELECT * FROM tasks WHERE root_id=? AND sequence_index>? AND status!='done' ORDER BY sequence_index LIMIT 1")
      .get(task.root_id, task.sequence_index);
    // 阶段状态可能变化（重跑、阻塞、恢复），根任务状态一律按各阶段真实状态回算。
    this.syncWorkflowStatus(task.root_id);
    return next || null;
  }

  // 由各阶段真实状态回算流程根任务状态。
  // 根任务不能只靠 startRun/finishRun 顺带设置：重跑一个已完成阶段、而后续阶段也已结束时，
  // 旧逻辑会让根任务永远停在「执行中」，看板泳道就一直显示进行中。
  syncWorkflowStatus(rootId) {
    const root = this.task(rootId);
    if (!root?.is_root) return root || null;
    // 用户已确认验收（done）的流程不再回退。
    if (root.status === "done") return root;
    const stages = this.db.prepare("SELECT status, phase FROM tasks WHERE root_id=? ORDER BY sequence_index").all(rootId);
    if (!stages.length) return root;
    const running = stages.some((stage) => stage.status === "running");
    const allDone = stages.every((stage) => stage.status === "done");
    const blocked = stages.some((stage) => ["blocked", "canceled"].includes(stage.status));
    const pending = stages.find((stage) => stage.status !== "done");
    let status;
    if (running) status = "running";
    else if (allDone) status = "in_review";
    else if (blocked) status = "blocked";
    // 还没开始且没有阻塞：轮到验证阶段时停在「待验证」，其余情况视为流程仍在推进。
    else if (pending?.phase === "verification") status = "in_review";
    else status = pending ? "running" : "todo";
    const progress = running ? root.progress : Math.round((stages.filter((stage) => stage.status === "done").length / stages.length) * 100);
    if (root.status === status && root.progress === progress) return root;
    return this.updateTask(rootId, { status, progress });
  }

  syncAllWorkflowStatuses() {
    for (const row of this.db.prepare("SELECT id FROM tasks WHERE is_root=1").all()) this.syncWorkflowStatus(row.id);
  }

  addEvent(taskId, runId, event) {
    const raw = event.raw ? JSON.stringify(event.raw) : null;
    const method = event.raw?.method;
    const chunk = method === "item/agentMessage/delta" || event.raw?.params?.update?.sessionUpdate === "agent_message_chunk";
    const last = this.db.prepare("SELECT id,json_extract(raw_json,'$.method') method,json_extract(raw_json,'$.params.update.sessionUpdate') update_type FROM events WHERE task_id=? AND run_id IS ? ORDER BY id DESC LIMIT 1").get(taskId, runId || null);
    const append = chunk && (last?.method === "item/agentMessage/delta" || last?.update_type === "agent_message_chunk");
    if (append || (last?.method === "item/agentMessage/delta" && method === "item/completed" && event.raw?.params?.item?.type === "agentMessage")) {
      this.db.prepare(`UPDATE events SET type=?,role=?,title=?,content=${append ? "content||?" : "?"},raw_json=?,created_at=? WHERE id=?`)
        .run(event.type, event.role || null, event.title || null, event.content || "", raw, now(), last.id);
      this.db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now(), taskId);
      if (runId) this.db.prepare("UPDATE runs SET last_event_seq=? WHERE id=?").run(Number(last.id), runId);
      return Number(last.id);
    }
    const info = this.db.prepare(`INSERT INTO events (task_id,run_id,type,role,title,content,raw_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(taskId, runId || null, event.type, event.role || null,
      event.title || null, event.content || "", raw, now());
    this.db.prepare("UPDATE tasks SET unread=unread+1, updated_at=? WHERE id=?").run(now(), taskId);
    if (runId) this.db.prepare("UPDATE runs SET last_event_seq=? WHERE id=?").run(Number(info.lastInsertRowid), runId);
    return Number(info.lastInsertRowid);
  }

  // 执行日志：写入前统一脱敏，失败只记录诊断信息，绝不拖垮主任务进程。
  addLog({ taskId, runId = null, stream = "system", level = "info", text = "", command = null, cwd = null, exitCode = null }) {
    try {
      const raw = text == null ? "" : String(text);
      const clean = this.redactor.text(sanitizeLogText(raw));
      const cleanCommand = command ? this.redactor.text(sanitizeLogText(String(command), { maxLine: 2000, maxBytes: 8 * 1024 })) : null;
      if (!clean && !cleanCommand) return null;
      const seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 n FROM run_logs WHERE task_id=?").get(taskId).n);
      const info = this.db.prepare(`INSERT INTO run_logs (task_id,run_id,seq,stream,level,text,command,cwd,exit_code,redacted,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, runId || null, seq, stream, level, clean, cleanCommand, cwd || null, exitCode == null ? null : Number(exitCode), clean === raw ? 0 : 1, now());
      const id = Number(info.lastInsertRowid);
      if (runId) this.db.prepare("UPDATE runs SET last_event_seq=? WHERE id=?").run(id, runId);
      return { id, seq };
    } catch (error) {
      console.error(`[luoshenfu] 执行日志写入失败：${error.message}`);
      return null;
    }
  }

  logPage(taskId, { after = null, before = null, limit = 300, streams = [], query = "" } = {}) {
    const size = Math.min(Math.max(1, Number(limit) || 300), 1000);
    const clauses = ["task_id=?"];
    const params = [taskId];
    if (after != null) { clauses.push("id>?"); params.push(Number(after)); }
    if (before != null) { clauses.push("id<?"); params.push(Number(before)); }
    if (streams.length) { clauses.push(`stream IN (${streams.map(() => "?").join(",")})`); params.push(...streams); }
    if (query) {
      clauses.push("(text LIKE ? ESCAPE '\\' OR COALESCE(command,'') LIKE ? ESCAPE '\\')");
      const needle = `%${String(query).slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
      params.push(needle, needle);
    }
    const where = clauses.join(" AND ");
    const total = Number(this.db.prepare(`SELECT COUNT(*) total FROM run_logs WHERE ${where}`).get(...params).total);
    const descending = after == null;
    const rows = this.db.prepare(`SELECT * FROM run_logs WHERE ${where} ORDER BY id ${descending ? "DESC" : "ASC"} LIMIT ?`).all(...params, size);
    const items = (descending ? rows.reverse() : rows).map((row) => ({
      ...row,
      text: this.redactor.text(row.text),
      command: row.command ? this.redactor.text(row.command) : null,
    }));
    return { items, total, oldest: items[0]?.id ?? null, newest: items.at(-1)?.id ?? null, hasMore: after == null && total > items.length };
  }

  addActivity({ projectId = null, taskId = null, type, title, body = "", dedupeKey }) {
    const id = randomUUID();
    const info = this.db.prepare(`INSERT OR IGNORE INTO activities (id,project_id,task_id,type,title,body,dedupe_key,read,created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`).run(id, projectId, taskId, type, title, body, dedupeKey, now());
    if (!info.changes) return null;
    return this.db.prepare("SELECT * FROM activities WHERE id=?").get(id);
  }

  activities(page = 1, pageSize = 50) {
    const size = Math.min(Math.max(1, Number(pageSize) || 50), 200);
    const current = Math.max(1, Math.trunc(Number(page)) || 1);
    const total = Number(this.db.prepare("SELECT COUNT(*) total FROM activities").get().total);
    const totalPages = Math.max(1, Math.ceil(total / size));
    const safePage = Math.min(current, totalPages);
    const items = this.db.prepare("SELECT * FROM activities ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?").all(size, (safePage - 1) * size);
    return { items, page: safePage, pageSize: size, total, totalPages: total ? totalPages : 0, unread: this.unreadActivityCount() };
  }

  unreadActivityCount() { return Number(this.db.prepare("SELECT COUNT(*) total FROM activities WHERE read=0").get().total); }
  readActivity(id) { return this.db.prepare("UPDATE activities SET read=1 WHERE id=?").run(id).changes > 0; }
  readAllActivities() { return this.db.prepare("UPDATE activities SET read=1 WHERE read=0").run().changes; }
  // 清空已读活动，未读活动必须保留。
  clearReadActivities() { return this.db.prepare("DELETE FROM activities WHERE read=1").run().changes; }

  readTask(id) { this.updateTask(id, { unread: 0 }); }

  eventAttachment(eventId, index) {
    // 不能限制 role：附件不只出现在用户消息里，智能体也会主动发图（attach_image）。
    // 界面侧对任何事件的 raw.attachments 都会渲染，这里必须保持一致，否则图能显示成缩略图却取不到内容。
    const row = this.db.prepare("SELECT raw_json FROM events WHERE id=?").get(eventId);
    if (!row?.raw_json || !Number.isInteger(index) || index < 0) return null;
    try {
      const item = JSON.parse(row.raw_json)?.attachments?.[index];
      return item && typeof item.path === "string" && typeof item.name === "string" && typeof item.mime === "string" ? item : null;
    } catch { return null; }
  }

  queuedMessage(taskId, eventId = null) {
    const row = eventId == null
      ? this.db.prepare("SELECT * FROM events WHERE task_id=? AND type='queued_message' ORDER BY id LIMIT 1").get(taskId)
      : this.db.prepare("SELECT * FROM events WHERE id=? AND task_id=? AND type='queued_message'").get(eventId, taskId);
    return row ? parseRaw(row) : null;
  }

  deleteQueuedMessage(taskId, eventId) {
    return this.db.prepare("DELETE FROM events WHERE id=? AND task_id=? AND type='queued_message'").run(eventId, taskId).changes > 0;
  }

  takeQueuedMessage(taskId, eventId = null) {
    const queued = this.queuedMessage(taskId, eventId);
    if (queued) this.deleteQueuedMessage(taskId, queued.id);
    return queued;
  }

  createApproval({ taskId, runId, provider, externalRequestId, title, detail, options }) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO approvals
      (id,task_id,run_id,provider,external_request_id,title,detail,options_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, taskId, runId, provider, String(externalRequestId), title, detail,
      JSON.stringify(options || []), "pending", now());
    this.db.prepare("UPDATE runs SET status='waiting_approval' WHERE id=?").run(runId);
    return this.approval(id);
  }

  approval(id) { const value = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id); return value && parseOptions(value); }
  decideApproval(id, decision) {
    this.db.prepare("UPDATE approvals SET status='decided', decision=?, decided_at=? WHERE id=? AND status='pending'").run(decision, now(), id);
    const item = this.approval(id);
    if (item) this.db.prepare("UPDATE runs SET status='running' WHERE id=? AND status='waiting_approval'").run(item.run_id);
    return item;
  }

  setting(key, fallback = null) { return this.db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? fallback; }
  setSetting(key, value) { this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value)); }

  /* ---------------- Deepseek 多账号元数据（密钥始终只在钥匙串） ---------------- */

  deepseekAccounts() { return this.db.prepare("SELECT * FROM deepseek_accounts ORDER BY created_at, rowid").all(); }
  deepseekAccount(id) { return id ? this.db.prepare("SELECT * FROM deepseek_accounts WHERE id=?").get(id) || null : null; }
  deepseekAccountByAlias(alias) { return this.db.prepare("SELECT * FROM deepseek_accounts WHERE alias=?").get(alias) || null; }
  createDeepseekAccount({ id, alias, lastFour }) {
    const stamp = now();
    this.db.prepare("INSERT INTO deepseek_accounts (id,alias,last_four,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, alias, lastFour || null, stamp, stamp);
    return this.deepseekAccount(id);
  }
  renameDeepseekAccount(id, alias) {
    this.db.prepare("UPDATE deepseek_accounts SET alias=?, updated_at=? WHERE id=?").run(alias, now(), id);
    return this.deepseekAccount(id);
  }
  updateDeepseekAccountKey(id, lastFour) {
    this.db.prepare("UPDATE deepseek_accounts SET last_four=?, updated_at=? WHERE id=?").run(lastFour || null, now(), id);
    return this.deepseekAccount(id);
  }
  deleteDeepseekAccount(id) { return this.db.prepare("DELETE FROM deepseek_accounts WHERE id=?").run(id).changes > 0; }
  activeDeepseekAccountId() { return this.setting("deepseek.activeAccount", "") || null; }
  setActiveDeepseekAccount(id) { this.setSetting("deepseek.activeAccount", id || ""); }

  enableWorkbenchSync(taskId, assignment = null) {
    this.db.prepare("INSERT OR IGNORE INTO workbench_sync (task_id,updated_at) VALUES (?,?)").run(taskId, now());
    if (assignment) this.db.prepare("UPDATE workbench_sync SET external_project_id=?,external_requirement_id=?,external_task_kind=?,updated_at=? WHERE task_id=?")
      .run(assignment.projectId, assignment.requirementId, assignment.kind, now(), taskId);
  }

  pendingWorkbenchSync() {
    return this.db.prepare(`SELECT t.*, p.name project_name, p.workspace, w.external_id, w.synced_status, w.synced_title, w.synced_description, w.last_error,
      w.external_project_id, w.external_requirement_id, w.external_task_kind,
      COALESCE(w.external_kind,'task') external_kind
      FROM workbench_sync w JOIN tasks t ON t.id=w.task_id JOIN projects p ON p.id=t.project_id
      WHERE (COALESCE(w.external_kind,'task')='issue' AND w.external_id IS NOT NULL AND w.synced_status!=t.status)
        OR (COALESCE(w.external_kind,'task')='task' AND (w.external_id IS NULL OR w.synced_status!=t.status OR w.synced_title IS NOT t.title OR w.synced_description IS NOT t.description))
      ORDER BY t.updated_at`).all();
  }

  markWorkbenchSync(taskId, { externalId, status, title, description, error = null, kind = null }) {
    this.db.prepare(`UPDATE workbench_sync SET external_id=COALESCE(?,external_id),
      synced_status=COALESCE(?,synced_status), external_kind=COALESCE(?,external_kind,'task'),
      synced_title=COALESCE(?,synced_title),synced_description=COALESCE(?,synced_description),
      last_error=?,updated_at=? WHERE task_id=?`)
      .run(externalId || null, status || null, kind || null, title ?? null, description ?? null, error, now(), taskId);
  }

  /** 按工作台任务 id 反查本地任务，反向拉取时用它去重。 */
  workbenchTaskByExternal(externalId) {
    if (!externalId) return null;
    const row = this.db.prepare(`SELECT t.*, p.name project_name, p.workspace,
      EXISTS(SELECT 1 FROM workbench_sync w WHERE w.task_id=t.id) workbench_sync,
      0 duration_seconds, NULL active_run_started_at
      FROM workbench_sync w JOIN tasks t ON t.id=w.task_id JOIN projects p ON p.id=t.project_id
      WHERE w.external_id=?`).get(String(externalId));
    return row ? parseTask(row) : null;
  }

  /**
   * 取出任务（含其子任务）关联的开发台任务 id。
   * 删除本地任务会级联子任务，单个开发台任务只关联在 root 上，但这里一并收集以防子任务也有独立关联。
   */
  workbenchExternalIds(taskId) {
    return this.db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM tasks WHERE id=? UNION ALL SELECT tasks.id FROM tasks JOIN tree ON tasks.parent_id=tree.id
    ) SELECT w.external_id external_id FROM workbench_sync w
      WHERE w.task_id IN (SELECT id FROM tree) AND w.external_id IS NOT NULL`).all(taskId).map((row) => String(row.external_id));
  }

  /** 任务（含子任务）的工作台关联，带类型；删除/改派按「任务 or 问题」分派。 */
  workbenchLinks(taskId) {
    return this.db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM tasks WHERE id=? UNION ALL SELECT tasks.id FROM tasks JOIN tree ON tasks.parent_id=tree.id
    ) SELECT w.external_id external_id, COALESCE(w.external_kind,'task') external_kind FROM workbench_sync w
      WHERE w.task_id IN (SELECT id FROM tree) AND w.external_id IS NOT NULL`).all(taskId)
      .map((row) => ({ external_id: String(row.external_id), external_kind: String(row.external_kind || "task") }));
  }

  /** 已从本地删除、不再需要自动拉回的工作台问题 id（问题没有可用的归档接口）。 */
  workbenchDismissedIssues() {
    try {
      const parsed = JSON.parse(this.setting("workbench.dismissedIssues", ""));
      return Array.isArray(parsed) ? [...new Set(parsed.map((item) => String(item)).filter(Boolean))] : [];
    } catch { return []; }
  }

  dismissWorkbenchIssues(externalIds) {
    const merged = [...new Set([...this.workbenchDismissedIssues(), ...(externalIds || []).map((item) => String(item)).filter(Boolean)])];
    this.setSetting("workbench.dismissedIssues", JSON.stringify(merged));
    return merged;
  }

  /** 恢复被忽略的问题：从本地忽略列表移除，之后拉取会重新带入。 */
  restoreWorkbenchIssues(externalIds) {
    const remove = new Set((externalIds || []).map((item) => String(item)).filter(Boolean));
    const remaining = this.workbenchDismissedIssues().filter((item) => !remove.has(item));
    this.setSetting("workbench.dismissedIssues", JSON.stringify(remaining));
    return { dismissed: remaining, restored: [...remove] };
  }

  /** 已存在的本地任务补写工作台关联，避免反向拉取重复建单。 */
  linkWorkbenchTask(taskId, externalId, status, kind = "task") {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.enableWorkbenchSync(taskId);
      this.db.prepare(`UPDATE workbench_sync SET external_id=?, synced_status=COALESCE(?,synced_status),
        external_kind=?,synced_title=(SELECT title FROM tasks WHERE id=?),synced_description=(SELECT description FROM tasks WHERE id=?),
        last_error=NULL, updated_at=? WHERE task_id=?`).run(String(externalId), status || null, kind, taskId, taskId, now(), taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 反向拉取：把工作台未开始任务落成本地待办，并记录关联的工作台任务 id。 */
  importWorkbenchTask({ projectId, title, description, externalId, kind = "task" }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 拉取的任务已经存在于工作台，只做本地登记：默认 Deepseek + 模型/Effort 走运行时默认、完全访问，
      // 之后仍可在任务详情里改执行者、模型与推理强度。
      const task = this.insertTask({
        projectId, title, description,
        provider: "deepseek", model: null, effort: null,
        permission: "danger-full-access", phase: "standalone", status: "todo",
      });
      this.db.prepare("INSERT OR IGNORE INTO workbench_sync (task_id,external_kind,updated_at) VALUES (?,?,?)").run(task.id, kind, now());
      this.db.prepare(`UPDATE workbench_sync SET external_id=?, synced_status='todo', external_kind=?,synced_title=?,synced_description=?,last_error=NULL, updated_at=? WHERE task_id=?`)
        .run(String(externalId), kind, task.title, task.description, now(), task.id);
      this.db.exec("COMMIT");
      return task;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  delegation(parentTaskId, idempotencyKey) {
    return this.db.prepare(`SELECT t.* FROM delegations d JOIN tasks t ON t.id=d.child_task_id
      WHERE d.parent_task_id=? AND d.idempotency_key=?`).get(parentTaskId, idempotencyKey);
  }

  delegationDepth(taskId) {
    let depth = 0;
    let task = this.task(taskId);
    while (task?.parent_id) { depth += 1; task = this.task(task.parent_id); }
    return depth;
  }

  createDelegatedTask(parent, input) {
    const previous = this.delegation(parent.id, input.idempotencyKey);
    if (previous) return previous;
    const child = this.insertTask({
      projectId: parent.project_id, title: input.title, description: input.description,
      provider: input.provider, permission: parent.permission, autoExecute: Boolean(parent.auto_execute),
      phase: "standalone", parentId: parent.id, rootId: parent.root_id || null, hidden: Boolean(parent.root_id),
    });
    this.db.prepare("INSERT INTO delegations VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), parent.id, child.id, parent.provider, input.provider, input.idempotencyKey, now());
    return child;
  }

  /* ---------------- 音乐播放器歌单 ---------------- */

  musicPlaylists() {
    const playlists = this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM music_playlist_items i WHERE i.playlist_id=p.id) count
      FROM music_playlists p ORDER BY p.created_at`).all();
    if (!playlists.length) return playlists;
    // 歌单数量通常很少，直接把条目内嵌返回，前端一次请求即可拿到完整结构。
    const items = this.db.prepare("SELECT playlist_id, path, position FROM music_playlist_items ORDER BY position, id").all();
    const grouped = new Map();
    for (const item of items) {
      if (!grouped.has(item.playlist_id)) grouped.set(item.playlist_id, []);
      grouped.get(item.playlist_id).push({ path: item.path, position: item.position });
    }
    return playlists.map((playlist) => ({ ...playlist, items: grouped.get(playlist.id) || [] }));
  }

  musicPlaylist(id) {
    const playlist = this.db.prepare("SELECT * FROM music_playlists WHERE id=?").get(id);
    if (!playlist) return null;
    const items = this.db.prepare("SELECT id, path, position FROM music_playlist_items WHERE playlist_id=? ORDER BY position, id").all(id);
    return { ...playlist, items };
  }

  createMusicPlaylist(name) {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare("INSERT INTO music_playlists VALUES (?,?,?,?)").run(id, name, stamp, stamp);
    return this.musicPlaylist(id);
  }

  renameMusicPlaylist(id, name) {
    this.db.prepare("UPDATE music_playlists SET name=?, updated_at=? WHERE id=?").run(name, now(), id);
    return this.musicPlaylist(id);
  }

  deleteMusicPlaylist(id) {
    this.db.prepare("DELETE FROM music_playlist_items WHERE playlist_id=?").run(id);
    return this.db.prepare("DELETE FROM music_playlists WHERE id=?").run(id).changes > 0;
  }

  /** 追加曲目到歌单末尾，已存在的路径自动跳过。 */
  addMusicItems(playlistId, paths) {
    const existing = new Set(this.db.prepare("SELECT path FROM music_playlist_items WHERE playlist_id=?").all(playlistId).map((row) => row.path));
    let position = Number(this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 n FROM music_playlist_items WHERE playlist_id=?").get(playlistId).n);
    const insert = this.db.prepare("INSERT INTO music_playlist_items (playlist_id,path,position,created_at) VALUES (?,?,?,?)");
    let added = 0;
    for (const item of paths) {
      if (existing.has(item)) continue;
      existing.add(item);
      insert.run(playlistId, item, position, now());
      position += 1;
      added += 1;
    }
    if (added) this.db.prepare("UPDATE music_playlists SET updated_at=? WHERE id=?").run(now(), playlistId);
    return { added, playlist: this.musicPlaylist(playlistId) };
  }

  removeMusicItem(playlistId, itemPath) {
    const changed = this.db.prepare("DELETE FROM music_playlist_items WHERE playlist_id=? AND path=?").run(playlistId, itemPath).changes;
    if (changed) this.db.prepare("UPDATE music_playlists SET updated_at=? WHERE id=?").run(now(), playlistId);
    return changed > 0;
  }

  /** 按给定顺序重排歌单（只保留传入的路径）。 */
  setMusicItems(playlistId, paths) {
    this.db.prepare("DELETE FROM music_playlist_items WHERE playlist_id=?").run(playlistId);
    const insert = this.db.prepare("INSERT INTO music_playlist_items (playlist_id,path,position,created_at) VALUES (?,?,?,?)");
    const stamp = now();
    paths.forEach((item, index) => insert.run(playlistId, item, index, stamp));
    this.db.prepare("UPDATE music_playlists SET updated_at=? WHERE id=?").run(stamp, playlistId);
    return this.musicPlaylist(playlistId);
  }
}

// raw_json 是事件正文的两倍体积来源：解析成 raw 后就不再回传原始字符串，详情响应因此接近减半。
function parseRaw(row) { const { raw_json, ...rest } = row; return { ...rest, raw: raw_json ? JSON.parse(raw_json) : null }; }
function parseOptions(row) { return { ...row, options: row.options_json ? JSON.parse(row.options_json) : [] }; }
// 任务说明附件以 JSON 存在 tasks.attachments 里；对上层始终是数组，避免每个调用点各自解析。
function parseTask(row) { return row ? { ...row, attachments: parseAttachments(row.attachments) } : row; }
function parseAttachments(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function compactEvents(events) {
  const result = [];
  let deltaIndex = -1;
  for (const event of events) {
    const method = event.raw?.method;
    if (method === "item/agentMessage/delta") {
      if (deltaIndex >= 0) result[deltaIndex] = { ...result[deltaIndex], content: result[deltaIndex].content + event.content, raw: event.raw };
      else { result.push(event); deltaIndex = result.length - 1; }
      continue;
    }
    if (method === "item/started" && event.raw?.params?.item?.type === "agentMessage") deltaIndex = -1;
    if (method === "item/completed" && event.raw?.params?.item?.type === "agentMessage" && deltaIndex >= 0) result.splice(deltaIndex, 1);
    deltaIndex = -1;
    result.push(event);
  }
  return result;
}

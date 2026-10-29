const BASE_URL = "https://cl.chuanlie.cc";
const STATUS = { todo: "todo", running: "doing", in_review: "review", blocked: "block", done: "done" };
// 洛神赋本地状态 → 开发台「问题」状态。问题有独立的状态流（新提交/已确认/修复中/待测试/测试打回/测试通过/已关闭）。
// 拉取进来的问题初始 synced_status='todo' 与本地待执行一致，所以首次同步不会把开发台已有状态改回去。
// blocked 故意不映射：阻塞时保持开发台问题原状态，避免显示成「修复中」误导协作方。
const ISSUE_STATUS = { todo: "confirmed", running: "fixing", in_review: "testing", done: "testing", canceled: "closed" };
// /api/dev/tasks 的 assignee 只接受登录名，传别的值会返回 400「assignee 不合法」。
// 改派名单由使用者在设置里维护（存 workbench.members）。
export const WORKBENCH_MEMBERS = [];
// 名单存储格式是 JSON 数组；解析失败或为空时返回空名单。
export function parseWorkbenchMembers(raw) {
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))];
        if (list.length) return list;
      }
    } catch { /* 存储损坏时回退默认名单 */ }
  }
  return [...WORKBENCH_MEMBERS];
}
// 待办列表路径：优先带 assignee 过滤，把「所有人 + 未开始」收窄到「我 + 未开始」，避免拉回上千条历史。
function openTasksPath(assignee = "") {
  const query = new URLSearchParams({ status: "todo" });
  if (assignee) query.set("assignee", assignee);
  return `/api/dev/tasks?${query}`;
}
// 工作台里「未开始」既可能是英文 backlog/todo，也可能是界面上的中文状态（如运营任务的「待处理」）；
// 反向拉取时都算待办，避免运营模块的任务因为状态是中文而漏拉。
const OPEN_STATUSES = new Set(["backlog", "todo", "待处理", "待办", "未开始", "待开始", "待执行", "未分配"]);
// 问题（issues）与任务是两个模块、两套状态流。
// 新建拉取只认「已确认（confirmed）」：新提交（new）还没确认，不进开发流程，也就不存在跳过确认的问题。
const PULL_ISSUE_STATUS = "confirmed";
// 已经拉进来的问题继续跟踪这些状态；测试打回（rejected）要回流，把本地任务重新打开。
const TRACKED_ISSUE_STATUSES = new Set(["confirmed", "fixing", "testing", "rejected"]);
// 打回说明写进任务描述时的固定前缀，用于覆盖旧说明而不是不断追加。
const REJECTED_MARK = "【测试不通过】";
const LOCAL_MARKER = /^洛神赋-ID:\s*(\S+)\s*$/;
// 反向拉取时写入任务说明的来源行，例如「来源：Lo查查工作台 L0-21（dt_14f3363221）」。
// 问题写「来源：Lo查查工作台问题（bug_xxx）」；负向前瞻把两者分开，避免问题关联被当作任务回写。
const IMPORT_SOURCE = /来源：Lo查查工作台(?!问题)[^\n（]*（([^）\n]+)）/;
const IMPORT_ISSUE_SOURCE = /来源：Lo查查工作台问题[^\n（]*（([^）\n]+)）/;
const ARCHIVE_SOURCE = /^归档来源：洛神赋对话\s+\S+\s*$/m;

export class WorkbenchSync {
  constructor({ store, readKey, onPulled = () => {} }) {
    this.store = store;
    this.readKey = readKey;
    this.onPulled = onPulled;
    this.syncTimer = setInterval(() => this.kick(), 60_000);
    this.pullTimer = setInterval(() => void this.pullBound(true).catch((error) => console.error(`[luoshenfu] 工作台自动拉取失败：${error.message}`)), 300_000);
    this.syncTimer.unref();
    this.pullTimer.unref();
  }

  kick() {
    this.queued = true;
    if (!this.running) this.running = (async () => {
      while (this.queued) { this.queued = false; await this.sync(); }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async request(method, pathname, body) {
    const key = await this.readKey();
    if (!key) throw new Error("请先在设置中配置工作台 API Key");
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
    const result = await response.json();
    if (!response.ok || result?.ok === false) throw new Error(`工作台连接失败（${response.status}）`);
    return result;
  }

  async test() {
    const result = await this.request("GET", "/api/dev/me");
    const user = result.user || result.data || result;
    const name = user.username || user.name || user.email || "已连接";
    this.store.setSetting("workbench.user", name);
    return { ok: true, user: name };
  }

  assignmentOptions() { return this.request("GET", "/api/dev/task-assignment-options"); }

  listTasks({ status = "", includeArchived = true, page = 0 } = {}) {
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    if (includeArchived) query.set("include_archived", "1");
    if (page > 0) query.set("page", String(page));
    return this.request("GET", `/api/dev/tasks${query.size ? `?${query}` : ""}`);
  }

  createTask(input) { return this.request("POST", "/api/dev/tasks", input); }

  updateTask(externalId, input) { return this.request("PATCH", `/api/dev/tasks/${encodeURIComponent(externalId)}`, input); }

  /**
   * 读取「我 + 未开始」的待办。带 assignee 过滤失败时逐级回退（只按状态 → 全量），
   * 保证开发台接口变化时不会完全拉不到，同时正常路径稳定在 KB 级。
   */
  async listOpen(assignee = "") {
    const attempts = [...new Set([openTasksPath(assignee), openTasksPath(""), "/api/dev/tasks"])];
    let lastError;
    for (const pathname of attempts) {
      try { return await this.request("GET", pathname); }
      catch (error) { lastError = error; }
    }
    throw lastError;
  }

  /** 读取问题的原始列表；该接口不按 assignee 过滤，负责人过滤由 pull 在本地完成。 */
  async listIssues() {
    return await this.request("GET", "/api/dev/issues");
  }

  /** 同步删除：开发台任务没有 DELETE，删除就是软删除（archive）。404 视为已不存在，同样算成功，避免本地任务删不掉。 */
  async remove(externalId) {
    try {
      await this.request("POST", `/api/dev/tasks/${encodeURIComponent(externalId)}/archive`);
    } catch (error) {
      if (!/404/.test(error.message)) throw error;
    }
    return { ok: true };
  }

  /** 改派：任务走 /tasks，问题走 /issues；本地副本由调用方按「彻底删除」处理。 */
  async assign(externalId, assignee, kind = "task") {
    const base = kind === "issue" ? "/api/dev/issues" : "/api/dev/tasks";
    await this.request("PATCH", `${base}/${encodeURIComponent(externalId)}`, { assignee });
    return { ok: true, assignee };
  }

  async sync() {
    if (!await this.readKey()) return;
    for (const task of this.store.pendingWorkbenchSync()) {
      // 问题只回写状态：不能在开发台重复建单，关联由反向拉取建立。
      if (task.external_kind === "issue") { await this.syncIssue(task); continue; }
      let creating = false;
      try {
        let externalId = task.external_id;
        let syncedStatus = task.synced_status;
        let syncedTitle = task.synced_title;
        let syncedDescription = task.synced_description;
        if (!externalId) {
          // 反向拉取的任务已经存在于工作台，说明里带「来源：Lo查查工作台（dt_xxx）」：
          // 即使关联记录丢失，也只补回关联，绝不调用创建接口，避免在工作台重复建单。
          const issueSource = importIssueSourceId(task.description);
          const importedFrom = issueSource || importSourceId(task.description);
          if (importedFrom) {
            externalId = importedFrom;
            syncedStatus = task.status;
            // 问题只补关联、不回写状态：问题的状态流与任务不同，交给工作台自己维护。
            this.store.markWorkbenchSync(task.id, { externalId, status: task.status, title: task.title, description: task.description, kind: issueSource ? "issue" : "task" });
          } else {
            const marker = `洛神赋-ID: ${task.id}`;
            const listed = task.last_error?.startsWith("创建结果待确认：") ? await this.request("GET", openTasksPath(this.store.setting("workbench.user", ""))) : null;
            externalId = listed?.tasks?.find((item) => item.detail?.split(/\r?\n/).includes(marker))?.id;
            const recovered = Boolean(externalId);
            if (!externalId) {
              creating = true;
              const created = await this.createTask({
                title: task.title.slice(0, 120),
                detail: remoteTaskDetail(task.description, marker),
                priority: "P2",
                repo: task.project_name.slice(0, 80),
                ...(task.external_project_id ? { project_id: task.external_project_id, requirement_id: task.external_requirement_id, kind: task.external_task_kind } : {}),
              });
              externalId = created.id || created.task?.id || created.data?.id;
              if (!externalId) throw new Error("工作台未返回任务 ID");
              creating = false;
            }
            syncedStatus = recovered ? null : "todo";
            syncedTitle = recovered ? null : task.title;
            syncedDescription = recovered ? null : task.description;
            this.store.markWorkbenchSync(task.id, { externalId, status: syncedStatus, title: syncedTitle, description: syncedDescription });
          }
        }
        const target = STATUS[task.status];
        if (target && syncedStatus !== task.status) {
          await this.updateTask(externalId, { status: target });
          this.store.markWorkbenchSync(task.id, { externalId, status: task.status });
        }
        if (!target && syncedStatus !== task.status) this.store.markWorkbenchSync(task.id, { externalId, status: task.status });
        const patch = {};
        if (syncedTitle !== task.title) patch.title = task.title.slice(0, 120);
        if (syncedDescription !== task.description) patch.detail = remoteTaskDetail(task.description, `洛神赋-ID: ${task.id}`);
        if (Object.keys(patch).length) await this.updateTask(externalId, patch);
        this.store.markWorkbenchSync(task.id, { externalId, status: task.status, title: task.title, description: task.description });
      } catch (error) {
        this.store.markWorkbenchSync(task.id, { error: `${creating ? "创建结果待确认：" : ""}${error.message}` });
      }
    }
  }

  /**
   * 问题状态回写：本地任务进入执行中/完成等状态时，把开发台问题改成对应的问题状态。
   * 只在本地状态相对上次同步发生变化时发请求；失败记录 last_error，下轮同步重试。
   */
  async syncIssue(task) {
    const target = ISSUE_STATUS[task.status];
    if (!task.external_id || !target || task.synced_status === task.status) return;
    try {
      await this.request("PATCH", `/api/dev/issues/${encodeURIComponent(task.external_id)}`, { status: target });
      this.store.markWorkbenchSync(task.id, { status: task.status, error: null, kind: "issue" });
    } catch (error) {
      this.store.markWorkbenchSync(task.id, { error: error.message, kind: "issue" });
    }
  }

  close() { clearInterval(this.syncTimer); clearInterval(this.pullTimer); }

  // ---- 反向拉取：把工作台未开始的待办任务落到本地「待执行」列 ----

  async pullBound(optional = false) {
    if (!await this.readKey()) {
      if (optional) return null;
      throw new Error("请先在设置中配置 Lo查查工作台 API Key");
    }
    const projectId = this.store.setting("workbench.projectId", "");
    if (!projectId || !this.store.project(projectId)) {
      if (optional) return null;
      throw new Error("请先在设置中为 Lo查查工作台绑定项目");
    }
    if (!this.pulling) this.pulling = this.pull(projectId).then((result) => {
      this.onPulled(result);
      return result;
    }).finally(() => { this.pulling = null; });
    return this.pulling;
  }

  /**
   * 只拉取未开始（backlog / todo）且未归档、归属于当前账号的任务。
   * 已有关联 external_id 的直接跳过；详情里带「洛神赋-ID」标记的只补关联，不重复建单。
   */
  async pull(projectId = null) {
    const projects = this.store.projects();
    if (!projects.length) throw new Error("请先添加一个本地项目，再拉取工作台待办任务");
    // 先取身份再拉列表：开发台全量有上千条历史（实测 1MB+），只按 status=todo 仍会带上所有人的待办；
    // 锁定「我 + 未开始」后稳定在 KB 级。assignee 只认登录名，拿不到时退回只按状态过滤。
    const me = await this.request("GET", "/api/dev/me").catch(() => null);
    const username = typeof me?.username === "string" ? me.username.trim() : "";
    if (username) this.store.setSetting("workbench.user", username);
    // /api/dev/me 偶发失败时不能把身份丢空：身份为空会让下面的负责人过滤整体失效，
    // 退化成「工作台所有人的待办都拉进来」。这里用上次成功保存的登录名兜底。
    const assignee = username || String(this.store.setting("workbench.user", "") || "").trim();
    const payload = await this.listOpen(assignee);
    // 工作台负责人字段可能是登录名或姓名，统一按本人处理。
    const selfNames = new Set([me?.username, me?.real_name, me?.persona, me?.user?.username, me?.user?.name, assignee].filter(Boolean).map(String));
    const list = Array.isArray(payload?.tasks) ? payload.tasks : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const fallbackProjectId = projectId && this.store.project(projectId) ? projectId : projects[0].id;
    const summary = { total: 0, issues: 0, created: 0, linked: 0, skipped: 0, reopened: 0, projectId: fallbackProjectId, taskIds: [] };
    for (const item of list) {
      const externalId = externalIdOf(item);
      if (!externalId || !isOpen(item)) continue;
      if (ARCHIVE_SOURCE.test(String(item.detail || ""))) continue;
      // 身份未知（拿不到登录名，也没有保存过的）时宁可不拉，避免把别人名下的待办误当成自己的拉进来。
      if (!selfNames.size) continue;
      if (item.assignee && !selfNames.has(String(item.assignee))) continue;
      summary.total += 1;
      if (this.store.workbenchTaskByExternal(externalId)) { summary.skipped += 1; continue; }
      const markerId = markerTaskId(item.detail);
      const existing = markerId ? this.store.task(markerId) : null;
      if (existing) {
        this.store.linkWorkbenchTask(existing.id, externalId, existing.status);
        summary.linked += 1;
        continue;
      }
      const task = this.store.importWorkbenchTask({
        projectId: pickProjectId(projects, item, projectId),
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 200) : `工作台任务 ${externalId}`,
        description: workbenchDescription(item, externalId),
        externalId,
      });
      summary.created += 1;
      summary.taskIds.push(task.id);
    }
    // 问题接口的 assignee 参数无效（实测传谁都返回同一批可见问题），只能在本地按负责人过滤；
    // 身份未知时宁可不拉，避免把别人名下的问题误拉进来。
    const issuesPayload = await this.listIssues().catch(() => null);
    const issues = Array.isArray(issuesPayload?.issues) ? issuesPayload.issues : [];
    const dismissed = new Set(this.store.workbenchDismissedIssues());
    for (const item of issues) {
      const externalId = externalIdOf(item);
      if (!externalId || !isTrackedIssue(item)) continue;
      // 已经转成任务的问题由任务通道负责，这里跳过，避免同一件事出现两份。
      if (item.task_id) continue;
      const owner = String(item.assignee || "").trim();
      if (!selfNames.size || !owner || !selfNames.has(owner)) continue;
      const existing = this.store.workbenchTaskByExternal(externalId);
      if (existing) {
        // 测试打回：本地重新打开为待处理，并把打回说明写进任务描述。
        if (String(item.status || "").toLowerCase() === "rejected" && this.reopenRejectedIssue(existing, item)) summary.reopened += 1;
        summary.skipped += 1;
        continue;
      }
      // 只有已确认的问题才新建本地任务；new（新提交）尚未确认，不拉取。
      if (String(item.status || "").toLowerCase() !== PULL_ISSUE_STATUS) continue;
      if (dismissed.has(externalId)) continue;
      summary.issues += 1;
      const task = this.store.importWorkbenchTask({
        projectId: pickProjectId(projects, item, projectId),
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 200) : `工作台问题 ${externalId}`,
        description: issueDescription(item, externalId),
        externalId,
        kind: "issue",
      });
      summary.created += 1;
      summary.taskIds.push(task.id);
    }
    return summary;
  }

  /**
   * 测试打回：把本地任务重新打开为「待处理」，并把打回说明写进任务描述。
   * 同时把 synced_status 对齐成 todo，避免下一轮回写把开发台的「测试打回」改回「已确认」。
   * 返回是否发生了实际变化。
   */
  reopenRejectedIssue(task, item) {
    const description = withRejectedNote(task.description, rejectedNote(item));
    const changed = task.status !== "todo" || description !== task.description;
    if (changed) this.store.updateTask(task.id, { status: "todo", description });
    this.store.markWorkbenchSync(task.id, { status: "todo", error: null, kind: "issue" });
    return changed;
  }
}

function externalIdOf(item) {
  const id = item?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

function isOpen(item) {
  if (!item || item.archived || item.archived_at || item.archivedAt) return false;
  // 状态缺失时按「未开始」处理：工作台待办列表本来就以 todo 为主。
  return OPEN_STATUSES.has(String(item.status || "todo").toLowerCase());
}

// 已拉取的问题继续跟踪的状态；new（新提交）与 passed/closed 都不在跟踪范围内。
function isTrackedIssue(item) {
  if (!item || item.archived || item.archived_at || item.archivedAt) return false;
  return TRACKED_ISSUE_STATUSES.has(String(item.status || "").toLowerCase());
}

function markerTaskId(detail) {
  if (typeof detail !== "string") return "";
  for (const row of detail.split(/\r?\n/)) {
    const match = row.trim().match(LOCAL_MARKER);
    if (match) return match[1];
  }
  return "";
}

// 从「来源：Lo查查工作台（dt_xxx）」还原工作台任务 id，用于关联丢失时只补关联、不重复建单。
function importSourceId(description) {
  const match = String(description || "").match(IMPORT_SOURCE);
  return match ? match[1].trim() : "";
}

// 从「来源：Lo查查工作台问题（bug_xxx）」还原工作台问题 id，同样只在关联丢失时补关联。
function importIssueSourceId(description) {
  const match = String(description || "").match(IMPORT_ISSUE_SOURCE);
  return match ? match[1].trim() : "";
}

// 问题的字段结构和任务不同：没有 detail，改按模块/严重级别/复现步骤等组装说明。
function issueDescription(item, externalId) {
  const rows = [`来源：Lo查查工作台问题（${externalId}）`];
  const meta = [];
  if (item.module) meta.push(`模块：${item.module}`);
  if (item.severity) meta.push(`严重级别：${item.severity}`);
  const statusLabel = item.status_label || item.status;
  if (statusLabel) meta.push(`问题状态：${statusLabel}`);
  if (item.device) meta.push(`设备：${item.device}`);
  if (meta.length) rows.push(meta.join("　"));
  if (item.steps) rows.push(`\n复现步骤：\n${item.steps}`);
  if (item.expected) rows.push(`\n预期结果：\n${item.expected}`);
  if (item.actual) rows.push(`\n实际结果：\n${item.actual}`);
  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  if (attachments.length) rows.push(`\n附件：${attachments.length} 个（请到工作台问题 ${externalId} 查看）`);
  return rows.join("\n").slice(0, 20_000);
}

// 从问题的处理时间线里找最近一次「测试打回」，生成一行可读的打回说明。
function rejectedNote(item) {
  const rows = Array.isArray(item.timeline) ? item.timeline : [];
  const hit = [...rows].reverse().find((row) => /打回/.test(`${row?.action || ""} ${row?.text || ""}`));
  const at = hit?.at ? new Date(hit.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const by = String(hit?.by || "").trim();
  const text = String(hit?.text || "测试未通过，请按反馈重新处理。").replace(/\s*\n\s*/g, " ").trim();
  return `${at ? `${at}${by ? ` · ${by}` : ""}：` : ""}${text}`;
}

// 打回说明固定写在描述末尾，用标记行覆盖旧内容，避免每次拉取不断追加。
function withRejectedNote(description, note) {
  const base = String(description || "").split("\n").filter((row) => !row.startsWith(REJECTED_MARK)).join("\n").trimEnd();
  return `${base ? `${base}\n\n` : ""}${REJECTED_MARK}${note}`;
}

// 详情里的「洛神赋-ID」是同步写回用的内部标记，反向拉取落到任务说明时要去掉。
function workbenchDescription(item, externalId) {
  const body = typeof item.detail === "string"
    ? item.detail.split(/\r?\n/).filter((row) => !LOCAL_MARKER.test(row.trim())).join("\n").trim()
    : "";
  const number = item.identifier || (item.number ? `#${item.number}` : "");
  const header = `来源：Lo查查工作台${number ? ` ${number}` : ""}（${externalId}）`;
  return `${header}${body ? `\n\n${body}` : ""}`.slice(0, 20_000);
}

function remoteTaskDetail(description, marker) {
  const rows = String(description || "").split(/\r?\n/);
  if (IMPORT_SOURCE.test(rows[0] || "")) rows.shift();
  while (rows[0] === "") rows.shift();
  const body = rows.filter((row) => !LOCAL_MARKER.test(row.trim())).join("\n").trim();
  return `${body.slice(0, 2000 - marker.length - 2)}\n\n${marker}`.trim();
}

// 优先用用户当前打开的项目；否则按工作台任务的 repo 名称匹配本地项目，匹配不到落到第一个项目。
function pickProjectId(projects, item, requestedProjectId) {
  if (requestedProjectId && projects.some((project) => project.id === requestedProjectId)) return requestedProjectId;
  const repo = typeof item.repo === "string" ? item.repo.trim() : "";
  if (repo) {
    const base = repo.split(/[\\/]/).filter(Boolean).pop() || repo;
    const matched = projects.find((project) => project.name === repo || project.name === base || project.workspace === repo || project.workspace.endsWith(`/${base}`));
    if (matched) return matched.id;
  }
  return projects[0].id;
}

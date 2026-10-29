import path from "node:path";
import { CodexRuntime } from "./codex.mjs";
import { DeepseekRuntime } from "./deepseek.mjs";
import { readDeepseekKey, readWorkbenchKey } from "./keychain.mjs";
import { WorktreeManager } from "./worktree.mjs";
import { parseWorkbenchMembers } from "./workbench.mjs";
import { deleteSnapshotRefs, snapshotWorktree } from "./git.mjs";

export const defaultLanguage = "zh-CN";
export const supportedLanguages = ["zh-CN", "en", "auto"];
const languageInstructions = {
  "zh-CN": "请始终使用简体中文回复用户，包括进度说明、思考摘要、工具说明和最终结论。",
  en: "Always respond in English, including progress updates, reasoning summaries, tool notes, and final conclusions.",
};

export class Runner {
  constructor({ store, dataDirectory, resourceDirectory, token, baseUrl, broadcast, reconnectDelays }) {
    this.store = store;
    this.broadcast = broadcast;
    this.token = token;
    this.baseUrl = baseUrl;
    this.resourceDirectory = resourceDirectory;
    this.dataDirectory = dataDirectory;
    // 传输层中断后的自动重连退避（毫秒）；长度同时决定最大重连次数。
    this.reconnectDelays = Array.isArray(reconnectDelays) ? [...reconnectDelays] : [3000, 10000, 30000];
    this.runsWithOutput = new Set();
    this.recycleRoot = path.join(dataDirectory, "recycle");
    this.worktree = new WorktreeManager({ store, dataDirectory });
    this.active = new Map();
    this.resumeLocks = new Set();
    this.deepSeekActive = 0;
    this.deepSeekQueue = [];
    this.priorityQueuedMessages = new Map();
    this.forcedOutcomes = new Map();
    this.pendingAgentNotifications = new Map();
    this.pendingLocalApprovals = new Map();
    this.computerAuthorizedRuns = new Set();
    // 慢且易变的账号数据（Codex 额度、各账号余额）走“缓存先返回 + 后台刷新”，
    // 绝不再让一个卡住的接口把整个设置页拖到 60 秒。
    this.rateLimitsCache = null;
    this.balanceCache = new Map();
    this.codexAccountCache = null;
    this.accountRefreshAt = 0;
    this.accountRefreshPromise = null;
    const mcpFile = path.join(resourceDirectory, "server/mcp.mjs");
    const env = (taskId) => ({ LUOSHENFU_BASE_URL: baseUrl, LUOSHENFU_TOKEN: token, LUOSHENFU_TASK_ID: taskId });
    const mcp = {
      codex: (taskId) => ({ command: process.execPath, args: [mcpFile], env: env(taskId) }),
      deepseek: (taskId) => ({ type: "stdio", name: "luoshenfu", command: process.execPath, args: [mcpFile], env: Object.entries(env(taskId)).map(([name, value]) => ({ name, value })) }),
    };
    const callbacks = {
      onEvent: (input) => this.recordEvent(input),
      onApproval: (input) => this.recordApproval(input),
      onAccountChange: () => this.broadcast("account", {}),
      mcp,
    };
    this.codex = new CodexRuntime({ ...callbacks, onExit: (error) => this.runtimeExited("codex", error), onStderr: (chunk) => this.recordRuntimeStderr("codex", null, chunk) });
    this.deepseek = new DeepseekRuntime({ ...callbacks, resourceDirectory, dataDirectory, readKey: (account) => readDeepseekKey(account), currentAccount: () => this.store.activeDeepseekAccountId(), onExit: (error, permission) => this.runtimeExited("deepseek", error, permission), onStderr: (chunk, permission) => this.recordRuntimeStderr("deepseek", permission, chunk) });
    try { const models = JSON.parse(this.store.setting("codex.models", "[]")); this.codex.modelCache = Array.isArray(models) ? models : []; } catch { this.codex.modelCache = []; }
    try { const models = JSON.parse(this.store.setting("deepseek.models", "[]")); this.deepseek.modelCache = Array.isArray(models) ? models : []; } catch { this.deepseek.modelCache = []; }
  }

  async accountSnapshot() {
    const [codex, key, workbenchKey] = await Promise.all([
      this.codexAccount(), this.currentDeepseekKey(), readWorkbenchKey(),
    ]);
    const workbenchProjectId = this.store.setting("workbench.projectId", "");
    const storedCodexModels = parseModelCache(this.store.setting("codex.models", "[]"));
    const storedDeepseekModels = parseModelCache(this.store.setting("deepseek.models", "[]"));
    // 额度、模型、余额都属于慢数据：本次请求只回缓存并立刻响应，后台刷新完成后再广播。
    void this.scheduleAccountRefresh();
    return {
      codex: { ...codex, rateLimits: this.rateLimitsCache },
      deepseek: {
        activeId: this.store.activeDeepseekAccountId(),
        configured: Boolean(key),
        lastFour: key ? key.slice(-4) : null,
        accounts: this.store.deepseekAccounts().map((account) => ({
          id: account.id,
          alias: account.alias,
          lastFour: account.last_four,
          balance: this.balanceCache.get(account.id) || null,
        })),
      },
      workbench: { configured: Boolean(workbenchKey), lastFour: workbenchKey ? workbenchKey.slice(-4) : null, user: this.store.setting("workbench.user", "") || null, projectId: this.store.project(workbenchProjectId) ? workbenchProjectId : null, members: parseWorkbenchMembers(this.store.setting("workbench.members", "")), dismissed: this.store.workbenchDismissedIssues() },
      models: {
        codex: this.codex.modelCache.length ? this.codex.modelCache : storedCodexModels,
        deepseek: this.deepseek.modelCache.length ? this.deepseek.modelCache : storedDeepseekModels,
      },
      language: this.language(),
      notifications: { system: this.store.setting("notifications.system", "true") !== "false" },
      worktree: { enabled: this.store.setting("worktree.enabled", "true") !== "false" },
    };
  }

  // Codex 账号信息取缓存；冷启动时最多等 4 秒，避免 app-server 没起来就把整页卡住。
  async codexAccount() {
    if (this.codexAccountCache) return this.codexAccountCache;
    const value = await withTimeout(
      this.codex.getAccountStatus().catch(() => ({ account: null, requiresOpenaiAuth: true })),
      4_000,
      { account: null, requiresOpenaiAuth: true },
    );
    if (value?.account) this.codexAccountCache = value;
    return value;
  }

  currentDeepseekKey() {
    const id = this.store.activeDeepseekAccountId();
    return id ? readDeepseekKey(id) : Promise.resolve(null);
  }

  async fetchDeepseekBalance(accountId) {
    const key = await readDeepseekKey(accountId);
    if (!key) return null;
    try {
      const response = await fetch("https://api.deepseek.com/user/balance", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`余额读取失败（${response.status}）`);
      return { ...(await response.json()), updatedAt: new Date().toISOString() };
    } catch (error) { return { error: error.message, updatedAt: new Date().toISOString() }; }
  }

  // 去重 + 最短 8 秒间隔，防止 account 事件与设置页轮询把刷新打成风暴。
  scheduleAccountRefresh() {
    if (this.accountRefreshPromise) return this.accountRefreshPromise;
    if (Date.now() - this.accountRefreshAt < 8_000) return null;
    this.accountRefreshAt = Date.now();
    this.accountRefreshPromise = (async () => {
      const [rateLimits, codexModels, deepseekModels, codexAccount] = await Promise.all([
        this.codex.getRateLimits(5_000).catch((error) => ({ error: error.message, updatedAt: new Date().toISOString() })),
        this.codex.listModels().catch(() => []),
        this.deepseek.listModels().catch(() => []),
        this.codex.getAccountStatus().catch(() => null),
      ]);
      this.rateLimitsCache = rateLimits;
      if (codexAccount?.account) this.codexAccountCache = codexAccount;
      if (codexModels.length) this.store.setSetting("codex.models", JSON.stringify(codexModels));
      if (deepseekModels.length) this.store.setSetting("deepseek.models", JSON.stringify(deepseekModels));
      const balances = await Promise.all(this.store.deepseekAccounts().map(async (account) => [account.id, await this.fetchDeepseekBalance(account.id)]));
      for (const [id, balance] of balances) this.balanceCache.set(id, balance);
    })().catch(() => {}).finally(() => {
      this.accountRefreshPromise = null;
      // 以“刷新完成”时间重新计时，否则慢刷新（余额最长 15s）结束后的广播会立刻再触发一轮，形成自循环。
      this.accountRefreshAt = Date.now();
      this.broadcast("account", {});
    });
    return this.accountRefreshPromise;
  }

  hasActiveDeepseekRun() {
    for (const active of this.active.values()) if (active.runtime === this.deepseek) return true;
    return this.deepSeekQueue.length > 0;
  }

  async switchDeepseekAccount(id) {
    const target = this.store.deepseekAccount(id);
    if (!target) throw new Error("账号不存在");
    if (this.store.activeDeepseekAccountId() === id) return { activeId: id };
    if (this.hasActiveDeepseekRun()) throw new Error("请先停止正在执行的 Deepseek 任务，再切换账号");
    this.store.setActiveDeepseekAccount(id);
    await this.deepseek.reset();
    this.balanceCache.delete(id);
    this.broadcast("account", {});
    void this.scheduleAccountRefresh();
    return { activeId: id };
  }

  // 更换密钥、删除账号前调用：确保没有正在用旧密钥的执行。
  async resetDeepseekRuntime() {
    if (this.hasActiveDeepseekRun()) throw new Error("请先停止正在执行的 Deepseek 任务，再更换密钥或删除账号");
    await this.deepseek.reset();
  }

  language() {
    const value = this.store.setting("agent.language", defaultLanguage);
    return supportedLanguages.includes(value) ? value : defaultLanguage;
  }

  setLanguage(language) {
    this.store.setSetting("agent.language", language);
    return language;
  }

  languageInstruction() {
    return languageInstructions[this.language()] || "";
  }

  // 判断任务是否真的在执行：内存中的活动执行优先于数据库状态，避免另一个实例
  // 把 run 误标为已中断后，续跑中的任务被当成“已中断”或拒绝消息入队。
  activeRunInfo(taskId) {
    const memory = this.active.get(taskId);
    if (memory) return { active: true, runId: memory.runId, memory: true };
    const run = this.store.activeRun(taskId);
    return run ? { active: true, runId: run.id, memory: false } : { active: false, runId: null, memory: false };
  }

  // 供接口层判断整棵任务树（含流程阶段）是否有活动执行。
  isTaskActive(taskId) {
    const task = this.store.task(taskId);
    if (!task) return false;
    const ids = task.is_root ? [taskId, ...this.store.taskDetail(taskId, { eventLimit: 1 }).children.map((child) => child.id)] : [taskId];
    return ids.some((id) => this.active.has(id) || Boolean(this.store.activeRun(id)));
  }

  // 整条流程（含本阶段）是否有执行：前端用它提示“别的阶段正在跑”，后端用它做阶段互斥。
  isFlowBusy(taskId) {
    const task = this.store.task(taskId);
    if (!task) return false;
    return this.isTaskActive(task.root_id || task.id);
  }

  // 同一条流程里除本任务外正在执行的阶段；没有就返回 null。
  treeBusyStage(task) {
    if (!task?.root_id) return null;
    const stages = this.store.taskDetail(task.root_id, { eventLimit: 1 })?.children || [];
    for (const stage of stages) {
      if (stage.id === task.id) continue;
      if (this.active.has(stage.id) || this.store.activeRun(stage.id)) return stage;
    }
    return null;
  }

  // 后台启动执行的唯一入口：任何 rejection 都必须在这里收敛成日志/事件。
  // 之前用 `void this.runTask(...)` 播下的未处理 rejection 会触发 Node 默认的 throw 策略，
  // 直接把本地服务进程带走，前端随后所有请求都变成 Load failed，只能重开 App。
  backgroundRun(label, promise, { taskId = null, runId = null } = {}) {
    Promise.resolve(promise).catch((error) => this.reportBackgroundFailure(label, taskId, runId, error));
  }

  reportBackgroundFailure(label, taskId, runId, error) {
    const message = error?.message || String(error);
    console.error(`[luoshenfu] ${label}：${error?.stack || message}`);
    this.log({ taskId, runId, stream: "error", level: "error", text: `${label}：${message}`, exitCode: 1 });
    if (!taskId) return;
    try {
      this.store.addEvent(taskId, runId, { type: "error", title: label, content: message });
      this.broadcast("changed", { taskId });
    } catch (storeError) {
      console.error(`[luoshenfu] 记录后台失败事件时出错：${storeError.message}`);
    }
  }

  // 阶段完成后的自动推进：必须幂等。同一目标阶段可能被推进多次（例如阶段被干预重跑后再次完成），
  // 目标已在执行或已完成时直接跳过，绝不重复启动。
  startNextStage(taskId) {
    const target = this.store.task(taskId);
    if (!target) return;
    // 已完成的阶段不重跑；阻塞/取消的阶段交给用户显式「继续任务」，不自动拉起。
    if (["done", "canceled", "blocked"].includes(target.status)) return;
    if (this.activeRunInfo(taskId).active) return;
    this.backgroundRun("自动推进下一阶段失败", this.runTask(taskId), { taskId });
  }

  async runTask(taskId, message, options = {}) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!task) throw new Error("任务不存在");
    if (task.is_root) {
      let next = task.children.find((stage) => stage.status !== "done");
      if (!next) {
        for (const stage of task.children) this.store.updateTask(stage.id, { status: "todo", progress: 0 });
        this.store.updateTask(task.id, { status: "todo", progress: 0 });
        next = task.children[0];
      }
      if (!next) throw new Error("流程任务没有可执行阶段");
      return this.runTask(next.id, message, options);
    }
    if (!task.provider) throw new Error("请先为任务分配 Codex 或 Deepseek");
    if (this.activeRunInfo(task.id).active) throw new Error("该任务已有活动执行");
    // 流程阶段必须串行：同一条流程里已有别的阶段在跑时，不再启动本阶段。
    // 否则「实施被干预重跑」和「自动推进的验证」会并行，推进方撞车后曾把整个本地服务带崩。
    const busyStage = this.treeBusyStage(task);
    if (busyStage) throw new Error(`流程的「${busyStage.title}」阶段正在执行，请先停止它或等它结束后再试`);
    if (this.store.priorStageIncomplete(task)) throw new Error("请先完成上一阶段");
    // 手动重跑一个已完成的阶段（设计返工、需求变更）时，它之后的阶段必须重新执行，
    // 保证流程严格按「设计→实施→验证」重走一遍，而不是跳过历史上已完成的下游阶段。
    if (task.status === "done") this.store.resetFollowingStages(task.id);
    const worktree = task.kind === "chat"
      ? { status: "unavailable", path: null, branch: null, baseCommit: null, note: "项目会话不启用 Worktree 隔离" }
      : await this.worktree.prepare(task);
    const workspace = worktree.status === "active" && worktree.path ? worktree.path : task.workspace;
    if ((options.planMode || options.skill) && task.provider !== "codex") throw new Error("计划模式和 Skills 仅支持 Codex");
    const skill = options.skill ? (await this.codex.listSkills(workspace)).find((item) => item.name === options.skill) : null;
    if (options.skill && !skill) throw new Error("所选 Skill 不存在或已停用");
    const attachments = options.attachments || [];
    // 任务说明里的图片属于任务需求：只在还没有外部会话（新会话）时随 prompt 投递一次，
    // 之后沿用同一会话上下文，避免每一轮都重复上传同一批图片。
    const declared = task.kind === "chat" || task.conversation?.external_id ? [] : (task.attachments || []);
    const delivered = mergeAttachments(attachments, declared);
    const messageText = message?.trim() || "";
    if (task.kind === "chat" && !messageText && !attachments.length) throw new Error("请输入会话内容");
    if (task.kind === "chat" && task.title === "新会话" && messageText) {
      task.title = messageText.split("\n")[0].slice(0, 40);
      this.store.updateTask(task.id, { title: task.title });
    }
    // 未配置账号时不在这里拦：保持与旧行为一致，等真正建运行时再提示配置。
    const deepseekAccountId = task.provider === "deepseek" ? this.store.activeDeepseekAccountId() : null;
    const conversation = this.store.conversation(task, task.provider, task.model, task.reasoning_effort, deepseekAccountId, workspace);
    const queued = task.provider === "deepseek" && this.deepSeekActive >= 2;
    const run = this.store.startRun(task.id, conversation.id, queued ? "queued" : "running", options.resumeKind || null);
    const prompt = messageText || (task.kind === "chat" && delivered.length ? "" : this.defaultPrompt(task));
    this.store.addEvent(task.id, run.id, {
      type: queued ? "progress" : "message",
      role: "user",
      title: queued ? "等待 Deepseek 执行位" : null,
      content: prompt,
      raw: attachments.length ? { attachments } : null,
    });
    this.log({
      taskId: task.id, runId: run.id, stream: "status",
      text: `${queued ? "已排队等待 Deepseek 执行位" : "开始执行"}｜provider=${task.provider}｜model=${task.model || "默认"}｜effort=${task.reasoning_effort || "默认"}`,
      cwd: workspace,
    });
    if (task.kind !== "chat") {
      this.log({
        taskId: task.id, runId: run.id, stream: "system",
        text: worktree.status === "active"
          ? `Worktree 隔离已启用｜分支=${worktree.branch}｜基准=${String(worktree.baseCommit).slice(0, 10)}${worktree.note ? `｜${worktree.note}` : ""}`
          : `未启用 Worktree 隔离：${worktree.note}`,
        cwd: workspace,
      });
    }
    this.broadcast("changed", { taskId: task.id });
    const work = { taskId: task.id, runId: run.id, conversationId: conversation.id, prompt, attachments: delivered, planMode: Boolean(options.planMode), skill, instructions: this.languageInstruction(), workspace };
    if (queued) this.deepSeekQueue.push(work); else this.backgroundRun("执行启动失败", this.execute(work), { taskId: task.id, runId: run.id });
    return { runId: run.id, queued };
  }

  queueTask(taskId, message, options = {}) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!task) throw new Error("任务不存在");
    const active = this.activeRunInfo(task.id);
    if (!active.active) throw new Error("任务当前未执行");
    // 内存里仍在执行、数据库却被误标时先恢复状态，排队消息要挂在真正的活动 run 上。
    if (active.memory) this.store.restoreRun(active.runId);
    const attachments = options.attachments || [];
    const content = message?.trim() || "";
    if (!content && !attachments.length) throw new Error("请输入消息或添加附件");
    if ((options.planMode || options.skill) && task.provider !== "codex") throw new Error("计划模式和 Skills 仅支持 Codex");
    const id = this.store.addEvent(task.id, active.runId, {
      type: "queued_message", role: "user", title: "已加入队列", content,
      raw: { attachments, planMode: Boolean(options.planMode), skill: options.skill || "" },
    });
    this.broadcast("changed", { taskId: task.id });
    return { queued: true, eventId: id };
  }

  async guideQueued(taskId, eventId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    const active = this.active.get(taskId);
    const queued = this.store.queuedMessage(taskId, eventId);
    if (!task || !active || !active.externalId || !active.turnId) throw new Error("智能体尚未开始执行，请稍后重试");
    if (!queued) throw new Error("排队消息不存在");
    if (task.provider === "codex") {
      const attachments = queued.raw?.attachments || [];
      await this.codex.steer(active.externalId, active.turnId, queued.content, attachments);
      this.store.deleteQueuedMessage(taskId, eventId);
      this.store.addEvent(taskId, active.runId, { type: "message", role: "user", title: "干预", content: queued.content, raw: attachments.length ? { attachments } : null });
    } else {
      if (this.priorityQueuedMessages.has(taskId)) throw new Error("已有一条消息正在干预当前任务");
      this.priorityQueuedMessages.set(taskId, eventId);
      try { await this.deepseek.cancel(active); }
      catch (error) { this.priorityQueuedMessages.delete(taskId); throw error; }
    }
    this.broadcast("changed", { taskId });
    return { ok: true, interrupted: task.provider === "deepseek" };
  }

  defaultPrompt(task) {
    // 流程三个阶段职责必须互不越界：设计只出方案、实施只执行当前设计、验证只核对实施结果。
    // 提示词直接决定每个阶段的行为边界，改动时保持「本阶段只做什么 / 明确不做什么」的写法。
    const phaseLead = {
      design: [
        "【设计阶段】只产出设计方案，不做任何实施。",
        "1. 只允许只读调研（阅读代码与文档、运行只读查询）；禁止写文件、改代码、做原型、装依赖、提交代码，禁止执行任何会改变工作区或系统状态的命令。所有落地操作一律交给实施阶段。",
        "2. 方案要能直接交给实施者照做：目标、现状与关键结论、需要改动的文件与位置、分步实施步骤、明确的验收标准、主要风险与回退方式。",
        "3. 缺少必须由用户确认的信息时，调用 block_task 说明缺口，不要替用户做决定，也不要把问题留给实施阶段自行发挥。",
        "4. 输出方案即结束本阶段，不要顺手实施方案中的任何一步。",
      ].join("\n"),
      implementation: [
        "【实施阶段】只执行设计阶段已确定的方案，不做方案之外的事。",
        "1. 严格按下面附带的当前设计方案逐条落实；不要做方案之外的重构、优化、顺手改动或新增需求。",
        "2. 方案与实际不符、缺少关键信息或无法照做时，调用 block_task 说明冲突点，不要自行改设计或扩大范围。",
        "3. 完成后汇报实际改动的文件、关键实现，以及对应验收标准的落实情况。",
      ].join("\n"),
      verification: [
        "【验证阶段】只验证实施结果是否符合设计阶段的验收标准，不做修复或新的实施。",
        "1. 依据下面附带的验收标准独立核对实施结果：检查改动、运行验证或测试，逐条给出「通过 / 不通过 + 证据」。",
        "2. 只报告问题，不修改代码、不修复、不返工，也不做任何实施类操作。",
        "3. 发现问题时明确列出不符合项与证据；无法判定时调用 block_task 说明，不要无限返工。",
      ].join("\n"),
      standalone: "请完成以下任务，并持续汇报关键进度。",
    }[task.phase];
    const missingInputRule = task.root_id ? "\n\n如果缺少继续所需的用户信息，请调用 block_task 说明缺失内容，不要将当前阶段标记为完成。" : "";
    // 验证阶段必须拿设计阶段的验收标准做基准，而不是只对实施结果本身做主观检查。
    const designContext = task.phase === "verification" ? this.store.stageProduct(task, "design") : "";
    return `${phaseLead}\n\n任务：${task.title}\n${task.description || ""}${this.store.previousStageSummary(task)}${designContext}${missingInputRule}`.trim();
  }

  actualRuntime(task) {
    if (task.run?.actual_model || task.run?.actual_effort) return { model: task.run.actual_model, effort: task.run.actual_effort };
    return task.provider === "codex" && task.conversation?.external_id && task.run?.external_turn_id
      ? this.codex.actualRuntime(task.conversation.external_id, task.run.external_turn_id)
      : null;
  }

  async execute(work) {
    const stored = this.store.taskDetail(work.taskId, { eventLimit: 1 });
    const task = stored ? { ...stored, workspace: work.workspace || stored.workspace } : stored;
    const conversation = this.store.conversationById(work.conversationId);
    const runtime = task.provider === "codex" ? this.codex : this.deepseek;
    if (task.provider === "deepseek") this.deepSeekActive += 1;
    this.store.activateRun(work.runId);
    this.active.set(task.id, { runtime, runId: work.runId, externalId: conversation.external_id, turnId: null, permission: task.permission });
    this.store.addEvent(task.id, work.runId, { type: "progress", title: "开始执行", content: `${task.provider === "codex" ? "Codex" : "Deepseek"} 已接收任务` });
    this.broadcast("changed", { taskId: task.id });
    try {
      const result = await this.startWithReconnect({ runtime, task, conversation, work });
      if (result?.model || result?.effort) this.store.setRunRuntime(work.runId, result.model, result.effort);
      const forced = this.forcedOutcomes.get(task.id);
      this.forcedOutcomes.delete(task.id);
      const interrupted = this.priorityQueuedMessages.has(task.id);
      const canceled = result?.stopReason === "cancelled" || interrupted;
      const outcome = forced?.status || (canceled ? "canceled" : "completed");
      this.store.addEvent(task.id, work.runId, { type: "result", title: outcome === "blocked" ? "任务阻塞" : interrupted ? "已接受干预" : canceled ? "已取消" : "执行完成", content: forced?.detail || (interrupted ? "当前轮次已停止，将立即按干预消息继续" : canceled ? "任务已由用户停止" : "本轮执行已完成"), raw: result });
      this.log({ taskId: task.id, runId: work.runId, stream: "status", level: outcome === "completed" ? "info" : "warn", text: `执行结束｜outcome=${outcome}｜stopReason=${result?.stopReason || "unknown"}`, exitCode: outcome === "completed" ? 0 : null });
      const next = this.store.finishRun(work.runId, outcome === "blocked" ? "failed" : outcome, null, !this.store.queuedMessage(task.id));
      if (!interrupted) this.notifyParent(task, outcome, forced?.detail);
      if (!interrupted) this.notifyOutcome(task, outcome, forced?.detail, next, work.runId);
      // 本阶段这一轮已经结束：先摘掉内存里的活动标记，下一阶段的流程互斥才不会把「刚结束的自己」当成占用。
      this.active.delete(task.id);
      if (next && (next.auto_execute || next.root_id)) this.startNextStage(next.id);
    } catch (error) {
      const current = this.store.run(work.runId);
      if (current?.status !== "canceled") {
        if (this.priorityQueuedMessages.has(task.id)) this.store.finishRun(work.runId, "canceled");
        else {
          this.store.addEvent(task.id, work.runId, { type: "error", title: "执行失败", content: error.message });
          this.log({ taskId: task.id, runId: work.runId, stream: "error", level: "error", text: `执行失败：${error.message}`, exitCode: 1 });
          this.store.finishRun(work.runId, "failed", error.message);
          this.notifyParent(task, "blocked", error.message);
          this.notifyOutcome(task, "failed", error.message, null, work.runId);
        }
      }
    } finally {
      this.active.delete(task.id);
      this.computerAuthorizedRuns.delete(work.runId);
      this.runsWithOutput.delete(work.runId);
      if (task.provider === "deepseek") {
        this.deepSeekActive -= 1;
        const next = this.deepSeekQueue.shift();
        if (next) this.backgroundRun("排队执行启动失败", this.execute(next), { taskId: next.taskId, runId: next.runId });
      }
      this.broadcast("changed", { taskId: task.id });
      const priorityId = this.priorityQueuedMessages.get(task.id);
      this.priorityQueuedMessages.delete(task.id);
      const queued = this.store.takeQueuedMessage(task.id, priorityId);
      const notifications = this.pendingAgentNotifications.get(task.id);
      if (queued) {
        const options = queued.raw || {};
        queueMicrotask(() => this.backgroundRun("排队消息未能启动", this.runTask(task.id, queued.content, { attachments: options.attachments || [], planMode: Boolean(options.planMode), skill: options.skill || "" }).catch((error) => {
          // 启动失败（例如流程的其它阶段此时正在执行）时把消息放回队列，不丢用户输入。
          this.store.addEvent(task.id, null, { type: "queued_message", role: "user", title: "等待重试", content: queued.content, raw: options });
          this.broadcast("changed", { taskId: task.id });
          throw error;
        }), { taskId: task.id }));
      } else if (notifications?.length) {
        this.pendingAgentNotifications.delete(task.id);
        queueMicrotask(() => this.backgroundRun("代理通知未能启动", this.runTask(task.id, notifications.join("\n")), { taskId: task.id }));
      }
      // 快照放在所有清理与排队之后，且不阻塞下一轮执行。
      await this.snapshotRun(task.id, work.runId);
    }
  }

  // 传输层中断（SSE 流被提前关闭、超时、连接被重置）可以自动重连；
  // 额度、上下文、用户取消等错误原样抛出，仍按执行失败处理。
  isReconnectable(error) {
    const message = String(error?.message || "");
    return [
      /SSE stream ended without \[DONE\]/,
      /SSE payload stream ended without \[DONE\]/,
      /DeepSeek API stream from .* failed/,
      /DeepSeek stream idle timeout/,
      /\bfetch failed\b/i,
      /\bsocket hang up\b/i,
      /other side closed/i,
      /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN)\b/,
    ].some((pattern) => pattern.test(message));
  }

  // 建立会话并等待本轮完成；中途遇到可重连的错误时，保持 run 为执行中，
  // 按退避自动重连，并在对话里写入“重连中/已恢复”状态，避免用户只看到底层报错。
  async startWithReconnect({ runtime, task, conversation, work }) {
    for (let attempt = 0; ; attempt += 1) {
      const started = await runtime.startConversation({
        task, conversation: { ...conversation, runId: work.runId }, message: attempt === 0 ? work.prompt : this.reconnectMessage(work, attempt),
        attachments: work.attachments, planMode: work.planMode, skill: work.skill, instructions: work.instructions,
      });
      this.store.setConversationExternal(conversation.id, started.externalId, task.model);
      this.store.setRunExternal(work.runId, started.turnId);
      if (started.actualModel || started.actualEffort) this.store.setRunRuntime(work.runId, started.actualModel, started.actualEffort);
      this.log({ taskId: task.id, runId: work.runId, stream: "status", text: `外部会话已建立｜session=${started.externalId}${started.actualModel ? `｜模型=${started.actualModel}` : ""}${started.actualEffort ? `｜effort=${started.actualEffort}` : ""}`, cwd: task.workspace });
      // 会话与 cwd 绑定：工作目录变化（Worktree 开关、路径变更）后旧上下文无法续接，运行时已按新目录重开会话。
      if (started.restarted) {
        this.store.addEvent(task.id, work.runId, { type: "status", title: "已开启新会话", content: "原会话绑定的工作目录已变化，历史上下文无法续接，已按当前目录重新建立会话继续执行。" });
        this.log({ taskId: task.id, runId: work.runId, stream: "status", level: "warn", text: "工作目录变化，旧会话不可续接，已开启新会话", cwd: task.workspace });
      }
      this.active.set(task.id, { runtime, runId: work.runId, externalId: started.externalId, turnId: started.turnId, permission: task.permission });
      try {
        const result = await started.completion;
        if (attempt > 0) this.recordReconnected(task, work, attempt);
        return result;
      } catch (error) {
        if (this.store.run(work.runId)?.status === "canceled" || this.priorityQueuedMessages.has(task.id)) throw error;
        if (!this.isReconnectable(error)) throw error;
        if (attempt >= this.reconnectDelays.length) throw new Error(`${error.message}（已自动重连 ${attempt} 次仍未成功）`, { cause: error });
        this.recordReconnect(task, work, attempt + 1, error);
        if (!await this.waitBeforeReconnect(work.runId, this.reconnectDelays[attempt])) throw error;
      }
    }
  }

  // 已经产出过内容的轮次用“继续”语义，避免重连后把整轮工作重做一遍。
  reconnectMessage(work, attempt) {
    const note = this.runsWithOutput.has(work.runId)
      ? "上一轮回复在输出过程中因网络中断被截断，请从中断处继续完成这个任务；不要重复已经执行过的工具调用，也不要重复已经给出的结论。"
      : "上一次请求因网络中断没有产生任何结果，请重新开始并完成这个任务。";
    return attempt > 1 ? `${note}（第 ${attempt} 次重连）` : note;
  }

  recordReconnect(task, work, attempt, error) {
    const total = this.reconnectDelays.length;
    const waitSeconds = Math.round(this.reconnectDelays[attempt - 1] / 1000);
    this.store.addEvent(task.id, work.runId, {
      type: "status", title: "连接中断，正在重连",
      content: `与 Deepseek 的连接被意外中断，${waitSeconds} 秒后发起第 ${attempt}/${total} 次重连。\n原因：${error.message}`,
      raw: { attempt, total, reason: error.message },
    });
    this.log({ taskId: task.id, runId: work.runId, stream: "status", level: "warn", text: `连接中断，准备第 ${attempt}/${total} 次重连｜${error.message}` });
    this.broadcast("changed", { taskId: task.id });
  }

  recordReconnected(task, work, attempt) {
    this.store.addEvent(task.id, work.runId, { type: "status", title: "连接已恢复", content: `第 ${attempt} 次重连成功，继续执行本轮任务。`, raw: { attempt } });
    this.log({ taskId: task.id, runId: work.runId, stream: "status", text: `连接已恢复｜第 ${attempt} 次重连后继续执行` });
    this.broadcast("changed", { taskId: task.id });
  }

  // 退避期间用户仍可停止任务：run 一旦被标记为 canceled 就立刻放弃重连。
  async waitBeforeReconnect(runId, delayMs) {
    const deadline = Date.now() + delayMs;
    for (;;) {
      if (this.store.run(runId)?.status === "canceled") return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  }

  async cancel(taskId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (task?.is_root) taskId = task.children.find((stage) => this.active.has(stage.id) || this.store.activeRun(stage.id))?.id || taskId;
    const active = this.active.get(taskId);
    const run = this.store.activeRun(taskId);
    if (!run) throw new Error("任务当前未执行");
    const queuedIndex = this.deepSeekQueue.findIndex((item) => item.taskId === taskId);
    if (queuedIndex >= 0) this.deepSeekQueue.splice(queuedIndex, 1);
    if (active?.externalId) await active.runtime.cancel(active);
    this.store.finishRun(run.id, "canceled");
    this.log({ taskId, runId: run.id, stream: "status", level: "warn", text: "任务已由用户停止", exitCode: 130 });
    this.broadcast("changed", { taskId });
  }

  forceOutcome(taskId, status, detail = "") {
    if (!this.active.has(taskId) && !this.store.activeRun(taskId)) throw new Error("任务当前未执行");
    this.forcedOutcomes.set(taskId, { status, detail });
  }

  log(input) {
    try { return this.store.addLog(input); }
    catch (error) { console.error(`[luoshenfu] 执行日志写入失败：${error.message}`); return null; }
  }

  // 把协议事件中可诊断的部分落到执行日志，保留 stdout/stderr/工具/命令/退出码。
  logFromEvent(taskId, runId, event) {
    const method = event.raw?.method || "";
    const update = event.raw?.params?.update;
    const item = event.raw?.params?.item;
    let stream = null;
    if (event.type === "error") stream = "error";
    else if (event.type === "tool") stream = method.includes("commandExecution") ? "stdout" : "tool";
    else if (event.type === "result" || event.type === "progress") stream = "status";
    if (!stream) return;
    const command = typeof item?.command === "string" ? item.command : Array.isArray(item?.command) ? item.command.join(" ") : null;
    const cwd = item?.cwd || event.raw?.params?.cwd || null;
    const exitCode = item?.exitCode ?? item?.exit_code ?? update?.exitCode ?? null;
    const text = event.content || event.title || update?.status || method;
    if (!text && !command) return;
    this.log({ taskId, runId, stream, level: event.type === "error" ? "error" : "info", text, command, cwd, exitCode });
  }

  recordEvent({ taskId, runId, event }) {
    if (runId && (event.type === "message" || event.type === "tool")) this.runsWithOutput.add(runId);
    this.store.addEvent(taskId, runId, event);
    this.logFromEvent(taskId, runId, event);
    if (event.type === "usage") this.store.updateTask(taskId, { progress: 70 });
    this.broadcast("event", { taskId });
  }

  // 运行时子进程 stderr 只有在能唯一确定归属任务时才落库，避免把不同任务的输出串在一起。
  recordRuntimeStderr(provider, permission, chunk) {
    const text = String(chunk || "");
    if (!text.trim()) return;
    const runtime = provider === "codex" ? this.codex : this.deepseek;
    const matches = [...this.active.entries()].filter(([, active]) => active.runtime === runtime && (!permission || active.permission === permission));
    if (matches.length !== 1) return;
    const [taskId, active] = matches[0];
    this.log({ taskId, runId: active.runId, stream: "stderr", level: "warn", text });
  }

  recordApproval(input) {
    const approval = this.store.createApproval({ ...input, provider: input.provider || "codex" });
    this.store.addEvent(input.taskId, input.runId, { type: "approval", title: input.title, content: input.detail });
    this.log({ taskId: input.taskId, runId: input.runId, stream: "status", level: "warn", text: `等待用户授权/回答：${input.title}` });
    const task = this.store.task(input.taskId);
    if (task) this.activity(task.id, "task.approval", `等待你的授权：${task.title}`, input.title || "任务正在等待授权或回答", approval.id);
    this.broadcast("approval", { taskId: input.taskId, approvalId: approval.id });
    return approval;
  }

  async respondApproval(id, decision) {
    const approval = this.store.approval(id);
    if (!approval || approval.status !== "pending") throw new Error("审批请求不存在或已处理");
    if (approval.external_request_id.startsWith("local:")) {
      if (!["allow", "reject", "cancel"].includes(decision)) throw new Error("审批决定无效");
      const pending = this.pendingLocalApprovals.get(id);
      if (!pending) throw new Error("审批请求已失效");
      this.pendingLocalApprovals.delete(id);
      this.store.decideApproval(id, decision);
      pending.resolve(decision);
      if (decision === "cancel") await this.cancel(approval.task_id);
      this.broadcast("changed", { taskId: approval.task_id });
      return;
    }
    const runtime = approval.provider === "codex" ? this.codex : this.deepseek;
    await runtime.respondToApproval(approval.external_request_id, decision);
    this.store.decideApproval(id, typeof decision === "string" ? decision : JSON.stringify(decision));
    const userInput = approval.external_request_id.startsWith("user-input:");
    this.store.addEvent(approval.task_id, approval.run_id, { type: "approval", title: userInput ? "已提交选择" : "审批已处理", content: userInput ? Object.values(decision.answers || {}).flatMap((item) => item.answers || []).join("、") : decision === "allow" ? "允许一次" : decision === "cancel" ? "取消任务" : "拒绝" });
    if (!userInput && decision === "cancel") await this.cancel(approval.task_id);
    this.broadcast("changed", { taskId: approval.task_id });
  }

  async authorizeComputer(taskId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    const run = this.store.activeRun(taskId);
    if (!task || !run || !this.active.has(taskId)) throw new Error("Computer Use 只能在执行中的任务内使用");
    if (this.computerAuthorizedRuns.has(run.id)) return;
    const approval = this.recordApproval({
      taskId, runId: run.id, provider: task.provider, externalRequestId: `local:computer:${run.id}`,
      title: "允许此任务查看并操作你的电脑？",
      detail: "授权仅在本次执行有效。操作系统可能还会请求“屏幕录制”与“辅助功能”权限。",
      options: [{ id: "allow", name: "允许本次执行" }, { id: "reject", name: "拒绝" }, { id: "cancel", name: "取消任务" }],
    });
    const decision = await new Promise((resolve) => this.pendingLocalApprovals.set(approval.id, { taskId, resolve }));
    if (decision !== "allow") throw new Error("用户未授权 Computer Use");
    this.computerAuthorizedRuns.add(run.id);
  }

  runtimeExited(provider, error, permission) {
    for (const [taskId, active] of this.active) {
      if (active.runtime !== (provider === "codex" ? this.codex : this.deepseek)) continue;
      if (permission && active.permission !== permission) continue;
      this.store.addEvent(taskId, active.runId, { type: "error", title: "运行时已退出", content: error.message });
      this.log({ taskId, runId: active.runId, stream: "error", level: "error", text: `运行时已退出：${error.message}`, exitCode: 1 });
      this.store.finishRun(active.runId, "failed", error.message);
      this.notifyOutcome(this.store.task(taskId) || {}, "failed", error.message, null, active.runId);
      this.active.delete(taskId);
    }
    this.broadcast("changed", {});
  }

  activity(taskId, type, title, body = "", dedupeSuffix = "") {
    const task = this.store.task(taskId);
    if (!task || task.kind !== "task") return null;
    const owner = task.root_id ? this.store.task(task.root_id) || task : task;
    const record = this.store.addActivity({
      projectId: owner.project_id, taskId: owner.id, type,
      title: String(title).slice(0, 200), body: String(body || "").slice(0, 1000),
      dedupeKey: `${owner.id}:${type}:${dedupeSuffix}`,
    });
    if (record) this.broadcast("activity", { activity: record });
    return record;
  }

  // 重要状态变化才产生活动与系统通知。去重键必须带上 runId：
  // 否则同一个任务第二次执行结束时会被 INSERT OR IGNORE 吞掉，用户就再也收不到通知。
  notifyOutcome(task, outcome, detail = "", next = null, runId = "") {
    const owner = task.root_id ? this.store.task(task.root_id) || task : task;
    if (owner.kind !== "task") return;
    const dedupe = runId || String(Date.now());
    if (task.root_id) {
      if (outcome === "completed") {
        if (next) return;
        this.activity(owner.id, "task.completed", `流程任务待验证：${owner.title}`, "设计、实施、验证阶段均已结束，等待你验收确认。", `${dedupe}:completed`);
      } else if (outcome === "blocked" || outcome === "failed") {
        this.activity(owner.id, "task.blocked", `流程任务受阻：${owner.title}`, detail || `阶段「${task.title}」执行未完成。`, `${task.id}:${dedupe}:${outcome}`);
      }
      return;
    }
    if (outcome === "completed") this.activity(owner.id, "task.completed", `任务待验证：${owner.title}`, detail || "本轮执行已完成，等待你验收确认。", `${dedupe}:completed`);
    else if (outcome === "blocked" || outcome === "failed") this.activity(owner.id, "task.blocked", `任务${outcome === "failed" ? "执行失败" : "被阻塞"}：${owner.title}`, detail || "任务需要处理。", `${dedupe}:${outcome}`);
  }

  worktreeInfo(taskId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    return task ? this.worktree.snapshot(task) : null;
  }

  // 每次执行结束后，把工作区（含未跟踪文件）打成一个不污染工作区的快照，供「按执行批次」查看变更。
  async snapshotRun(taskId, runId) {
    try {
      const task = this.store.taskDetail(taskId, { eventLimit: 1 });
      if (!task) return null;
      const owner = task.root_id ? this.store.task(task.root_id) || task : task;
      if (owner.worktree_status !== "active" || !owner.worktree_path) return null;
      const previous = this.store.previousSnapshot(owner.id, runId) || owner.base_commit;
      if (!previous) return null;
      const refName = `refs/luoshenfu/snapshots/${owner.id}/${runId}`;
      const commit = await snapshotWorktree(owner.worktree_path, previous, refName);
      if (commit) {
        this.store.setRunSnapshot(runId, commit);
        this.log({ taskId: task.id, runId, stream: "system", text: `已记录本次执行快照 ${commit.slice(0, 8)}` });
      }
      return commit;
    } catch (error) {
      this.log({ taskId, runId, stream: "system", level: "warn", text: `执行快照失败：${error.message}` });
      return null;
    }
  }

  // 供变更页使用的执行批次列表（仅返回已成功记录快照的执行）。
  changeBatches(taskId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!task) return [];
    const owner = task.root_id ? this.store.task(task.root_id) || task : task;
    return this.store.taskRuns(owner.id)
      .filter((run) => run.snapshot_commit)
      .map((run) => ({
        runId: run.id,
        status: run.status,
        phase: run.task_phase,
        stageTitle: run.task_title,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        resumeKind: run.resume_kind,
        snapshot: run.snapshot_commit,
        previous: this.store.previousSnapshot(owner.id, run.id) || owner.base_commit,
      }));
  }

  // 创建任务时预先准备 Worktree，并把原目录、Worktree、分支、基准提交与状态持久化。
  async prepareWorktree(taskId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!task || task.kind !== "task") return null;
    const info = await this.worktree.prepare(task);
    this.broadcast("changed", { taskId: task.id });
    return info;
  }

  async removeWorktree(taskId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!task) throw new Error("任务不存在");
    const info = await this.worktree.remove(task);
    this.log({ taskId: task.id, runId: null, stream: "recovery", text: `Worktree 已移除｜分支=${task.worktree_branch || "未知"}` });
    this.broadcast("changed", { taskId });
    return info;
  }

  // 在「隔离」与「直接使用原项目目录」之间切换；执行中禁止切换，含变更的工作树切到 direct 时会被拒绝。
  async setWorktreeMode(taskId, mode) {
    if (!["isolate", "direct"].includes(mode)) throw new Error("Worktree 模式无效");
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!task) throw new Error("任务不存在");
    if (task.kind === "chat") throw new Error("项目会话不启用 Worktree 隔离");
    const owner = task.root_id ? this.store.task(task.root_id) || task : task;
    const ownerDetail = owner.id === task.id ? task : this.store.taskDetail(owner.id, { eventLimit: 1 });
    const busy = (id) => this.activeRunInfo(id).active;
    if (busy(task.id) || busy(owner.id) || (ownerDetail?.children || []).some((stage) => busy(stage.id))) throw new Error("任务执行中不能切换 Worktree 模式");
    if ((owner.worktree_mode || "isolate") === mode) {
      if (mode === "isolate") {
        await this.worktree.prepare(ownerDetail || owner);
        this.broadcast("changed", { taskId: owner.id });
      }
      return this.store.taskDetail(taskId, { eventLimit: 1 });
    }

    if (mode === "direct") {
      if (owner.worktree_status === "active" && owner.worktree_path) await this.worktree.remove(ownerDetail || owner);
      this.store.updateTask(owner.id, { worktree_mode: "direct" });
      this.store.setWorktreeStatus(owner.id, "disabled", "你选择了直接使用原项目目录");
      this.log({ taskId: owner.id, runId: null, stream: "recovery", level: "warn", text: "已关闭 Worktree 隔离：后续执行直接在原项目目录进行" });
    } else {
      this.store.updateTask(owner.id, { worktree_mode: "isolate" });
      const info = await this.worktree.prepare(this.store.taskDetail(owner.id, { eventLimit: 1 }) || owner);
      this.log({ taskId: owner.id, runId: null, stream: "recovery", text: info.status === "active" ? `已重新启用 Worktree 隔离｜分支=${info.branch}` : `重新启用 Worktree 隔离失败：${info.note}` });
    }
    this.broadcast("changed", { taskId: owner.id });
    return this.store.taskDetail(taskId, { eventLimit: 1 });
  }

  // 删除任务前释放 Worktree：干净工作树会被移除；含变更的工作树一律保留并回报路径。
  async releaseWorktree(taskId) {
    const task = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!task) return { status: "missing" };
    const owner = task.root_id ? this.store.task(task.root_id) || task : task;
    // 任务即将删除，清理它为执行批次创建的快照引用（不影响用户分支）。
    const project = this.store.project(owner.project_id);
    if (project?.workspace) await deleteSnapshotRefs(project.workspace, owner.id);
    if (owner.worktree_status !== "active" || !owner.worktree_path) return { status: owner.worktree_status || "unavailable", note: owner.worktree_note };
    try { return await this.worktree.remove(task); }
    catch (error) {
      this.log({ taskId: owner.id, runId: null, stream: "recovery", level: "warn", text: `删除任务时保留了含变更的 Worktree：${owner.worktree_path}（${error.message}）` });
      return { status: "preserved", path: owner.worktree_path, branch: owner.worktree_branch, note: error.message };
    }
  }

  async resumeTask(taskId) {
    const root = this.store.taskDetail(taskId, { eventLimit: 1 });
    if (!root) throw new Error("任务不存在");
    if (root.archived) throw new Error("已归档任务不能继续");
    const target = root.is_root
      ? root.children.find((stage) => stage.status !== "done") || root.children.at(-1)
      : root;
    if (!target) throw new Error("流程任务没有可恢复的阶段");
    if (this.resumeLocks.has(target.id)) throw new Error("任务正在恢复，请勿重复点击");
    if (this.activeRunInfo(target.id).active) throw new Error("该任务已在执行");
    const last = this.store.lastRun(target.id);
    if (!last || !["interrupted", "failed", "blocked", "canceled"].includes(last.status)) throw new Error("没有可恢复的中断执行");
    const conversation = this.store.conversationById(last.conversation_id);
    const kind = conversation?.external_id ? "session" : "rerun";
    this.resumeLocks.add(target.id);
    try {
      this.log({ taskId: target.id, runId: last.id, stream: "recovery", level: "warn", text: kind === "session" ? "用户继续任务：按原外部会话恢复" : "用户继续任务：原会话不可用，使用已有上下文重新续跑" });
      const message = kind === "rerun" ? this.resumePrompt(target, last) : "";
      await this.runTask(target.id, message, { resumeKind: kind });
      this.activity(target.id, "task.resumed", `任务已继续：${target.title}`, kind === "session" ? "已按原外部会话恢复。" : "原会话不可用，已使用已有上下文重新续跑。", `${last.id}:${kind}`);
      return { ok: true, resumeKind: kind };
    } finally {
      this.resumeLocks.delete(target.id);
    }
  }

  resumePrompt(task, last) {
    const events = this.store.taskDetail(task.id, { eventLimit: 8 }).events.slice(-8).map((event) => `${event.title || event.type}：${String(event.content || "").slice(0, 400)}`).join("\n");
    const logs = this.store.logPage(task.id, { limit: 20 }).items.map((item) => `[${item.stream}] ${String(item.text).slice(0, 300)}`).join("\n");
    return `【重新续跑】上一次执行被中断（${last.interrupt_reason || last.error || "未知原因"}），且原外部会话不可用。请基于以下已有上下文继续完成任务，不要重复已完成的步骤，也不要重复执行可能产生副作用的命令。\n\n最近事件：\n${events || "（无）"}\n\n最近日志：\n${logs || "（无）"}`;
  }

  notifyParent(task, status, detail = "") {
    if (!task.parent_id) return;
    const parent = this.store.task(task.parent_id);
    if (!parent || parent.is_root) return;
    const message = `子任务 #${task.number}「${task.title}」${status === "completed" ? "已完成" : status === "blocked" ? "被阻塞" : "已取消"}${detail ? `：${detail}` : ""}`;
    this.store.addEvent(parent.id, null, { type: "notification", title: "子任务通知", content: message });
    const active = this.active.get(parent.id);
    if (active?.externalId && parent.provider === "codex") void this.codex.steer(active.externalId, active.turnId, message).catch(() => {});
    if (active && parent.provider === "deepseek") {
      const pending = this.pendingAgentNotifications.get(parent.id) || [];
      pending.push(message);
      this.pendingAgentNotifications.set(parent.id, pending);
    }
  }

  async close() { await Promise.all([this.codex.close(), this.deepseek.close()]); }
}

// 合并「本次消息附件」与「任务说明附件」：按路径去重，本次消息优先，整体仍受 10 个上限约束。
function mergeAttachments(...groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const item of group || []) {
      if (!item?.path || seen.has(item.path)) continue;
      seen.add(item.path);
      result.push(item);
    }
  }
  return result.slice(0, 10);
}

// 超时兜底：返回 fallback 而不是抛错，调用方无需再包一层 catch。
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => { const timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); }),
  ]);
}

function parseModelCache(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

import { spawn } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonRpcProcess } from "./json-rpc.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";

export class CodexRuntime {
  constructor({ onEvent, onApproval, onExit, onAccountChange, onStderr, mcp }) {
    this.onEvent = onEvent;
    this.onApproval = onApproval;
    this.onExit = onExit;
    this.onAccountChange = onAccountChange;
    this.onStderr = onStderr;
    this.mcp = mcp;
    this.modelCache = [];
    this.contexts = new Map();
    this.pendingApprovals = new Map();
    this.pendingUserInputs = new Map();
    this.rpc = new JsonRpcProcess(resolveCodexExecutable(), ["app-server", "--stdio"], {
      env: process.env,
      onRequest: (message) => this.handleRequest(message),
      onExit: (error) => {
        this.initialized = false;
        this.readyPromise = null;
        for (const context of this.contexts.values()) context.reject?.(error);
        this.contexts.clear();
        this.onExit?.(error);
      },
      onStderr: (chunk) => { process.stderr.write(`[codex] ${chunk}`); this.onStderr?.(chunk); },
    });
    this.rpc.subscribe((message) => this.handleNotification(message));
  }

  async ready() {
    if (this.initialized) return;
    if (!this.readyPromise) this.readyPromise = (async () => {
      try { await this.rpc.start(); }
      catch (error) {
        if (error?.code === "ENOENT") throw new Error("未找到 Codex 可执行文件，请安装或更新官方 ChatGPT / Codex App");
        throw error;
      }
      await this.rpc.request("initialize", {
        clientInfo: { name: "luoshenfu", title: "洛神赋", version: "1.0.2" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, 15_000);
      this.rpc.notify("initialized");
      this.initialized = true;
    })().finally(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  async getAccountStatus() {
    try { await this.ready(); return await this.rpc.request("account/read", { refreshToken: false }, 5_000); }
    catch (error) { return { account: null, requiresOpenaiAuth: true, error: error.message }; }
  }

  // 额度接口在部分环境会一直不返回：给短超时，宁可显示“暂时无法读取”，也不拖住整页账号信息。
  async getRateLimits(timeout = 5_000) {
    try { await this.ready(); return { ...(await this.rpc.request("account/rateLimits/read", {}, timeout)), updatedAt: new Date().toISOString() }; }
    catch (error) { return { error: error.message, updatedAt: new Date().toISOString() }; }
  }

  async consumeRateLimitReset(idempotencyKey, creditId) {
    await this.ready();
    return this.rpc.request("account/rateLimitResetCredit/consume", { idempotencyKey, creditId });
  }

  async listModels() {
    try {
      await this.ready();
      const response = await this.rpc.request("model/list", { includeHidden: false, limit: 100 }, 10_000);
      const models = (response.data || []).map((model) => ({
        id: model.model || model.id,
        name: model.displayName || model.model || model.id,
        description: model.description,
        provider: "codex",
        isDefault: model.isDefault,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts || [],
      }));
      if (models.length) this.modelCache = models;
    } catch {}
    return this.modelCache;
  }

  async listSkills(cwd) {
    try {
      await this.ready();
      const response = await this.rpc.request("skills/list", { cwds: [cwd], forceReload: true }, 3_000);
      return (response.data?.find((entry) => entry.cwd === cwd)?.skills || []).filter((skill) => skill.enabled);
    } catch { return localSkills(cwd); }
  }

  async login() {
    await this.ready();
    const result = await this.rpc.request("account/login/start", { type: "chatgpt", useHostedLoginSuccessPage: true });
    if (result.authUrl) spawn("/usr/bin/open", [result.authUrl], { detached: true, stdio: "ignore" }).unref();
    return result;
  }

  async logout() { await this.ready(); return this.rpc.request("account/logout", null); }

  async startConversation({ task, conversation, message, attachments = [], planMode = false, skill = null, instructions = "" }) {
    await this.ready();
    let threadId = conversation.external_id;
    const config = { mcp_servers: { luoshenfu: this.mcp.codex(task.id) } };
    const approvalPolicy = task.permission === "danger-full-access" ? "never" : "on-request";
    if (threadId && !this.contexts.has(threadId)) {
      await this.rpc.request("thread/resume", { threadId, cwd: task.workspace, model: task.model || null, approvalPolicy, sandbox: task.permission, config, excludeTurns: true });
    } else if (!threadId) {
      const result = await this.rpc.request("thread/start", { cwd: task.workspace, model: task.model || null, approvalPolicy, sandbox: task.permission, config, ephemeral: false });
      threadId = result.thread?.id || result.threadId;
    }
    this.contexts.set(threadId, { taskId: task.id, runId: conversation.runId });
    const model = task.model || conversation.model || (await this.listModels()).find((item) => item.isDefault)?.id;
    if (!model) throw new Error("无法读取 Codex 默认模型，暂时不能切换协作模式");
    const body = message ? (skill ? `$${skill.name} ${message}` : message) : "";
    const text = [instructions, body].filter((item) => item && item.trim()).join("\n\n");
    const input = [
      ...(text ? [{ type: "text", text, text_elements: [] }] : []),
      ...attachments.map((item) => item.mime.startsWith("image/") ? { type: "localImage", path: item.path } : { type: "mention", name: item.name, path: item.path }),
      ...(skill ? [{ type: "skill", name: skill.name, path: skill.path }] : []),
    ];
    const result = await this.rpc.request("turn/start", {
      threadId,
      input,
      cwd: task.workspace,
      model: task.model || null,
      approvalPolicy,
      ...(conversation.reasoning_effort ? { effort: conversation.reasoning_effort } : {}),
      collaborationMode: { mode: planMode ? "plan" : "default", settings: { model, reasoning_effort: conversation.reasoning_effort || "high", developer_instructions: null } },
    });
    const turnId = result.turn?.id || result.turnId;
    this.contexts.set(threadId, { taskId: task.id, runId: conversation.runId, turnId });
    return { externalId: threadId, turnId, completion: this.waitForTurn(threadId, turnId) };
  }

  async sendMessage(input) { return this.startConversation(input); }

  waitForTurn(threadId, turnId) {
    return new Promise((resolve, reject) => {
      const context = this.contexts.get(threadId);
      this.contexts.set(threadId, { ...context, turnId, resolve, reject });
    });
  }

  async cancel({ externalId, turnId }) {
    await this.ready();
    return this.rpc.request("turn/interrupt", { threadId: externalId, turnId });
  }

  async steer(externalId, turnId, message, attachments = []) {
    await this.ready();
    return this.rpc.request("turn/steer", { threadId: externalId, expectedTurnId: turnId, input: [
      ...(message ? [{ type: "text", text: message, text_elements: [] }] : []),
      ...attachments.map((item) => item.mime.startsWith("image/") ? { type: "localImage", path: item.path } : { type: "mention", name: item.name, path: item.path }),
    ] });
  }

  async respondToApproval(requestId, decision) {
    if (String(requestId).startsWith("user-input:")) {
      const id = String(requestId).slice("user-input:".length);
      const pending = this.pendingUserInputs.get(id);
      if (!pending) throw new Error("选择请求已失效");
      this.pendingUserInputs.delete(id);
      pending(decision);
      return;
    }
    const pending = this.pendingApprovals.get(String(requestId));
    if (!pending) throw new Error("审批请求已失效");
    this.pendingApprovals.delete(String(requestId));
    pending({ decision: decision === "allow" ? "accept" : decision === "cancel" ? "cancel" : "decline" });
  }

  actualRuntime(threadId, turnId) { return readCodexRuntime(threadId, turnId); }

  handleRequest(message) {
    if (message.method === "item/tool/requestUserInput") {
      const context = this.contexts.get(message.params?.threadId);
      if (!context) throw new Error("选择请求没有对应的洛神赋任务");
      return new Promise((resolve) => {
        this.pendingUserInputs.set(String(message.id), resolve);
        this.onApproval({
          ...context,
          provider: "codex",
          taskId: context.taskId,
          runId: context.runId,
          externalRequestId: `user-input:${message.id}`,
          title: "请选择后继续",
          detail: "",
          options: message.params?.questions || [],
        });
      });
    }
    if (!message.method.includes("requestApproval")) throw new Error(`Unsupported Codex request: ${message.method}`);
    const threadId = message.params?.threadId;
    const context = this.contexts.get(threadId);
    if (!context) throw new Error("审批请求没有对应的洛神赋任务");
    return new Promise((resolve) => {
      this.pendingApprovals.set(String(message.id), resolve);
      this.onApproval({
        ...context,
        taskId: context.taskId,
        runId: context.runId,
        externalRequestId: String(message.id),
        title: message.params?.reason || message.params?.item?.command || "Codex 请求执行权限",
        detail: JSON.stringify(message.params, null, 2),
        options: [{ id: "allow", name: "允许一次" }, { id: "reject", name: "拒绝" }, { id: "cancel", name: "取消任务" }],
      });
    });
  }

  handleNotification(message) {
    if (["account/rateLimits/updated", "account/updated", "account/login/completed"].includes(message.method)) this.onAccountChange?.();
    const threadId = message.params?.threadId || message.params?.thread?.id;
    const context = this.contexts.get(threadId);
    if (!context) return;
    const event = normalizeCodex(message);
    if (event) this.onEvent({ ...context, event });
    if (message.method === "turn/completed") {
      const turn = message.params?.turn;
      const status = turn?.status;
      if (status === "failed") context.reject?.(new Error(turn.error?.message || "Codex 执行失败"));
      else context.resolve?.({ stopReason: status === "interrupted" ? "cancelled" : "end_turn", ...this.actualRuntime(threadId, context.turnId) });
      this.contexts.set(threadId, { taskId: context.taskId, runId: context.runId });
    }
  }

  async close() { await this.rpc.close(); }
}

function localSkills(cwd) {
  const roots = [path.join(os.homedir(), ".codex", "skills"), path.join(os.homedir(), ".agents", "skills"), path.join(cwd, ".agents", "skills")];
  const seen = new Set();
  return roots.flatMap((root) => globSync(path.join(root, "**", "SKILL.md"))).map((file) => {
    const source = readFileSync(file, "utf8");
    const name = source.match(/^name:\s*(.+)$/m)?.[1]?.trim() || path.basename(path.dirname(file));
    const description = source.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
    return { name, description, path: file, enabled: true, interface: { displayName: name } };
  }).filter((skill) => !seen.has(skill.name) && seen.add(skill.name));
}

export function readCodexRuntime(threadId, turnId, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  try {
    const file = globSync(path.join(codexHome, "sessions", "**", `*${threadId}.jsonl`))[0];
    let actual = null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "turn_context" && (!turnId || entry.payload?.turn_id === turnId)) actual = { model: entry.payload.model, effort: entry.payload.effort };
      } catch {}
    }
    return actual;
  } catch { return null; }
}

function normalizeCodex(message) {
  const { method, params } = message;
  if (method === "item/agentMessage/delta") return { type: "message", role: "assistant", content: params.delta || "", raw: message };
  if (method.includes("reasoning") && typeof params?.delta === "string") return { type: "thought", role: "assistant", title: "思考摘要", content: params.delta, raw: message };
  if (method.includes("commandExecution") && typeof params?.delta === "string") return { type: "tool", title: "命令输出", content: params.delta, raw: message };
  if (method === "item/started" || method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage" && item.text) return { type: "message", role: "assistant", content: item.text, raw: message };
    return { type: "tool", title: item.type || method, content: summarizeItem(item), raw: message };
  }
  if (method === "turn/completed") return { type: "result", title: "本轮结束", content: params.turn?.status || "completed", raw: message };
  if (method === "error") return { type: "error", title: "Codex 错误", content: params.error?.message || params.message || "未知错误", raw: message };
  return null;
}

function summarizeItem(item) {
  if (item.command) return Array.isArray(item.command) ? item.command.join(" ") : String(item.command);
  if (item.path) return item.path;
  if (item.name) return item.name;
  return item.status || "";
}

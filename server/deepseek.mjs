import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { JsonRpcProcess } from "./json-rpc.mjs";

export class DeepseekRuntime {
  constructor({ resourceDirectory, dataDirectory, readKey, currentAccount, onEvent, onApproval, onExit, onStderr, mcp }) {
    this.resourceDirectory = resourceDirectory;
    this.dataDirectory = dataDirectory;
    this.readKey = readKey;
    // 当前使用的账号 id；密钥、DSH_HOME 与会话隔离都以它为准。
    this.currentAccount = currentAccount || (() => null);
    this.onEvent = onEvent;
    this.onApproval = onApproval;
    this.onExit = onExit;
    this.onStderr = onStderr;
    this.mcp = mcp;
    this.pools = new Map();
    this.sessions = new Map();
    this.pendingApprovals = new Map();
    this.modelCache = [];
    // 主动重置（切号/换密钥）时关闭子进程不应被当成"运行时崩溃"上报给执行器。
    this.suppressed = new Set();
  }

  accountId() { return this.currentAccount?.() || null; }

  async currentKey() { return this.readKey(this.accountId()); }

  async getAccountStatus() { return { configured: Boolean(await this.currentKey()) }; }

  async getBalance() {
    const key = await this.currentKey();
    if (!key) return null;
    try {
      const response = await fetch("https://api.deepseek.com/user/balance", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`余额读取失败（${response.status}）`);
      return { ...(await response.json()), updatedAt: new Date().toISOString() };
    } catch (error) { return { error: error.message, updatedAt: new Date().toISOString() }; }
  }
  listModels() { return Promise.resolve(this.modelCache); }

  async pool(permission) {
    if (this.pools.has(permission)) return this.pools.get(permission);
    const account = this.accountId();
    const key = await this.readKey(account);
    if (!key) throw new Error("请先在设置中配置 Deepseek API Key");
    const dsh = path.join(this.resourceDirectory, "node_modules/@deepseek-ai/dsh/lib/bin.js");
    const imagePatch = path.join(this.resourceDirectory, "server/deepseek-image.patch.yml");
    const rpc = new JsonRpcProcess(process.execPath, [dsh, "--profile", "acp", "--patch", imagePatch], {
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: key,
        // 会话与缓存按账号隔离，避免用 A 账号的 key 去续 B 账号的会话。
        DSH_HOME: path.join(this.dataDirectory, "deepseek", account || "default", permission),
        DSH_PERMISSION_MODE: permission,
      },
      onRequest: (message) => this.handleRequest(rpc, message),
      onExit: (error) => {
        if (this.suppressed.has(rpc)) { this.suppressed.delete(rpc); return; }
        if (this.pools.get(permission) === rpc) this.pools.delete(permission);
        this.onExit?.(error, permission);
      },
      onStderr: (chunk) => { process.stderr.write(`[deepseek:${permission}] ${chunk}`); this.onStderr?.(chunk, permission); },
    });
    rpc.subscribe((message) => this.handleNotification(rpc, message));
    await rpc.start();
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    this.pools.set(permission, rpc);
    return rpc;
  }

  async startConversation({ task, conversation, message, attachments = [], instructions = "" }) {
    const rpc = await this.pool(task.permission);
    let sessionId = conversation.external_id;
    let response;
    // 旧会话绑定的 cwd 已变、或会话无法续接时，会按当前目录重开会话；调用方据此提示用户上下文不再续接。
    let restarted = false;
    const mcpServers = [this.mcp.deepseek(task.id)];
    const active = sessionId ? this.sessions.get(sessionId) : null;
    if (active?.rpc === rpc && active.workspace === task.workspace) response = { configOptions: active.configOptions };
    else if (active?.rpc === rpc) {
      // 内存中的会话被别的工作目录占用：harness 不允许换目录续接，直接按当前目录重开，不浪费一次注定失败的 resume。
      restarted = true;
      this.sessions.delete(sessionId);
      sessionId = null;
      response = await rpc.request("session/new", { cwd: task.workspace, mcpServers });
    } else if (sessionId) {
      try {
        response = await rpc.request("session/resume", { sessionId, cwd: task.workspace, mcpServers });
      } catch (error) {
        if (!restartableSession(error)) throw error;
        restarted = true;
        this.sessions.delete(sessionId);
        sessionId = null;
        response = await rpc.request("session/new", { cwd: task.workspace, mcpServers });
      }
    } else response = await rpc.request("session/new", { cwd: task.workspace, mcpServers });
    sessionId ||= response.sessionId;
    let configOptions = response.configOptions || [];
    const context = { taskId: task.id, runId: conversation.runId, rpc, configOptions, workspace: task.workspace };
    this.sessions.set(sessionId, context);
    this.captureModels(configOptions);
    const requested = modelConfigValue(configOptions, task.model || "deepseek-flash");
    const updatedModel = await rpc.request("session/set_config_option", { sessionId, configId: "model", value: requested });
    configOptions = updatedModel.configOptions || configOptions;
    this.captureModels(configOptions);
    if (conversation.reasoning_effort) {
      const updated = await rpc.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: conversation.reasoning_effort });
      configOptions = updated.configOptions || configOptions;
      this.captureModels(configOptions);
    }
    context.configOptions = configOptions;
    const text = [instructions, message].filter((item) => item && item.trim()).join("\n\n");
    const prompt = [
      ...(text ? [{ type: "text", text }] : []),
      ...await Promise.all(attachments.map(async (item) => item.mime.startsWith("image/")
        ? { type: "image", data: (await readFile(item.path)).toString("base64"), mimeType: item.mime }
        : { type: "resource_link", name: item.name, uri: pathToFileURL(item.path).href, mimeType: item.mime })),
    ];
    const completion = rpc.request("session/prompt", { sessionId, prompt }, 24 * 60 * 60 * 1000);
    const actualModel = configOptions.find((option) => option.id === "model")?.currentValue;
    const actualEffort = configOptions.find((option) => option.id === "reasoning_effort" || option.category === "thought_level")?.currentValue;
    return { externalId: sessionId, turnId: sessionId, actualModel: actualModel ? parseModelId(actualModel) : null, actualEffort, restarted, completion };
  }

  sendMessage(input) { return this.startConversation(input); }

  async cancel({ externalId, permission }) {
    const rpc = await this.pool(permission);
    rpc.notify("session/cancel", { sessionId: externalId });
  }

  async respondToApproval(requestId, decision) {
    const pending = this.pendingApprovals.get(String(requestId));
    if (!pending) throw new Error("审批请求已失效");
    this.pendingApprovals.delete(String(requestId));
    if (decision !== "allow") return pending.resolve({ outcome: { outcome: "cancelled" } });
    const option = pending.options.find((item) => item.kind === "allow_once" || item.kind === "allow_always");
    pending.resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
  }

  handleRequest(rpc, message) {
    if (message.method !== "session/request_permission") throw new Error(`Unsupported ACP request: ${message.method}`);
    const context = this.sessions.get(message.params?.sessionId);
    if (!context || context.rpc !== rpc) throw new Error("审批请求没有对应的洛神赋任务");
    return new Promise((resolve) => {
      this.pendingApprovals.set(String(message.id), { resolve, options: message.params.options || [] });
      this.onApproval({
        provider: "deepseek",
        taskId: context.taskId,
        runId: context.runId,
        externalRequestId: String(message.id),
        title: message.params.toolCall?.title || "Deepseek 请求执行权限",
        detail: JSON.stringify(message.params.toolCall || {}, null, 2),
        options: [{ id: "allow", name: "允许一次" }, { id: "reject", name: "拒绝" }, { id: "cancel", name: "取消任务" }],
      });
    });
  }

  handleNotification(rpc, message) {
    if (message.method !== "session/update") return;
    const context = this.sessions.get(message.params?.sessionId);
    if (!context || context.rpc !== rpc) return;
    const event = normalizeAcp(message.params.update, message);
    if (event) this.onEvent({ ...context, event });
  }

  captureModels(configOptions) {
    const model = configOptions.find((option) => option.id === "model");
    const choices = model?.options || model?.select?.options || [];
    const effort = configOptions.find((option) => option.id === "reasoning_effort" || option.category === "thought_level");
    const efforts = flattenOptions(effort?.options || effort?.select?.options || []).map((item) => ({ reasoningEffort: item.value, description: item.description, name: item.name || item.value }));
    const discovered = flattenOptions(choices).map((item) => ({
      id: parseModelId(item.value),
      name: brandName(item.name || item.value),
      description: item.description,
      provider: "deepseek",
      isDefault: parseModelId(item.value) === "deepseek-flash",
      defaultReasoningEffort: effort?.currentValue,
      supportedReasoningEfforts: efforts,
    }));
    this.modelCache = [...new Map([...this.modelCache, ...discovered].map((item) => [item.id, item])).values()];
  }

  // 切换账号/更换密钥时调用：关闭并丢弃所有子进程与会话缓存，下一次执行用新账号重新建池。
  async reset() {
    const pools = [...this.pools.values()];
    this.pools.clear();
    this.sessions.clear();
    this.pendingApprovals.clear();
    this.modelCache = [];
    for (const rpc of pools) this.suppressed.add(rpc);
    await Promise.all(pools.map((rpc) => rpc.close()));
  }

  async close() { await this.reset(); }
}

function flattenOptions(options) {
  return options.flatMap((item) => item.options || item.select?.options || item.entries || item.groups ? flattenOptions(item.options || item.select?.options || item.entries || item.groups || []) : item.value ? [item] : []);
}

// 运行时会返回官方品牌名 “DeepSeek-V41-Flash”，界面统一显示为 “Deepseek-V4.1-Flash”。
function brandName(value) {
  return String(value ?? "").replace(/DeepSeek/g, "Deepseek").replace("V41-", "V4.1-");
}

function modelConfigValue(configOptions, requested) {
  const model = configOptions.find((option) => option.id === "model");
  const choices = flattenOptions(model?.options || model?.select?.options || []);
  const match = choices.find((item) => item.value === requested || item.name === requested || parseModelId(item.value) === requested);
  if (!match) throw new Error(`Deepseek 运行时不支持模型：${requested}`);
  return match.value;
}

function parseModelId(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed[1] : value; }
  catch { return value; }
}

// 旧会话绑定的工作目录已变、或会话日志已被清理时，harness 会拒绝 resume；
// 这类情况按当前目录重开会话即可，不应让整轮执行失败。
function restartableSession(error) {
  return /session cwd does not match|session is not resumable/i.test(String(error?.message || ""));
}

function text(content) {
  if (content?.type === "text") return content.text || "";
  if (content?.type === "resource_link") return `${content.name || "资源"}: ${content.uri || ""}`;
  return content ? JSON.stringify(content) : "";
}

function normalizeAcp(update, raw) {
  const kind = update?.sessionUpdate;
  if (kind === "agent_message_chunk") return { type: "message", role: "assistant", content: text(update.content), raw };
  if (kind === "agent_thought_chunk") return { type: "thought", role: "assistant", title: "思考摘要", content: text(update.content), raw };
  if (kind === "tool_call" || kind === "tool_call_update") return { type: "tool", title: update.title || update.kind || "工具调用", content: update.rawInput ? JSON.stringify(update.rawInput, null, 2) : (update.status || text(update.content?.[0]?.content)), raw };
  if (kind === "usage_update") return { type: "usage", title: "上下文用量", content: JSON.stringify(update, null, 2), raw };
  if (kind === "plan" || kind === "plan_update") return { type: "progress", title: "执行计划", content: JSON.stringify(update.entries || update, null, 2), raw };
  return { type: "diagnostic", title: kind || "ACP 事件", content: "", raw };
}

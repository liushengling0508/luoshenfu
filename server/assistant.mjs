// 贾维斯的日常问答。
//
// 直接调用 Deepseek 的 OpenAI 兼容接口，不走 runner：
// 这里只需要一问一答，不需要任务编排、Worktree 隔离、执行快照那些重机制，
// 走一遍反而慢得多。API Key 仍然只从钥匙串读取，不落库、不记日志。
//
// 支持两件让贾维斯"真的能做事"的事：
// 1. 工具调用——查时间/天气、打开网页或文件、操作这台 Mac 的屏幕、执行命令；
// 2. 流式输出——第一句话生成出来就交给界面播报，不用等整段写完。

import { readDeepseekKey } from "./keychain.mjs";
import { executeTool, toolDefs } from "./assistant-tools.mjs";

const endpoint = "https://api.deepseek.com/chat/completions";

// 官方目前只放开这两个（实测 /models 的返回，也是报错信息里给出的名字）。
// deepseek-chat 作为旧别名仍然能用，但已不在列表里，所以不再当默认值。
export const supportedModels = [
  { id: "deepseek-flash", name: "Deepseek Flash", hint: "响应快、便宜，适合日常问答" },
  { id: "deepseek-v4-pro", name: "Deepseek V4 Pro", hint: "推理模型，更慢更贵，但更擅长复杂问题" },
];

export const defaultModel = "deepseek-flash";

const systemPrompt = `你是洛神赋里的智能助手「贾维斯」。洛神赋是运行在这台 Mac 上的本地智能体工作台，可以创建任务交给 Codex 或 Deepseek 执行。

回答要求：
- 用简体中文，简洁直接，不要客套和过度铺垫；回答会被念出来，所以控制在几句话内。
- 你可以调用工具：查当前时间、查城市天气、打开网页或本地文件、截屏查看屏幕、移动与点击鼠标、输入文字、按键、滚动、执行命令。
- 用户让你做这些事时，直接调用工具去做，不要说"我做不到"；做完后用一两句话说明结果。
- 不确定的事就说不确定，绝不编造执行结果。
- 遇到删除文件、格式化磁盘、关机重启这类破坏性要求，先说明风险并拒绝执行。`;

const maxRounds = 6;

/** 给界面用的短说明，播报时能听出贾维斯正在做什么。 */
function toolSummary(name, args) {
  if (name === "get_current_time") return "正在看时间";
  if (name === "get_weather") return `正在查天气${args.city ? `（${args.city}）` : ""}`;
  if (name === "open_target") return `正在打开${args.target ? ` ${args.target}` : ""}`;
  if (name === "run_shell") return "正在执行命令";
  if (name === "computer_screenshot") return "正在看屏幕";
  if (name === "computer_click") return `正在点击（${args.x}, ${args.y}）`;
  if (name === "computer_type") return "正在输入文字";
  if (name === "computer_key") return `正在按键 ${args.key || ""}`;
  if (name === "computer_scroll") return "正在滚动";
  return `正在执行 ${name}`;
}

/** 流式返回的 tool_calls 是分片下发的，要按 index 拼回完整调用。 */
function mergeToolCalls(calls, deltas) {
  for (const item of deltas) {
    const index = Number.isInteger(item.index) ? item.index : calls.length;
    if (!calls[index]) calls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
    const target = calls[index];
    if (item.id) target.id = item.id;
    if (item.function?.name) target.function.name += item.function.name;
    if (item.function?.arguments) target.function.arguments += item.function.arguments;
  }
}

/** 逐行读取 SSE，把正文增量交给 onDelta，把工具调用拼好返回。 */
async function readSse(body, onDelta) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let content = "";
  const calls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      const delta = event?.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) mergeToolCalls(calls, delta.tool_calls);
    }
  }
  return { content, calls };
}

/** 非流式问答：内部仍然走流式请求，只是把增量拼成完整答案一次返回。 */
export async function ask(question, history = [], model, accountId = null) {
  const result = await run({ question, history, model, accountId, onDelta: () => {}, onTool: () => {} });
  return { answer: result.answer, model: result.model, usage: result.usage, tools: result.tools };
}

/** 流式问答：正文增量与工具调用通过 emit(type, data) 实时交给界面。 */
export function askStream(question, history = [], model, accountId, emit) {
  return run({
    question,
    history,
    model,
    accountId,
    onDelta: (text) => emit("delta", { text }),
    onTool: (info) => emit("tool", info),
  });
}

async function run({ question, history, model, accountId, onDelta, onTool }) {
  const key = await readDeepseekKey(accountId);
  if (!key) throw new Error("尚未配置 Deepseek API Key，请先在「设置」里填写");

  const chosen = supportedModels.some((item) => item.id === model) ? model : defaultModel;

  // 只带最近几轮，避免上下文无限增长；工具调用会让请求变重，历史再长就更慢。
  const recent = history
    .filter((item) => item && typeof item.content === "string" && item.content.trim())
    .slice(-6)
    .map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content.slice(0, 2000) }));

  const messages = [{ role: "system", content: systemPrompt }, ...recent, { role: "user", content: question }];
  const used = [];
  let answer = "";
  let usage = null;
  let withTools = true;

  for (let round = 0; round < maxRounds; round += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: chosen,
        messages,
        stream: true,
        // 回答会被朗读，太长既慢又难听完；Flash 在这个长度内足够表达清楚。
        max_tokens: 1024,
        ...(withTools ? { tools: toolDefs, tool_choice: "auto" } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // 只有确认是 tools 参数不被支持时才去掉工具重试；
      // 图片之类的 400 应当如实抛出来，而不是把工具静默关掉（那样用户会以为"还是做不到"）。
      if (withTools && response.status === 400 && /tool|function/i.test(detail)) {
        withTools = false;
        round -= 1;
        continue;
      }
      throw new Error(`Deepseek 请求失败（${response.status}）${detail ? `：${detail.slice(0, 200)}` : ""}`);
    }

    const { content, calls } = await readSse(response.body, onDelta);
    if (content) answer += content;

    if (!calls.length) {
      const finalText = answer.trim();
      if (!finalText) throw new Error("模型只产出了推理过程、没有给出正文，请重试或换用 Deepseek Flash");
      return { answer: finalText, model: chosen, usage, tools: used };
    }

    // 先把模型这一轮的"我要调用工具"记进上下文，再逐个执行并回填结果。
    messages.push({ role: "assistant", content: content || null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name || "";
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
      onTool({ name, arguments: args, summary: toolSummary(name, args) });
      used.push(name);
      let result;
      try {
        result = await executeTool(name, args);
      } catch (error) {
        result = { text: `工具执行失败：${error.message}` };
      }
      const toolContent = result.image
        ? [
          { type: "text", text: result.text },
          { type: "image_url", image_url: { url: `data:${result.image.mimeType};base64,${result.image.data}` } },
        ]
        : result.text;
      messages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
    }
  }

  return { answer: answer.trim() || "这一步没有产生回答，请再试一次。", model: chosen, usage, tools: used };
}

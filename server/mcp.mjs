import readline from "node:readline";

const baseUrl = process.env.LUOSHENFU_BASE_URL;
const token = process.env.LUOSHENFU_TOKEN;
const taskId = process.env.LUOSHENFU_TASK_ID;

const tools = [
  tool("get_task", "读取当前洛神赋任务", {}),
  tool("workbench_me", "读取当前开发台账号，使用洛神赋 Keychain 中的个人凭据", {}),
  tool("workbench_assignment_options", "读取开发台真实项目和大需求选项", {}),
  tool("workbench_list_tasks", "查询当前账号可见的开发台任务，可包含已归档记录", { status: { enum: ["todo", "doing", "review", "done", "block"] }, include_archived: { type: "boolean", default: true }, page: { type: "integer", minimum: 1 } }),
  tool("workbench_create_task", "创建开发台任务；须使用真实项目、大需求和明确的开发或测试类型", { title: string(), detail: string(), priority: { enum: ["P0", "P1", "P2"] }, repo: string(), project_id: string(), requirement_id: string(), kind: { enum: ["development", "test"] } }, ["title", "detail", "project_id", "kind"]),
  tool("workbench_update_task", "修改开发台任务的标题、说明或状态", { task_id: string(), title: string(), detail: string(), status: { enum: ["todo", "doing", "review", "done", "block"] } }, ["task_id"]),
  tool("list_my_tasks", "列出当前任务创建或关联的子任务", {}),
  tool("create_subtask", "向另一个智能体创建子任务", { title: string(), description: string(), idempotency_key: string() }, ["title", "idempotency_key"]),
  tool("report_progress", "上报任务进度（0-100）", { progress: { type: "integer", minimum: 0, maximum: 100 }, message: string() }, ["progress"]),
  tool("send_task_message", "向父任务或子任务发送明确消息", { task_id: string(), message: string() }, ["task_id", "message"]),
  tool("complete_task", "声明当前任务完成", { summary: string() }, ["summary"]),
  tool("block_task", "声明当前任务阻塞", { reason: string() }, ["reason"]),
  tool("attach_image", "把一张本机图片直接显示到当前任务的会话里：用户能看到、点击放大、复制图像或保存。用于展示验证截图、生成的结果图等；只发值得让用户看到的图片，不要每张都发。", { path: string(), name: string(), caption: string() }, ["path"]),
  tool("computer_screenshot", "查看 Mac 主屏幕。仅在用户要求操作电脑或验证界面时使用；首次使用会请求用户授权", {}),
  tool("computer_click", "点击主屏幕坐标；操作前先用 computer_screenshot 查看屏幕", { x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 } }, ["x", "y"]),
  tool("computer_type", "在当前焦点输入文字", { text: { type: "string", minLength: 1, maxLength: 4000 } }, ["text"]),
  tool("computer_key", "按键或组合键", { key: { type: "string", description: "enter/tab/escape/delete/space/left/right/up/down/page_up/page_down 或单个字母数字" }, modifiers: { type: "array", items: { enum: ["command", "control", "option", "shift"] }, uniqueItems: true } }, ["key"]),
  tool("computer_scroll", "滚动当前界面", { direction: { enum: ["up", "down"] }, amount: { type: "integer", minimum: 1, maximum: 10, default: 3 } }, ["direction"]),
];

function string() { return { type: "string" }; }
function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

async function call(name, args) {
  const response = await fetch(`${baseUrl}/api/mcp/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-luoshenfu-token": token, "x-luoshenfu-task": taskId },
    body: JSON.stringify(args || {}),
  });
  const body = await response.json();
  if (!response.ok) return { content: [{ type: "text", text: body.error || `HTTP ${response.status}` }], isError: true };
  return Array.isArray(body.content) ? body : { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(message, "id")) return;
  try {
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "luoshenfu", version: "1.0.2" } };
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") result = await call(message.params?.name, message.params?.arguments);
    else throw new Error(`Unsupported method: ${message.method}`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } })}\n`);
  }
});

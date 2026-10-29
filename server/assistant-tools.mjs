// 贾维斯可以调用的工具：查时间与天气、打开网页或本地文件、操作这台 Mac 的屏幕、执行命令。
// 每个工具只做被明确要求的事，并把结果交回模型；真正的动作都在本机完成，不经过任何第三方。

import { execFile as execFileCallback, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { useComputer } from "./computer.mjs";
import { openArguments } from "./open-target.mjs";

const execFile = promisify(execFileCallback);

/** OpenAI 兼容格式的工具声明。描述写得具体一些，模型才不容易乱调。 */
export const toolDefs = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前日期、星期和准确时间。用户问现在几点、今天几号时使用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询某个城市当前的天气和今天的气温范围。用户问天气时使用。",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "城市名，例如 杭州、北京、上海" } },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_target",
      description: "用系统默认应用打开一个网页网址，或在访达中显示一个本地绝对路径。用户说打开某网站、打开某文件或文件夹时使用。",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "http(s) 网址，或本地绝对路径" } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computer_screenshot",
      description: "截取主屏幕截图并查看内容。做点击、输入这类操作前先用它看清屏幕，点击坐标以这张截图的像素为准。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "computer_click",
      description: "在主屏幕的指定像素坐标点击一次。坐标必须来自最近一次截图。",
      parameters: {
        type: "object",
        properties: { x: { type: "integer" }, y: { type: "integer" } },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computer_type",
      description: "向当前获得焦点的输入位置键入一段文字。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "要输入的文字" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computer_key",
      description: "按一个键或组合键，例如回车、esc、上下左右，或 command+c 这类组合。",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "enter/tab/escape/delete/space/left/right/up/down/page_up/page_down 或单个字母数字" },
          modifiers: { type: "array", items: { type: "string", enum: ["command", "control", "option", "shift"] } },
        },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computer_scroll",
      description: "滚动当前界面。",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "integer", description: "滚动格数 1-10，默认 3" },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "在这台 Mac 上执行一条 shell 命令并返回输出。适合查看系统信息、文件列表、进程等；不允许执行破坏性命令。",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "要执行的命令" } },
        required: ["command"],
      },
    },
  },
];

// 明确会破坏系统的命令直接拒绝——模型偶尔会被上下文带偏，这里不能只靠提示词。
const forbidden = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bdiskutil\s+(erase|reformat|partitionDisk)/i,
  /:\(\)\s*\{/,
  />\s*\/dev\/(disk|rdisk)/i,
];

function currentTime() {
  const now = new Date();
  return now.toLocaleString("zh-CN", { dateStyle: "full", timeStyle: "medium" });
}

const weatherCodes = new Map([
  [0, "晴"], [1, "大致晴朗"], [2, "局部多云"], [3, "阴"], [45, "雾"], [48, "雾凇"],
  [51, "小毛毛雨"], [53, "毛毛雨"], [55, "大毛毛雨"], [61, "小雨"], [63, "中雨"], [65, "大雨"],
  [66, "冻雨"], [67, "强冻雨"], [71, "小雪"], [73, "中雪"], [75, "大雪"], [77, "雪粒"],
  [80, "阵雨"], [81, "强阵雨"], [82, "暴雨"], [85, "阵雪"], [86, "强阵雪"],
  [95, "雷阵雨"], [96, "雷阵雨伴冰雹"], [99, "强雷阵雨伴冰雹"],
]);

function weatherText(code) {
  return weatherCodes.get(Number(code)) || "未知天气";
}

async function getWeather(city) {
  const name = String(city || "").trim();
  if (!name) throw new Error("缺少城市名");
  const geo = await (await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`,
    { signal: AbortSignal.timeout(10_000) },
  )).json();
  const place = geo?.results?.[0];
  if (!place) throw new Error(`没有找到城市「${name}」`);
  const data = await (await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}`
    + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m"
    + "&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1",
    { signal: AbortSignal.timeout(10_000) },
  )).json();
  const current = data?.current || {};
  const daily = data?.daily || {};
  const low = daily.temperature_2m_min?.[0];
  const high = daily.temperature_2m_max?.[0];
  return `${place.name}${place.admin1 ? `（${place.admin1}）` : ""}：现在 ${current.temperature_2m}°C，`
    + `体感 ${current.apparent_temperature}°C，${weatherText(current.weather_code)}，`
    + `湿度 ${current.relative_humidity_2m}%，风速 ${current.wind_speed_10m} km/h；`
    + `今天 ${low}~${high}°C。`;
}

async function openTarget(target) {
  const args = openArguments(target);
  if (args[0] === "-R") await stat(args[1]);
  spawn("/usr/bin/open", args, { detached: true, stdio: "ignore" }).unref();
  return args[0] === "-R" ? `已在访达中显示：${args[1]}` : `已用默认浏览器/应用打开：${args[0]}`;
}

async function runShell(command) {
  const value = String(command || "").trim();
  if (!value) throw new Error("命令为空");
  if (value.length > 4000) throw new Error("命令过长");
  if (forbidden.some((rule) => rule.test(value))) throw new Error("这条命令可能破坏系统，已拒绝执行");
  const { stdout, stderr } = await execFile("/bin/zsh", ["-c", value], { timeout: 20_000, maxBuffer: 1 << 20 });
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  return output ? output.slice(0, 4000) : "（命令执行完成，没有输出）";
}

async function runComputer(name, input) {
  const result = await useComputer(name, input);
  if (result?.content) {
    const textPart = result.content.find((item) => item.type === "text");
    const imagePart = result.content.find((item) => item.type === "image");
    return {
      text: textPart?.text || "已截取屏幕",
      image: imagePart ? { data: imagePart.data, mimeType: imagePart.mimeType } : null,
    };
  }
  return { text: JSON.stringify(result) };
}

/**
 * 执行一个工具。返回 { text, image? }：
 * text 一定存在，image 只在截图时出现（交给多模态模型查看）。
 */
export async function executeTool(name, input = {}) {
  if (name === "get_current_time") return { text: `现在的本机时间是：${currentTime()}` };
  if (name === "get_weather") return { text: await getWeather(input.city) };
  if (name === "open_target") return { text: await openTarget(input.target) };
  if (name === "run_shell") return { text: await runShell(input.command) };
  if (name === "computer_screenshot") return runComputer(name, {});
  if (name.startsWith("computer_")) return runComputer(name, input);
  throw new Error(`未知工具：${name}`);
}

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const keyCodes = { enter: 36, tab: 48, escape: 53, delete: 51, space: 49, left: 123, right: 124, down: 125, up: 126, page_up: 116, page_down: 121 };
const modifierNames = { command: "command down", control: "control down", option: "option down", shift: "shift down" };

export function validateComputerInput(name, input = {}, bounds = { width: 100_000, height: 100_000 }) {
  if (name === "computer_click") {
    const x = Number(input.x), y = Number(input.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) throw new Error(`点击坐标超出主屏幕范围（${bounds.width}×${bounds.height}）`);
    return { x, y };
  }
  if (name === "computer_type") {
    if (typeof input.text !== "string" || !input.text || input.text.length > 4000) throw new Error("输入文字必须为 1-4000 个字符");
    return { text: input.text };
  }
  if (name === "computer_key") {
    const key = String(input.key || "").toLowerCase();
    if (!keyCodes[key] && !/^[a-z0-9]$/.test(key)) throw new Error("不支持这个按键");
    const modifiers = [...new Set(Array.isArray(input.modifiers) ? input.modifiers : [])];
    if (modifiers.some((item) => !modifierNames[item])) throw new Error("不支持这个组合键");
    return { key, modifiers };
  }
  if (name === "computer_scroll") {
    const direction = input.direction === "up" ? "up" : input.direction === "down" ? "down" : "";
    const amount = Number(input.amount ?? 3);
    if (!direction || !Number.isInteger(amount) || amount < 1 || amount > 10) throw new Error("滚动方向或距离无效");
    return { direction, amount };
  }
  if (name === "computer_screenshot") return {};
  throw new Error("未知的 Computer Use 操作");
}

async function screenBounds() {
  const script = 'ObjC.import("AppKit"); const f=$.NSScreen.mainScreen.frame; JSON.stringify({width:Number(f.size.width),height:Number(f.size.height)})';
  const { stdout } = await execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
  return JSON.parse(stdout.trim());
}

async function appleScript(lines, args = []) {
  await execFile("/usr/bin/osascript", [...lines.flatMap((line) => ["-e", line]), "--", ...args]);
}

export async function useComputer(name, input) {
  const bounds = await screenBounds();
  const value = validateComputerInput(name, input, bounds);
  if (name === "computer_click") {
    await appleScript([`tell application "System Events" to click at {${value.x}, ${value.y}}`]);
    return { ok: true, action: "click", ...value };
  }
  if (name === "computer_type") {
    await appleScript(["on run argv", "tell application \"System Events\" to keystroke (item 1 of argv)", "end run"], [value.text]);
    return { ok: true, action: "type", characters: value.text.length };
  }
  if (name === "computer_key") {
    const using = value.modifiers.length ? ` using {${value.modifiers.map((item) => modifierNames[item]).join(", ")}}` : "";
    const action = keyCodes[value.key] ? `key code ${keyCodes[value.key]}` : `keystroke "${value.key}"`;
    await appleScript([`tell application "System Events" to ${action}${using}`]);
    return { ok: true, action: "key", ...value };
  }
  if (name === "computer_scroll") {
    const code = value.direction === "down" ? keyCodes.down : keyCodes.up;
    await appleScript([`tell application "System Events" to repeat ${value.amount} times`, `key code ${code}`, "end repeat"]);
    return { ok: true, action: "scroll", ...value };
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-screen-"));
  const file = path.join(directory, "screen.png");
  try {
    await execFile("/usr/sbin/screencapture", ["-x", "-D", "1", file]);
    await execFile("/usr/bin/sips", ["-z", String(bounds.height), String(bounds.width), file]);
    return { content: [
      { type: "text", text: `主屏幕截图 ${bounds.width}×${bounds.height}；点击工具使用截图中的像素坐标。` },
      { type: "image", data: (await readFile(file)).toString("base64"), mimeType: "image/png" },
    ] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

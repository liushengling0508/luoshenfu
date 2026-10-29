// 语音播报：调用 macOS 自带的 `say`。
// 离线、免费、不消耗任何模型额度，也不需要新的依赖。

import { execFile as execFileCallback, spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// `say -v '?'` 列出的是"系统认识的音色"，不等于"语音数据已安装"。
// 未安装的音色会合成出一个只有文件头的空音频（约 4.8KB）并静默退出——
// 表现就是"配置了却没声音"。所以必须实际合成一次来判断。
const probeText = "这是一段用于检测音色是否真正可用的测试文本，长度固定。";
const minAudioBytes = 20_000;

// 缓存不能是永久的：用户随时可能在系统设置里下载新语音，
// 永久缓存会让他必须重启 App 才看得到（踩过这个坑）。
const cacheTtlMs = 30_000;
let voicesCache = null;
let inFlight = null;

/** 合成一小段固定文本，用输出体积判断这个音色是否真的装了。 */
async function probeVoice(name) {
  const file = path.join(os.tmpdir(), `luoshenfu-voice-${process.pid}-${name.replace(/[^\w-]/g, "")}.aiff`);
  try {
    await execFile("/usr/bin/say", ["-v", name, "-o", file, "--", probeText], { timeout: 10_000 });
    const info = await stat(file);
    return info.size;
  } catch {
    return 0;
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

/**
 * 列出中文语音，并标出哪些真的可用。
 * 音色名会作为参数传给 say，所以只能来自系统输出，不能让调用方拼字符串。
 * @param force 跳过期缓存立即重新扫描（用户刚下载完语音时用）。
 */
export function listChineseVoices(force = false) {
  if (!force && voicesCache && Date.now() - voicesCache.at < cacheTtlMs) return Promise.resolve(voicesCache.list);
  // 同一时刻只跑一次扫描，避免并发请求把探测重复做十几遍。
  if (inFlight) return inFlight;
  inFlight = execFile("/usr/bin/say", ["-v", "?"], { maxBuffer: 1 << 20 })
    .then(async ({ stdout }) => {
      const found = [];
      const seen = new Set();
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(.+?)\s+zh_CN\s+#\s*(.*)$/);
        if (!match) continue;
        // 名字形如 "Eddy (中文（中国大陆）)" 或 "Yue (Premium)"；短名才是稳定的调用形式。
        const raw = match[1].trim();
        const name = raw.replace(/\s*\(.*$/, "");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        // 括号里的 "Premium" / "Enhanced" 是音质等级，保留下来用于挑选默认值。
        found.push({ name, sample: match[2].trim(), premium: /premium|enhanced|高级|增强/i.test(raw) });
      }
      // 并行探测：10 个音色约 1 秒。
      const probed = await Promise.all(found.map(async (item) => ({
        ...item,
        available: (await probeVoice(item.name)) > minAudioBytes,
      })));
      // 只保留真正装了语音数据的。列出没装的只会让人选到"没声音"的选项——
      // `say -v '?'` 会把它们也报出来，但合成结果是一个空的文件头。
      // 高音质的排在前面，下拉框第一项就是更好的那个。
      return probed
        .filter((item) => item.available)
        .sort((a, b) => Number(b.premium) - Number(a.premium));
    })
    .then((list) => {
      voicesCache = { at: Date.now(), list };
      return list;
    })
    .catch(() => voicesCache?.list || [])
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** 默认音色：列表已按"高音质优先"排过序，直接取第一个。 */
export async function defaultVoice() {
  const voices = await listChineseVoices();
  return voices[0]?.name || "Tingting";
}

let current = null;
// 流式回答会被切成好几段播报：同一轮内按顺序排队，不能被下一段打断；
// 只有新一轮提问（interrupt）或手动停止才会清空整条队列。
let generation = 0;
let pending = 0;
let tail = Promise.resolve();

function playSay(chosen, content, atSchedule) {
  return new Promise((resolve) => {
    // 排队期间已经被打断，这一条就不播了。
    if (atSchedule !== generation) return resolve();
    // `--` 之后的内容一律当作文本，避免消息以 "-" 开头时被 say 当成选项。
    const child = spawn("/usr/bin/say", ["-v", chosen, "--", content], { stdio: "ignore" });
    current = child;
    const clear = () => { if (current === child) current = null; };
    child.once("exit", () => { clear(); resolve(); });
    child.once("error", () => { clear(); resolve(); });
  });
}

/**
 * 播报。默认打断当前与队列里未播的内容（用于新一轮提问）；
 * 流式分段播报传 interrupt: false，让几段话按顺序说完。
 */
export async function speak(content, voice, options = {}) {
  if (options.interrupt !== false) stopSpeaking();
  const atSchedule = generation;
  const voices = await listChineseVoices();
  // 用户选的音色没装（或名字非法）时，回落到一个确实能出声的。
  const requested = voices.find((item) => item.name === voice && item.available);
  const chosen = requested?.name || await defaultVoice();
  tail = tail.then(async () => {
    if (atSchedule !== generation) return;
    pending += 1;
    try { await playSay(chosen, content, atSchedule); } finally { pending -= 1; }
  }).catch(() => {});
  // 按中文语速粗略估算时长，前端用它决定"说话态"要维持多久。
  return { voice: chosen, characters: content.length, estimatedMs: Math.min(60_000, 600 + content.length * 190) };
}

export function stopSpeaking() {
  // 号码一换，排队中的段落全部作废。
  generation += 1;
  if (!current) return false;
  current.kill("SIGTERM");
  current = null;
  return true;
}

export function isSpeaking() {
  return Boolean(current) || pending > 0;
}

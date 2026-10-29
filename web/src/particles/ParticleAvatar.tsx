// 贾维斯的粒子窗口界面：一个透明背景的画布 + 悬停才出现的控制条，
// 以及底部的问答输入。问答走 /api/assistant，播报走 /api/speech（系统 say）。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api, apiStream } from "../api";
import { builtinSkins, defaultCustomSkin, isDarkColor, parseCustomSkin, skinById } from "../skins";
import { nebulaCloud } from "./geometry";
import { ParticleRenderer } from "./renderer";
import { avatarStates, type AvatarState } from "./state";
import "./avatar.css";

// 一次性生成上限点云，密度靠"只画前 N 颗"实现，所以拖动滑块不必重建缓冲区。
// URL 的 ?particles= 可以覆盖这个上限，用于低配机器、无头截图和性能调试。
// 上限收到 6 万：星云生成要为每颗粒子跑分形噪声，粒子过多会让窗口打开明显变慢。
const MIN_PARTICLES = 8_000;
const DEFAULT_MAX_PARTICLES = 60_000;

function maxParticles(): number {
  const value = Number(new URLSearchParams(window.location.search).get("particles"));
  return Number.isFinite(value) && value >= 500 && value <= 400_000 ? Math.round(value) : DEFAULT_MAX_PARTICLES;
}

// 点云只生成一次，窗口重开时直接复用。
const cloud = nebulaCloud(maxParticles());

// 滑块用对数映射：低密度区间需要更细的手感，线性映射会让可用的手感全挤在前半段。
function densityToCount(density: number): number {
  if (cloud.count <= MIN_PARTICLES) return cloud.count;
  return Math.round(MIN_PARTICLES * Math.pow(cloud.count / MIN_PARTICLES, density / 100));
}

function countToDensity(count: number): number {
  if (cloud.count <= MIN_PARTICLES) return 100;
  const ratio = Math.log(count / MIN_PARTICLES) / Math.log(cloud.count / MIN_PARTICLES);
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function formatCount(count: number): string {
  return count >= 10_000 ? `${(count / 10_000).toFixed(1)} 万` : String(count);
}

// 星云铺满整个体积（不是一层壳），所以需要比"球"更多的粒子才有云的密度；
// 但粒子本身要小，靠数量和重叠融成雾，而不是靠单颗大点。
const defaults = { density: countToDensity(14_000), pointSize: 55, sphereSize: 75, brightness: 70 };

// 范围 0.25–2.4：滑块拉到头时颗粒约为默认的 1.7 倍，能明显看出变化。
function pointScaleOf(value: number) { return 0.25 + (value / 100) * 2.15; }
function radiusOf(value: number) { return 0.4 + (value / 100) * 0.8; }
function gainOf(value: number) { return 0.4 + (value / 100) * 1.6; }

// 窗口跟随球体等比缩放：球缩小时整个窗体一起缩小，而不是留一大片空白。
// 下限 300 是为了还能放下底部的控制条。
const BASE_WINDOW_SIZE = 420;
const MIN_WINDOW_SIZE = 300;

// 说完一句话后静默这么久没有新的识别结果，就自动发送。
const SILENCE_MS = 2000;

function savedSlider(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    // 必须先判 null：Number(null) 是 0 而不是 NaN，直接转换会让 fallback 永远失效，
    // 首次打开时全部读到 0（球又小又暗又稀）。
    if (raw === null || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveSlider(key: string, value: number) {
  // 存储不可用时只影响记忆，不影响本次调整。
  try { localStorage.setItem(key, String(Math.round(value))); } catch { /* 忽略 */ }
}

function savedFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.trim() === "") return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* 忽略 */ }
}

const captions: Record<AvatarState, string> = {
  idle: "贾维斯",
  listening: "正在聆听",
  thinking: "正在思考",
  speaking: "正在说话",
  working: "正在执行",
};

const buttonLabels: Record<AvatarState, string> = {
  idle: "待机",
  listening: "聆听",
  thinking: "思考",
  speaking: "说话",
  working: "执行",
};

/** 读取主窗口的皮肤：强调色决定粒子颜色，底色明暗决定用发光还是墨点。 */
function currentSkin(): { accent: string; dark: boolean } {
  try {
    const custom = parseCustomSkin(localStorage.getItem("appearance.skinCustom"));
    const skinId = localStorage.getItem("appearance.skin");
    if (skinId === "custom") {
      const background = custom?.background || defaultCustomSkin().background;
      return { accent: custom?.accent || defaultCustomSkin().accent, dark: isDarkColor(background) };
    }
    const preset = (skinId ? skinById(skinId) : undefined) || builtinSkins[0];
    return { accent: preset.accent, dark: isDarkColor(preset.background) };
  } catch {
    return { accent: builtinSkins[0].accent, dark: false };
  }
}

type MicrophoneStatus = "live" | "simulated" | "denied";

/** 音频能量：麦克风可用就用真实音量，不可用则用合成包络兜底，保证形态变化看得见。 */
function useAudioEnergy() {
  const energy = useRef(0);
  const [status, setStatus] = useState<MicrophoneStatus>("simulated");
  const analyserRef = useRef<AnalyserNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  // 让按钮能重新发起连接：用户可能在首次尝试之后才去系统设置里授权。
  const connectRef = useRef<() => Promise<void>>(async () => {});
  const connectingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let samples: Uint8Array<ArrayBuffer> | null = null;
    let frame = 0;

    const tick = () => {
      if (cancelled) return;
      const analyser = analyserRef.current;
      let target: number;
      if (analyser) {
        if (!samples || samples.length !== analyser.frequencyBinCount) samples = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(samples);
        // 只取低频段：人声能量集中在这里，高频底噪不该驱动粒子。
        const bins = Math.max(1, Math.floor(samples.length * 0.22));
        let sum = 0;
        for (let index = 0; index < bins; index += 1) sum += samples[index];
        target = Math.min(1, Math.pow(sum / bins / 255, 0.7) * 1.9);
      } else {
        const t = performance.now() / 1000;
        const syllable = Math.pow(Math.abs(Math.sin(t * 6.1)), 0.6) * 0.62 + Math.pow(Math.abs(Math.sin(t * 3.3 + 1.7)), 0.8) * 0.38;
        const phrase = Math.pow(Math.max(0.08, Math.sin(t * 0.52)), 0.8);
        target = Math.min(1, syllable * phrase);
      }
      // 快起慢落，贴合声音包络，避免粒子颤抖。
      energy.current += (target - energy.current) * (target > energy.current ? 0.45 : 0.1);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const connect = async () => {
      if (connectingRef.current || analyserRef.current) return;
      connectingRef.current = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        const context = new AudioContext();
        await context.resume().catch(() => {});
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        contextRef.current = context;
        analyserRef.current = analyser;
        setStatus("live");
      } catch {
        if (!cancelled) setStatus("denied");
      } finally {
        connectingRef.current = false;
      }
    };
    connectRef.current = connect;
    void connect();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      analyserRef.current = null;
      void contextRef.current?.close().catch(() => {});
      contextRef.current = null;
    };
  }, []);

  // 恢复 AudioContext 需要用户手势；之前失败的连接也在这里重试一次。
  const requestMicrophone = useCallback(async () => {
    const context = contextRef.current;
    if (context) { await context.resume().catch(() => {}); return; }
    await connectRef.current();
  }, []);

  return { energy, status, requestMicrophone };
}

export function ParticleAvatar() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ParticleRenderer | null>(null);
  const { energy, status, requestMicrophone } = useAudioEnergy();
  const [state, setState] = useState<AvatarState>("idle");
  const [skin, setSkin] = useState(currentSkin);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [density, setDensity] = useState(() => savedSlider("avatar.density", defaults.density));
  const [pointSize, setPointSize] = useState(() => savedSlider("avatar.pointSize", defaults.pointSize));
  const [sphereSize, setSphereSize] = useState(() => savedSlider("avatar.sphereSize", defaults.sphereSize));
  const [brightness, setBrightness] = useState(() => savedSlider("avatar.brightness", defaults.brightness));
  // 默认开：全息投影需要暗底，浅色桌面上没有它就没法看。
  const [halo, setHalo] = useState(() => savedFlag("avatar.halo", true));
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  // 听写：正在把麦克风里的说话转成文字（Rust 侧 SFSpeechRecognizer）。
  const [dictating, setDictating] = useState(false);
  const [dictationNote, setDictationNote] = useState("");
  // 语音唤醒：喊一声名字就开始听，不用点球。默认关闭，避免麦克风常开。
  const [wakeEnabled, setWakeEnabled] = useState(() => savedFlag("avatar.wake", false));
  const [wakeKeyword, setWakeKeyword] = useState(() => localStorage.getItem("avatar.wakeKeyword") || "贾维斯");
  // 音色与模型都存在本机；选项来自服务端（系统真实可用的语音 / 官方放开的模型）。
  const [voice, setVoice] = useState(() => localStorage.getItem("avatar.voice") || "");
  const [model, setModel] = useState(() => localStorage.getItem("avatar.model") || "");
  const [voiceOptions, setVoiceOptions] = useState<{ name: string; sample: string; available: boolean; premium: boolean }[]>([]);
  const [modelOptions, setModelOptions] = useState<{ id: string; name: string; hint: string }[]>([]);
  // 只带最近几轮，避免上下文无限增长。
  const historyRef = useRef<{ role: string; content: string }[]>([]);
  const speakTimer = useRef<number | null>(null);
  // 流式回答的分段播报：攒够一句就先念，结束时再补上尾巴。
  const speechBuffer = useRef("");
  const speechEndAt = useRef(0);
  // 听写状态：静音计时器、当前识别到的文本、"这一段是否已经发出去"。
  const silenceTimer = useRef<number | null>(null);
  const lastText = useRef("");
  const sentText = useRef(false);
  // 单击 = 说话，按住移动 = 拖动窗口；靠位移区分，所以不再依赖系统的拖动区域。
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // 监听模式：off 不监听 / wake 等唤醒词 / talk 正在正式提问。
  const mode = useRef<"off" | "wake" | "talk">("off");
  // 事件回调里要读到最新值，但不该因此重新订阅。
  const wakeKeywordRef = useRef(wakeKeyword);
  const wakeEnabledRef = useRef(wakeEnabled);
  useEffect(() => { wakeKeywordRef.current = wakeKeyword; }, [wakeKeyword]);
  useEffect(() => { wakeEnabledRef.current = wakeEnabled; }, [wakeEnabled]);
  useEffect(() => { saveFlag("avatar.wake", wakeEnabled); }, [wakeEnabled]);
  useEffect(() => {
    try { localStorage.setItem("avatar.wakeKeyword", wakeKeyword); } catch { /* 忽略 */ }
  }, [wakeKeyword]);

  const clearSilence = useCallback(() => {
    if (silenceTimer.current !== null) { window.clearTimeout(silenceTimer.current); silenceTimer.current = null; }
  }, []);

  // 几段播报可能排队，所以"说话态"按「剩余时间 + 本段时长」累加，否则会被后一段提前收回。
  const markSpeaking = useCallback((ms: number) => {
    const now = Date.now();
    const remaining = Math.max(0, speechEndAt.current - now) + ms;
    speechEndAt.current = now + remaining;
    setState("speaking");
    if (speakTimer.current) window.clearTimeout(speakTimer.current);
    speakTimer.current = window.setTimeout(() => {
      speakTimer.current = null;
      setState((current) => (current === "speaking" ? "idle" : current));
    }, remaining);
  }, []);

  const playSegment = useCallback((text: string) => {
    void api<{ estimatedMs: number }>("/api/speech/speak", {
      method: "POST",
      // interrupt: false —— 同一轮回答的几段话要按顺序念完，不能互相打断。
      body: JSON.stringify({ text, voice: voice || undefined, interrupt: false }),
    }).then((spoken) => markSpeaking(spoken.estimatedMs)).catch(() => {});
  }, [voice, markSpeaking]);

  // 流式增量按句切分：攒到句末标点（或够长）就先念，听到第一句的等待因此大幅缩短。
  const queueSpeech = useCallback((text: string) => {
    speechBuffer.current += text;
    const match = speechBuffer.current.match(/^([\s\S]*?[。！？!?；;\n])/);
    if (match && match[1].trim().length >= 4) {
      speechBuffer.current = speechBuffer.current.slice(match[1].length);
      playSegment(match[1].trim());
      return;
    }
    if (speechBuffer.current.trim().length >= 80) {
      const segment = speechBuffer.current.trim();
      speechBuffer.current = "";
      playSegment(segment);
    }
  }, [playSegment]);

  const flushSpeech = useCallback(() => {
    const tail = speechBuffer.current.trim();
    speechBuffer.current = "";
    if (tail) playSegment(tail);
  }, [playSegment]);

  useEffect(() => {
    void api<{ voices: { name: string; sample: string; available: boolean; premium: boolean }[]; default: string }>("/api/speech/voices")
      .then((data) => {
        setVoiceOptions(data.voices);
        // 只在用户没存过偏好时才用默认值，否则会覆盖他自己的选择。
        setVoice((current) => current || data.default);
      })
      .catch(() => {});
    void api<{ models: { id: string; name: string; hint: string }[]; default: string }>("/api/assistant/models")
      .then((data) => {
        setModelOptions(data.models);
        setModel((current) => current || data.default);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { if (voice) localStorage.setItem("avatar.voice", voice); }, [voice]);
  useEffect(() => { if (model) localStorage.setItem("avatar.model", model); }, [model]);

  // 试听：播报一小段，让用户直接比较音色，不用先问一个问题。
  const previewVoice = useCallback((name: string) => {
    void api("/api/speech/speak", { method: "POST", body: JSON.stringify({ text: "你好，我是贾维斯。", voice: name }) }).catch(() => {});
  }, []);

  const submit = useCallback(async (raw?: string) => {
    const value = (raw ?? question).trim();
    if (!value || asking) return;
    setQuestion("");
    setAnswer("");
    setAsking(true);
    setShowSettings(false);
    setDemo(false);
    // 立刻收掉听写：等待回答与开始播报的这段时间里，喇叭的声音会绕回麦克风被识别。
    // sentText 同时挡住迟到的识别片段，别把输入框又填上。
    mode.current = "off";
    clearSilence();
    sentText.current = true;
    void invoke("stop_dictation").catch(() => {});
    // 新一轮提问：清掉上一轮还没念完的播报，别让旧答案压住新问题。
    void api("/api/speech/stop", { method: "POST" }).catch(() => {});
    speechBuffer.current = "";
    speechEndAt.current = 0;
    // 提问到回答之间是"思考"；第一段文字到达后由 markSpeaking 切到"说话"。
    setState("thinking");
    try {
      // 流式：第一句生成出来就开始念，不用等整段写完——这就是"响应快"的主要来源。
      const result = await apiStream("/api/assistant/stream", {
        question: value,
        history: historyRef.current,
        model: model || undefined,
      }, {
        onDelta: (text) => { setAnswer((current) => current + text); queueSpeech(text); },
        // 调工具时在球下方短暂显示"正在打开…"，让用户知道它真的在动手。
        onTool: (info) => setDictationNote(info.summary),
      });
      historyRef.current = [...historyRef.current, { role: "user", content: value }, { role: "assistant", content: result.answer }].slice(-8);
      setAnswer(result.answer);
      flushSpeech();
    } catch (reason) {
      setAnswer(reason instanceof Error ? reason.message : "提问失败");
      setState("idle");
    } finally {
      setAsking(false);
    }
  }, [question, asking, model, clearSilence, queueSpeech, flushSpeech]);

  // 事件回调需要调用最新的 submit，但不能因此把监听反复重新订阅。
  const submitRef = useRef(submit);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  /** 把当前识别到的文字当成一次提问发出去；同一段话只发一次。 */
  const sendDictated = useCallback(() => {
    if (sentText.current) return;
    const text = lastText.current.trim();
    if (!text) return;
    sentText.current = true;
    setQuestion(text);
    setDictating(false);
    setState((current) => (current === "listening" ? "thinking" : current));
    // 先停听写：释放麦克风，也让识别任务收尾（迟到的片段会被 sentText 挡掉）。
    void invoke("stop_dictation").catch(() => {});
    void submitRef.current(text);
  }, []);

  // Rust 侧听写结果：partial 实时回填输入框，停顿一会自动发送，error / done 收尾。
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen<{ kind: string; text: string; message: string | null }>("dictation", (event) => {
      const payload = event.payload;
      if (payload.kind === "partial") {
        // 已经发送过就忽略迟到的识别片段，别把输入框又填上。
        if (sentText.current) return;
        // 识别器会周期性重复推送同一个片段；只有文字真的变了才刷新静音计时，
        // 否则计时会被无限重置，话说完也不会自动发送。
        if (payload.text === lastText.current) return;
        // 唤醒监听：只有听到那一声名字才理会，其余说话一律忽略。
        if (mode.current === "wake") {
          const keyword = wakeKeywordRef.current.trim();
          lastText.current = payload.text;
          if (!keyword) return;
          const at = payload.text.lastIndexOf(keyword);
          if (at < 0) return;
          const rest = payload.text.slice(at + keyword.length).replace(/^[，,。、！!？?\s]+/, "").trim();
          if (rest.length >= 2) {
            // 一次说全："贾维斯，今天天气怎么样"
            mode.current = "off";
            clearSilence();
            void invoke("stop_dictation").catch(() => {});
            void submitRef.current(rest);
          } else {
            // 只喊了名字：另起一个正式会话，避免把"贾维斯"三个字带进问题里。
            mode.current = "talk";
            clearSilence();
            sentText.current = false;
            lastText.current = "";
            void (async () => {
              await invoke("stop_dictation").catch(() => {});
              await new Promise((resolve) => window.setTimeout(resolve, 320));
              if (mode.current !== "talk") return;
              setDictating(true);
              setState("listening");
              await invoke("start_dictation", { locale: "zh-CN" }).catch(() => {});
            })();
          }
          return;
        }
        setQuestion(payload.text);
        lastText.current = payload.text;
        clearSilence();
        if (payload.text.trim()) {
          silenceTimer.current = window.setTimeout(() => { silenceTimer.current = null; sendDictated(); }, SILENCE_MS);
        }
      } else if (payload.kind === "final") {
        clearSilence();
        if (payload.text) lastText.current = payload.text;
        if (lastText.current.trim()) sendDictated();
        else { setDictating(false); setState((current) => (current === "listening" ? "idle" : current)); }
      } else if (payload.kind === "error") {
        clearSilence();
        mode.current = "off";
        sentText.current = true;
        setDictating(false);
        setState((current) => (current === "listening" ? "idle" : current));
        setDictationNote(payload.message || "语音识别失败");
      } else {
        clearSilence();
        mode.current = "off";
        setDictating(false);
        setState((current) => (current === "listening" ? "idle" : current));
      }
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; clearSilence(); unlisten?.(); };
  }, [clearSilence, sendDictated]);

  /** 进入唤醒监听：麦克风常开，只等那一声名字。 */
  const startWake = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__ || !wakeEnabledRef.current) return;
    mode.current = "wake";
    sentText.current = false;
    lastText.current = "";
    setQuestion("");
    clearSilence();
    await requestMicrophone();
    setDictating(true);
    setState("listening");
    try {
      await invoke("start_dictation", { locale: "zh-CN" });
    } catch {
      mode.current = "off";
      setDictating(false);
      setState("idle");
    }
  }, [requestMicrophone, clearSilence]);

  // 空闲下来（播报结束、会话超时）且开关还开着时，自动回到唤醒监听。
  useEffect(() => {
    if (!wakeEnabled || !window.__TAURI_INTERNALS__) return;
    if (state !== "idle" || asking || dictating) return;
    if (mode.current !== "off") return;
    const timer = window.setTimeout(() => { void startWake(); }, 700);
    return () => window.clearTimeout(timer);
  }, [wakeEnabled, state, asking, dictating, startWake]);

  // 点击球开始 / 停止听写。开始前先确保麦克风已授权——Rust 与网页用的是同一个麦克风权限。
  const toggleDictation = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__) { setDictationNote("语音提问只在桌面版可用"); return; }
    if (dictating) {
      mode.current = "off";
      clearSilence();
      if (lastText.current.trim()) {
        // 手动停止时把已经听到的内容发出去，而不是丢掉。
        sendDictated();
      } else {
        // 什么都没听到：直接退出聆听，别让按钮卡在"正在聆听"上，
        // 否则用户得再点一次才能真正开始下一轮。
        sentText.current = true;
        void invoke("stop_dictation").catch(() => {});
        setDictating(false);
        setState((current) => (current === "listening" ? "idle" : current));
      }
      return;
    }
    // 手动点击开始：这是正式听写，不是唤醒监听。
    mode.current = "talk";
    setDictationNote("");
    setShowSettings(false);
    setDemo(false);
    // 贾维斯正在播报就先让它闭嘴：外放的声音会绕回麦克风被识别成用户说的话。
    if (speakTimer.current !== null) { window.clearTimeout(speakTimer.current); speakTimer.current = null; }
    void api("/api/speech/stop", { method: "POST" }).catch(() => {});
    clearSilence();
    lastText.current = "";
    sentText.current = false;
    await requestMicrophone();
    setDictating(true);
    setState("listening");
    try {
      await invoke("start_dictation", { locale: "zh-CN" });
    } catch (reason) {
      setDictating(false);
      setState("idle");
      setDictationNote(typeof reason === "string" ? reason : "无法启动语音识别");
    }
  }, [dictating, requestMicrophone, clearSilence, sendDictated]);

  // 提示只短暂显示，不常驻在球上。
  useEffect(() => {
    if (!dictationNote) return;
    const timer = window.setTimeout(() => setDictationNote(""), 6000);
    return () => window.clearTimeout(timer);
  }, [dictationNote]);

  useEffect(() => () => {
    if (speakTimer.current) window.clearTimeout(speakTimer.current);
    if (silenceTimer.current !== null) window.clearTimeout(silenceTimer.current);
    // 关闭窗口时收掉听写，不让麦克风一直开着。
    if (window.__TAURI_INTERNALS__) void invoke("stop_dictation").catch(() => {});
  }, []);

  // 渲染器只创建一次：能量通过 ref 回调读取，避免每帧重挂载。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: ParticleRenderer | null = null;
    try {
      renderer = new ParticleRenderer({ canvas, cloud, accent: currentSkin().accent, getEnergy: () => energy.current });
      renderer.start();
      rendererRef.current = renderer;
      requestAnimationFrame(() => renderer?.setTargetOpacity(1));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "粒子渲染初始化失败");
    }
    return () => {
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => { rendererRef.current?.setState(state); }, [state]);
  useEffect(() => {
    rendererRef.current?.setAccent(skin.accent);
    // 有暗底时始终用发光模式；没有暗底时，浅色皮肤会把加法发光吃掉，只能切成墨点。
    rendererRef.current?.setLightMode(!halo && !skin.dark);
  }, [skin, halo]);
  useEffect(() => saveFlag("avatar.halo", halo), [halo]);
  // 三个外观参数只改 uniform 或绘制数量，拖动时实时生效，不重建顶点缓冲。
  useEffect(() => { rendererRef.current?.setDrawCount(densityToCount(density)); }, [density]);
  useEffect(() => { rendererRef.current?.setPointScale(pointScaleOf(pointSize)); }, [pointSize]);
  useEffect(() => { rendererRef.current?.setRadius(radiusOf(sphereSize)); }, [sphereSize]);
  // 窗体跟着球体一起缩放。浏览器开发模式下没有窗口能力，直接跳过。
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const size = Math.max(MIN_WINDOW_SIZE, Math.round(BASE_WINDOW_SIZE * radiusOf(sphereSize)));
    void getCurrentWindow().setSize(new LogicalSize(size, size)).catch(() => {});
  }, [sphereSize]);
  useEffect(() => { rendererRef.current?.setGain(gainOf(brightness)); }, [brightness]);
  useEffect(() => saveSlider("avatar.density", density), [density]);
  useEffect(() => saveSlider("avatar.pointSize", pointSize), [pointSize]);
  useEffect(() => saveSlider("avatar.sphereSize", sphereSize), [sphereSize]);
  useEffect(() => saveSlider("avatar.brightness", brightness), [brightness]);

  // 皮肤可能在主窗口里被改掉；storage 事件之外再低频轮询一次兜底。
  useEffect(() => {
    const sync = () => setSkin((current) => {
      const next = currentSkin();
      return next.accent === current.accent && next.dark === current.dark ? current : next;
    });
    window.addEventListener("storage", sync);
    const timer = window.setInterval(sync, 1500);
    return () => {
      window.removeEventListener("storage", sync);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!demo) return;
    const sequence: AvatarState[] = ["listening", "thinking", "speaking", "idle"];
    let index = 0;
    setState(sequence[0]);
    const timer = window.setInterval(() => {
      index = (index + 1) % sequence.length;
      setState(sequence[index]);
    }, 3400);
    return () => window.clearInterval(timer);
  }, [demo]);

  // 语音/麦克风出问题时才出现一行小字，平时窗口里只有贾维斯本体。
  const microphoneIssue = status === "denied" ? "麦克风未授权：请到「系统设置 → 隐私与安全性 → 麦克风」允许洛神赋" : "";
  const note = dictationNote || microphoneIssue;

  return (
    <div className={halo ? "avatar-shell halo" : "avatar-shell"}>
      <div className="avatar-halo" aria-hidden="true" />
      {/* 窗口里只有贾维斯本体：单击说话 / 再点停下，按住拖动窗口。 */}
      <canvas
        ref={canvasRef}
        className="avatar-canvas"
        onMouseDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, moved: false }; }}
        onMouseMove={(event) => {
          const current = drag.current;
          if (!current || current.moved) return;
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 5) {
            current.moved = true;
            if (window.__TAURI_INTERNALS__) void getCurrentWindow().startDragging().catch(() => {});
          }
        }}
        onMouseUp={() => {
          const current = drag.current;
          drag.current = null;
          if (current && !current.moved) void toggleDictation();
        }}
        onMouseLeave={() => { drag.current = null; }}
      />
      {/* 鼠标移上来才出现的最小出口：外观 / 音色设置与关闭。 */}
      <div className="avatar-mini">
        <button type="button" className={showSettings ? "active" : ""} title="外观与音色设置" onClick={() => setShowSettings((value) => !value)}>⚙</button>
        <button type="button" title="关闭贾维斯窗口" onClick={() => void invoke("close_avatar").catch(() => window.close())}>×</button>
      </div>
      {error && <div className="avatar-error">{error}</div>}
      {showSettings && <div className="avatar-settings">
        <label><span>密度</span><input type="range" min="0" max="100" value={density} onChange={(event) => setDensity(Number(event.target.value))} /><b>{formatCount(densityToCount(density))}</b></label>
        <label><span>光点</span><input type="range" min="0" max="100" value={pointSize} onChange={(event) => setPointSize(Number(event.target.value))} /><b>{Math.round(pointSize)}</b></label>
        <label><span>球体</span><input type="range" min="0" max="100" value={sphereSize} onChange={(event) => setSphereSize(Number(event.target.value))} /><b>{Math.round(sphereSize)}</b></label>
        <label><span>亮度</span><input type="range" min="0" max="100" value={brightness} onChange={(event) => setBrightness(Number(event.target.value))} /><b>{Math.round(brightness)}</b></label>
        <label><span>暗底</span><button type="button" className={halo ? "avatar-switch on" : "avatar-switch"} aria-pressed={halo} onClick={() => setHalo((value) => !value)}><i /></button><b>{halo ? "开" : "关"}</b></label>
        <label><span>语音唤醒</span><button type="button" className={wakeEnabled ? "avatar-switch on" : "avatar-switch"} aria-pressed={wakeEnabled} onClick={() => setWakeEnabled((value) => !value)}><i /></button><b>{wakeEnabled ? "开" : "关"}</b></label>
        <label><span>唤醒词</span><input className="avatar-wake-input" value={wakeKeyword} maxLength={12} placeholder="贾维斯" title="喊出这个词就开始聆听" onChange={(event) => setWakeKeyword(event.target.value)} /><b /></label>
        <label><span>音色</span>
          <select value={voice} onChange={(event) => setVoice(event.target.value)} aria-label="播报音色">
            {voiceOptions.length ? voiceOptions.map((item) => <option key={item.name} value={item.name}>{item.premium ? `${item.name}（高音质）` : item.name}</option>) : <option value={voice}>{voice || "读取中…"}</option>}
          </select>
          <button type="button" className="avatar-try" title="试听这个音色" onClick={() => previewVoice(voice)}>▶</button>
        </label>
        <label><span>模型</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="问答模型" title={modelOptions.find((item) => item.id === model)?.hint || ""}>
            {modelOptions.length ? modelOptions.map((item) => <option key={item.id} value={item.id} title={item.hint}>{item.name}</option>) : <option value={model}>{model || "读取中…"}</option>}
          </select>
          <b />
        </label>
        <button type="button" className="avatar-settings-reset" onClick={() => { setDensity(defaults.density); setPointSize(defaults.pointSize); setSphereSize(defaults.sphereSize); setBrightness(defaults.brightness); }}>恢复默认</button>
      </div>}
      {!showSettings && note && <div className="avatar-toast">{note}</div>}
    </div>
  );
}

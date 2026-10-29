import { invoke } from "@tauri-apps/api/core";

export type ServiceInfo = { baseUrl: string; token: string };
let service: ServiceInfo | null = null;

async function info(): Promise<ServiceInfo> {
  if (service) return service;
  service = window.__TAURI_INTERNALS__ ? await invoke<ServiceInfo>("service_info") : { baseUrl: "http://127.0.0.1:47844", token: "dev-token" };
  return service;
}

/** 供 <audio>/<img> 等无法自定义请求头的元素使用：令牌只能走查询参数。 */
export async function serviceInfo(): Promise<ServiceInfo> {
  return info();
}

export function musicEndpoint(target: ServiceInfo, endpoint: string, filePath: string): string {
  return `${target.baseUrl}/api/music/${endpoint}?token=${encodeURIComponent(target.token)}&path=${encodeURIComponent(filePath)}`;
}

// 默认 20 秒兜底：本地服务的慢接口不该让界面无限等待；需要更久时由调用方显式指定。
const defaultTimeout = 20_000;

function requestSignal(signal: AbortSignal | null | undefined, timeout: number): AbortSignal {
  const timer = AbortSignal.timeout(timeout);
  if (!signal) return timer;
  // AbortSignal.any 在部分旧 WebView 上不存在，此时以超时为准（取消语义降级但不至于卡死）。
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return any ? any([signal, timer]) : timer;
}

// 本地服务不可达时，WKWebView 的 fetch 会抛 "Load failed"（其它内核是 "Failed to fetch"）。
// 这类错误不是业务失败，而是服务正在重启：统一换成一句用户能理解、也知道会自愈的提示。
function networkError(error: unknown): Error {
  const message = (error as Error)?.message || String(error);
  if (/load failed|failed to fetch|networkerror|network request failed/i.test(message)) {
    return new Error("本地服务已断开，正在自动恢复；若长时间没有反应，请重开洛神赋");
  }
  return error as Error;
}

export async function api<T>(path: string, init: RequestInit = {}, timeout = defaultTimeout): Promise<T> {
  const target = await info();
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}${path}`, {
      ...init,
      signal: requestSignal(init.signal, timeout),
      headers: { "content-type": "application/json", "x-luoshenfu-token": target.token, ...init.headers },
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") throw new Error("本地服务响应超时，请稍后重试");
    throw networkError(error);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `请求失败（${response.status}）`), { code: payload.code, status: response.status });
  return payload;
}

export async function apiBlob(path: string): Promise<Blob> {
  const target = await info();
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}${path}`, { headers: { "x-luoshenfu-token": target.token } });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `请求失败（${response.status}）`);
  }
  return response.blob();
}

export type ServerEvent = { type: string; data: Record<string, unknown> };

export async function connectEvents(onChange: (event: ServerEvent) => void, onOpen?: () => void, onState?: (online: boolean) => void): Promise<() => void> {
  const target = await info();
  const events = new EventSource(`${target.baseUrl}/api/events?token=${encodeURIComponent(target.token)}`);
  // 首次连上（含断线重连成功）时回调一次：App 的界面可能比本地服务先就绪，
  // 首个快照请求失败后界面不会自己恢复，用 SSE 建连作为「服务已可用」的信号补一次同步。
  events.onopen = () => { onState?.(true); onOpen?.(); };
  // 断线时先告诉界面「服务不在了」，重连成功后会自己恢复；本地服务现在也会被主进程自动重启。
  events.onerror = () => onState?.(false);
  for (const type of ["changed", "event", "approval", "account", "activity"]) {
    events.addEventListener(type, (message) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse((message as MessageEvent).data || "{}"); } catch { data = {}; }
      onChange({ type, data });
    });
  }
  return () => events.close();
}

export type StreamHandlers = {
  onDelta?: (text: string) => void;
  onTool?: (info: { name: string; summary: string }) => void;
  onDone?: (result: { answer: string; model: string; tools: string[] }) => void;
};

export type StreamResult = { answer: string; model: string; tools: string[] };

/**
 * 流式问答：逐段读取 SSE，把正文增量与工具调用实时交给界面。
 * 用 fetch 而不是 EventSource——这里必须发 POST 带 body。
 */
export async function apiStream(
  path: string,
  body: unknown,
  handlers: StreamHandlers = {},
  timeout = 180_000,
): Promise<StreamResult> {
  const target = await info();
  const response = await fetch(`${target.baseUrl}${path}`, {
    method: "POST",
    signal: requestSignal(null, timeout),
    headers: { "content-type": "application/json", "x-luoshenfu-token": target.token },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({} as Record<string, unknown>));
    throw new Error(String(payload.error || `请求失败（${response.status}）`));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: StreamResult | null = null;
  let failure: Error | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let type = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!type) continue;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(data || "{}") as Record<string, unknown>; } catch { payload = {}; }
      if (type === "delta") handlers.onDelta?.(String(payload.text || ""));
      else if (type === "tool") handlers.onTool?.({ name: String(payload.name || ""), summary: String(payload.summary || "") });
      else if (type === "done") {
        result = {
          answer: String(payload.answer || ""),
          model: String(payload.model || ""),
          tools: Array.isArray(payload.tools) ? payload.tools.map(String) : [],
        };
      } else if (type === "error") {
        failure = new Error(String(payload.message || "问答失败"));
      }
    }
  }

  if (failure) throw failure;
  if (!result) throw new Error("问答没有正常结束，请重试");
  handlers.onDone?.(result);
  return result;
}

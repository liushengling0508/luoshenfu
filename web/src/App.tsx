import { Component, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ErrorInfo, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, apiBlob, connectEvents } from "./api";
import type { Activity, ActivityPage, Approval, ArchivePage, Attachment, ChangeDiff, ChangeFile, ChatPage, LogPage, ModelOption, MusicSettings, PermissionMode, Project, Provider, RateLimitResetCredit, RevertResult, SettingsSnapshot, SkillOption, Snapshot, Task, TaskChanges, TaskDetail, TaskLog, TaskStatus, UserInputQuestion, WorktreeInfo } from "./types";
import { MusicPlayer } from "./Music";
import { Markdown } from "./markdown";
import { TaskDescription } from "./TaskDescription";
import { notificationBody, notificationCategory, notificationCategoryName, notificationLifetimeMs, notificationLimit } from "./notifications";
import { MAX_WALLPAPER_CHARS, MAX_WALLPAPER_SCRIM, builtinSkins, customFromSkin, defaultCustomSkin, exportSkin, importSkin, isDarkColor, materialOptions, migrateLegacyAppearance, parseCustomSkin, patchCustomSkin, radiusOptions, resolveActiveSkin, selectCustomSkin, selectPresetSkin, serializeCustomSkin, skinById, wallpaperBackgrounds, wallpaperOptions, wallpaperPreviewBackground, type ActiveSkin, type CustomSkin, type SkinState } from "./skins";

const columns: { id: TaskStatus; label: string; hint: string }[] = [
  { id: "todo", label: "待执行", hint: "准备开始" },
  { id: "running", label: "执行中", hint: "实时运行" },
  { id: "in_review", label: "待验证", hint: "检查结果" },
  { id: "blocked", label: "阻塞", hint: "需要处理" },
  { id: "done", label: "已完成", hint: "执行结束" },
];
const lanes = [
  { id: "codex", provider: "codex", name: "Codex" },
  { id: "deepseek", provider: "deepseek", name: "Deepseek" },
] as const;
const phaseName = { standalone: "独立任务", design: "设计", implementation: "实施", verification: "验证" };
// 流程三个阶段各自的职责边界，界面上要一眼看清，避免把实施或验证的工作混进设计阶段。
const phaseDuty = { standalone: "直接完成并汇报关键进度", design: "只出方案，不做任何实施", implementation: "只执行当前设计，不扩大范围", verification: "只核对实施结果，不修复、不返工" };
const permissionName = { "read-only": "只读", "workspace-write": "工作区写入", "danger-full-access": "完整访问" };
type RunOptions = { targetId?: string; message?: string; planMode?: boolean; skill?: string; attachments?: Attachment[] };
type WorkflowStages = Record<"design" | "implementation" | "verification", { provider: Provider; model: string; effort: string }>;
const newWorkflowStages = (): WorkflowStages => ({
  design: { provider: "codex", model: "", effort: "high" },
  implementation: { provider: "deepseek", model: "", effort: "high" },
  verification: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
});
// 应用内通知：一条活动记录 + 出现时间，渲染成右上角的通知卡片。
type AppNotification = { id: string; activity: Activity; shownAt: number };
const replyLanguages = [
  { id: "zh-CN", name: "简体中文" },
  { id: "en", name: "English" },
  { id: "auto", name: "跟随输入" },
];
const uiScaleOptions = [{ value: .9, name: "较小" }, { value: 1, name: "标准" }, { value: 1.1, name: "稍大" }, { value: 1.2, name: "较大" }];
const setupPrompt = `请帮我检查并完成“洛神赋”App 的运行前置配置，目标是安装后即可使用。请按以下顺序执行，并在最后给出逐项检查结果：

1. 只读检查这台电脑是否为 Apple Silicon Mac、macOS 14 或更高版本；如果不满足，请停止并说明原因。
2. 检查“应用程序”目录中是否已安装官方 ChatGPT 或 Codex App，或者 PATH 中是否有可执行的 codex 命令。若缺失，只能从 OpenAI 官方渠道安装，并在下载或安装前征得我的确认。
3. 检查 Codex 是否已登录。需要登录时打开官方登录流程，由我本人完成账号登录；不要读取或记录我的登录凭据，也不要修改 ~/.codex/config.toml。
4. 如果我已附带洛神赋 DMG，请检查文件后将 App 安装到“应用程序”；如果没有，请告诉我需要提供洛神赋_1.0.2_arm64.dmg。遇到 macOS 未签名提示时优先指导我右键“打开”，执行任何解除隔离命令前必须先说明影响并征得我确认。
5. Deepseek Harness 已内置在洛神赋中，不要重复安装。只检查网络能否访问 Deepseek API，并提醒我从 Deepseek 官方平台获取个人 API Key，再由我本人粘贴到“洛神赋 → 设置”中。
6. 不要要求我在聊天中发送 Deepseek API Key，不要读取、打印、记录或写入任何密钥；密钥应只由洛神赋保存到 macOS 钥匙串。
7. 启动洛神赋，确认 Codex 显示已连接；提醒我完成 Deepseek API Key 录入和测试连接。除登录、密钥录入及必须由我确认的安全步骤外，请自动完成其余安全、可逆的检查和配置。

最后请用“已通过 / 需要我操作 / 未通过”列出每项结果和仍存在的阻塞。`;
function savedSkinState(): SkinState {
  const storedCustom = parseCustomSkin(localStorage.getItem("appearance.skinCustom"));
  const skinId = localStorage.getItem("appearance.skin");
  if (skinId === "custom") return { skinId, custom: storedCustom ?? defaultCustomSkin() };
  const preset = skinId ? skinById(skinId) : undefined;
  if (preset) return { skinId: preset.id, custom: storedCustom ?? customFromSkin(preset) };
  const migrated = migrateLegacyAppearance({ theme: localStorage.getItem("appearance.theme"), background: localStorage.getItem("appearance.background"), accent: localStorage.getItem("appearance.accent") });
  return storedCustom ? { ...migrated, custom: storedCustom } : migrated;
}
function activeWallpaperBackground(active: ActiveSkin): string {
  if (active.wallpaper !== "custom") return wallpaperBackgrounds[active.wallpaper];
  return active.wallpaperImage ? `url("${active.wallpaperImage}") center / cover no-repeat` : "transparent";
}
function savedUiScale() { const value = Number(localStorage.getItem("appearance.uiScale")); return uiScaleOptions.some((item) => item.value === value) ? value : 1; }
// 任务详情双栏：右侧分隔条拖动改变左右两栏比例，左侧分隔条拖动改变整个面板宽度并让两栏等比缩放；
// 两者都记在 localStorage 里，下次打开沿用。没记录时交给 CSS 的默认值。
// 左栏最小 300px，右侧执行区至少保留 380px（含 12px 分隔条），整个面板最小 720px、最大跟随窗口。
const drawerSplitMinInfo = 300;
const drawerSplitMinExec = 380;
const drawerSplitHandleWidth = 12;
const drawerSplitStep = 24;
const drawerSplitKey = "layout.taskDrawerInfoWidth";
const drawerPanelMinWidth = 720;
const drawerPanelStep = 32;
const drawerPanelKey = "layout.taskDrawerWidth";
function savedDrawerSplitWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(drawerSplitKey));
    return Number.isFinite(value) && value >= drawerSplitMinInfo ? Math.round(value) : null;
  } catch { return null; }
}
function savedDrawerPanelWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(drawerPanelKey));
    return Number.isFinite(value) && value >= drawerPanelMinWidth ? Math.round(value) : null;
  } catch { return null; }
}

// 兜底错误边界：任何渲染或副作用异常都只显示可恢复页面，而不是整页白屏。
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("洛神赋界面异常", error, info.componentStack); }
  private recover = () => {
    try {
      localStorage.removeItem("appearance.skin");
      localStorage.removeItem("appearance.skinCustom");
    } catch { /* 清不掉就直接重载 */ }
    window.location.reload();
  };
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="crash-page">
      <h1>界面出现异常</h1>
      <p>{this.state.error.message || "未知错误"}</p>
      <div className="crash-actions">
        <button onClick={() => window.location.reload()}>重新加载</button>
        <button className="primary" onClick={this.recover}>恢复默认皮肤并重载</button>
      </div>
    </div>;
  }
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ projects: [], tasks: [], chats: [], archivedTotal: 0, unreadActivities: 0 });
  const [projectId, setProjectId] = useState<string>("");
  const [page, setPage] = useState<"board" | "archive" | "settings" | "activity">("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [pullingWorkbench, setPullingWorkbench] = useState(false);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [music, setMusic] = useState<MusicSettings | null>(null);
  const [notice, setNotice] = useState<string>("");
  // 本地服务（sidecar）连接状态：断线时顶栏给出明确提示，SSE 重连成功后自动恢复。
  const [serviceOnline, setServiceOnline] = useState(true);
  const [activities, setActivities] = useState<ActivityPage>({ items: [], page: 1, pageSize: 50, total: 0, totalPages: 0, unread: 0 });
  const [appNotifications, setAppNotifications] = useState<AppNotification[]>([]);
  const notificationsEnabled = useRef(true);
  const [skin, setSkin] = useState<SkinState>(savedSkinState);
  const [uiScale, setUiScale] = useState(savedUiScale);
  const [avatar, setAvatarState] = useState(() => localStorage.getItem("profile.avatar") || "");
  const [agentName, setAgentNameState] = useState(() => localStorage.getItem("profile.agentName") || "智能体");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("appearance.sidebarCollapsed") === "true");
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [projectChats, setProjectChats] = useState<Task[]>([]);
  const [chatPage, setChatPage] = useState(0);
  const [chatTotalPages, setChatTotalPages] = useState(0);
  const chatRequest = useRef(0);
  const chatPageRef = useRef(0);
  const expandedProjectRef = useRef<string | null>(null);
  const chatRefreshTimer = useRef<number | null>(null);
  const projectIdRef = useRef("");
  const selectedIdRef = useRef<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const detailTimer = useRef<number | null>(null);
  const refreshRequest = useRef(0);
  const detailRequest = useRef(0);

  // refresh 保持稳定引用：SSE 订阅因此只挂载一次，不再随选中项目/任务反复重连。
  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    const currentProject = projectIdRef.current;
    const next = await api<Snapshot>(`/api/snapshot${currentProject ? `?projectId=${currentProject}` : ""}`);
    // 快速切换项目时只认最后一次请求，避免旧项目的响应覆盖新项目。
    if (request !== refreshRequest.current) return;
    setSnapshot(next);
    setSnapshotLoaded(true);
    // 快照里的 tasks 是按项目过滤的：当前项目失效（或尚未选中）时回退到第一个项目，避免空面板。
    if (next.projects[0] && !next.projects.some((item) => item.id === currentProject)) setProjectId(next.projects[0].id);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    // 只取最近 300 条事件；更早的记录由 loadOlderEvents 按需续拉，避免一次几十 MB。
    const next = await api<TaskDetail>(`/api/tasks/${id}?eventLimit=300`);
    if (request !== detailRequest.current) return;
    setDetail((value) => {
      if (!value || value.id !== id) return next;
      // 保留用户已手动加载的更早记录，避免流式刷新把它们清掉、滚动位置跳回底部。
      const oldestNew = next.eventsOldestId ?? null;
      const olderKept = oldestNew ? value.events.filter((event) => event.id < oldestNew) : [];
      if (!olderKept.length) return next;
      return { ...next, events: [...olderKept, ...next.events], eventsHasMore: value.eventsHasMore ?? next.eventsHasMore, eventsOldestId: value.eventsOldestId ?? next.eventsOldestId };
    });
  }, []);

  const loadOlderEvents = useCallback(async (id: string, beforeId: number) => {
    if (!beforeId) return;
    const older = await api<TaskDetail>(`/api/tasks/${id}?eventLimit=300&beforeId=${beforeId}`);
    setDetail((value) => value && value.id === id
      ? { ...value, events: [...older.events, ...value.events], eventsHasMore: older.eventsHasMore, eventsOldestId: older.eventsOldestId }
      : value);
  }, []);

  // 流式输出时每个 chunk 都会推一条事件，统一做 200ms 尾随合并，避免请求风暴。
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refresh().catch(() => {});
    }, 200);
  }, [refresh]);

  const scheduleDetailRefresh = useCallback(() => {
    if (detailTimer.current !== null) return;
    detailTimer.current = window.setTimeout(() => {
      detailTimer.current = null;
      const current = selectedIdRef.current;
      if (current) void loadDetail(current).catch(() => {});
    }, 300);
  }, [loadDetail]);

  const loadSettings = useCallback(async () => setSettings(await api<SettingsSnapshot>("/api/settings")), []);
  const loadMusic = useCallback(async () => setMusic(await api<MusicSettings>("/api/music/settings")), []);
  const loadActivities = useCallback(async (nextPage = 1) => setActivities(await api<ActivityPage>(`/api/activities?page=${nextPage}`)), []);
  const openActivity = useCallback((activity: Activity) => {
    if (activity.project_id) setProjectId(activity.project_id);
    // 直接在当前页面弹出任务详情抽屉（与归档页一致），不先跳到任务面板。
    if (activity.task_id) setSelectedId(activity.task_id);
  }, []);
  // 贾维斯是独立的透明置顶窗口，浏览器开发模式下没有这个能力。
  const toggleAvatar = useCallback(() => {
    if (!window.__TAURI_INTERNALS__) { setNotice("贾维斯窗口只在桌面版可用"); return; }
    void invoke<boolean>("toggle_avatar").catch((error) => setNotice(typeof error === "string" ? error : "无法打开贾维斯窗口"));
  }, []);

  // 本地服务随 App 一起冷启动，可能比界面晚几秒；首屏快照按 200ms 间隔重试约 30 秒，服务就绪后立刻出数据。
  useEffect(() => { void retry(refresh, 150, 200).catch((error) => setNotice(error.message)); }, [refresh]);
  useEffect(() => { void retry(loadSettings).catch((error) => setNotice(error.message)); }, [loadSettings]);
  useEffect(() => { void retry(loadMusic).catch(() => {}); }, [loadMusic]);
  useEffect(() => { void retry(loadActivities).catch(() => {}); }, [loadActivities]);
  useEffect(() => { notificationsEnabled.current = settings ? settings.notifications.system : true; }, [settings]);
  useEffect(() => { expandedProjectRef.current = expandedProjectId; }, [expandedProjectId]);
  useEffect(() => {
    projectIdRef.current = projectId;
    // 切换项目必须重新拉取快照：快照里的任务列表是按上一个项目过滤过的，
    // 沿用旧数据会让新项目的看板显示为空（表现为「刚打开没有任务」）。
    if (projectId) void refresh().catch(() => {});
  }, [projectId, refresh]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  // 只订阅一次：回调内部通过 ref 读取最新选中状态，切换项目/任务不再重复建立 EventSource。
  useEffect(() => {
    let close: (() => void) | undefined;
    let disposed = false;
    void connectEvents((event) => {
      scheduleRefresh();
      scheduleDetailRefresh();
      scheduleProjectChatsRefresh();
      if (event.type === "account") { void loadSettings(); void loadMusic(); }
      if (event.type === "activity") {
        void loadActivities();
        const activity = event.data.activity as Activity | undefined;
        // 应用内通知：直接推进右上角通知栈；窗口在后台时卡片会保留到回到应用再计时消失。
        if (activity && notificationsEnabled.current) {
          setAppNotifications((current) => [{ id: activity.id, activity, shownAt: Date.now() }, ...current.filter((item) => item.id !== activity.id)].slice(0, notificationLimit));
        }
      }
    }, () => {
      // SSE 建连成功说明本地服务已就绪：补一次快照与设置，修复「界面比服务先启动」时的空白面板。
      scheduleRefresh();
      void loadSettings().catch(() => {});
    }, setServiceOnline).then((value) => { if (disposed) value(); else close = value; });
    return () => { disposed = true; close?.(); };
  }, []);
  useEffect(() => { if (selectedId) void loadDetail(selectedId).catch((error) => setNotice(error.message)); else setDetail(null); }, [loadDetail, selectedId]);
  useEffect(() => {
    if (page !== "activity") return;
    void loadActivities().catch(() => {});
  }, [loadActivities, page]);
  useEffect(() => {
    if (page !== "settings") return;
    void loadSettings().catch((error) => setNotice(error.message));
    const timer = window.setInterval(() => void loadSettings().catch(() => {}), 10_000);
    return () => window.clearInterval(timer);
  }, [loadSettings, page]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 3000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => {
    let active: ActiveSkin;
    try {
      active = resolveActiveSkin(skin);
    } catch (error) {
      setNotice(`皮肤加载失败：${(error as Error).message}`);
      return;
    }
    const root = document.documentElement;
    root.dataset.skin = active.id;
    root.dataset.theme = active.theme;
    root.dataset.contrast = isDarkColor(active.background) ? "dark" : "light";
    root.dataset.material = active.material;
    root.dataset.radius = active.radius;
    root.dataset.wallpaper = active.wallpaper;
    root.style.setProperty("--violet", active.accent);
    root.style.setProperty("--custom-bg", active.background);
    root.style.setProperty("--wallpaper-opacity", String(active.wallpaperOpacity / 100));
    root.style.setProperty("--wallpaper-blur", `${active.wallpaperBlur}px`);
    // 遮罩：在壁纸上叠一层主题底色，浅色皮肤提亮、深色皮肤压暗，让任何壁纸都能落到同一对比区间。
    root.style.setProperty("--wallpaper-scrim-color", active.wallpaper === "none" || active.wallpaperScrim <= 0
      ? "transparent"
      : `color-mix(in srgb, var(--void) ${active.wallpaperScrim}%, transparent)`);
    root.style.setProperty("--skin-wallpaper", activeWallpaperBackground(active));
    // 本地存储写入不能抛到 effect 之外，否则 React 会卸载整棵界面（表现为白屏）。
    try {
      localStorage.setItem("appearance.skin", active.id);
      localStorage.setItem("appearance.skinCustom", serializeCustomSkin(skin.custom));
    } catch (error) {
      setNotice(`皮肤已应用，但本机保存失败，重启后可能重置：${(error as Error).message}`);
    }
  }, [skin]);
  useEffect(() => { try { localStorage.setItem("appearance.uiScale", String(uiScale)); } catch { /* 存储不可用时不影响本次缩放 */ } if (window.__TAURI_INTERNALS__) void getCurrentWebview().setZoom(uiScale).catch(() => { document.body.style.zoom = String(uiScale); }); else document.body.style.zoom = String(uiScale); }, [uiScale]);

  const projectTasks = useMemo(() => snapshot.tasks.filter((task) => !projectId || task.project_id === projectId), [snapshot.tasks, projectId]);
  const tasks = useMemo(() => projectTasks.filter((task) => !task.archived && !task.root_id), [projectTasks]);
  const workflowStages = useMemo(() => projectTasks.filter((task) => Boolean(task.root_id)), [projectTasks]);
  const project = snapshot.projects.find((item) => item.id === projectId);

  async function openNewChat(targetProjectId: string) {
    try {
      setProjectId(targetProjectId);
      setPage("board");
      const chat = await api<TaskDetail>("/api/chats", { method: "POST", body: JSON.stringify({ projectId: targetProjectId }) });
      setDetail(chat);
      setSelectedId(chat.id);
    } catch (error) { setNotice((error as Error).message); }
  }

  async function loadProjectChats(targetProjectId: string, nextPage: number, append = false) {
    const request = ++chatRequest.current;
    const result = await api<ChatPage>(`/api/chats?projectId=${encodeURIComponent(targetProjectId)}&page=${nextPage}`);
    if (request !== chatRequest.current) return;
    setProjectChats((current) => append ? [...current, ...result.items.filter((item) => !current.some((old) => old.id === item.id))] : result.items);
    setChatPage(result.page);
    chatPageRef.current = result.page;
    setChatTotalPages(result.totalPages);
  }

  // 会话列表只在展开时加载，这里按已加载的页数静默刷新，避免必须收起项目再点开才能看到最新执行状态。
  async function refreshProjectChats(targetProjectId: string) {
    const pages = Math.max(1, chatPageRef.current);
    const request = ++chatRequest.current;
    const collected: Task[] = [];
    let totalPages = 1;
    for (let currentPage = 1; currentPage <= pages; currentPage += 1) {
      const result = await api<ChatPage>(`/api/chats?projectId=${encodeURIComponent(targetProjectId)}&page=${currentPage}`);
      if (request !== chatRequest.current) return;
      collected.push(...result.items);
      totalPages = result.totalPages;
      if (currentPage >= result.totalPages) break;
    }
    setProjectChats(collected);
    setChatTotalPages(totalPages);
  }

  function scheduleProjectChatsRefresh() {
    if (expandedProjectRef.current === null || chatRefreshTimer.current !== null) return;
    chatRefreshTimer.current = window.setTimeout(() => {
      chatRefreshTimer.current = null;
      const target = expandedProjectRef.current;
      if (target) void refreshProjectChats(target).catch(() => {});
    }, 600);
  }

  async function toggleProject(targetProjectId: string) {
    setProjectId(targetProjectId);
    setPage("board");
    if (expandedProjectId === targetProjectId) {
      chatRequest.current += 1;
      setExpandedProjectId(null);
      setProjectChats([]);
      setChatPage(0);
      chatPageRef.current = 0;
      setChatTotalPages(0);
      return;
    }
    setExpandedProjectId(targetProjectId);
    setProjectChats([]);
    try { await loadProjectChats(targetProjectId, 1); }
    catch (error) { setNotice((error as Error).message); }
  }

  // 从工作台反向拉取未开始的任务：写入当前项目的待执行列，已有的自动跳过。
  async function pullWorkbenchTasks() {
    if (!settings?.workbench.configured) { setNotice("请先在设置中配置 Lo查查工作台 API Key"); return; }
    setPullingWorkbench(true);
    try {
      const result = await api<{ created: number; linked: number; skipped: number; issues: number; reopened: number }>(
        "/api/workbench/pull", { method: "POST", body: JSON.stringify({ projectId }) }, 120_000);
      await refresh();
      const parts = [];
      if (result.created) parts.push(`新建 ${result.created} 个待办`);
      if (result.issues) parts.push(`其中 ${result.issues} 个来自工作台问题`);
      if (result.reopened) parts.push(`重新打开 ${result.reopened} 个测试打回的问题`);
      if (result.linked) parts.push(`关联 ${result.linked} 个已有任务`);
      if (parts.length) setNotice(`已从工作台拉取：${parts.join("，")}`);
      else if (result.skipped) setNotice(`工作台的未开始任务与问题都已存在（跳过 ${result.skipped} 个）`);
      else setNotice("工作台没有未开始的任务或问题");
    } catch (error) { setNotice((error as Error).message); }
    finally { setPullingWorkbench(false); }
  }

  async function moveTask(id: string, status: TaskStatus) {
    try { await api(`/api/tasks/${id}${status === "running" ? "/run" : ""}`, { method: status === "running" ? "POST" : "PATCH", body: JSON.stringify(status === "running" ? {} : { status }) }); await refresh(); }
    catch (error) { setNotice((error as Error).message); }
  }

  async function runTask(task: TaskDetail, options: RunOptions = {}) {
    try {
      const { targetId = task.id, ...body } = options;
      await api(`/api/tasks/${targetId}/${body.message || body.attachments?.length ? "messages" : "run"}`, { method: "POST", body: JSON.stringify(body) });
      await Promise.all([refresh(), loadDetail(task.id)]);
    } catch (error) { setNotice((error as Error).message); }
  }

  async function deleteTask(task: Pick<Task, "id" | "kind" | "title">) {
    const noun = task.kind === "chat" ? "会话" : "任务";
    if (!window.confirm(`确定删除${noun}“${task.title}”吗？相关对话和执行记录也会永久删除。含变更的 Worktree 会被保留。`)) return;
    try {
      const result = await api<{ deleted: number; workbenchDeleted?: number; worktree?: { status: string; path?: string | null } }>(`/api/tasks/${task.id}`, { method: "DELETE" });
      if (selectedId === task.id) { setSelectedId(null); setDetail(null); }
      if (task.kind === "chat") setProjectChats((current) => current.filter((item) => item.id !== task.id));
      await refresh();
      const suffix = result.workbenchDeleted ? "，已同步删除开发台任务" : "";
      setNotice(result.worktree?.status === "preserved" ? `${noun}已删除${suffix}；含变更的 Worktree 已保留在 ${result.worktree.path}` : `${noun}已删除${suffix}`);
    } catch (error) { setNotice((error as Error).message); }
  }

  async function archiveTask(task: Pick<Task, "id">) {
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
      if (selectedId === task.id) { setSelectedId(null); setDetail(null); }
      await refresh();
      setNotice("任务已归档");
    } catch (error) { setNotice((error as Error).message); }
  }

  // 改派给开发台的其他负责人：成功后本地任务彻底删除（开发台任务保留，只是换了负责人）。
  async function assignTask(task: Pick<Task, "id" | "title">, assignee: string) {
    if (!window.confirm(`把任务“${task.title}”指派给 ${assignee}？改派成功后本地任务会被删除，开发台任务转给对方。`)) return;
    try {
      await api("/api/workbench/assign", { method: "POST", body: JSON.stringify({ taskId: task.id, assignee }) });
      if (selectedId === task.id) { setSelectedId(null); setDetail(null); }
      await refresh();
      setNotice(`已指派给 ${assignee}，本地任务已移除`);
    } catch (error) { setNotice((error as Error).message); }
  }

  async function readActivity(activity: Activity) {
    try {
      if (!activity.read) await api(`/api/activities/${activity.id}/read`, { method: "POST", body: "{}" });
      openActivity(activity);
      await Promise.all([loadActivities(), refresh()]);
    } catch (error) { setNotice((error as Error).message); }
  }

  async function readAllActivities() {
    try {
      await api("/api/activities/read-all", { method: "POST", body: "{}" });
      await Promise.all([loadActivities(), refresh()]);
      setNotice("活动已全部标记为已读");
    } catch (error) { setNotice((error as Error).message); }
  }

  async function clearReadActivities() {
    if (!window.confirm("确定清空已读活动吗？未读活动会保留。清空后无法恢复。")) return;
    try {
      const result = await api<{ changed: number }>("/api/activities/clear-read", { method: "POST", body: "{}" });
      // 已读活动会被删除，正在展示的对应应用内通知也一并撤下。
      setAppNotifications((current) => current.filter((item) => !item.activity.read));
      await Promise.all([loadActivities(), refresh()]);
      setNotice(result.changed > 0 ? `已清空 ${result.changed} 条已读活动` : "没有可清空的已读活动");
    } catch (error) { setNotice((error as Error).message); }
  }

  function setAvatar(value: string) {
    setAvatarState(value);
    if (value) localStorage.setItem("profile.avatar", value); else localStorage.removeItem("profile.avatar");
  }

  function setAgentName(value: string) {
    const next = value.slice(0, 24);
    setAgentNameState(next);
    if (next.trim()) localStorage.setItem("profile.agentName", next); else localStorage.removeItem("profile.agentName");
  }

  return <div className="app-shell">
    <div className="skin-wallpaper" aria-hidden="true" />
    <div className="skin-scrim" aria-hidden="true" />
    <div className="app-body">
    <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
      <button className="sidebar-toggle" aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCollapsed((value) => { localStorage.setItem("appearance.sidebarCollapsed", String(!value)); return !value; })}>{sidebarCollapsed ? "›" : "‹"}</button>
      <div className="brand"><img className="brand-mark" src="/app-icon.png" alt="" /><div><strong>洛神赋</strong><small>智能体工作台</small></div></div>
      <nav>
        <Nav active={page === "board"} icon={<PanelIcon />} label="任务面板" onClick={() => setPage("board")} />
        <Nav active={page === "activity"} icon={<BellIcon />} label="活动中心" count={activities.unread || snapshot.unreadActivities} onClick={() => setPage("activity")} />
        <Nav active={page === "archive"} icon={<ArchiveIcon />} label="归档任务" onClick={() => setPage("archive")} />
      </nav>
      <div className="side-section"><span>项目</span><button onClick={() => setShowNewProject(true)}>＋</button></div>
      <div className="projects">
        {snapshot.projects.map((item) => <div className="project-group" key={item.id}>
          <div className="project-line"><button className={item.id === projectId ? "project active" : "project"} title={item.name} aria-expanded={expandedProjectId === item.id} onClick={() => void toggleProject(item.id)}><span>{item.name.slice(0, 1)}</span><div>{item.name}</div></button><button className="new-chat" aria-label={`在 ${item.name} 中新建会话`} title="新建项目会话" onClick={() => void openNewChat(item.id)}><ChatIcon /></button></div>
          {expandedProjectId === item.id && <div className="project-chats">{projectChats.map((chat) => <div className={selectedId === chat.id ? "project-chat-row active" : "project-chat-row"} key={chat.id}><button className="project-chat-open" title={chat.title} onClick={() => { setSelectedId(chat.id); setProjectChats((current) => current.map((item) => item.id === chat.id && item.unread ? { ...item, unread: 0 } : item)); }}><ProviderIcon provider={chat.provider || "codex"} /><span>{chat.title}</span>{chat.active_run_started_at ? <i className="running" /> : chat.unread > 0 ? <i className="unread" /> : null}</button><button className="chat-delete" aria-label={`删除会话 ${chat.title}`} title="删除会话" onClick={() => void deleteTask(chat)}><TrashIcon /></button></div>)}{chatPage < chatTotalPages && <button className="chat-load-more" onClick={() => void loadProjectChats(item.id, chatPage + 1, true)}>展开显示</button>}</div>}
        </div>)}
      </div>
      <div className="sidebar-bottom">
        <Nav active={false} icon={<SparkIcon />} label="贾维斯" onClick={toggleAvatar} />
        <Nav active={page === "settings"} icon="⚙" label="设置" onClick={() => setPage("settings")} />
      </div>
    </aside>

    <main className="content">
      {page === "board" && <>
        <header className="topbar">
          <div><div className="eyebrow">本地项目</div><h1>{project?.name || "创建第一个项目"}</h1><p>{project?.workspace || "选择工作目录后即可建立任务"}</p></div>
          <div className="top-actions"><span className={serviceOnline ? "local status" : "local status offline"} title={serviceOnline ? undefined : "本地服务正在自动重启，恢复后会自动同步"}><i /> {serviceOnline ? "本地服务已连接" : "本地服务重连中…"}</span>{project && settings?.workbench.configured && settings.workbench.projectId === project.id && <button disabled={pullingWorkbench} title="从 Lo查查工作台拉取未开始的任务，写入当前项目的待执行列表；系统每 5 分钟自动拉取一次" onClick={() => void pullWorkbenchTasks()}>{pullingWorkbench ? "拉取中…" : "⤓ 拉取工作台待办"}</button>}<button className="primary" disabled={!project} onClick={() => setShowNewTask(true)}>＋ 新建任务</button></div>
        </header>
        {project ? <Board tasks={tasks} workflowStages={workflowStages} settings={settings} loaded={snapshotLoaded} onSelect={setSelectedId} onMove={moveTask} onDelete={deleteTask} onArchive={archiveTask} /> : <EmptyProject onCreate={() => setShowNewProject(true)} />}
      </>}
      {page === "archive" && <ArchiveList projectId={projectId} archiveTotal={snapshot.archivedTotal} settings={settings} onSelect={setSelectedId} />}
      {page === "activity" && <ActivityCenter data={activities} onOpen={readActivity} onReadAll={readAllActivities} onClearRead={clearReadActivities} onRefresh={loadActivities} />}
      {page === "settings" && <Settings data={settings} projects={snapshot.projects} reload={async () => setSettings(await api<SettingsSnapshot>("/api/settings"))} notify={setNotice} skin={skin} setSkin={setSkin} uiScale={uiScale} setUiScale={setUiScale} avatar={avatar} setAvatar={setAvatar} agentName={agentName} setAgentName={setAgentName} music={music} reloadMusic={loadMusic} />}
    </main>
    </div>
    {music?.enabled && <MusicPlayer settings={music} onNotify={setNotice} onOpenSettings={() => setPage("settings")} onReloadSettings={loadMusic} />}

    {selectedId && detail?.id === selectedId && <TaskDrawer task={detail} settings={settings} avatar={avatar} agentName={agentName.trim() || "智能体"} onClose={() => setSelectedId(null)} onArchive={() => archiveTask(detail)} onDelete={() => deleteTask(detail)} onAssign={assignTask} onRun={runTask} onVerify={() => { void moveTask(detail.id, "done").then(() => loadDetail(detail.id)); }} onReload={() => loadDetail(detail.id)} onLoadOlder={(beforeId) => { void loadOlderEvents(detail.id, beforeId).catch((error) => setNotice((error as Error).message)); }} notify={setNotice} />}
    {showNewTask && project && <NewTask project={project} settings={settings} onClose={() => setShowNewTask(false)} onCreated={async () => { setShowNewTask(false); await refresh(); }} />}
    {showNewProject && <NewProject onClose={() => setShowNewProject(false)} onCreated={async (created) => { setShowNewProject(false); setProjectId(created.id); await refresh(); }} />}
    <NotificationStack items={appNotifications} onOpen={(item) => { setAppNotifications((current) => current.filter((value) => value.id !== item.id)); void readActivity(item.activity); }} onDismiss={(id) => setAppNotifications((current) => current.filter((value) => value.id !== id))} />
    {notice && <div className="toast" onClick={() => setNotice("")}>{notice}<button>×</button></div>}
  </div>;
}

function NotificationStack({ items, onOpen, onDismiss }: { items: AppNotification[]; onOpen: (item: AppNotification) => void; onDismiss: (id: string) => void }) {
  if (!items.length) return null;
  return <div className="app-notifications" role="region" aria-label="应用内通知" aria-live="polite">
    {items.map((item) => <NotificationCard key={item.id} item={item} onOpen={() => onOpen(item)} onDismiss={() => onDismiss(item.id)} />)}
  </div>;
}

function NotificationCard({ item, onOpen, onDismiss }: { item: AppNotification; onOpen: () => void; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(() => typeof document === "undefined" || (!document.hidden && document.hasFocus()));
  const dismiss = useRef(onDismiss);
  useEffect(() => { dismiss.current = onDismiss; }, [onDismiss]);
  // 鼠标停留或应用不在前台时不自动消失，避免任务提醒被悄悄错过。
  useEffect(() => {
    const sync = () => setFocused(!document.hidden && document.hasFocus());
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { window.removeEventListener("focus", sync); window.removeEventListener("blur", sync); document.removeEventListener("visibilitychange", sync); };
  }, []);
  useEffect(() => {
    if (hovered || !focused) return;
    const timer = window.setTimeout(() => dismiss.current(), notificationLifetimeMs);
    return () => window.clearTimeout(timer);
  }, [focused, hovered]);
  const category = notificationCategory(item.activity.type);
  return <article className="app-notification" data-category={category} tabIndex={0} title="点击查看任务" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>
    <span className="app-notification-bar" aria-hidden="true" />
    <img className="app-notification-icon" src="/app-icon.png" alt="" />
    <div className="app-notification-body">
      <header><b>洛神赋 · {notificationCategoryName(category)}</b><time>{relative(item.activity.created_at)}</time></header>
      <strong>{item.activity.title}</strong>
      <p>{notificationBody(item.activity)}</p>
    </div>
    <button type="button" className="app-notification-close" aria-label="关闭通知" onClick={(event) => { event.stopPropagation(); onDismiss(); }}>×</button>
  </article>;
}

function Nav({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void }) {
  return <button className={active ? "nav-item active" : "nav-item"} title={label} onClick={onClick}><span>{icon}</span><em>{label}</em>{Boolean(count) && <b>{count}</b>}</button>;
}

function ProviderIcon({ provider, size = "small", label }: { provider: Provider; size?: "small" | "medium" | "large"; label?: string }) {
  const codex = provider === "codex";
  return <img className={`provider-icon ${codex ? "codex" : "deepseek"} ${size}`} src={codex ? "/codex-official.png" : "/deepseek-official.svg"} alt={label || (codex ? "Codex" : "Deepseek")} title={label} draggable={false} />;
}

function PersonalAvatar({ value, size = "small" }: { value: string; size?: "small" | "large" }) {
  return value ? <img className={`personal-avatar ${size}`} src={value} alt="个人头像" /> : <span className={`personal-avatar fallback ${size}`}>你</span>;
}

function SparkIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.3"/><circle cx="12" cy="4.6" r="1.25"/><circle cx="12" cy="19.4" r="1.25"/><circle cx="4.6" cy="12" r="1.25"/><circle cx="19.4" cy="12" r="1.25"/><circle cx="6.8" cy="6.8" r="1"/><circle cx="17.2" cy="17.2" r="1"/><circle cx="6.8" cy="17.2" r="1"/><circle cx="17.2" cy="6.8" r="1"/></svg>; }
function PanelIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="9" rx="2"/></svg>; }
function BellIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 15V10a6 6 0 1 0-12 0v5l-2 3h16z"/><path d="M10 21h4"/></svg>; }
function ArchiveIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v13H4z"/><path d="M3 3h18v4H3zM9 11h6"/></svg>; }
function EditIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>; }
function CheckIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>; }
function CopyIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>; }
function ChatIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>; }
function JumpTopIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14M12 20V8m-5 5 5-5 5 5"/></svg>; }
function JumpBottomIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20h14M12 4v12m-5-5 5 5 5-5"/></svg>; }
// 设置页图标：统一 24 网格 / 1.7 描边，替换掉原来的汉字方块。
function WorkbenchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7.5" height="10" rx="2"/><rect x="13.5" y="3" width="7.5" height="6" rx="2"/><rect x="3" y="16" width="7.5" height="5" rx="2"/><rect x="13.5" y="12" width="7.5" height="9" rx="2"/></svg>; }
function AgentIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="3.5"/><path d="M12 4.5V8M8.6 14h.01M15.4 14h.01"/></svg>; }
function LanguageIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.7 2.8 2.7 15.2 0 18M12 3c-2.7 2.8-2.7 15.2 0 18"/></svg>; }
function NotifyIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4 18.5h16z"/><path d="M9.8 21.4h4.4"/></svg>; }
function MusicIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>; }
function BranchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.5" cy="6" r="2.8"/><circle cx="6.5" cy="18" r="2.8"/><circle cx="17.5" cy="9" r="2.8"/><path d="M6.5 8.8v6.4M17.5 11.8a6 6 0 0 1-6 6H9.3"/></svg>; }
function FontScaleIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19 8.2 5 13.4 19M5.1 14.4h6.2"/><path d="M15.8 19 19 9.5 22.2 19M16.9 16h4.2"/></svg>; }
function AppearanceIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg>; }

function Board({ tasks, workflowStages, settings, loaded, onSelect, onMove, onDelete, onArchive }: { tasks: Task[]; workflowStages: Task[]; settings: SettingsSnapshot | null; loaded: boolean; onSelect: (id: string) => void; onMove: (id: string, status: TaskStatus) => void; onDelete: (task: Task) => void; onArchive: (task: Task) => void }) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const stagesFor = (task: Task) => workflowStages.filter((stage) => stage.root_id === task.id);
  const hasProvider = (task: Task, value: Provider) => task.provider === value || stagesFor(task).some((stage) => stage.provider === value);
  const visibleTasks = provider ? tasks.filter((task) => hasProvider(task, provider)) : tasks;
  return <section className="board-scroll"><div className="board">
    <div className="board-corner"><strong>任务面板</strong><span>{loaded ? `${visibleTasks.length} 个任务` : "正在加载…"}</span></div>
    {columns.map((column) => <div className="column-head" key={column.id}><div><b>{column.label}</b><small>{column.hint}</small></div><span>{visibleTasks.filter((task) => statusMatch(task.status, column.id)).length}</span></div>)}
    <div className="lane-head"><strong>执行泳道</strong>{lanes.map((lane) => <button className={provider === lane.provider ? "provider-filter selected" : "provider-filter"} aria-pressed={provider === lane.provider} title={provider === lane.provider ? `取消筛选 ${lane.name}` : `只看 ${lane.name} 任务`} key={lane.id} onClick={() => setProvider((value) => value === lane.provider ? null : lane.provider)}>
      <ProviderIcon provider={lane.provider} /><div><b>{lane.name}</b><div className="lane-counts">{columns.slice(0, 4).map((column) => <span className={column.id} title={`${column.label} ${tasks.filter((task) => hasProvider(task, lane.provider) && statusMatch(task.status, column.id)).length}`} key={column.id}>{column.label} <em>{tasks.filter((task) => hasProvider(task, lane.provider) && statusMatch(task.status, column.id)).length}</em></span>)}</div></div>
    </button>)}</div>
    {columns.map((column) => <div className="board-cell" data-status={column.id} key={column.id}>
      {visibleTasks.filter((task) => statusMatch(task.status, column.id)).sort((left, right) => column.id === "running" ? right.number - left.number : 0).map((task) => <TaskCard key={task.id} task={task} stages={stagesFor(task)} settings={settings} clock={clock} onClick={() => onSelect(task.id)} onMove={(status) => onMove(task.id, status)} onVerify={() => onMove(task.id, "done")} onAction={() => task.status === "done" ? onArchive(task) : onDelete(task)} />)}
    </div>)}
  </div></section>;
}

function TaskCard({ task, stages, settings, clock, onClick, onMove, onVerify, onAction }: { task: Task; stages: Task[]; settings: SettingsSnapshot | null; clock: number; onClick: () => void; onMove: (status: TaskStatus) => void; onVerify: () => void; onAction: () => void }) {
  const workflowModels = task.is_root ? lanes.map(({ provider }) => ({ provider, names: [...new Set(stages.filter((stage) => stage.provider === provider).map((stage) => taskModelName(stage, settings)))] })).filter((item) => item.names.length) : [];
  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const card = event.currentTarget;
    const { clientX: startX, clientY: startY, pointerId } = event;
    let moved = false;
    let target: HTMLElement | null = null;
    let ghost: HTMLElement | null = null;
    document.querySelectorAll(".task-drag-ghost").forEach((item) => item.remove());
    card.setPointerCapture(pointerId);
    const cellAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>(".board-cell[data-status]") || null;
    const move = (current: PointerEvent) => {
      if (current.pointerId !== pointerId) return;
      const x = current.clientX - startX;
      const y = current.clientY - startY;
      if (!moved && Math.hypot(x, y) < 5) return;
      current.preventDefault();
      if (!moved) {
        moved = true;
        const rect = card.getBoundingClientRect();
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.add("task-drag-ghost");
        ghost.style.width = `${rect.width}px`;
        ghost.style.left = `${rect.left}px`;
        ghost.style.top = `${rect.top}px`;
        document.body.append(ghost);
        card.classList.add("pointer-dragging");
      }
      if (ghost) ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      const nextTarget = cellAt(current.clientX, current.clientY);
      if (nextTarget !== target) {
        target?.classList.remove("drop-target");
        target = nextTarget;
        target?.classList.add("drop-target");
      }
    };
    const finish = (current: PointerEvent) => {
      if (current.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
      target?.classList.remove("drop-target");
      ghost?.remove();
      card.classList.remove("pointer-dragging");
      if (!moved) return;
      card.dataset.justDragged = "true";
      const status = target?.dataset.status as TaskStatus | undefined;
      if (current.type !== "pointercancel" && status && status !== task.status) onMove(status);
      window.setTimeout(() => delete card.dataset.justDragged, 0);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  }
  return <article className={`task-card ${task.status}`} onPointerDown={startDrag} onClick={(event) => { if (!event.currentTarget.dataset.justDragged) onClick(); }}>
    {task.status === "in_review" && !task.active_run_started_at && <button className="task-card-action verify" aria-label={`验证通过并标记完成 ${task.title}`} title="验证通过" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onVerify(); }}><CheckIcon /></button>}
    <button className={`task-card-action ${task.status === "done" ? "archive" : "delete"}`} aria-label={task.status === "done" ? `归档任务 ${task.title}` : `删除任务 ${task.title}`} title={task.status === "done" ? "归档任务" : "删除任务"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onAction(); }}>{task.status === "done" ? <ArchiveIcon /> : <TrashIcon />}</button>
    <div className="card-top"><span>{taskNumber(task)}</span><div><i className={`task-state ${task.status}`}>{runName(task.status)}</i>{task.unread > 0 && <b>{task.unread}</b>}</div></div>
    <h3>{task.title}</h3>
    <div className="tags"><span>{task.is_root ? "流程任务" : phaseName[task.phase]}</span><span>{permissionName[task.permission]}</span></div>
    {Boolean(task.is_root) && <div className="workflow-models">{workflowModels.map((item) => <span key={item.provider} title={item.names.join(" / ")}><ProviderIcon provider={item.provider} /><b>{item.names.join(" / ")}</b></span>)}</div>}
    {task.status === "running" && <div className="progress"><i style={{ width: `${Math.max(6, task.progress)}%` }} /></div>}
    <footer>{task.is_root ? <small><strong>设计 → 实施 → 验证</strong> · 自动串行</small> : <>{task.provider && <ProviderIcon provider={task.provider} />}<small><strong>{task.provider ? taskModelName(task, settings) : "未分配"}</strong>{task.reasoning_effort ? ` · ${effortName(task.reasoning_effort)}` : " · 默认 Effort"}</small></>}<time>{taskDuration(task, clock)}</time></footer>
  </article>;
}

function TaskDrawer({ task, settings, avatar, agentName, onClose, onArchive, onDelete, onAssign, onRun, onVerify, onReload, onLoadOlder, notify }: { task: TaskDetail; settings: SettingsSnapshot | null; avatar: string; agentName: string; onClose: () => void; onArchive: () => Promise<void>; onDelete: () => Promise<void>; onAssign: (task: TaskDetail, assignee: string) => Promise<void>; onRun: (task: TaskDetail, options?: RunOptions) => void; onVerify: () => void; onReload: () => void; onLoadOlder: (beforeId: number) => void; notify: (message: string) => void }) {
  const [message, setMessage] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [skill, setSkill] = useState("");
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [infoTab, setInfoTab] = useState<"info" | "changes" | "logs">("info");
  // 双栏拖动：infoWidth / panelWidth 为 null 时走 CSS 默认值，拖动或方向键调整后固定为像素宽度。
  // panelDrag 标记当前正在拖哪一根，用来锁住文本选择与光标。
  const [infoWidth, setInfoWidth] = useState<number | null>(savedDrawerSplitWidth);
  const [panelWidth, setPanelWidth] = useState<number | null>(savedDrawerPanelWidth);
  const [panelDrag, setPanelDrag] = useState<"split" | "width" | null>(null);
  const drawerBody = useRef<HTMLDivElement>(null);
  const drawerPanel = useRef<HTMLElement>(null);
  const splitDrag = useRef<{ pointerId: number; startX: number; startWidth: number; max: number } | null>(null);
  const widthDrag = useRef<{ pointerId: number; startX: number; startWidth: number; ratio: number; max: number } | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const marks = useRef<HTMLElement>(null);
  const followConversation = useRef(true);
  const [scrollEdges, setScrollEdges] = useState({ scrollable: false, atTop: true, atBottom: true });
  const [activeQuestionId, setActiveQuestionId] = useState<number | null>(null);
  const [flashedEventId, setFlashedEventId] = useState<number | null>(null);
  const flashTimer = useRef<number | null>(null);
  const [hoveredQuestion, setHoveredQuestion] = useState<number | null>(null);
  const [hoveredTipTop, setHoveredTipTop] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([]);
  const [convertToWorkflow, setConvertToWorkflow] = useState(false);
  const [draftStages, setDraftStages] = useState<WorkflowStages>(newWorkflowStages);
  const [savingEdit, setSavingEdit] = useState(false);
  // 改派只对「已关联开发台」的任务开放；成员名单来自设置里维护的 workbench.members。
  const workbenchExternalId = task.workbench_external_id || "";
  const [members, setMembers] = useState<string[]>([]);
  const [membersMe, setMembersMe] = useState("");
  const [assigning, setAssigning] = useState(false);
  useEffect(() => {
    if (!workbenchExternalId) { setMembers([]); return; }
    let active = true;
    api<{ members: string[]; me: string }>("/api/workbench/members").then((result) => {
      if (!active) return;
      setMembers(result.members || []);
      setMembersMe(result.me || "");
    }).catch(() => {});
    return () => { active = false; };
  }, [workbenchExternalId]);
  async function assignTo(assignee: string) {
    setAssigning(true);
    try { await onAssign(task, assignee); }
    finally { setAssigning(false); }
  }
  const chat = task.kind === "chat";
  const workflow = Boolean(task.is_root);
  const currentStage = workflow ? task.children.find((stage) => stage.status === "running" || stage.status === "blocked") || task.children.find((stage) => stage.status !== "done") || task.children.at(-1) : null;
  const [stageId, setStageId] = useState(currentStage?.id || "");
  const [followCurrentStage, setFollowCurrentStage] = useState(true);
  useEffect(() => { setFollowCurrentStage(true); setStageId(currentStage?.id || ""); }, [task.id]);
  useEffect(() => { if (followCurrentStage && currentStage) setStageId(currentStage.id); }, [currentStage?.id, followCurrentStage]);
  const selectedStage = workflow ? task.children.find((stage) => stage.id === stageId) || currentStage : null;
  const interactionTask = selectedStage || task;
  const selectedStageIndex = selectedStage ? task.children.findIndex((stage) => stage.id === selectedStage.id) : -1;
  const priorStageIncomplete = selectedStageIndex > 0 && task.children.slice(0, selectedStageIndex).some((stage) => stage.status !== "done");
  const workflowModels = workflow ? lanes.map(({ provider }) => ({ provider, names: [...new Set(task.children.filter((stage) => stage.provider === provider).map((stage) => taskModelName(stage, settings)))] })).filter((item) => item.names.length) : [];
  useEffect(() => {
    setSkill("");
    if (interactionTask.provider !== "codex") { setSkills([]); return; }
    void api<SkillOption[]>(`/api/tasks/${interactionTask.id}/skills`).then(setSkills).catch((error) => notify(error.message));
  }, [interactionTask.id, interactionTask.provider, notify]);
  const running = Boolean(task.active) || task.run?.status === "running" || task.run?.status === "waiting_approval" || task.run?.status === "queued";
  // 同一条流程里别的阶段正在执行：本阶段暂不接收输入，避免后端的流程互斥把消息顶回来。
  const flowBusy = !chat && !running && Boolean(task.flow_active);
  const interrupted = !running && task.run?.status === "interrupted";
  const resumable = !chat && !task.archived && !running && ["interrupted", "failed", "blocked", "canceled"].includes(task.run?.status || "");
  const convertible = !chat && !workflow && task.status === "todo" && !task.archived && !task.run;
  const stageEvents = task.events.filter((event) => event.task_id === interactionTask.id);
  const events = stageEvents.filter((event) => event.type === "message" || event.type === "error" || event.type === "notification" || event.type === "status" || (event.type === "result" && event.title === "任务阻塞"));
  const questions = events.filter((event) => event.type === "message" && event.role === "user");
  const queuedMessages = stageEvents.filter((event) => event.type === "queued_message");
  const approvals = task.approvals.filter((approval) => approval.task_id === interactionTask.id);
  const latestEvent = events[events.length - 1];
  function syncScrollEdges(node: HTMLDivElement, userScroll = false) {
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    const next = { scrollable: max > 18, atTop: node.scrollTop <= 18, atBottom: max - node.scrollTop <= 18 };
    if (userScroll) followConversation.current = next.atBottom;
    setScrollEdges((current) => current.scrollable === next.scrollable && current.atTop === next.atTop && current.atBottom === next.atBottom ? current : next);
    // 右侧提问节点条高亮到当前滚动位置所属的那次提问。
    const top = node.getBoundingClientRect().top;
    let currentId: number | null = null;
    for (const element of node.querySelectorAll<HTMLElement>(".event.message.user")) {
      if (element.getBoundingClientRect().top - top <= 28) currentId = Number(element.dataset.eventId);
      else break;
    }
    setActiveQuestionId((value) => (value === currentId ? value : currentId));
  }
  function jumpConversation(edge: "top" | "bottom") {
    const node = conversation.current;
    if (!node) return;
    followConversation.current = edge === "bottom";
    node.scrollTo({ top: edge === "top" ? 0 : node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  // 悬停/聚焦某个节点时，把预览浮层垂直对齐到该节点，并夹在节点条范围内。
  function showMarkTip(index: number, element: HTMLElement) {
    setHoveredQuestion(index);
    const nav = marks.current;
    if (!nav) return;
    const navRect = nav.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    // 夹取半径取「半个浮层高度」和「半个节点条高度」的较小值：节点很少时浮层也居中在条内。
    const padding = Math.min(30, navRect.height / 2);
    const top = rect.top - navRect.top + rect.height / 2;
    setHoveredTipTop(Math.min(Math.max(top, padding), Math.max(navRect.height - padding, padding)));
  }
  function hideMarkTip(index: number) { setHoveredQuestion((value) => (value === index ? null : value)); }
  function jumpToQuestion(eventId: number) {
    const node = conversation.current;
    const target = node?.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`);
    if (!node || !target) return;
    followConversation.current = false;
    const delta = target.getBoundingClientRect().top - node.getBoundingClientRect().top;
    node.scrollTo({ top: node.scrollTop + delta - 12, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    // 跳转后给目标消息一次闪光，避免条目多时看不清落点。
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    setFlashedEventId(eventId);
    flashTimer.current = window.setTimeout(() => setFlashedEventId((value) => (value === eventId ? null : value)), 1500);
  }
  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current); }, []);
  useEffect(() => { followConversation.current = true; }, [interactionTask.id]);
  useEffect(() => { setInfoTab("info"); }, [task.id]);
  // 拖过的两栏宽度与面板总宽写回本地，下次打开沿用；超宽由 CSS 的 min() 兜底收缩，不改用户的记忆值。
  useEffect(() => {
    if (infoWidth === null) return;
    try { localStorage.setItem(drawerSplitKey, String(infoWidth)); } catch { /* 存储不可用不影响本次布局 */ }
  }, [infoWidth]);
  useEffect(() => {
    if (panelWidth === null) return;
    try { localStorage.setItem(drawerPanelKey, String(panelWidth)); } catch { /* 存储不可用不影响本次布局 */ }
  }, [panelWidth]);
  // 组件卸载（例如切换任务关闭抽屉）时清掉拖动期间挂在 body 上的临时样式。
  useEffect(() => () => { document.body.style.userSelect = ""; document.body.style.cursor = ""; }, []);
  // 切换任务时退出编辑态；外部（如另一窗口或 SSE 刷新）改动标题/说明时同步草稿，但编辑中不打断输入。
  useEffect(() => { setEditing(false); setSavingEdit(false); }, [task.id]);
  useEffect(() => {
    if (editing) return;
    setDraftTitle(task.title);
    setDraftDescription(task.description);
  }, [task.id, task.title, task.description, editing]);  useEffect(() => {
    const node = conversation.current;
    if (!node) return;
    const frame = window.requestAnimationFrame(() => {
      if (followConversation.current) node.scrollTop = node.scrollHeight;
      syncScrollEdges(node);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [interactionTask.id, events.length, latestEvent?.content, approvals.length, running]);
  async function cancel() { try { await api(`/api/tasks/${task.id}/cancel`, { method: "POST", body: "{}" }); await onReload(); } catch (error) { notify((error as Error).message); } }
  async function resume() {
    try {
      const result = await api<{ resumeKind: string }>(`/api/tasks/${task.id}/resume`, { method: "POST", body: "{}" });
      notify(result.resumeKind === "session" ? "已按原外部会话继续执行" : "原会话不可用，已使用已有上下文重新续跑");
      await onReload();
    } catch (error) { notify((error as Error).message); }
  }
  async function deleteQueued(id: number) { try { await api(`/api/tasks/${interactionTask.id}/queue/${id}`, { method: "DELETE" }); await onReload(); } catch (error) { notify((error as Error).message); } }
  async function editQueued(event: TaskDetail["events"][number]) { setMessage(event.content); setAttachments(eventAttachments(event.raw)); await deleteQueued(event.id); }
  async function guideQueued(id: number) { try { await api(`/api/tasks/${interactionTask.id}/queue/${id}/guide`, { method: "POST", body: "{}" }); await onReload(); } catch (error) { notify((error as Error).message); } }
  async function approve(id: string, decision: unknown) { try { await api(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision }) }); await onReload(); } catch (error) { notify((error as Error).message); } }
  async function updateRuntime(change: { provider?: Provider; model?: string | null; effort?: string | null }) { try { await api(`/api/tasks/${interactionTask.id}`, { method: "PATCH", body: JSON.stringify(change) }); await onReload(); notify("已保存，下次执行生效"); } catch (error) { notify((error as Error).message); } }
  // 执行权限也允许在任务详情里改：切到「完全访问」前沿用新建任务时的确认，避免误放宽沙箱。
  async function updatePermission(permission: PermissionMode) {
    if (permission === interactionTask.permission) return;
    if (permission === "danger-full-access" && !window.confirm("完全访问允许智能体读取和修改工作区之外的文件。确认后，这个任务及后续对话不再重复询问。是否切换？")) return;
    try {
      await api(`/api/tasks/${interactionTask.id}`, { method: "PATCH", body: JSON.stringify({ permission }) });
      await onReload();
      notify(`执行权限已改为${permissionName[permission]}，下次执行生效`);
    } catch (error) { notify((error as Error).message); }
  }
  function startEdit() { setDraftTitle(task.title); setDraftDescription(task.description); setDraftAttachments(task.attachments || []); setConvertToWorkflow(false); setDraftStages(newWorkflowStages()); setEditing(true); }
  function cancelEdit() { setEditing(false); setSavingEdit(false); }
  const setDraftStage = (key: keyof WorkflowStages, change: Partial<WorkflowStages[keyof WorkflowStages]>) => setDraftStages((value) => ({ ...value, [key]: { ...value[key], ...change } }));
  async function saveEdit() {
    const title = draftTitle.trim();
    if (!title) { notify("任务标题不能为空"); return; }
    setSavingEdit(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(chat ? { title } : {
        title,
        description: draftDescription,
        attachments: draftAttachments.map(({ path, name, mime }) => ({ path, name, mime })),
        ...(convertToWorkflow ? { kind: "workflow", stages: draftStages } : {}),
      }) });
      setEditing(false);
      await onReload();
      notify(convertToWorkflow ? "已转为流程任务" : "已保存，下次执行生效");
    } catch (error) { notify((error as Error).message); }
    finally { setSavingEdit(false); }
  }
  async function chooseFiles() {
    try { const picked = await pickAttachmentPaths(); setAttachments((current) => uniqueAttachments([...current, ...picked])); }
    catch (error) { notify((error as Error).message); }
  }
  async function pasteFiles(files: File[]) {
    try { const saved = await uploadAttachments(files); setAttachments((current) => uniqueAttachments([...current, ...saved])); }
    catch (error) { notify((error as Error).message); }
  }
  async function editDescriptionFiles(files: File[]) {
    try { const saved = await uploadAttachments(files); setDraftAttachments((current) => uniqueAttachments([...current, ...saved])); }
    catch (error) { notify((error as Error).message); }
  }
  async function chooseDescriptionFiles() {
    try { const picked = await pickAttachmentPaths(); setDraftAttachments((current) => uniqueAttachments([...current, ...picked])); }
    catch (error) { notify((error as Error).message); }
  }
  const models = interactionTask.provider ? settings?.models[interactionTask.provider] || [] : [];
  const activeModel = workflow ? taskModelName(interactionTask, settings) : task.actual_runtime?.model || taskModelName(task, settings);
  const trigger = interactionTask.provider === "codex" ? message.match(/(?:^|\s)([/@])([^\s]*)$/) : null;
  const query = trigger?.[2].toLocaleLowerCase() || "";
  const suggestions = trigger?.[1] === "/"
    ? [{ id: "plan", title: "/plan", detail: planMode ? "关闭计划模式" : "开启计划模式" }].filter((item) => item.id.includes(query))
    : trigger?.[1] === "@"
      ? skills.filter((item) => `${item.name} ${item.interface?.displayName || ""}`.toLocaleLowerCase().includes(query)).map((item) => ({ id: item.name, title: `@${item.name}`, detail: item.interface?.displayName || "Skill" }))
      : [];
  function chooseSuggestion(index: number) {
    const item = suggestions[index];
    if (!item || !trigger) return;
    const start = (trigger.index || 0) + trigger[0].lastIndexOf(trigger[1]);
    if (trigger[1] === "/") { setPlanMode((value) => !value); setMessage(message.slice(0, start)); }
    else { setSkill(item.id); setMessage(`${message.slice(0, start)}@${item.id} `); }
    setSuggestionIndex(0);
  }
  // ── 任务详情：右侧分隔条调两栏比例，左侧分隔条调面板总宽（两栏等比缩放）──
  // 两根都支持拖动、方向键微调、Home/End 到边界、双击/回车复位。
  function splitMaxWidth() {
    const total = drawerBody.current?.getBoundingClientRect().width || 0;
    return Math.max(drawerSplitMinInfo, Math.floor(total - drawerSplitHandleWidth - drawerSplitMinExec));
  }
  function currentInfoWidth() {
    const measured = drawerBody.current?.querySelector<HTMLElement>(".drawer-info")?.getBoundingClientRect().width;
    return Math.round(measured || infoWidth || drawerSplitMinInfo);
  }
  function currentPanelWidth() {
    const measured = drawerPanel.current?.getBoundingClientRect().width;
    return Math.round(measured || panelWidth || 0);
  }
  function panelMaxWidth() { return Math.max(drawerPanelMinWidth, window.innerWidth - 40); }
  function applyInfoWidth(value: number) { setInfoWidth(Math.round(Math.min(Math.max(value, drawerSplitMinInfo), splitMaxWidth()))); }
  // 面板总宽变化时，左栏按同一比例增减，右栏由 1fr 自然补齐，实现两个区域等比缩放。
  function applyPanelWidth(next: number, ratio: number) {
    setPanelWidth(next);
    setInfoWidth(Math.round(Math.min(Math.max(next * ratio, drawerSplitMinInfo), Math.max(drawerSplitMinInfo, next - drawerSplitHandleWidth - drawerSplitMinExec))));
  }
  function beginPanelDrag() {
    // 立刻锁住选中与光标：React 状态更新是异步的，等它生效时指针已经扫过两栏内容了。
    // 这里不做 preventDefault，否则后续 click/dblclick 会被一并抑制，双击复位就失效了。
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }
  function finishPanelDrag() {
    setPanelDrag(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }
  function startSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    splitDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: currentInfoWidth(), max: splitMaxWidth() };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanelDrag("split");
    beginPanelDrag();
  }
  function moveSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = splitDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setInfoWidth(Math.round(Math.min(Math.max(drag.startWidth + event.clientX - drag.startX, drawerSplitMinInfo), drag.max)));
  }
  function endSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = splitDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    splitDrag.current = null;
    finishPanelDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function resetSplitWidth() {
    setInfoWidth(null);
    try { localStorage.removeItem(drawerSplitKey); } catch { /* 忽略 */ }
  }
  function onSplitterKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const base = currentInfoWidth();
    if (event.key === "ArrowLeft") { event.preventDefault(); applyInfoWidth(base - drawerSplitStep); }
    else if (event.key === "ArrowRight") { event.preventDefault(); applyInfoWidth(base + drawerSplitStep); }
    else if (event.key === "Home") { event.preventDefault(); applyInfoWidth(drawerSplitMinInfo); }
    else if (event.key === "End") { event.preventDefault(); applyInfoWidth(splitMaxWidth()); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); resetSplitWidth(); }
  }
  function startWidthDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const startWidth = currentPanelWidth();
    widthDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      ratio: startWidth ? currentInfoWidth() / startWidth : 0.38,
      max: panelMaxWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanelDrag("width");
    beginPanelDrag();
  }
  function moveWidthDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = widthDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    // 往左拖变宽：位移取反后夹在最小/最大总宽之间，再按起始比例同步两栏。
    const next = Math.round(Math.min(Math.max(drag.startWidth - (event.clientX - drag.startX), drawerPanelMinWidth), drag.max));
    applyPanelWidth(next, drag.ratio);
  }
  function endWidthDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = widthDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    widthDrag.current = null;
    finishPanelDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function resetPanelWidth() {
    // 恢复默认整体布局：宽度回到 CSS 默认值，两栏比例也一并回到默认。
    setPanelWidth(null);
    setInfoWidth(null);
    try { localStorage.removeItem(drawerPanelKey); localStorage.removeItem(drawerSplitKey); } catch { /* 忽略 */ }
  }
  function onWidthHandleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const base = currentPanelWidth();
    const ratio = base ? currentInfoWidth() / base : 0.38;
    if (event.key === "ArrowLeft") { event.preventDefault(); applyPanelWidth(Math.min(base + drawerPanelStep, panelMaxWidth()), ratio); }
    else if (event.key === "ArrowRight") { event.preventDefault(); applyPanelWidth(Math.max(base - drawerPanelStep, drawerPanelMinWidth), ratio); }
    else if (event.key === "Home") { event.preventDefault(); applyPanelWidth(drawerPanelMinWidth, ratio); }
    else if (event.key === "End") { event.preventDefault(); applyPanelWidth(panelMaxWidth(), ratio); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); resetPanelWidth(); }
  }
  // 任务类详情空间紧张：拆成「左任务信息 / 右执行情况」两栏；项目会话（chat）保持单栏，不留空栏。
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside ref={drawerPanel} className={`drawer${chat ? "" : " drawer-split"}${!chat && panelDrag ? " resizing-panel" : ""}`} style={panelWidth === null ? undefined : ({ "--drawer-width": `${panelWidth}px` } as CSSProperties)} onMouseDown={(event) => event.stopPropagation()}>
    {!chat && <div
      className={`drawer-width-handle${panelDrag === "width" ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调节任务详情整体宽度"
      aria-valuemin={drawerPanelMinWidth}
      aria-valuemax={panelMaxWidth()}
      aria-valuenow={panelWidth ?? undefined}
      tabIndex={0}
      title="左右拖动调节整体宽度，两栏等比缩放；双击恢复默认宽度与比例"
      onPointerDown={startWidthDrag}
      onPointerMove={moveWidthDrag}
      onPointerUp={endWidthDrag}
      onPointerCancel={endWidthDrag}
      onDoubleClick={resetPanelWidth}
      onKeyDown={onWidthHandleKeyDown}
    />}
    <header><div><span>{chat ? `${task.project_name} · 项目会话` : `${taskNumber(task)} · ${workflow ? "流程任务" : phaseName[task.phase]}`}</span>{editing ? <input className="edit-title" value={draftTitle} maxLength={200} autoFocus aria-label="任务标题" placeholder="任务标题" onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") cancelEdit(); else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void saveEdit(); } }} /> : <h2>{task.title}</h2>}</div><div className="drawer-header-actions">{editing ? <><button type="button" className="edit-cancel" onClick={cancelEdit}>取消</button><button type="button" className="primary edit-save" disabled={savingEdit || !draftTitle.trim()} onClick={() => void saveEdit()}>{savingEdit ? "保存中…" : "保存"}</button></> : <>{!chat && task.status === "done" && !task.archived && <button className="archive-button" onClick={() => void onArchive()}><ArchiveIcon />归档</button>}{!task.archived && <button className="edit-button" title="编辑任务" onClick={startEdit}><EditIcon />编辑</button>}</>}<button className="icon-button" onClick={editing ? () => { cancelEdit(); onClose(); } : onClose} title={editing ? "放弃修改并关闭" : "关闭"}>×</button></div></header>
    <div className="drawer-body" ref={drawerBody} style={infoWidth === null ? undefined : ({ "--drawer-info-width": `${infoWidth}px` } as CSSProperties)}>
    <div className="drawer-info">
    {!chat && <div className="drawer-info-tabs" role="tablist"><button type="button" role="tab" aria-selected={infoTab === "info"} className={infoTab === "info" ? "active" : ""} onClick={() => setInfoTab("info")}>信息</button><button type="button" role="tab" aria-selected={infoTab === "changes"} className={infoTab === "changes" ? "active" : ""} onClick={() => setInfoTab("changes")}>变更</button><button type="button" role="tab" aria-selected={infoTab === "logs"} className={infoTab === "logs" ? "active" : ""} onClick={() => setInfoTab("logs")}>执行日志</button></div>}
    {(chat || infoTab === "info") && <div className="drawer-info-body">
    <div className="task-meta">{workflow ? <div className="workflow-meta-icons">{workflowModels.map((item) => <ProviderIcon key={item.provider} provider={item.provider} size="medium" label={item.names.join(" / ")} />)}</div> : task.provider && <ProviderIcon provider={task.provider} size="medium" label={activeModel} />}<div><b>{workflow ? "流程任务" : task.provider === "codex" ? "Codex" : task.provider === "deepseek" ? "Deepseek" : "待分配"}</b><small>{workflow ? workflowModels.map((item) => item.names.join(" / ")).join(" → ") : task.actual_runtime ? `实际运行 · ${task.actual_runtime.model || "未知模型"} · ${effortName(task.actual_runtime.effort || "默认")}` : `配置 · ${taskModelName(task, settings)} · ${effortName(task.reasoning_effort || "默认")}`}</small></div><span className="permission">{permissionName[task.permission]} · {taskDuration(task, Date.now())}</span></div>
    {!chat && (editing ? <>
      <textarea className="description" value={draftDescription} maxLength={20000} aria-label="任务说明" placeholder="补充目标、背景和验收标准…（可直接粘贴或拖入图片）" onChange={(event) => setDraftDescription(event.target.value)} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void editDescriptionFiles(files); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { const files = [...event.dataTransfer.files]; if (files.length) { event.preventDefault(); void editDescriptionFiles(files); } }} onKeyDown={(event) => { if (event.key === "Escape") cancelEdit(); else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void saveEdit(); } }} />
      <div className="description-attachments"><AttachmentChips items={draftAttachments} onRemove={(path) => setDraftAttachments((current) => current.filter((value) => value.path !== path))} /><button type="button" className="attach-button" onClick={() => void chooseDescriptionFiles()}>＋ 添加图片</button></div>
      {convertible && <div className="edit-workflow">
        <div><b>任务类型</b><div className="segmented"><button type="button" className={!convertToWorkflow ? "active" : ""} onClick={() => setConvertToWorkflow(false)}>独立任务</button><button type="button" className={convertToWorkflow ? "active" : ""} onClick={() => setConvertToWorkflow(true)}>流程任务</button></div></div>
        {convertToWorkflow && <><small>保存后将按设计 → 实施 → 验证依次执行，转换不可撤销。</small><div className="workflow-stages">
          <StageSettings title="设计" hint={phaseDuty.design} value={draftStages.design} models={settings?.models} onChange={(change) => setDraftStage("design", change)} />
          <i>↓</i>
          <StageSettings title="实施" hint={phaseDuty.implementation} value={draftStages.implementation} models={settings?.models} onChange={(change) => setDraftStage("implementation", change)} />
          <i>↓</i>
          <StageSettings title="验证" hint={phaseDuty.verification} value={draftStages.verification} models={settings?.models} onChange={(change) => setDraftStage("verification", change)} />
        </div></>}
      </div>}
    </> : <>{task.description && <TaskDescription description={task.description} />}<TaskAttachments taskId={task.id} items={task.attachments || []} notify={notify} onAdd={(item) => setAttachments((current) => uniqueAttachments([...current, item]))} /></>)}
    {!chat && !task.archived && workbenchExternalId && members.length > 0 && <div className="drawer-assign"><span>指派给</span><select aria-label="指派给开发台负责人" title="改派成功后本地任务会被删除，开发台任务转给对方" value="" disabled={running || assigning} onChange={(event) => { const value = event.target.value; if (value) void assignTo(value); }}><option value="">{assigning ? "指派中…" : "选择负责人"}</option>{members.filter((member) => member !== membersMe).map((member) => <option key={member} value={member}>{member}</option>)}</select></div>}
    <div className="drawer-actions"><button onClick={() => api(`/api/tasks/${task.id}/open`, { method: "POST", body: "{}" }).catch((error) => notify(error.message))}>打开工作目录</button>{!chat && resumable && !running && <button className="primary resume-action" onClick={() => void resume()}>{interrupted ? "继续任务" : "重新续跑"}</button>}{!chat && (task.archived ? <span className="archived-label"><ArchiveIcon /> 已归档</span> : workflow && running ? <button className="danger" onClick={() => void cancel()}>停止执行</button> : !running && <>{task.status === "in_review" && <button className="primary verify-action" title="确认验收通过，标记为已完成" onClick={() => onVerify()}>验证通过</button>}<button className={task.status === "in_review" ? "" : "primary"} disabled={!workflow && !task.provider} title={!workflow && !task.provider ? "请先选择执行者" : undefined} onClick={() => onRun(task, { planMode, skill })}>{task.status === "done" || task.status === "in_review" ? "重新执行" : "开始执行"}</button></>)}<button className="primary delete-action" disabled={running} onClick={() => void onDelete()}>{chat ? "删除会话" : "删除任务"}</button></div>
    {!chat && <WorktreeBar task={task} notify={notify} onReload={onReload} />}
    {interrupted && <div className="resume-note" role="status"><span aria-hidden="true">!</span><div><b>上次执行已中断</b><small>原因：{task.run?.interrupt_reason || task.run?.error || "未知原因"}。原会话可恢复时优先复用，否则使用已有上下文重新续跑。</small></div></div>}
    </div>}
    {!chat && infoTab === "changes" && <ChangesPanel task={task} notify={notify} onReload={onReload} />}
    {!chat && infoTab === "logs" && <LogsPanel task={task} notify={notify} />}
    </div>
    {!chat && <div
      className={`drawer-splitter${panelDrag === "split" ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调节任务信息与执行区宽度"
      aria-valuemin={drawerSplitMinInfo}
      aria-valuemax={splitMaxWidth()}
      aria-valuenow={infoWidth ?? undefined}
      tabIndex={0}
      title="左右拖动调节两栏宽度，双击恢复默认"
      onPointerDown={startSplitDrag}
      onPointerMove={moveSplitDrag}
      onPointerUp={endSplitDrag}
      onPointerCancel={endSplitDrag}
      onDoubleClick={resetSplitWidth}
      onKeyDown={onSplitterKeyDown}
    />}
    <div className="drawer-exec">
    {workflow && <div className="workflow-progress">{task.children.map((stage, index) => <button type="button" title={phaseDuty[stage.phase]} aria-pressed={stage.id === selectedStage?.id} className={`${stage.status}${stage.id === selectedStage?.id ? " selected" : ""}`} key={stage.id} onClick={() => { setFollowCurrentStage(false); setStageId(stage.id); }}><span>{index + 1}</span><b>{phaseName[stage.phase]}</b><small>{stage.provider === "codex" ? "Codex" : "Deepseek"} · {taskModelName(stage, settings)}</small><i>{runName(stage.status)}</i></button>)}</div>}
    <>
    <div className="conversation-shell">
      <div className="conversation-title">
        <b>{selectedStage ? `${phaseName[selectedStage.phase]}阶段` : chat ? "对话" : "执行过程"}</b>
        <span>{selectedStage ? runName(selectedStage.status) : running ? "执行中" : task.run ? runName(task.run.status) : chat ? "新会话" : "尚未执行"}</span>
        {scrollEdges.scrollable && <div className="conversation-jump" role="group" aria-label="消息快速定位">
          <button type="button" aria-label="回到消息顶部" title="回到消息顶部" disabled={scrollEdges.atTop} onClick={() => jumpConversation("top")}><JumpTopIcon /></button>
          <button type="button" aria-label="前往消息底部" title="前往消息底部" disabled={scrollEdges.atBottom} onClick={() => jumpConversation("bottom")}><JumpBottomIcon /></button>
        </div>}
      </div>
      <div className="conversation" ref={conversation} onScroll={(event) => syncScrollEdges(event.currentTarget, true)}>
        {task.eventsHasMore && <button type="button" className="load-older" onClick={() => { if (task.eventsOldestId) onLoadOlder(task.eventsOldestId); }}>加载更早的记录</button>}
        {events.length === 0 && <div className="empty-events">{selectedStage ? `${phaseName[selectedStage.phase]}阶段还没有执行结果。` : chat ? "发送消息，开始项目会话。" : `任务完成后，${agentName}结论会显示在这里。`}</div>}
        {events.map((event) => <Event key={event.id} event={event} flash={event.id === flashedEventId} provider={event.provider || interactionTask.provider} model={activeModel} avatar={avatar} agentName={agentName} notify={notify} onAddAttachment={(item) => setAttachments((current) => uniqueAttachments([...current, item]))} />)}
        {running && !selectedStage && <div className="workflow-running"><ProviderIcon provider={interactionTask.provider || "codex"} size="medium" /><div><b>{interactionTask.provider === "deepseek" ? "Deepseek" : "Codex"} 正在执行</b><span>正在生成执行结果</span></div><i><span /><span /><span /></i></div>}
        {selectedStage && (selectedStage.status === "running" || (running && selectedStage.id === currentStage?.id)) && <div className="workflow-running"><ProviderIcon provider={selectedStage.provider || "codex"} size="medium" /><div><b>{selectedStage.provider === "deepseek" ? "Deepseek" : "Codex"} 正在执行{phaseName[selectedStage.phase]}阶段</b><span>{stageEvents.at(-1) ? `最近更新 ${new Date(stageEvents.at(-1)!.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}` : "正在启动运行时"}</span></div><i><span /><span /><span /></i></div>}
        {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onAnswer={(decision) => approve(approval.id, decision)} />)}
      </div>
      {questions.length > 1 && <nav className={`conversation-marks${questions.length > 12 ? " dense" : ""}${questions.length > 20 ? " compact" : ""}`} ref={marks} aria-label="提问定位">
        <div className="marks-list">
          {questions.map((event, index) => <button type="button" key={event.id} className={activeQuestionId === event.id ? "active" : ""} aria-label={`第 ${index + 1} 次提问：${questionPreview(event)}`} aria-current={activeQuestionId === event.id ? "true" : undefined} onClick={() => jumpToQuestion(event.id)} onMouseEnter={(mouseEvent) => showMarkTip(index, mouseEvent.currentTarget)} onMouseLeave={() => hideMarkTip(index)} onFocus={(focusEvent) => showMarkTip(index, focusEvent.currentTarget)} onBlur={() => setHoveredQuestion(null)}><i aria-hidden="true">{index + 1}</i></button>)}
        </div>
        {hoveredQuestion !== null && questions[hoveredQuestion] && <span className="marks-tip" role="tooltip" style={{ top: hoveredTipTop }}><b><i>{hoveredQuestion + 1}</i>第 {hoveredQuestion + 1} 次提问<small>共 {questions.length} 次</small></b><time>{new Date(questions[hoveredQuestion].created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</time><em>{questionPreview(questions[hoveredQuestion])}</em></span>}
      </nav>}
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); if ((!message.trim() && !attachments.length) || task.archived) return; if (flowBusy) { notify("流程的其他阶段正在执行，请等它结束后再发送"); return; } void onRun(task, { targetId: selectedStage?.id, message, planMode, skill, attachments: attachments.map(({ path, name, mime }) => ({ path, name, mime })) }); setMessage(""); setSkill(""); setAttachments([]); }}>
      {queuedMessages.length > 0 && <div className="queued-messages">{queuedMessages.map((queued) => <div key={queued.id}><span>↳</span><b>{queued.content || `${eventAttachments(queued.raw).length} 个附件`}</b><small>排队中</small><button type="button" className="queue-guide" title={interactionTask.provider === "deepseek" ? "停止当前轮次并优先执行此消息" : "直接引导当前轮次"} onClick={() => void guideQueued(queued.id)}>↪ 干预</button><button type="button" className="queue-edit" onClick={() => void editQueued(queued)}>编辑</button><button type="button" className="queue-delete" aria-label="删除排队消息" onClick={() => void deleteQueued(queued.id)}><TrashIcon /></button></div>)}</div>}
      {trigger && <div className="composer-suggestions" role="listbox">{suggestions.length ? suggestions.map((item, index) => <button type="button" role="option" aria-selected={index === suggestionIndex} className={index === suggestionIndex ? "selected" : ""} key={item.id} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSuggestion(index)}><b>{item.title}</b><small>{item.detail}</small></button>) : <span>没有匹配的 {trigger[1] === "@" ? "Skill" : "命令"}</span>}</div>}
      {attachments.length > 0 && <AttachmentChips items={attachments} onRemove={(path) => setAttachments((current) => current.filter((value) => value.path !== path))} />}
      <textarea value={message} aria-keyshortcuts="Shift+Enter" title="Shift + Enter 发送" onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void pasteFiles(files); } }} onChange={(event) => { const value = event.target.value; setMessage(value); if (skill && !value.includes(`@${skill}`)) setSkill(""); setSuggestionIndex(0); }} onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); return; } if (!trigger || !suggestions.length) return; if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex((value) => (value + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length); } else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); chooseSuggestion(suggestionIndex); } else if (event.key === "Escape") { event.preventDefault(); setMessage(`${message} `); } }} placeholder={task.archived ? "归档任务仅供查看" : flowBusy ? "流程其他阶段正在执行，稍后再发送…" : running ? "输入消息，发送后加入队列…" : priorStageIncomplete ? "请先完成上一阶段" : selectedStage ? `继续${phaseName[selectedStage.phase]}阶段…` : chat ? "在项目中开始对话…" : interactionTask.provider === "codex" ? "描述你的任务，输入 / 使用命令，@ 使用 Skill…" : "描述你的任务…"} disabled={Boolean(task.archived) || priorStageIncomplete || flowBusy || !interactionTask.provider}/>
      <div className="composer-bar"><div><button type="button" className="composer-add" aria-label="添加图片或文件" title="添加图片或文件" disabled={Boolean(task.archived) || priorStageIncomplete} onClick={() => void chooseFiles()}>＋</button><PermissionPicker value={interactionTask.permission} disabled={workflow || running || Boolean(task.archived)} onChange={(permission) => void updatePermission(permission)} />{interactionTask.provider === "codex" && <button type="button" className={planMode ? "mode-toggle selected" : "mode-toggle"} aria-pressed={planMode} title={planMode ? "计划模式已开启；点击关闭后，下次发送将开始执行" : "开启计划模式，只分析并输出方案"} onClick={() => setPlanMode((value) => !value)}>☼ {planMode ? "计划中" : "计划"}</button>}</div><div>{chat && <SelectField className="provider-select" ariaLabel="会话智能体" value={interactionTask.provider || "codex"} disabled={running || events.length > 0} onChange={(provider) => void updateRuntime({ provider: provider as Provider, model: null, effort: "high" })} options={[{ value: "codex", label: "Codex", icon: "codex" }, { value: "deepseek", label: "Deepseek", icon: "deepseek" }]} />}{!chat && !workflow && <SelectField className="provider-select" ariaLabel="任务执行者" value={interactionTask.provider || ""} disabled={running || Boolean(task.archived)} onChange={(provider) => { if (provider) void updateRuntime({ provider: provider as Provider, model: null, effort: "high" }); }} options={[{ value: "", label: "选择执行者" }, { value: "codex", label: "Codex", icon: "codex" }, { value: "deepseek", label: "Deepseek", icon: "deepseek" }]} />}{interactionTask.provider && <><SelectField className="model-select" ariaLabel="任务模型" value={interactionTask.model || ""} disabled={running || Boolean(task.archived)} onChange={(model) => void updateRuntime({ model: model || null })} options={modelSelectOptions(models, interactionTask.provider, false)} /><SelectField className="effort-select" ariaLabel="任务推理强度" value={interactionTask.reasoning_effort || ""} disabled={running || Boolean(task.archived)} onChange={(effort) => void updateRuntime({ effort: effort || null })} options={effortOptions(interactionTask.provider, interactionTask.model || "", models)} /></>}{running && <button type="button" className="composer-send stop" aria-label="停止任务" onClick={cancel}>■</button>}<button className="composer-send" aria-label={running ? "加入队列" : "发送"} title="发送（Shift + Enter）" disabled={(!message.trim() && !attachments.length) || Boolean(task.archived) || priorStageIncomplete || flowBusy}>↑</button></div></div>
    </form>
    </>
    </div>
    </div>
  </aside></div>;
}

function WorktreeBar({ task, notify, onReload }: { task: TaskDetail; notify: (message: string) => void; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  if (task.kind === "chat") return null;
  const active = task.worktree_status === "active" && Boolean(task.worktree_path);
  const disabled = task.worktree_mode === "direct";
  async function openIn(app: "finder" | "terminal") {
    if (!task.worktree_path) return;
    try { await api("/api/open-target", { method: "POST", body: JSON.stringify({ target: task.worktree_path, app }) }); }
    catch (error) { notify((error as Error).message); }
  }
  async function setMode(next: boolean) {
    if (!next && !window.confirm("改为直接使用原项目目录吗？\n\n如果当前工作树含未撤销的变更会被拒绝。切换后智能体会直接修改你的原项目目录。")) return;
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ worktreeMode: next }) });
      notify(next ? "已启用 Worktree 隔离" : "已改为直接使用原项目目录");
      onReload();
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!task.worktree_path || !window.confirm(`确定移除 Worktree 吗？\n\n${task.worktree_path}\n\n仅当工作树没有未撤销的变更时才会移除。`)) return;
    setBusy(true);
    try { await api(`/api/tasks/${task.id}/worktree/remove`, { method: "POST", body: "{}" }); notify("Worktree 已移除"); onReload(); }
    catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  }
  const stateText = active ? "Worktree 隔离已启用" : disabled ? "已关闭 Worktree 隔离" : "未启用 Worktree 隔离";
  return <div className={active ? "worktree-bar active" : disabled ? "worktree-bar disabled" : "worktree-bar"}>
    <span className={`worktree-state ${disabled ? "disabled" : task.worktree_status || "unavailable"}`}>{stateText}</span>
    {active ? <><code title={task.worktree_path || ""}>{task.worktree_branch}</code><small title={task.worktree_path || ""}>{task.worktree_path}</small></> : <small>{disabled ? "你选择了直接使用原项目目录，智能体改动会直接生效。" : task.worktree_note || "该项目不是可用的 Git 仓库"}</small>}
    {active && task.worktree_note && <em>{task.worktree_note}</em>}
    <div className="worktree-actions">
      {active && <button type="button" onClick={() => void openIn("finder")}>在 Finder 中显示</button>}
      {active && <button type="button" onClick={() => void openIn("terminal")}>在终端打开</button>}
      {active && <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>移除 Worktree</button>}
      {active && <button type="button" disabled={busy} onClick={() => void setMode(false)}>改为直接使用</button>}
      {!active && disabled && <button type="button" className="primary" disabled={busy} onClick={() => void setMode(true)}>启用隔离</button>}
      {!active && !disabled && <button type="button" disabled={busy} onClick={() => void setMode(true)}>重试创建隔离</button>}
    </div>
  </div>;
}

const changeStatusName: Record<string, string> = { added: "新增", modified: "修改", deleted: "删除", untracked: "未跟踪", renamed: "重命名" };
function changeLetter(status: string) { return ({ added: "A", modified: "M", deleted: "D", untracked: "?", renamed: "R" } as Record<string, string>)[status] || "M"; }

function ChangesPanel({ task, notify, onReload }: { task: TaskDetail; notify: (message: string) => void; onReload: () => void }) {
  const [data, setData] = useState<TaskChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [runId, setRunId] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<ChangeDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const taskId = task.id;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<TaskChanges>(`/api/tasks/${taskId}/changes${runId ? `?run=${encodeURIComponent(runId)}` : ""}`);
      setData(next);
      setOpenPath((current) => current && next.files.some((file) => file.path === current) ? current : null);
    } catch (error) { notify((error as Error).message); }
    finally { setLoading(false); }
  }, [notify, runId, taskId]);
  useEffect(() => { setData(null); setOpenPath(null); setDiff(null); void load(); }, [load]);
  async function toggle(file: ChangeFile) {
    if (openPath === file.path) { setOpenPath(null); setDiff(null); return; }
    setOpenPath(file.path);
    setDiff(null);
    const query = `path=${encodeURIComponent(file.path)}${runId ? `&run=${encodeURIComponent(runId)}` : ""}`;
    try { setDiff(await api<ChangeDiff>(`/api/tasks/${taskId}/changes/file?${query}`)); }
    catch (error) { notify((error as Error).message); }
  }
  async function revert(paths: string[], label: string) {
    if (!paths.length) { notify("没有可撤销的变更"); return; }
    const preview = paths.slice(0, 30).join("\n");
    if (!window.confirm(`确认撤销${label}吗？\n\n${preview}${paths.length > 30 ? `\n…共 ${paths.length} 个文件` : ""}\n\n已跟踪文件会恢复到任务基准提交；未跟踪文件会移动到应用数据目录下的可恢复回收区。`)) return;
    setBusy(true);
    try {
      const result = await api<{ results: RevertResult[] }>(`/api/tasks/${taskId}/changes/revert`, { method: "POST", body: JSON.stringify({ paths }) });
      setOpenPath(null); setDiff(null);
      notify(`已处理 ${result.results.length} 个文件`);
      await load();
      onReload();
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  }
  const batches = data?.batches || [];
  const batchOptions = [{ value: "", label: "当前（相对任务基准）" }, ...batches.map((batch, index) => ({ value: batch.runId, label: `第 ${index + 1} 次 · ${relative(batch.startedAt)} · ${runName(batch.status)}` }))];
  const batchView = Boolean(runId);
  const batchIndex = batches.findIndex((batch) => batch.runId === runId);
  if (!data) return <div className="drawer-panel muted">{loading ? "正在读取变更…" : "暂无数据"}</div>;
  if (!data.available) return <div className="drawer-panel muted"><b>无法读取 Git 变更</b><span>{data.reason || "当前任务没有启用 Worktree 隔离"}</span>{batchOptions.length > 1 && <SelectField value={runId} onChange={setRunId} options={batchOptions} ariaLabel="选择执行批次" className="batch-select" />}</div>;
  const totalAdd = data.files.reduce((sum, file) => sum + (file.additions || 0), 0);
  const totalDelete = data.files.reduce((sum, file) => sum + (file.deletions || 0), 0);
  return <div className="drawer-panel changes-panel">
    <header className="panel-toolbar">
      <div><b>{batchView ? `第 ${batchIndex + 1} 次执行的变更` : "相对基准提交的变更"}</b><small>{batchView ? `${data.batch?.snapshot.slice(0, 8)} · 只读快照` : `${data.baseCommit?.slice(0, 10)}`} · {data.files.length} 个文件{data.files.length ? ` · +${totalAdd} −${totalDelete}` : ""}</small></div>
      <div className="panel-actions"><SelectField value={runId} onChange={setRunId} options={batchOptions} ariaLabel="选择执行批次" className="batch-select" /><button type="button" disabled={loading || busy} onClick={() => void load()}>刷新</button>{!batchView && <button type="button" className="danger" disabled={busy || !data.files.length} onClick={() => void revert(data.files.map((file) => file.path), "全部变更")}>撤销全部</button>}</div>
    </header>
    {batchView && <p className="change-readonly">这是第 {batchIndex + 1} 次执行结束时的工作区快照，用于审查该次改动；撤销请回到「当前」视图操作。</p>}
    {data.files.length === 0 && <div className="panel-empty">{batchView ? "该次执行没有产生代码变更。" : "工作树干净，没有相对基准提交的变更。"}</div>}
    <div className="change-list">{data.files.map((file) => <div className={openPath === file.path ? "change-item open" : "change-item"} key={file.path}>
      <div className="change-row" role="button" tabIndex={0} onClick={() => void toggle(file)} onKeyDown={(event) => { if (event.key === "Enter") void toggle(file); }}>
        <span className={`change-status ${file.status}`} title={changeStatusName[file.status]}>{changeLetter(file.status)}</span>
        <span className="change-path" title={file.path}>{file.path}</span>
        <span className="change-tags">{file.staged && <i>已暂存</i>}{file.unstaged && <i>未暂存</i>}{file.binary && <i>二进制</i>}</span>
        <span className="change-stat">{file.binary ? "—" : <><b>+{file.additions ?? 0}</b><em>−{file.deletions ?? 0}</em></>}</span>
        {!batchView && <button type="button" className="change-revert" disabled={busy} onClick={(event) => { event.stopPropagation(); void revert([file.path], `「${file.path}」`); }}>撤销</button>}
      </div>
      {openPath === file.path && <div className="change-diff">{diff && diff.path === file.path ? (diff.binary ? <p>二进制文件，不展示文本 Diff。</p> : diff.diff ? <DiffView diff={diff.diff} /> : <p>没有可展示的差异。</p>) : <p>正在加载 Diff…</p>}</div>}
    </div>)}</div>
  </div>;
}

type DiffRow = { kind: "add" | "del" | "ctx" | "hunk" | "note"; oldNo: number | null; newNo: number | null; text: string };
function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line }); continue; }
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename |old mode|new mode)/.test(line)) continue;
    if (line.startsWith("+")) { rows.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) }); newNo += 1; continue; }
    if (line.startsWith("-")) { rows.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) }); oldNo += 1; continue; }
    if (line.startsWith(" ")) { rows.push({ kind: "ctx", oldNo, newNo, text: line.slice(1) }); oldNo += 1; newNo += 1; continue; }
    if (!line.trim()) continue;
    rows.push({ kind: "note", oldNo: null, newNo: null, text: line });
  }
  return rows;
}

// 只渲染 unified diff 里的变更块与少量上下文，未改动的大段文件内容不会显示。
function DiffView({ diff }: { diff: string }) {
  const rows = useMemo(() => diffRows(diff), [diff]);
  if (!rows.length) return <p>没有可展示的差异。</p>;
  return <div className="diff-view">{rows.map((row, index) => {
    if (row.kind === "hunk") return <div className="diff-hunk" key={index}>{row.text}</div>;
    if (row.kind === "note") return <div className="diff-note" key={index}>{row.text}</div>;
    return <div className={`diff-row ${row.kind}`} key={index}><span className="diff-old">{row.oldNo ?? ""}</span><span className="diff-new">{row.newNo ?? ""}</span><span className="diff-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span><span className="diff-text">{row.text || " "}</span></div>;
  })}</div>;
}

const logStreamOptions = [
  { id: "stdout", name: "stdout" }, { id: "stderr", name: "stderr" }, { id: "tool", name: "工具" }, { id: "command", name: "命令" },
  { id: "status", name: "状态" }, { id: "system", name: "系统" }, { id: "error", name: "错误" }, { id: "recovery", name: "恢复" },
];

function LogsPanel({ task, notify }: { task: TaskDetail; notify: (message: string) => void }) {
  const [items, setItems] = useState<TaskLog[]>([]);
  const [meta, setMeta] = useState<{ total: number; oldest: number | null; newest: number | null; hasMore: boolean }>({ total: 0, oldest: null, newest: null, hasMore: false });
  const [streams, setStreams] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const newest = useRef<number | null>(null);
  const taskId = task.id;
  const active = ["running", "queued", "waiting_approval"].includes(task.run?.status || "");
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 300); return () => window.clearTimeout(timer); }, [query]);
  const queryString = useCallback((limit: number) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (streams.length) params.set("streams", streams.join(","));
    if (search) params.set("q", search);
    return params;
  }, [search, streams]);
  const loadTail = useCallback(async () => {
    setBusy(true);
    try {
      const params = queryString(300);
      const page = await api<LogPage>(`/api/tasks/${taskId}/logs?${params}`);
      setItems(page.items);
      newest.current = page.newest;
      setMeta({ total: page.total, oldest: page.oldest, newest: page.newest, hasMore: page.hasMore });
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  }, [notify, queryString, taskId]);
  useEffect(() => { setItems([]); newest.current = null; void loadTail(); }, [loadTail]);
  const loadOlder = useCallback(async () => {
    if (meta.oldest == null) return;
    setBusy(true);
    try {
      const params = queryString(300);
      params.set("before", String(meta.oldest));
      const page = await api<LogPage>(`/api/tasks/${taskId}/logs?${params}`);
      setItems((current) => [...page.items, ...current].slice(-2000));
      setMeta((value) => ({ ...value, oldest: page.oldest ?? value.oldest, hasMore: page.hasMore }));
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(false); }
  }, [meta.oldest, notify, queryString, taskId]);
  const loadNewer = useCallback(async () => {
    const params = queryString(300);
    if (newest.current != null) params.set("after", String(newest.current));
    try {
      const page = await api<LogPage>(`/api/tasks/${taskId}/logs?${params}`);
      if (!page.items.length) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))].slice(-2000);
      });
      newest.current = page.newest;
      setMeta((value) => ({ ...value, total: page.total, newest: page.newest ?? value.newest }));
    } catch { /* 轮询失败保持静默，避免打断执行 */ }
  }, [queryString, taskId]);
  useEffect(() => {
    const timer = window.setInterval(() => void loadNewer(), 2000);
    return () => window.clearInterval(timer);
  }, [loadNewer]);
  useEffect(() => {
    const node = container.current;
    if (node && follow) node.scrollTop = node.scrollHeight;
  }, [items, follow]);
  function textFor(log: TaskLog) {
    return `${new Date(log.created_at).toLocaleString("zh-CN")} [${log.stream}]${log.command ? ` $ ${log.command}` : ""} ${log.text}${log.exit_code != null ? ` (exit ${log.exit_code})` : ""}`;
  }
  async function copyLogs() {
    try { await navigator.clipboard.writeText(items.map(textFor).join("\n")); notify("执行日志已复制"); }
    catch (error) { notify((error as Error).message); }
  }
  function exportLogs(kind: "txt" | "json") {
    const content = kind === "json" ? JSON.stringify(items, null, 2) : items.map(textFor).join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: kind === "json" ? "application/json" : "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${taskNumber(task)}-logs.${kind}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="drawer-panel logs-panel">
    <header className="panel-toolbar">
      <div><b>执行日志</b><small>{items.length}/{meta.total} 条{meta.hasMore ? " · 可加载更早" : ""}{active ? " · 实时追加中" : ""}</small></div>
      <div className="panel-actions">{meta.hasMore && <button type="button" disabled={busy} onClick={() => void loadOlder()}>加载更早</button>}<button type="button" disabled={busy} onClick={() => void loadTail()}>刷新</button><button type="button" onClick={() => void copyLogs()}>复制</button><button type="button" onClick={() => exportLogs("txt")}>导出 TXT</button><button type="button" onClick={() => exportLogs("json")}>导出 JSON</button></div>
    </header>
    <div className="logs-filters">
      <div className="log-stream-filter"><button type="button" className={streams.length === 0 ? "active" : ""} onClick={() => setStreams([])}>全部</button>{logStreamOptions.map((stream) => <button type="button" key={stream.id} className={streams.includes(stream.id) ? "active" : ""} onClick={() => setStreams((current) => current.includes(stream.id) ? current.filter((value) => value !== stream.id) : [...current, stream.id])}>{stream.name}</button>)}</div>
      <label className="logs-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志关键字" aria-label="搜索日志关键字" /></label>
      <label className="logs-follow"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> 自动跟随</label>
    </div>
    <div className="logs-view" ref={container} onScroll={() => { const node = container.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 24); }}>
      {items.length === 0 && <div className="panel-empty">{active ? "正在等待日志…" : "没有匹配的执行日志。"}</div>}
      {items.map((log) => <div className={`log-line ${log.stream}${log.level === "error" ? " error" : ""}`} key={log.id}><time>{new Date(log.created_at).toLocaleTimeString("zh-CN", { hour12: false })}</time><span className="log-stream">{log.stream}</span>{log.command && <code className="log-command">$ {log.command}</code>}<span className="log-text">{log.text}</span>{log.exit_code != null && <em className="log-exit">exit {log.exit_code}</em>}</div>)}
    </div>
  </div>;
}

function ActivityCenter({ data, onOpen, onReadAll, onClearRead, onRefresh }: { data: ActivityPage; onOpen: (activity: Activity) => void; onReadAll: () => void; onClearRead: () => void; onRefresh: (page?: number) => Promise<void> }) {
  const readCount = Math.max(0, data.total - data.unread);
  return <section className="list-page activity-page">
    <header className="activity-hero"><div><div className="eyebrow">本机事件</div><h1>活动中心</h1><p>任务完成、失败、阻塞、等待授权与中断可恢复都会记录在这里，重启后仍然保留。</p></div><div className="activity-summary"><span><b>{data.unread}</b>未读</span><button type="button" disabled={!data.unread} onClick={onReadAll}>全部已读</button><button type="button" disabled={readCount === 0} onClick={onClearRead}>清空已读</button></div></header>
    <div className="activity-content">
      {data.items.length === 0 ? <div className="panel-empty">还没有活动记录。创建并执行任务后，重要状态会出现在这里。</div> : <div className="activity-list">{data.items.map((activity) => <button type="button" className={activity.read ? "activity-row read" : "activity-row"} key={activity.id} onClick={() => onOpen(activity)}><span className={`activity-dot ${activity.type}`} /><div><b>{activity.title}</b><small>{activity.body}</small></div><time>{relative(activity.created_at)}</time>{!activity.read && <i />}</button>)}</div>}
      {data.totalPages > 1 && <nav className="archive-pagination">{paginationPages(data.page, data.totalPages).map((item, index) => item === "…" ? <span key={`gap-${index}`}>…</span> : <button type="button" className={item === data.page ? "active" : ""} key={item} onClick={() => void onRefresh(item)}>{item}</button>)}</nav>}
    </div>
  </section>;
}

function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (decision: unknown) => void }) {
  const questions = approval.external_request_id.startsWith("user-input:") ? approval.options as UserInputQuestion[] : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (approval.status === "expired") return <div className="approval expired"><strong>授权已失效</strong><p>{approval.title}</p><pre>{approval.detail}</pre><div><span className="approval-expired-note">本地服务已重启，原授权进程已不存在，无法继续处理。请点击“继续任务”后重新授权。</span></div></div>;
  if (!questions.length) return <div className="approval"><strong>需要你的授权</strong><p>{approval.title}</p><pre>{approval.detail}</pre><div><button className="primary" onClick={() => onAnswer("allow")}>允许一次</button><button onClick={() => onAnswer("reject")}>拒绝</button><button className="danger" onClick={() => onAnswer("cancel")}>取消任务</button></div></div>;
  const complete = questions.every((question) => Boolean(answers[question.id]?.trim()));
  return <div className="approval user-input"><strong>需要你的选择</strong>{questions.map((question) => <fieldset key={question.id}><legend>{question.header}</legend><p>{question.question}</p>{question.options?.length ? <div className="answer-options">{question.options.map((option) => <button type="button" className={answers[question.id] === option.label ? "selected" : ""} key={option.label} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}><b>{option.label}</b><small>{option.description}</small></button>)}</div> : <input type={question.isSecret ? "password" : "text"} value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</fieldset>)}<div><button className="primary" disabled={!complete} onClick={() => onAnswer({ answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [answers[question.id].trim()] }])) })}>确认并继续</button></div></div>;
}

function Event({ event, flash, provider, model, avatar, agentName, notify, onAddAttachment }: { event: TaskDetail["events"][number]; flash?: boolean; provider: Provider | null; model: string; avatar: string; agentName: string; notify: (message: string) => void; onAddAttachment: (item: Attachment) => void }) {
  const visual = event.type === "message" && event.role === "user" ? <PersonalAvatar value={avatar} /> : event.type === "message" && provider ? <ProviderIcon provider={provider} label={model} /> : event.type === "error" ? "!" : event.type === "status" ? "⟳" : "·";
  const attachments = eventAttachments(event.raw);
  return <div className={`event ${event.type} ${event.role || ""}${flash ? " flash" : ""}`} data-event-id={event.id}><div className={`event-icon ${event.type === "message" ? "image" : ""}`}>{visual}</div><div><header><b>{event.title || (event.role === "user" ? "你" : agentName)}</b><time>{new Date(event.created_at).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</time></header>{event.content && <Markdown content={event.content} notify={notify} onOpen={(target) => void api("/api/open-target", { method: "POST", body: JSON.stringify({ target }) }).catch((error) => notify(error.message))} />}{attachments.length > 0 && <div className="event-attachments">{attachments.map((item, index) => <EventAttachment key={`${item.path}-${index}`} source={`/api/events/${event.id}/attachments/${index}`} item={item} notify={notify} onAdd={() => onAddAttachment(item)} />)}</div>}{event.content && <button type="button" className="event-copy" aria-label="复制此消息" title="复制" onClick={() => void navigator.clipboard.writeText(event.content).then(() => notify("消息已复制")).catch((error) => notify(error.message))}><CopyIcon /></button>}</div></div>;
}

function EventAttachment({ source, item, notify, onAdd }: { source: string; item: Attachment; notify: (message: string) => void; onAdd: () => void }) {
  const [url, setUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const image = item.mime.startsWith("image/");
  useEffect(() => {
    if (!image) return;
    let active = true;
    let objectUrl = "";
    void apiBlob(source).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      if (active) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
    }).catch((error) => notify(error.message));
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source, image, notify]);
  async function reveal() { await api("/api/open-target", { method: "POST", body: JSON.stringify({ target: item.path }) }); }
  async function download() {
    const destination = await saveDialog({ defaultPath: item.name });
    if (destination) await api(`${source}/copy`, { method: "POST", body: JSON.stringify({ destination }) });
  }
  async function copy() {
    const blob = await clipboardImage(await apiBlob(source));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }
  const run = (action: () => void | Promise<void>, message?: string) => { setMenu(false); void Promise.resolve(action()).then(() => message && notify(message)).catch((error) => notify(error.message)); };
  return <div className={`event-attachment ${image ? "image" : "file"}`} onContextMenu={(event) => { event.preventDefault(); setMenu(true); }}>
    {image ? <button type="button" className="attachment-preview" disabled={!url} onClick={() => setExpanded(true)}>{url ? <img src={url} alt={item.name} /> : <i>加载中</i>}</button> : <button type="button" className="attachment-file" title={item.path} onClick={() => run(reveal)}><i>文</i><span><b>{item.name}</b><small>在 Finder 中显示</small></span></button>}
    <button type="button" className="attachment-more" aria-label={`${item.name} 更多操作`} onClick={() => setMenu((value) => !value)}>•••</button>
    {menu && <div className="attachment-menu" onMouseLeave={() => setMenu(false)}>{image && <button type="button" onClick={() => run(onAdd, "已添加到输入框")}>添加到聊天</button>}{image && <button type="button" onClick={() => run(copy, "已复制图像")}>复制图像</button>}<button type="button" onClick={() => run(reveal)}>在 Finder 中显示</button><button type="button" onClick={() => run(download, "已保存副本")}>下载副本</button></div>}
    {expanded && url && <div className="attachment-lightbox" onClick={() => setExpanded(false)}><img src={url} alt={item.name} /><button type="button" aria-label="关闭图片预览">×</button></div>}
  </div>;
}

function questionPreview(event: { content?: string; raw?: unknown }): string {
  const text = (event.content || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 72 ? `${text.slice(0, 72)}…` : text;
  return eventAttachments(event.raw).length ? "（仅附件）" : "（空消息）";
}

function eventAttachments(raw: unknown): Attachment[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { attachments?: unknown }).attachments)) return [];
  return (raw as { attachments: unknown[] }).attachments.filter((item): item is Attachment => Boolean(item && typeof item === "object" && typeof (item as Attachment).path === "string" && typeof (item as Attachment).name === "string" && typeof (item as Attachment).mime === "string"));
}

async function clipboardImage(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片复制失败")), "image/png"));
}

function NewTask({ project, settings, onClose, onCreated }: { project: Project; settings: SettingsSnapshot | null; onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<"standalone" | "workflow">("standalone");
  const [provider, setProvider] = useState<Provider>("codex");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("high");
  const [stages, setStages] = useState<WorkflowStages>(newWorkflowStages);
  const [permission, setPermission] = useState<PermissionMode>("danger-full-access");
  const [autoExecute, setAutoExecute] = useState(false);
  const [workbenchSync, setWorkbenchSync] = useState(false);
  const [workbenchOptions, setWorkbenchOptions] = useState<{ projects: { id: string; name: string; task_only?: boolean }[]; requirements: { id: string; title: string; project_id: string }[] } | null>(null);
  const [workbenchProjectId, setWorkbenchProjectId] = useState("");
  const [workbenchRequirementId, setWorkbenchRequirementId] = useState("");
  const [workbenchKind, setWorkbenchKind] = useState("");
  const [worktree, setWorktree] = useState(settings?.worktree?.enabled ?? true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState("");
  async function addFiles(files: File[]) {
    try { const saved = await uploadAttachments(files); setAttachments((current) => uniqueAttachments([...current, ...saved])); }
    catch (reason) { setError((reason as Error).message); }
  }
  async function chooseFiles() {
    try { const picked = await pickAttachmentPaths(); setAttachments((current) => uniqueAttachments([...current, ...picked])); }
    catch (reason) { setError((reason as Error).message); }
  }
  async function toggleWorkbenchSync(checked: boolean) {
    if (!checked) { setWorkbenchSync(false); return; }
    try {
      const result = await api<{ projects?: { id: string; name: string; task_only?: boolean }[]; requirements?: { id: string; title: string; project_id: string }[]; data?: { projects?: { id: string; name: string; task_only?: boolean }[]; requirements?: { id: string; title: string; project_id: string }[] } }>("/api/workbench/assignment-options");
      setWorkbenchOptions({ projects: result.projects || result.data?.projects || [], requirements: result.requirements || result.data?.requirements || [] });
      setWorkbenchSync(true);
      setError("");
    } catch (reason) { setError((reason as Error).message); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dangerConfirmed = permission !== "danger-full-access" || window.confirm("完全访问允许智能体读取和修改工作区之外的文件。确认后，这个任务及后续对话不再重复询问。是否创建？");
    if (!dangerConfirmed) return;
    try {
      await api("/api/tasks", { method: "POST", body: JSON.stringify({
        projectId: project.id, kind, title: form.get("title"), description: form.get("description"),
        attachments: attachments.map(({ path, name, mime }) => ({ path, name, mime })),
        provider: kind === "workflow" ? null : provider, model: model || null, effort: effort || null,
        stages, permission, dangerConfirmed, autoExecute, workbenchSync, worktreeMode: worktree,
        ...(workbenchSync ? { workbenchAssignment: { projectId: workbenchProjectId, requirementId: workbenchRequirementId || null, kind: workbenchKind } } : {}),
      }) });
      onCreated();
    } catch (reason) { setError((reason as Error).message); }
  }
  const models = settings?.models[provider] || [];
  const modelOptions = modelSelectOptions(models, provider);
  const setStage = (key: keyof typeof stages, change: Partial<{ provider: Provider; model: string; effort: string }>) => setStages((value) => ({ ...value, [key]: { ...value[key], ...change } }));
  return <Modal title="新建任务" className="new-task-modal" onClose={onClose}><form className="form" onSubmit={submit}>
    <div className="segmented"><button type="button" className={kind === "standalone" ? "active" : ""} onClick={() => setKind("standalone")}>独立任务</button><button type="button" className={kind === "workflow" ? "active" : ""} onClick={() => setKind("workflow")}>流程任务</button></div>
    <label>任务标题<input name="title" required maxLength={200} autoFocus placeholder="要完成什么？" /></label>
    <label>任务说明<textarea name="description" rows={5} placeholder="目标、背景和验收标准（可直接粘贴或拖入图片）" onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { const files = [...event.dataTransfer.files]; if (files.length) { event.preventDefault(); void addFiles(files); } }} /></label>
    <div className="description-attachments"><AttachmentChips items={attachments} onRemove={(path) => setAttachments((current) => current.filter((value) => value.path !== path))} /><button type="button" className="attach-button" onClick={() => void chooseFiles()}>＋ 添加图片</button><small>图片会随任务说明一起交给智能体</small></div>
    {kind === "standalone" ? <>
      <div className="field"><span>执行者</span><SelectField value={provider} onChange={(value) => { setProvider(value as Provider); setModel(""); setEffort("high"); }} options={[{ value: "codex", label: "Codex", icon: "codex" }, { value: "deepseek", label: "Deepseek", icon: "deepseek" }]} /></div>
      <div className="field"><span>模型</span><SelectField value={model} onChange={(value) => { setModel(value); setEffort("high"); }} options={modelOptions} /></div>
      <div className="field"><span>推理强度</span><SelectField value={effort} onChange={setEffort} options={effortOptions(provider, model, models)} /></div>
    </> : <div className="workflow-stages">
      <StageSettings title="设计" hint={phaseDuty.design} value={stages.design} models={settings?.models} onChange={(change) => setStage("design", change)} />
      <i>→</i>
      <StageSettings title="实施" hint={phaseDuty.implementation} value={stages.implementation} models={settings?.models} onChange={(change) => setStage("implementation", change)} />
      <i>→</i>
      <StageSettings title="验证" hint={phaseDuty.verification} value={stages.verification} models={settings?.models} onChange={(change) => setStage("verification", change)} />
    </div>}
    <div className="field"><span>执行权限</span><SelectField value={permission} onChange={(value) => setPermission(value as PermissionMode)} options={[{ value: "read-only", label: "只读" }, { value: "workspace-write", label: "工作区写入" }, { value: "danger-full-access", label: "完全访问" }]} /></div>
    <label className="check"><input type="checkbox" checked={autoExecute} onChange={(event) => setAutoExecute(event.target.checked)} /> 创建后自动执行</label>
    <label className="check"><input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} /> 使用 Worktree 隔离（推荐）</label>
    <p className="field-help">{worktree ? "智能体在独立工作副本与分支中改动，原项目目录不受影响，可在任务详情页审查和撤销。" : "关闭后智能体将直接在你的原项目目录中执行，改动即时生效，但会直接影响你当前的未提交修改。"}</p>
    <label className="check"><input type="checkbox" checked={workbenchSync} disabled={!settings?.workbench.configured} onChange={(event) => void toggleWorkbenchSync(event.target.checked)} /> 同步到 Lo查查工作台（可选）</label>
    {workbenchSync && workbenchOptions && <>
      <label>开发台项目<select required value={workbenchProjectId} onChange={(event) => { setWorkbenchProjectId(event.target.value); setWorkbenchRequirementId(""); }}><option value="">请选择项目</option>{workbenchOptions.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {!workbenchOptions.projects.find((item) => String(item.id) === workbenchProjectId)?.task_only && <label>大需求<select required value={workbenchRequirementId} onChange={(event) => setWorkbenchRequirementId(event.target.value)}><option value="">请选择大需求</option>{workbenchOptions.requirements.filter((item) => String(item.project_id) === workbenchProjectId).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      <label>任务类型<select required value={workbenchKind} onChange={(event) => setWorkbenchKind(event.target.value)}><option value="">请选择类型</option><option value="development">开发</option><option value="test">测试</option></select></label>
    </>}
    {!settings?.workbench.configured && <p className="field-help">如需同步，请先到设置中配置工作台 API Key。</p>}
    {error && <p className="form-error">{error}</p>}
    <div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary">创建任务</button></div>
  </form></Modal>;
}

function StageSettings({ title, hint, value, models, onChange }: { title: string; hint: string; value: { provider: Provider; model: string; effort: string }; models?: SettingsSnapshot["models"]; onChange: (change: Partial<{ provider: Provider; model: string; effort: string }>) => void }) {
  const providerModels = models?.[value.provider] || [];
  return <section className="stage-settings"><header><b>{title}</b><SelectField className="stage-provider-select" ariaLabel={`${title}执行者`} value={value.provider} onChange={(provider) => onChange({ provider: provider as Provider, model: "", effort: "high" })} options={[{ value: "codex", label: "Codex", icon: "codex" }, { value: "deepseek", label: "Deepseek", icon: "deepseek" }]} /></header>
    <p className="stage-hint">{hint}</p>
    <SelectField ariaLabel={`${title}模型`} value={value.model} onChange={(model) => onChange({ model, effort: "high" })} options={modelSelectOptions(providerModels, value.provider)} />
    <SelectField ariaLabel={`${title}推理强度`} value={value.effort} onChange={(effort) => onChange({ effort })} options={effortOptions(value.provider, value.model, providerModels)} />
  </section>;
}

type SelectOption = { value: string; label: string; icon?: Provider };
function SelectOptionLabel({ option }: { option?: SelectOption }) {
  return <span className="select-option-label">{option?.icon && <ProviderIcon provider={option.icon} />}<span>{option?.label}</span></span>;
}
function SelectField({ value, options, onChange, ariaLabel, className = "", disabled = false }: { value: string; options: SelectOption[]; onChange: (value: string) => void; ariaLabel?: string; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return <div className={`${open ? "select-field open" : "select-field"} ${className}`.trim()} ref={root}>
    <button type="button" className="select-trigger" aria-label={ariaLabel || selected?.label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}><SelectOptionLabel option={selected} /><i>⌄</i></button>
    {open && <div className="select-menu" role="listbox">{options.map((option) => <button type="button" role="option" aria-label={option.label} aria-selected={option.value === value} className={option.value === value ? "selected" : ""} key={option.value} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false); onChange(option.value); }}><SelectOptionLabel option={option} /><i>{option.value === value ? "✓" : ""}</i></button>)}</div>}
  </div>;
}

const permissionOptions: { value: PermissionMode; label: string; hint: string; tone: "read" | "write" | "danger" }[] = [
  { value: "read-only", label: "只读", hint: "只查看与检索，不做任何改动", tone: "read" },
  { value: "workspace-write", label: "工作区写入", hint: "只能修改当前项目目录", tone: "write" },
  { value: "danger-full-access", label: "完全访问", hint: "可读写工作区之外的文件", tone: "danger" },
];

function PermissionIcon({ tone }: { tone: "read" | "write" | "danger" }) {
  if (tone === "read") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.6 12S6.1 6.6 12 6.6 21.4 12 21.4 12 17.9 17.4 12 17.4 2.6 12 2.6 12Z" /><circle cx="12" cy="12" r="2.6" /></svg>;
  if (tone === "write") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16" /><path d="M14.6 4.6a2.1 2.1 0 0 1 3 3L9 16l-4 1 1-4Z" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 2.9 19h18.2Z" /><path d="M12 9.6v4.4M12 16.6h.01" /></svg>;
}

// 执行权限选择：触发器只留图标+文字，颜色随等级变化，菜单和模型选择器同一套视觉。
function PermissionPicker({ value, disabled, onChange }: { value: PermissionMode; disabled: boolean; onChange: (value: PermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const current = permissionOptions.find((item) => item.value === value) || permissionOptions[0];
  return <div className={`permission-picker tone-${current.tone}${open ? " open" : ""}`} ref={root}>
    <button type="button" className="permission-trigger" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} title={`执行权限：${current.label} · ${current.hint}`} onClick={() => setOpen((value) => !value)}>
      <PermissionIcon tone={current.tone} /><span>{current.label}</span><i>⌄</i>
    </button>
    {open && <div className="permission-menu" role="listbox">
      {permissionOptions.map((item) => <button type="button" role="option" aria-selected={item.value === value} className={`tone-${item.tone}${item.value === value ? " selected" : ""}`} key={item.value} onClick={() => { setOpen(false); onChange(item.value); }}>
        <PermissionIcon tone={item.tone} /><span><b>{item.label}</b><small>{item.hint}</small></span>{item.value === value && <i>✓</i>}
      </button>)}
    </div>}
  </div>;
}

const effortNames: Record<string, string> = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极致" };
// 运行时（Deepseek/Codex）公布的强度名称是英文，界面统一显示中文；已是中文或未知的名称保持原样。
function effortLabel(item: { reasoningEffort: string; name?: string }) {
  const name = (item.name || "").trim();
  return /[\u4e00-\u9fff]/.test(name) ? name : effortNames[item.reasoningEffort] || name || item.reasoningEffort;
}
function effortOptions(provider: Provider, modelId: string, models: ModelOption[]): SelectOption[] {
  const model = models.find((item) => item.id === modelId) || models.find((item) => item.isDefault);
  const supported = model?.supportedReasoningEfforts?.length ? model.supportedReasoningEfforts : (provider === "deepseek" ? ["off", "low", "high", "max"] : ["low", "medium", "high", "xhigh", "max", "ultra"]).map((reasoningEffort) => ({ reasoningEffort, name: effortName(reasoningEffort) }));
  const defaultLabel = model?.defaultReasoningEffort ? `模型默认（${effortName(model.defaultReasoningEffort)}）` : provider === "codex" ? "模型默认（中）" : "模型默认";
  return [{ value: "", label: defaultLabel }, ...supported.filter((item) => item.reasoningEffort !== "").map((item) => ({ value: item.reasoningEffort, label: effortLabel(item) }))];
}

function uniqueAttachments(items: Attachment[]) { return [...new Map(items.map((item) => [item.path, item])).values()].slice(0, 10); }
function mimeForFile(file: string) { return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json" } as Record<string, string>)[file.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream"; }
function fileDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("无法读取附件")); reader.readAsDataURL(file); }); }
// 粘贴或拖入的文件没有本地路径，先交给服务端存一份，返回可长期引用的附件记录。
async function uploadAttachments(files: File[]) {
  return Promise.all(files.slice(0, 10).map(async (file) => {
    const data = await fileDataUrl(file);
    const attachment = await api<Attachment>("/api/attachments", { method: "POST", body: JSON.stringify({ name: file.name, mime: file.type, data }) });
    return file.type.startsWith("image/") ? { ...attachment, preview: data } : attachment;
  }));
}
async function pickAttachmentPaths() {
  const picked = await openDialog({ multiple: true, directory: false });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  return paths.map((file) => ({ path: file, name: file.split(/[\\/]/).pop() || file, mime: mimeForFile(file) }));
}
// 任务说明和聊天输入共用一套附件缩略图；preview 是新粘贴图片的本地数据地址，没有时退化为类型图标。
function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove: (path: string) => void }) {
  if (!items.length) return null;
  return <div className="composer-attachments">{items.map((item) => <span key={item.path}>{item.preview ? <img src={item.preview} alt="" /> : <i>{item.mime.startsWith("image/") ? "图" : "文"}</i>}<b title={item.name}>{item.name}</b><button type="button" aria-label={`移除 ${item.name}`} onClick={() => onRemove(item.path)}>×</button></span>)}</div>;
}
// 任务说明里的图片始终可见：说明可以折叠，但图片是任务输入的一部分，不跟着藏起来。
function TaskAttachments({ taskId, items, notify, onAdd }: { taskId: string; items: Attachment[]; notify: (message: string) => void; onAdd: (item: Attachment) => void }) {
  if (!items.length) return null;
  return <div className="task-attachments"><b>任务图片 <span>{items.length}</span></b><div className="event-attachments">{items.map((item, index) => <EventAttachment key={`${item.path}-${index}`} source={`/api/tasks/${taskId}/attachments/${index}`} item={item} notify={notify} onAdd={() => onAdd(item)} />)}</div></div>;
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  async function chooseWorkspace() { try { const selected = await openDialog({ directory: true, multiple: false, title: "选择项目文件夹" }); if (selected) { setWorkspace(selected); if (!name) setName(selected.split("/").filter(Boolean).pop() || "本地项目"); } } catch (reason) { setError((reason as Error).message); } }
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); try { onCreated(await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name, workspace }) })); } catch (reason) { setError((reason as Error).message); } }
  return <Modal title="添加本地项目" onClose={onClose}><form className="form" onSubmit={submit}><label>项目名称<input required maxLength={100} autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：洛查查" /></label><label>工作目录<div style={{ display: "flex", gap: 8 }}><input required value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="选择或输入项目目录" style={{ flex: 1 }} /><button type="button" className="primary" style={{ border: 0, borderRadius: 9, padding: "0 14px" }} onClick={() => void chooseWorkspace()}>选择文件夹</button></div></label><p className="field-help">选择已存在的本地目录。两个智能体只在这个工作区内协作。</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary">添加项目</button></div></form></Modal>;
}

function Modal({ title, children, onClose, className = "" }: { title: string; children: ReactNode; onClose: () => void; className?: string }) { return <div className="modal-backdrop" onMouseDown={onClose}><section className={`modal ${className}`.trim()} onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></header>{children}</section></div>; }

function ArchiveList({ projectId, archiveTotal, settings, onSelect }: { projectId: string; archiveTotal: number; settings: SettingsSnapshot | null; onSelect: (id: string) => void }) {
  const empty: ArchivePage = { items: [], page: 1, pageSize: 20, total: 0, totalPages: 0, summary: { total: 0, durationSeconds: 0 } };
  const [data, setData] = useState<ArchivePage>(empty);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(query.trim()); setPage(1); }, 300); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    if (!projectId) { setData(empty); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ projectId, page: String(page) });
    if (search) params.set("query", search);
    setLoading(true);
    setError("");
    void api<ArchivePage>(`/api/archives?${params}`, { signal: controller.signal }).then((result) => { setData(result); if (result.page !== page) setPage(result.page); }).catch((reason) => { if (reason.name !== "AbortError") setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [archiveTotal, page, projectId, search]);
  return <section className="list-page archive-page"><header className="archive-hero"><div><div className="eyebrow">历史记录</div><h1>归档任务</h1><p>点击任务查看完整对话、工具调用和最终结果。</p></div><div className="archive-summary"><span><b>{data.summary.total}</b>归档任务</span><span><b>{formatDuration(data.summary.durationSeconds)}</b>累计执行</span></div></header>
    <div className="archive-content"><div className="archive-toolbar"><label className="archive-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务名称或模型" aria-label="搜索归档任务" />{query && <button aria-label="清空搜索" onClick={() => setQuery("")}>×</button>}</label><span>{loading ? "正在查询…" : `${data.total} 条结果`}</span></div>
      {error ? <div className="archive-empty"><ArchiveIcon /><b>归档任务读取失败</b><span>{error}</span></div> : !loading && data.summary.total === 0 ? <div className="archive-empty"><ArchiveIcon /><b>还没有归档任务</b><span>已完成任务可在详情页右上角归档。</span></div> : !loading && data.items.length === 0 ? <div className="archive-empty"><ArchiveIcon /><b>没有匹配的任务</b><span>换一个任务名称或模型试试。</span></div> : <><div className={loading ? "archive-table loading" : "archive-table"}><div className="archive-table-head"><span>任务</span><span>智能体与模型</span><span>状态</span><span>执行时长</span><span>归档时间</span><i /></div>{data.items.map((task) => <button className="archive-row" key={task.id} onClick={() => onSelect(task.id)}><div className="archive-task"><span className="archive-number">{taskNumber(task)}</span><b>{task.title}</b><small>{task.is_root ? "流程任务" : phaseName[task.phase]} · {permissionName[task.permission]}</small></div><div className="archive-agent">{task.is_root ? <div className="workflow-meta-icons"><ProviderIcon provider="codex" size="medium" /><ProviderIcon provider="deepseek" size="medium" /></div> : task.provider && <ProviderIcon provider={task.provider} size="medium" />}<span><b>{task.is_root ? "流程任务" : task.provider === "codex" ? "Codex" : "Deepseek"}</b><small>{task.is_root ? "Codex → Deepseek → Codex" : `${taskModelName(task, settings)}${task.reasoning_effort ? ` · ${effortName(task.reasoning_effort)}` : ""}`}</small></span></div><span className={`archive-status ${task.status}`}>{runName(task.status)}</span><time>{taskDuration(task, Date.now())}</time><time title={new Date(task.archived_at || task.updated_at).toLocaleString("zh-CN")}>{relative(task.archived_at || task.updated_at)}</time><i className="archive-arrow">›</i></button>)}</div>{data.totalPages > 1 && <nav className="archive-pagination" aria-label="归档任务分页"><button disabled={data.page === 1} onClick={() => setPage((value) => value - 1)}>上一页</button>{paginationPages(data.page, data.totalPages).map((item, index) => item === "…" ? <span key={`ellipsis-${index}`}>…</span> : <button className={item === data.page ? "active" : ""} aria-current={item === data.page ? "page" : undefined} key={item} onClick={() => setPage(item)}>{item}</button>)}<button disabled={data.page === data.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button></nav>}</>}
    </div>
  </section>;
}

function Settings({ data, projects, reload, notify, skin, setSkin, uiScale, setUiScale, avatar, setAvatar, agentName, setAgentName, music, reloadMusic }: { data: SettingsSnapshot | null; projects: Project[]; reload: () => Promise<void>; notify: (message: string) => void; skin: SkinState; setSkin: (updater: (current: SkinState) => SkinState) => void; uiScale: number; setUiScale: (value: number) => void; avatar: string; setAvatar: (value: string) => void; agentName: string; setAgentName: (value: string) => void; music: MusicSettings | null; reloadMusic: () => Promise<void> }) {
  const active = resolveActiveSkin(skin);
  // “自定义”卡片固定预览已保存的自定义皮肤；切换内置皮肤不会清空它。
  const savedCustom = resolveActiveSkin({ skinId: "custom", custom: skin.custom });
  function applyPreset(id: string) {
    // 只切换选中的皮肤，保留 custom，切回“自定义”时上传的壁纸与微调仍在。
    setSkin((current) => selectPresetSkin(current, id));
  }
  function enterCustom() {
    setSkin(selectCustomSkin);
  }
  function updateCustom(patch: Partial<CustomSkin>) {
    setSkin((current) => patchCustomSkin(current, patch));
  }
  async function uploadWallpaper(file: File) {
    try { updateCustom({ wallpaper: "custom", wallpaperImage: await wallpaperData(file) }); notify("壁纸已更新"); }
    catch (error) { notify((error as Error).message); }
  }
  function exportSkinFile() {
    try {
      const url = URL.createObjectURL(new Blob([exportSkin(skin)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `洛神赋皮肤-${active.name}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("当前皮肤已导出为 JSON 文件");
    } catch (error) { notify(`导出失败：${(error as Error).message}`); }
  }
  async function importSkinFile(file: File) {
    // 常见误操作：把图片当成皮肤文件导入。图片请走「自定义皮肤 → 上传壁纸图片」。
    if (file.type.startsWith("image/")) {
      notify("这是图片，不是皮肤文件；如需用图片做壁纸，请在「自定义皮肤 → 壁纸 → 自定义图片」中上传");
      return;
    }
    try {
      // 先解析再更新状态：解析错误必须在这里抛出，不能被带进 React 的 state updater。
      const next = importSkin(await file.text());
      setSkin(() => next);
      notify("皮肤已导入并应用");
    } catch (error) { notify(`导入失败：${(error as Error).message}`); }
  }
  const [deepseekKey, setDeepseekKey] = useState("");
  const [showDeepseekKey, setShowDeepseekKey] = useState(false);
  const [accountModal, setAccountModal] = useState<"create" | "rename" | null>(null);
  const [accountAlias, setAccountAlias] = useState("");
  const [workbenchKey, setWorkbenchKey] = useState("");
  const [membersDraft, setMembersDraft] = useState("");
  // 名单内容变化时才回填输入框，避免用户编辑时被设置刷新的新对象覆盖。
  const membersSignature = JSON.stringify(data?.workbench.members || []);
  useEffect(() => { setMembersDraft((data?.workbench.members || []).join(", ")); }, [membersSignature]);
  const deepseekAccounts = data?.deepseek.accounts || [];
  const activeDeepseekAccount = deepseekAccounts.find((account) => account.id === data?.deepseek.activeId) || null;
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showResetCredits, setShowResetCredits] = useState(false);
  async function action(path: string, method = "POST", body?: unknown, success?: string) { try { await api(path, { method, body: body ? JSON.stringify(body) : undefined }); await reload(); if (success) notify(success); return true; } catch (error) { notify((error as Error).message); return false; } }
  async function resetCodex(creditId: string) {
    try {
      const result = await api<{ outcome: string }>("/api/codex/reset", { method: "POST", body: JSON.stringify({ creditId }) });
      await reload();
      setShowResetCredits(false);
      notify(({ reset: "Codex 额度已重置", alreadyRedeemed: "额度已重置", nothingToReset: "当前没有可重置的额度窗口", noCredit: "没有可用的重置次数" } as Record<string, string>)[result.outcome] || "已刷新 Codex 额度");
      return true;
    } catch (error) { notify((error as Error).message); return false; }
  }
  const resetCredits = (data?.codex.rateLimits.rateLimitResetCredits?.credits || []).filter((credit) => !credit.status || credit.status === "available").slice().sort((left, right) => (left.expiresAt ?? Infinity) - (right.expiresAt ?? Infinity));
  const musicStatusText = !music || music.status === "unset" ? "尚未选择音乐目录" : music.status === "missing" ? "目录不可用，请重新选择" : music.status === "denied" ? "系统拒绝访问，请重新选择目录" : music.status === "empty" ? "目录内没有音乐文件" : "已就绪";
  async function toggleNotifications() {
    const next = !data?.notifications.system;
    await action("/api/settings/notifications", "POST", { enabled: next }, next ? "应用内通知已开启" : "应用内通知已关闭");
  }
  async function saveMembers() {
    const members = membersDraft.split(",").map((item) => item.trim()).filter(Boolean);
    if (!members.length) { notify("请至少填写一个负责人"); return; }
    await action("/api/workbench/members", "POST", { members }, "负责人名单已保存");
  }
  async function toggleWorktree() {
    await action("/api/settings/worktree", "POST", { enabled: !data?.worktree.enabled }, data?.worktree.enabled ? "新任务默认不再使用 Worktree 隔离" : "新任务默认使用 Worktree 隔离");
  }
  async function saveMusic(input: { enabled?: boolean; directory?: string }, success: string) {
    try {
      await api("/api/music/settings", { method: "POST", body: JSON.stringify(input) });
      await reloadMusic();
      notify(success);
    } catch (error) { notify((error as Error).message); }
  }
  async function chooseMusicDirectory() {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: "选择音乐目录" });
      if (!selected) return;
      await saveMusic({ directory: selected, enabled: true }, "音乐目录已保存，正在扫描");
    } catch (error) { notify((error as Error).message); }
  }
  return <section className="settings-page"><header><div className="eyebrow">本地连接</div><h1>模型与账号</h1><p>凭据只保存在本机钥匙串，不会进入数据库或任务日志。</p><button type="button" className="setup-guide-link" onClick={() => setShowSetupGuide(true)}>接入说明 · 查看前置条件和一键配置提示词 <span>→</span></button></header>
    <div className="setting-card"><ProviderIcon provider="codex" size="large" /><div className="setting-main"><h2>Codex</h2>{data?.codex.account ? <><p>{data.codex.account.email || "已通过 ChatGPT 登录"}</p><span className="connected">已连接 · {data.codex.account.planType || data.codex.account.type || "ChatGPT"}</span></> : <><p>登录 ChatGPT 账号后复用官方 Codex 会话。</p><span className="disconnected">未登录</span></>}</div><CodexQuota data={data?.codex.rateLimits} onReset={() => setShowResetCredits(true)} /><div className="setting-actions">{data?.codex.account ? <button onClick={() => action("/api/codex/logout")}>退出登录</button> : <button className="primary" onClick={() => action("/api/codex/login")}>登录 Codex</button>}</div></div>
    <div className="setting-card"><ProviderIcon provider="deepseek" size="large" /><div className="setting-main"><h2>Deepseek Harness</h2>{deepseekAccounts.length ? <div className="deepseek-account-row"><SelectField className="deepseek-account-select" ariaLabel="Deepseek 账号" value={data?.deepseek.activeId || ""} options={deepseekAccounts.map((account) => ({ value: account.id, label: `${account.alias} ····${account.lastFour || "----"}` }))} onChange={(id) => void action(`/api/deepseek/accounts/${id}/activate`, "POST", undefined, "已切换 Deepseek 账号")} /><span className="connected">已安全保存到 macOS 钥匙串</span></div> : <><p>使用 Deepseek 开放平台 API Key。</p><span className="disconnected">尚未配置</span></>}</div><DeepseekQuota data={activeDeepseekAccount?.balance || null} configured={Boolean(activeDeepseekAccount)} /><div className="key-row deepseek-account-actions">{showDeepseekKey ? <><input type="password" autoFocus value={deepseekKey} onChange={(event) => setDeepseekKey(event.target.value)} placeholder="输入新密钥以更换" /><button className="primary" disabled={!deepseekKey.trim() || !activeDeepseekAccount} onClick={async () => { if (activeDeepseekAccount && await action(`/api/deepseek/accounts/${activeDeepseekAccount.id}/key`, "PUT", { key: deepseekKey }, "密钥已更新")) { setDeepseekKey(""); setShowDeepseekKey(false); } }}>保存</button><button onClick={() => { setDeepseekKey(""); setShowDeepseekKey(false); }}>取消</button></> : <><button onClick={() => { setAccountAlias(""); setDeepseekKey(""); setAccountModal("create"); }}>＋ 新增账号</button>{activeDeepseekAccount && <><button onClick={() => { setAccountAlias(activeDeepseekAccount.alias); setAccountModal("rename"); }}>重命名</button><button onClick={() => { notify("正在测试 Deepseek…"); void action(`/api/deepseek/accounts/${activeDeepseekAccount.id}/test`, "POST", undefined, "Deepseek 连接成功"); }}>测试连接</button><button onClick={() => setShowDeepseekKey(true)}>更换密钥</button><button className="danger" onClick={async () => { if (window.confirm(`确定删除账号「${activeDeepseekAccount.alias}」吗？该账号的密钥会从钥匙串移除。`)) await action(`/api/deepseek/accounts/${activeDeepseekAccount.id}`, "DELETE", undefined, "账号已删除"); }}>删除</button></>}</>}</div></div>
    {accountModal && <Modal title={accountModal === "create" ? "新增 Deepseek 账号" : "重命名账号"} onClose={() => setAccountModal(null)}><form className="form" onSubmit={async (event) => { event.preventDefault(); const alias = accountAlias.trim(); if (!alias) { notify("请填写账号别名"); return; } if (accountModal === "create") { if (deepseekKey.trim().length < 12) { notify("请填写有效的 API Key"); return; } if (await action("/api/deepseek/accounts", "POST", { alias, key: deepseekKey }, "账号已添加并切换")) { setDeepseekKey(""); setAccountModal(null); } } else if (activeDeepseekAccount && await action(`/api/deepseek/accounts/${activeDeepseekAccount.id}`, "PATCH", { alias }, "账号别名已更新")) setAccountModal(null); }}><label>账号别名<input required maxLength={24} autoFocus value={accountAlias} onChange={(event) => setAccountAlias(event.target.value)} placeholder="例如：主号 / 备用号" /></label>{accountModal === "create" && <label>API Key<input required type="password" value={deepseekKey} onChange={(event) => setDeepseekKey(event.target.value)} placeholder="sk-…" /></label>}<div className="modal-actions"><button type="button" onClick={() => setAccountModal(null)}>取消</button><button className="primary">{accountModal === "create" ? "添加并切换" : "保存"}</button></div></form></Modal>}
    <div className="setting-card"><div className="setting-logo workbench"><WorkbenchIcon /></div><div className="setting-main"><h2>Lo查查工作台</h2>{data?.workbench.configured ? <><p>{data.workbench.user || "个人开发台"} · API Key ···· {data.workbench.lastFour}</p><span className={data.workbench.projectId ? "connected" : "disconnected"}>{data.workbench.projectId ? "已绑定项目 · 每 5 分钟自动拉取待办" : "请选择要绑定的本地项目"}</span></> : <><p>配置个人开发台 API Key 后，可按任务同步状态，也能反向拉取工作台待办任务。</p><span className="disconnected">尚未配置</span></>}</div><div className="key-row workbench-actions">{data?.workbench.configured && <SelectField className="workbench-project-select" ariaLabel="绑定项目" value={data.workbench.projectId || ""} options={[{ value: "", label: "绑定项目：未绑定" }, ...projects.map((project) => ({ value: project.id, label: `绑定项目：${project.name}` }))]} onChange={(projectId) => void action("/api/workbench/project", "POST", { projectId }, projectId ? "工作台项目已绑定" : "已取消项目绑定")} />}<input type="password" value={workbenchKey} onChange={(event) => setWorkbenchKey(event.target.value)} placeholder={data?.workbench.configured ? "输入新密钥以更换" : "工作台 API Key"}/><button className="primary" disabled={!workbenchKey.trim()} onClick={async () => { if (await action("/api/workbench/key", "POST", { key: workbenchKey })) setWorkbenchKey(""); }}>保存</button>{data?.workbench.configured && <><button onClick={() => { notify("正在测试工作台…"); void action("/api/workbench/test", "POST", undefined, "工作台连接成功"); }}>测试连接</button><button className="danger" onClick={() => action("/api/workbench/key", "DELETE")}>删除</button></>}</div>{data?.workbench.configured && <div className="key-row workbench-members"><input value={membersDraft} maxLength={400} onChange={(event) => setMembersDraft(event.target.value)} placeholder="可指派负责人，用逗号分隔" aria-label="可指派负责人名单" /><button onClick={() => void saveMembers()}>保存名单</button></div>}{data?.workbench.configured && (data.workbench.dismissed?.length ? <div className="workbench-dismissed"><span>已忽略 {data.workbench.dismissed.length} 个已删除的问题，不再自动拉取</span><div className="dismissed-list">{data.workbench.dismissed.map((id) => <span className="dismissed-chip" key={id}><code>{id}</code><button type="button" onClick={() => void action("/api/workbench/restore", "POST", { externalId: id }, "已恢复，下次拉取会重新带入")}>恢复</button></span>)}</div></div> : null)}</div>
    <div className="setting-card avatar-card"><PersonalAvatar value={avatar} size="large" /><div className="setting-main"><h2>个人头像</h2><p>显示在任务对话中的个人消息旁，仅保存在本机。</p><span className="connected">选择后自动保存</span></div><div className="avatar-actions"><label className="avatar-upload">{avatar ? "更换头像" : "选择头像"}<input type="file" accept="image/*" onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; if (!file) return; try { setAvatar(await avatarData(file)); notify("个人头像已更新"); } catch (error) { notify((error as Error).message); } }} /></label>{avatar && <button className="danger" onClick={() => { setAvatar(""); notify("个人头像已移除"); }}>移除</button>}</div></div>
    <div className="setting-card"><div className="setting-logo agent-name"><AgentIcon /></div><div className="setting-main"><h2>智能体名称</h2><p>显示在所有 AI 回复上方，仅保存在本机。</p><span className="connected">输入后即时生效</span></div><div className="key-row"><input value={agentName} maxLength={24} onChange={(event) => setAgentName(event.target.value)} onBlur={() => { if (!agentName.trim()) setAgentName("智能体"); }} placeholder="智能体" aria-label="智能体名称" /></div></div>
    <div className="setting-card language-card"><div className="setting-logo language"><LanguageIcon /></div><div className="setting-main"><h2>回复语言</h2><p>要求 Codex 与 Deepseek 用它回复，包括进度说明、思考摘要和最终结论。</p><span className="connected">下次执行生效</span></div><div className="language-options">{replyLanguages.map((item) => <button type="button" className={(data?.language || "zh-CN") === item.id ? "active" : ""} aria-pressed={(data?.language || "zh-CN") === item.id} key={item.id} onClick={() => void action("/api/settings/language", "POST", { language: item.id }, "回复语言已更新")}>{item.name}</button>)}</div></div>
    <div className="setting-card notify-card"><div className="setting-logo notify"><NotifyIcon /></div><div className="setting-main"><h2>应用内通知</h2><p>仅在任务完成、失败、阻塞、等待授权或中断可恢复时，在主界面右上角弹出通知；普通日志不通知。不再依赖 macOS 系统通知权限。</p><span className={data?.notifications.system ? "connected" : "disconnected"}>当前：{data?.notifications.system ? "已开启 · 窗口在后台时通知会保留，回到应用后再消失" : "已关闭"}</span></div><div className="setting-actions"><button className={data?.notifications.system ? "" : "primary"} onClick={() => void toggleNotifications()}>{data?.notifications.system ? "关闭通知" : "开启通知"}</button></div></div>
    <div className="setting-card worktree-card"><div className="setting-logo worktree"><BranchIcon /></div><div className="setting-main"><h2>Worktree 隔离</h2><p>新任务默认在独立工作副本与分支中执行，原项目目录不受影响；新建任务时可单独关闭。</p><span className={data?.worktree.enabled ? "connected" : "disconnected"}>当前默认：{data?.worktree.enabled ? "使用 Worktree 隔离" : "直接使用原项目目录"}</span></div><div className="setting-actions"><button className={data?.worktree.enabled ? "" : "primary"} onClick={() => void toggleWorktree()}>{data?.worktree.enabled ? "关闭默认隔离" : "开启默认隔离"}</button></div></div>
    <div className="setting-card music-card"><div className="setting-logo music"><MusicIcon /></div><div className="setting-main"><h2>音乐播放器</h2><p>播放本机音乐文件，支持歌单、封面与逐字跟唱歌词。音频全程在本机流式播放，不联网、不消耗任何模型额度。</p><span className={music?.enabled ? "connected" : "disconnected"}>当前：{music?.enabled ? `已开启 · ${musicStatusText}` : "已关闭"}{music?.directory ? ` · ${music.directory}` : ""}</span></div><div className="setting-actions music-actions"><button className={music?.enabled ? "" : "primary"} onClick={() => void saveMusic({ enabled: !music?.enabled }, music?.enabled ? "音乐播放器已隐藏" : "音乐播放器已开启")}>{music?.enabled ? "隐藏播放器" : "开启播放器"}</button><button onClick={() => void chooseMusicDirectory()}>{music?.directory ? "更换目录" : "选择音乐目录"}</button></div></div>
    <div className="setting-card font-scale-card"><div className="setting-logo font-scale"><FontScaleIcon /></div><div className="setting-main"><h2>界面大小</h2><p>字体、按钮、卡片和间距同步缩放。</p><span className="connected">实时生效并自动保存</span></div><div className="font-scale-options">{uiScaleOptions.map((item) => <button type="button" className={uiScale === item.value ? "active" : ""} aria-pressed={uiScale === item.value} key={item.value} onClick={() => setUiScale(item.value)}>{item.name}<small>{Math.round(item.value * 100)}%</small></button>)}</div></div>
    <div className="setting-card appearance-card"><div className="setting-logo appearance"><AppearanceIcon /></div><div className="setting-main"><h2>皮肤</h2><p>整套配色、壁纸、材质与圆角，实时生效并自动保存。</p><span className="connected">当前：{active.name}</span></div><div className="appearance-controls"><div className="skin-file-actions"><label className="avatar-upload">导入皮肤<input type="file" accept="application/json,.json" onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; if (file) await importSkinFile(file); }} /></label><button onClick={exportSkinFile}>导出当前皮肤</button></div></div></div>
    <div className="skin-gallery" role="radiogroup" aria-label="皮肤列表">{builtinSkins.map((item) => <button type="button" role="radio" aria-checked={skin.skinId === item.id} className={skin.skinId === item.id ? "skin-card-item active" : "skin-card-item"} key={item.id} onClick={() => applyPreset(item.id)}><span className="skin-swatch" style={{ background: item.background }}><i style={{ background: wallpaperPreviewBackground(item.wallpaper) }} /><b style={{ background: item.accent }} /></span><strong>{item.name}</strong><small>{item.description}</small></button>)}<button type="button" role="radio" aria-checked={skin.skinId === "custom"} className={skin.skinId === "custom" ? "skin-card-item active" : "skin-card-item"} onClick={enterCustom}><span className="skin-swatch" style={{ background: savedCustom.background }}><i style={{ background: activeWallpaperBackground(savedCustom) }} /><b style={{ background: savedCustom.accent }} /></span><strong>自定义</strong><small>微调成自己的皮肤</small></button></div>
    {skin.skinId === "custom" && <div className="setting-card skin-custom-card"><div className="setting-main"><h2>自定义皮肤</h2><p>基于“{skinById(skin.custom.baseId)?.name || "海盐"}”微调；上传的壁纸图片只保存在本机。</p><span className="connected">实时生效并自动保存</span></div><div className="skin-controls">
      <div className="skin-control-block"><span>壁纸</span><div className="skin-chip-row">{wallpaperOptions.map((option) => <button type="button" className={skin.custom.wallpaper === option.id ? "active" : ""} key={option.id} onClick={() => updateCustom({ wallpaper: option.id })}>{option.name}</button>)}</div>{skin.custom.wallpaper === "custom" && <div className="skin-inline"><label className="avatar-upload">{skin.custom.wallpaperImage ? "更换壁纸图片" : "上传壁纸图片"}<input type="file" accept="image/*" onChange={async (event) => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; if (file) await uploadWallpaper(file); }} /></label>{skin.custom.wallpaperImage && <button className="danger" onClick={() => updateCustom({ wallpaperImage: "" })}>移除图片</button>}</div>}</div>
      <div className="skin-control-block"><span>材质</span><div className="skin-chip-row">{materialOptions.map((option) => <button type="button" title={option.hint} className={skin.custom.material === option.id ? "active" : ""} key={option.id} onClick={() => updateCustom({ material: option.id })}>{option.name}</button>)}</div></div>
      <div className="skin-control-block"><span>圆角</span><div className="skin-chip-row">{radiusOptions.map((option) => <button type="button" className={skin.custom.radius === option.id ? "active" : ""} key={option.id} onClick={() => updateCustom({ radius: option.id })}>{option.name}</button>)}</div></div>
      <div className="skin-control-block"><span>颜色</span><div className="color-pickers"><label>背景色 <input aria-label="背景色" type="color" value={skin.custom.background} onChange={(event) => updateCustom({ background: event.target.value })} /></label><label>强调色 <input aria-label="强调色" type="color" value={skin.custom.accent} onChange={(event) => updateCustom({ accent: event.target.value })} /></label></div></div>
      <div className="skin-control-block"><span>壁纸不透明度 · {skin.custom.wallpaperOpacity}%</span><input aria-label="壁纸不透明度" type="range" min={0} max={100} value={skin.custom.wallpaperOpacity} onChange={(event) => updateCustom({ wallpaperOpacity: Number(event.target.value) })} /></div>
      <div className="skin-control-block"><span>壁纸遮罩 · {skin.custom.wallpaperScrim}%</span><input aria-label="壁纸遮罩" type="range" min={0} max={MAX_WALLPAPER_SCRIM} value={skin.custom.wallpaperScrim} onChange={(event) => updateCustom({ wallpaperScrim: Number(event.target.value) })} /></div>
      <div className="skin-control-block"><span>壁纸模糊 · {skin.custom.wallpaperBlur}px</span><input aria-label="壁纸模糊" type="range" min={0} max={40} value={skin.custom.wallpaperBlur} onChange={(event) => updateCustom({ wallpaperBlur: Number(event.target.value) })} /></div>
    </div></div>}
    <div className="model-section"><h2>运行时模型</h2><div><ModelList title="Codex" models={data?.models.codex || []}/><ModelList title="Deepseek" models={data?.models.deepseek || []}/></div></div>
    {showSetupGuide && <SetupGuideModal onClose={() => setShowSetupGuide(false)} notify={notify} />}
    {showResetCredits && <ResetCreditModal credits={resetCredits} onClose={() => setShowResetCredits(false)} onConfirm={resetCodex} />}
  </section>;
}

function SetupGuideModal({ onClose, notify }: { onClose: () => void; notify: (message: string) => void }) {
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(setupPrompt); notify("接入配置提示词已复制"); }
    catch (error) { notify(`复制失败：${(error as Error).message}`); }
  }
  return <Modal title="洛神赋接入说明" onClose={onClose} className="setup-guide-modal"><div className="setup-guide-body">
    <p className="setup-guide-intro">正式安装包面向 Apple Silicon Mac。完成下面几项后，即可使用 Codex 与 Deepseek 双智能体能力。</p>
    <div className="setup-requirements">
      <article><i>1</i><div><b>电脑与系统</b><span>Apple Silicon Mac，macOS 14 或更高版本。</span></div></article>
      <article><i>2</i><div><b>Codex</b><span>安装并登录官方 ChatGPT 或 Codex App；也支持 PATH 中已有的 codex 命令。</span></div></article>
      <article><i>3</i><div><b>Deepseek</b><span>Harness 已随洛神赋内置，无需另装；需准备个人 Deepseek API Key。</span></div></article>
      <article><i>4</i><div><b>网络与项目目录</b><span>可访问 OpenAI、Deepseek 服务，并准备一个真实存在的本地项目文件夹。</span></div></article>
    </div>
    <section className="setup-prompt"><header><div><b>交给 Codex 自动检查</b><span>复制后连同洛神赋 DMG 一起发给 Codex；登录、密钥和安全确认仍由本人完成。</span></div><button type="button" className="primary" onClick={() => void copyPrompt()}>复制提示词</button></header><pre>{setupPrompt}</pre></section>
    <div className="modal-actions"><button type="button" onClick={onClose}>知道了</button></div>
  </div></Modal>;
}

function ResetCreditModal({ credits, onClose, onConfirm }: { credits: RateLimitResetCredit[]; onClose: () => void; onConfirm: (creditId: string) => Promise<boolean> }) {
  const [selectedId, setSelectedId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selected = credits.find((credit) => credit.id === selectedId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    if (!await onConfirm(selected.id)) setSubmitting(false);
  }
  return <Modal title="选择重置机会" onClose={onClose} className="reset-credit-modal"><form className="reset-credit-form" onSubmit={submit}>
    <p>每次重置机会的有效期独立。请选择并确认本次要消耗的机会。</p>
    {credits.length ? <div className="reset-credit-list" role="radiogroup" aria-label="可用的 Codex 额度重置机会">{credits.map((credit, index) => <label className={selectedId === credit.id ? "selected" : ""} key={credit.id}>
      <input type="radio" name="reset-credit" value={credit.id} checked={selectedId === credit.id} onChange={() => setSelectedId(credit.id)} />
      <span><b>{credit.title || `重置机会 ${index + 1}`}</b>{credit.description && <small>{credit.description}</small>}</span>
      <time>{credit.expiresAt ? `有效期至 ${quotaExpiry(credit.expiresAt)}` : "长期有效"}</time>
    </label>)}</div> : <div className="reset-credit-empty">暂时无法读取每次重置机会的明细，请刷新后重试。</div>}
    <div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={!selected || submitting}>{submitting ? "正在重置…" : "确认重置"}</button></div>
  </form></Modal>;
}

function CodexQuota({ data, onReset }: { data?: SettingsSnapshot["codex"]["rateLimits"]; onReset: () => void }) {
  if (!data || data.error) return <div className="quota-panel unavailable"><b>实时额度</b><span>{data?.error ? "暂时无法读取" : "正在读取…"}</span></div>;
  const buckets = data.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId) : data.rateLimits ? [data.rateLimits] : [];
  const windows = buckets.flatMap((bucket) => [bucket.primary, bucket.secondary].filter(Boolean).map((window) => ({ bucket, window: window! })));
  const credits = data.rateLimitResetCredits?.availableCount || 0;
  return <div className="quota-panel"><header><b>实时额度</b><small>{quotaUpdated(data.updatedAt)}</small></header>{windows.map(({ bucket, window }, index) => { const remaining = Math.max(0, 100 - Math.round(window.usedPercent)); return <div className="quota-row" key={`${bucket.limitId}-${window.windowDurationMins}-${index}`}><div><span>{bucket.limitName ? `${bucket.limitName} · ` : "Codex · "}{quotaWindowName(window.windowDurationMins)}</span><strong>剩余 {remaining}%</strong></div><i><em style={{ width: `${remaining}%` }} /></i><small>{quotaReset(window.resetsAt)}</small></div>; })}<footer><span>可重置 {credits} 次</span><button disabled={!credits} onClick={onReset}>重置额度</button></footer></div>;
}

function DeepseekQuota({ data, configured }: { data?: SettingsSnapshot["deepseek"]["balance"]; configured?: boolean }) {
  if (!data || data.error) return <div className="quota-panel unavailable"><b>实时余额</b><span>{data?.error ? "暂时无法读取" : configured ? "正在读取…" : "配置密钥后显示"}</span></div>;
  return <div className="quota-panel balance-panel"><header><b>实时余额</b><small>{quotaUpdated(data.updatedAt)}</small></header><div>{(data.balance_infos || []).map((balance) => <span key={balance.currency}><small>{balance.currency}</small><strong>{balance.total_balance}</strong></span>)}</div><footer><span className={data.is_available ? "connected" : "disconnected"}>{data.is_available ? "可用" : "余额不足"}</span><small>每 10 秒校准</small></footer></div>;
}

function ModelList({ title, models }: { title: string; models: ModelOption[] }) { return <article><b>{title}</b>{models.length ? models.map((model) => <span key={model.id}>{modelDisplayName(model.name)}{(title === "Deepseek" ? model.id === "deepseek-flash" : model.isDefault) ? " · 默认" : ""}</span>) : <small>首次建立会话后由运行时返回</small>}</article>; }
function EmptyProject({ onCreate }: { onCreate: () => void }) { return <div className="empty-project"><span>洛</span><h2>从一个本地项目开始</h2><p>添加工作目录后，即可创建 Codex、Deepseek 或流程任务。</p><button className="primary" onClick={onCreate}>添加项目</button></div>; }
function paginationPages(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1].filter((page) => page > 0 && page <= total));
  return [...pages].sort((left, right) => left - right).flatMap((page, index, values) => index && page - values[index - 1] > 1 ? ["…", page] : [page]);
}
function taskNumber(task: Pick<Task, "number" | "project_name">) {
  const words = task.project_name.match(/[a-z0-9]+/gi) || [];
  const first = words[0] || "";
  const prefix = words.length > 1 ? words.map((word) => word[0]).join("") : first.length > 1 ? first.slice(0, 3) : Array.from(task.project_name.replace(/\s/g, "")).slice(0, 3).join("");
  return `${(prefix || "TASK").toUpperCase()}-${String(task.number).padStart(3, "0")}`;
}
function statusMatch(actual: TaskStatus, column: TaskStatus) { return column === "blocked" ? actual === "blocked" || actual === "canceled" : actual === column; }
function relative(value: string) { const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000); if (seconds < 60) return "刚刚"; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`; return `${Math.floor(seconds / 86400)} 天前`; }
function runName(status: string) { return ({ todo: "待执行", queued: "排队中", running: "执行中", waiting_approval: "等待授权", in_review: "待验证", blocked: "阻塞", done: "已完成", completed: "已完成", failed: "失败", canceled: "已取消", interrupted: "已中断，可恢复", expired: "已失效" } as Record<string, string>)[status] || status; }
function effortName(value: string) { return effortNames[value] || value; }
function modelName(value: string | null) { if (!value) return ""; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? String(parsed[1] || value) : value; } catch { return value; } }
function modelDisplayName(value: string) { return value === "deepseek-flash" ? "Deepseek-V4.1-Flash" : value.replace(/DeepSeek/g, "Deepseek").replace("V41-", "V4.1-"); }
function defaultModel(models: ModelOption[], provider?: Provider | null) { return provider === "deepseek" ? models.find((model) => model.id === "deepseek-flash") || models.find((model) => /V4\.?1-Flash/i.test(model.name)) || models[0] : models.find((model) => model.isDefault) || models[0]; }
function defaultModelName(models: ModelOption[], provider?: Provider | null) { return modelDisplayName(defaultModel(models, provider)?.name || (provider === "deepseek" ? "deepseek-flash" : provider === "codex" ? "GPT-6-Astra" : "运行时默认模型")); }
function modelSelectOptions(models: ModelOption[], provider: Provider, markDefault = true): SelectOption[] {
  const preferred = defaultModel(models, provider);
  const defaultName = defaultModelName(models, provider);
  return [{ value: "", label: markDefault ? `默认 · ${defaultName}` : defaultName }, ...models.filter((model, index) => model.id !== preferred?.id && models.findIndex((item) => item.id === model.id) === index).map((model) => ({ value: model.id, label: modelDisplayName(model.name) }))];
}
function taskModelName(task: Task, settings: SettingsSnapshot | null) { return task.model ? modelDisplayName(modelName(task.model)) : defaultModelName(task.provider ? settings?.models[task.provider] || [] : [], task.provider); }
function taskDuration(task: Task, clock: number) {
  const active = task.active_run_started_at ? Math.max(0, (clock - new Date(task.active_run_started_at).getTime()) / 1000) : 0;
  const seconds = Math.max(0, Number(task.duration_seconds || 0) + active);
  if (!seconds) return "未执行";
  return `${active ? "已运行" : "累计"} ${formatDuration(seconds)}`;
}
function formatDuration(value: number) { const seconds = Math.floor(value); if (seconds < 60) return `${seconds}秒`; if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`; return `${Math.floor(seconds / 3600)}时${Math.floor(seconds % 3600 / 60)}分`; }
function quotaWindowName(minutes: number) { return minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440} 天额度` : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时额度` : `${minutes} 分钟额度`; }
function quotaReset(timestamp: number) { return `${new Date(timestamp * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} 重置`; }
function quotaExpiry(timestamp: number) { return new Date(timestamp * 1000).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
function quotaUpdated(value: string) { return `${new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} 更新`; }
async function retry(work: () => Promise<void>, attempts = 20, delay = 200) { let error: unknown; for (let attempt = 0; attempt < attempts; attempt += 1) { try { return await work(); } catch (reason) { error = reason; await new Promise((resolve) => setTimeout(resolve, delay)); } } throw error; }
async function avatarData(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 20 * 1024 * 1024) throw new Error("请选择 20MB 以内的图片");
  const source = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("无法读取这张图片")); reader.readAsDataURL(file); });
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("无法读取这张图片")); image.src = source; });
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 192;
  canvas.getContext("2d")?.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 192, 192);
  return canvas.toDataURL("image/webp", .88);
}
async function wallpaperData(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 20 * 1024 * 1024) throw new Error("请选择 20MB 以内的图片");
  const source = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("无法读取这张图片")); reader.readAsDataURL(file); });
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("无法读取这张图片")); image.src = source; });
  // 壁纸要进 localStorage，逐步压缩到体积上限以内，保证跨重启可恢复。
  let limit = 1920;
  let quality = .84;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/webp", quality);
    if (result.length <= MAX_WALLPAPER_CHARS) return result;
    limit = Math.round(limit * .75);
    quality = Math.max(.5, quality - .12);
  }
  throw new Error("图片太大，请换一张更小的图片");
}

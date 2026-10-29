export type Provider = "codex" | "deepseek";
export type TaskStatus = "todo" | "running" | "in_review" | "blocked" | "done" | "canceled";
export type TaskPhase = "standalone" | "design" | "implementation" | "verification";
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";

export interface Attachment { path: string; name: string; mime: string; preview?: string }

export interface Project { id: string; name: string; workspace: string; created_at: string; updated_at: string }
export interface Task {
  id: string; number: number; project_id: string; project_name: string; workspace: string; title: string; description: string;
  attachments: Attachment[];
  kind: "task" | "chat";
  status: TaskStatus; phase: TaskPhase; provider: Provider | null; model: string | null; permission: PermissionMode;
  reasoning_effort: string | null; workbench_sync: number; workbench_external_id?: string | null;
  parent_id: string | null; root_id: string | null; sequence_index: number | null; is_root: number; auto_execute: number;
  progress: number; unread: number; archived: number; archived_at: string | null; duration_seconds: number; active_run_started_at: string | null; created_at: string; updated_at: string;
  worktree_path: string | null; worktree_branch: string | null; base_commit: string | null; worktree_status: "active" | "unavailable" | "missing" | "removed" | "disabled" | null; worktree_note: string | null; worktree_mode: "isolate" | "direct";
}
export interface EventItem { id: number; task_id: string; type: string; role: string | null; title: string | null; content: string; raw: unknown; created_at: string; provider?: Provider | null }
export interface UserInputQuestion { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] | null }
export interface Approval { id: string; task_id: string; external_request_id: string; title: string; detail: string; provider: Provider; status: string; options: ({ id: string; name: string } | UserInputQuestion)[] }
export interface RunRecord { status: string; error: string | null; actual_model: string | null; actual_effort: string | null; resume_kind?: string | null; interrupt_reason?: string | null; started_at?: string; ended_at?: string | null }
export interface TaskDetail extends Task { active: boolean; flow_active?: boolean; events: EventItem[]; eventsHasMore?: boolean; eventsOldestId?: number | null; approvals: Approval[]; conversation: Record<string, unknown> | null; run: RunRecord | null; actual_runtime: { model: string | null; effort: string | null } | null; children: Task[] }
export interface WorktreeInfo { taskId?: string; status: "active" | "unavailable" | "missing" | "removed"; path: string | null; branch: string | null; baseCommit: string | null; note: string | null }
export interface ChangeFile { path: string; status: "added" | "modified" | "deleted" | "untracked" | "renamed"; staged: boolean; unstaged: boolean; additions: number | null; deletions: number | null; binary: boolean }
export interface ChangeBatch { runId: string; status: string; phase: string | null; stageTitle: string | null; startedAt: string; endedAt: string | null; resumeKind: string | null; snapshot: string; previous: string | null }
export interface TaskChanges { available: boolean; reason?: string; baseCommit?: string; from?: string; to?: string; files: ChangeFile[]; batches?: ChangeBatch[]; batch?: ChangeBatch }
export interface ChangeDiff { path: string; tracked: boolean; binary: boolean; diff: string; truncated: boolean; error: string | null }
export interface RevertResult { path: string; action: "restored" | "removed" | "recycled" | "un-staged" | "missing" | "failed"; recoveredTo?: string; error?: string }
export interface TaskLog { id: number; task_id: string; run_id: string | null; seq: number; stream: "stdout" | "stderr" | "tool" | "command" | "status" | "system" | "error" | "recovery"; level: string; text: string; command: string | null; cwd: string | null; exit_code: number | null; redacted: number; created_at: string }
export interface LogPage { items: TaskLog[]; total: number; oldest: number | null; newest: number | null; hasMore: boolean }
export interface Activity { id: string; project_id: string | null; task_id: string | null; type: string; title: string; body: string; read: number; created_at: string }
export interface ActivityPage { items: Activity[]; page: number; pageSize: number; total: number; totalPages: number; unread: number }
export interface ReasoningEffortOption { reasoningEffort: string; name?: string; description?: string }
export interface ModelOption { id: string; name: string; description?: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: ReasoningEffortOption[] }
export interface SkillOption { name: string; description: string; path: string; enabled: boolean; interface?: { displayName?: string; shortDescription?: string } }
export interface Snapshot { projects: Project[]; tasks: Task[]; chats: Task[]; archivedTotal: number; unreadActivities: number }
export interface ChatPage { items: Task[]; page: number; pageSize: number; total: number; totalPages: number }
export interface ArchivePage { items: Task[]; page: number; pageSize: number; total: number; totalPages: number; summary: { total: number; durationSeconds: number } }
export interface RateLimitWindow { usedPercent: number; windowDurationMins: number; resetsAt: number }
export interface RateLimitBucket { limitId?: string; limitName?: string | null; primary?: RateLimitWindow | null; secondary?: RateLimitWindow | null }
export interface RateLimitResetCredit { id: string; title?: string | null; description?: string | null; expiresAt?: number | null; status?: "available" | "redeeming" | "redeemed" | "unknown" }
export interface CodexRateLimits {
  rateLimits?: RateLimitBucket; rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
  rateLimitResetCredits?: { availableCount: number; credits?: RateLimitResetCredit[] | null } | null;
  updatedAt: string; error?: string;
}
export interface DeepseekBalance { is_available?: boolean; balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[]; updatedAt: string; error?: string }
export interface DeepseekAccount { id: string; alias: string; lastFour: string | null; balance: DeepseekBalance | null }
export interface SettingsSnapshot {
  codex: { account: null | { email?: string; planType?: string; type?: string }; requiresOpenaiAuth: boolean; error?: string; rateLimits: CodexRateLimits };
  deepseek: { activeId: string | null; accounts: DeepseekAccount[]; configured?: boolean; lastFour?: string | null; balance?: DeepseekBalance | null };
  workbench: { configured: boolean; lastFour: string | null; user: string | null; projectId: string | null; members: string[]; dismissed: string[] };
  models: { codex: ModelOption[]; deepseek: ModelOption[] };
  language: string;
  notifications: { system: boolean };
  worktree: { enabled: boolean };
}

/* ---------------- 本机音乐播放器 ---------------- */

export type MusicDirectoryStatus = "unset" | "ready" | "empty" | "missing" | "denied";
export type MusicRepeatMode = "off" | "all" | "one";

export interface MusicSettings { enabled: boolean; directory: string; status: MusicDirectoryStatus }

export interface MusicTrack {
  id: number; path: string; name: string; relative: string; folder: string; size: number; modifiedAt: number;
  title: string; artist: string; album: string; year: string; trackNumber: string; duration: number | null;
  hasCover: boolean; coverMime: string | null; hasLyrics: boolean; lyricsSource: string | null; lyricsKind: string | null;
}

export interface MusicLibrary { directory: string; status: MusicDirectoryStatus; tracks: MusicTrack[]; truncated: boolean; error: string | null }

export interface MusicLyricWord { time: number; text: string }
export interface MusicLyricLine { time: number; text: string; words: MusicLyricWord[] | null }
export interface MusicLyrics { kind: "none" | "line" | "word"; source: string | null; lines: MusicLyricLine[] }

export interface MusicPlaylist {
  id: string; name: string; created_at: string; updated_at: string; count: number;
  items: { path: string; position: number }[];
}

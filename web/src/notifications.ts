import type { Activity } from "./types";

// 打包后的 macOS 应用收不到可靠的系统通知：WKWebView 不接管网页通知授权弹窗，
// 应用本身也常常不出现在「系统设置 → 通知」的列表里（通知中心显示“没有最近的通知”）。
// 因此任务提醒统一改由「应用内通知」承担：在主界面右上角弹出一条仿 macOS 通知样式的卡片。
// 这里只放纯逻辑（分类、文案、时长），渲染在 App.tsx 的 NotificationStack 中。
export type NotificationCategory = "completed" | "blocked" | "approval" | "resumed" | "interrupted" | "info";

/** 通知在窗口处于前台时自动消失的时间；窗口在后台时保持显示，回到应用后再计时。 */
export const notificationLifetimeMs = 7000;
/** 屏幕上同时保留的通知条数，超出后优先保留最新的。 */
export const notificationLimit = 4;

export function notificationCategory(type: string): NotificationCategory {
  if (type === "task.completed") return "completed";
  if (type === "task.blocked" || type === "task.failed") return "blocked";
  if (type === "task.approval") return "approval";
  if (type === "task.resumed") return "resumed";
  if (type === "task.interrupted") return "interrupted";
  return "info";
}

export function notificationCategoryName(category: NotificationCategory): string {
  return ({ completed: "任务完成", blocked: "需要处理", approval: "等待授权", resumed: "任务继续", interrupted: "任务中断", info: "任务动态" })[category];
}

/** 通知正文：活动没有 body 时退回分类说明，避免出现空行。 */
export function notificationBody(activity: Activity): string {
  return (activity.body || "").trim() || notificationCategoryName(notificationCategory(activity.type));
}

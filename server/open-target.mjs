import path from "node:path";
import { fileURLToPath } from "node:url";

export function openArguments(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) throw new Error("打开目标无效");
  const target = value.trim();
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持网页链接");
    return [url.href];
  }
  const file = (target.startsWith("file://") ? fileURLToPath(target) : target).replace(/:\d+(?::\d+)?$/, "");
  if (!path.isAbsolute(file)) throw new Error("只支持本地绝对路径");
  return ["-R", file];
}

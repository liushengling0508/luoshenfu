// 图片类型识别与命名。
//
// harness 的附件是按内容 sha256 命名的，**没有扩展名**：
//   attachments/v1/objects/fb/fbaf916c...4607
// 而界面靠 `mime.startsWith("image/")` 决定渲染成图片还是普通文件，
// 所以判断"这是不是图片"只能看文件头——只看扩展名会被当成文件，图就显示不出来。

import { open } from "node:fs/promises";
import path from "node:path";

const signatures = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

export const imageExtensions = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** 读文件头判断图片类型；不是支持的图片时返回 null。 */
export async function sniffImageMime(file) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12) return null;
    for (const item of signatures) {
      if (item.bytes.every((value, index) => header[index] === value)) return item.mime;
    }
    // WebP 是 RIFF 容器：前 4 字节 RIFF，第 8-11 字节 WEBP。
    if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    return null;
  } finally {
    await handle.close();
  }
}

/** 附件在界面上的显示名。哈希文件名没有扩展名，给它补一个能认出来的名字。 */
export function imageFileName(file, mime) {
  const existing = path.basename(file);
  if (path.extname(existing)) return existing;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `图片-${stamp}${imageExtensions[mime] || ".png"}`;
}

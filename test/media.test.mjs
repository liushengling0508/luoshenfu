import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imageFileName, imageExtensions, sniffImageMime } from "../server/media.mjs";

function padded(head) {
  const buffer = Buffer.alloc(16);
  Buffer.from(head).copy(buffer);
  return buffer;
}

test("按文件内容识别图片类型，不依赖扩展名", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-media-"));
  try {
    // harness 存的就是这种没有扩展名的哈希文件名，必须能认出来。
    const hashed = path.join(directory, "fbaf916c3d3bc39e1bbf0462a5d51223958ec5ff4b81cd9870777c8aa07de836");
    await writeFile(hashed, padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.equal(await sniffImageMime(hashed), "image/png");
    assert.match(imageFileName(hashed, "image/png"), /^图片-\d{14}\.png$/);

    const jpeg = path.join(directory, "photo.bin");
    await writeFile(jpeg, padded([0xff, 0xd8, 0xff, 0xe0]));
    assert.equal(await sniffImageMime(jpeg), "image/jpeg");

    const webp = path.join(directory, "shot");
    const riff = Buffer.alloc(16);
    riff.write("RIFF", 0, "ascii");
    riff.write("WEBP", 8, "ascii");
    await writeFile(webp, riff);
    assert.equal(await sniffImageMime(webp), "image/webp");
    assert.match(imageFileName(webp, "image/webp"), /\.webp$/);

    const gif = path.join(directory, "anim");
    await writeFile(gif, padded([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    assert.equal(await sniffImageMime(gif), "image/gif");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("非图片与过短的文件不会被误判，已有扩展名的文件沿用原名", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-media-"));
  try {
    const text = path.join(directory, "notes.txt");
    await writeFile(text, "这不是图片，只是一段文字。");
    assert.equal(await sniffImageMime(text), null);
    assert.equal(imageFileName(text, "image/png"), "notes.txt");

    const empty = path.join(directory, "empty");
    await writeFile(empty, "");
    assert.equal(await sniffImageMime(empty), null);

    // 只靠扩展名会误判：内容不是 PNG 的 .png 文件必须被拒绝。
    const fake = path.join(directory, "fake.png");
    await writeFile(fake, "not really a png");
    assert.equal(await sniffImageMime(fake), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("每一种支持的图片类型都有对应的扩展名", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    assert.ok(imageExtensions[mime], `${mime} 缺少扩展名映射`);
  }
});

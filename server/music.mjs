// 本机音乐库：目录扫描、音频元数据 / 封面 / 歌词解析、HTTP Range 流式播放。
// 全部使用 Node 原生能力，不引入第三方依赖；解析结果按「路径 + 修改时间 + 体积」缓存。
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const audioExtensions = new Set([".mp3", ".m4a", ".aac", ".flac", ".wav", ".aif", ".aiff", ".ogg", ".opus", ".mp4"]);

const audioMimes = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
};

const maxTagBytes = 12 * 1024 * 1024;
const maxCacheEntries = 2000;
const maxCoverBytes = 4 * 1024 * 1024;

/** 缓存：绝对路径 → { key, meta, cover, lyrics }。key 变化（文件被改写）时自动失效。 */
const cache = new Map();

export function isAudioFile(file) {
  return audioExtensions.has(path.extname(file).toLowerCase());
}

export function audioMime(file) {
  return audioMimes[path.extname(file).toLowerCase()] || "application/octet-stream";
}

/** 目标路径必须位于给定目录内，防止越权读取目录外的文件。 */
export function insideDirectory(root, target) {
  if (!root || !target) return false;
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function clearMusicCache() {
  cache.clear();
}

/* ------------------------------------------------------------------ *
 * 目录扫描
 * ------------------------------------------------------------------ */

export async function scanDirectory(root, { maxFiles = 4000, maxDepth = 8 } = {}) {
  const files = [];
  const queue = [{ dir: root, depth: 0 }];
  let truncated = false;
  let error = null;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (reason) {
      // 权限被系统拒绝（例如 macOS 隐私保护）时要让调用方知道，而不是静默返回空列表。
      if (!error) error = reason.code || reason.message;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; break; }
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        files.push(full);
      }
    }
  }
  return { files, truncated, error };
}

/** 把扫描到的文件路径补全为带元数据的曲目列表。 */
export async function buildLibrary(root, options) {
  const { files, truncated, error } = await scanDirectory(root, options);
  const tracks = await mapLimit(files, 8, async (file, index) => {
    try {
      const info = await stat(file);
      const entry = await loadTrack(file, info);
      return {
        id: index,
        path: file,
        name: path.basename(file),
        relative: path.relative(root, file),
        folder: path.dirname(path.relative(root, file)) === "." ? "" : path.dirname(path.relative(root, file)),
        size: info.size,
        modifiedAt: info.mtimeMs,
        title: entry.meta.title,
        artist: entry.meta.artist,
        album: entry.meta.album,
        year: entry.meta.year,
        trackNumber: entry.meta.track,
        duration: entry.meta.duration,
        hasCover: Boolean(entry.cover),
        coverMime: entry.cover?.mime || null,
        hasLyrics: Boolean(entry.lyrics && entry.lyrics.lines.length),
        lyricsSource: entry.lyrics?.source || null,
        lyricsKind: entry.lyrics?.kind || null,
      };
    } catch {
      return null;
    }
  });
  return { tracks: tracks.filter(Boolean), truncated, error };
}

/* ------------------------------------------------------------------ *
 * 单曲解析（带缓存）
 * ------------------------------------------------------------------ */

export async function loadTrack(file, info = null) {
  const stats = info || await stat(file);
  const key = `${stats.mtimeMs}:${stats.size}`;
  const cached = cache.get(file);
  if (cached && cached.key === key) return cached;

  let parsed = { tags: {}, cover: null, lyrics: null };
  try {
    parsed = await parseFile(file, stats);
  } catch {
    parsed = { tags: {}, cover: null, lyrics: null };
  }

  const extension = path.extname(file).toLowerCase();
  const lrc = await readSidecarLyrics(file);
  const embedded = parsed.lyrics;
  const lyrics = lrc || embedded;

  const meta = {
    title: clean(parsed.tags.title) || path.basename(file, extension),
    artist: clean(parsed.tags.artist),
    album: clean(parsed.tags.album),
    year: clean(parsed.tags.year),
    track: clean(parsed.tags.track),
    genre: clean(parsed.tags.genre),
    duration: Number.isFinite(parsed.duration) && parsed.duration > 0 ? Math.round(parsed.duration * 1000) / 1000 : null,
  };

  const entry = { key, meta, cover: parsed.cover || null, lyrics: lyrics || null };
  cache.set(file, entry);
  if (cache.size > maxCacheEntries) {
    for (const oldest of cache.keys()) {
      cache.delete(oldest);
      if (cache.size <= maxCacheEntries * 0.8) break;
    }
  }
  return entry;
}

async function parseFile(file, stats) {
  const extension = path.extname(file).toLowerCase();
  const { buffer, tagLength } = await readTagArea(file, stats);
  if (!buffer.length) return { tags: {}, cover: null, lyrics: null, duration: null };

  if (extension === ".mp3" || buffer.toString("latin1", 0, 3) === "ID3") {
    const id3 = parseId3v2(buffer);
    const tags = { ...(id3?.tags || {}) };
    let duration = id3?.duration ?? null;
    const audioStart = id3?.end ?? 0;
    if (duration == null) duration = mp3Duration(buffer, audioStart, stats.size);
    if (!tags.title || !tags.artist) Object.assign(tags, await readId3v1(file, stats.size));
    if (!tags.title && !tags.artist) Object.assign(tags, guessFromName(file));
    return { tags, cover: id3?.cover || null, lyrics: id3?.lyrics || null, duration };
  }

  if (buffer.toString("latin1", 4, 8) === "ftyp" || extension === ".m4a" || extension === ".mp4" || extension === ".aac") {
    const mp4 = parseMp4(buffer);
    if (mp4) return { tags: mp4.tags, cover: mp4.cover, lyrics: mp4.lyrics, duration: mp4.duration };
  }

  if (buffer.toString("latin1", 0, 4) === "fLaC") {
    const flac = parseFlac(buffer);
    if (flac) return { tags: flac.tags, cover: flac.cover, lyrics: flac.lyrics, duration: flac.duration };
  }

  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WAVE") {
    return { tags: guessFromName(file), cover: null, lyrics: null, duration: parseWavDuration(buffer) };
  }

  return { tags: guessFromName(file), cover: null, lyrics: null, duration: null };
}

async function readTagArea(file, stats) {
  const handle = await open(file, "r");
  try {
    const head = await readBytes(handle, 0, Math.min(10, stats.size));
    let tagLength = 0;
    if (head.length >= 10 && head.toString("latin1", 0, 3) === "ID3") tagLength = syncSafeInt(head, 6) + 10;
    let want;
    if (tagLength) want = Math.min(stats.size, Math.min(tagLength, maxTagBytes) + 128 * 1024);
    else want = Math.min(stats.size, 512 * 1024);
    let buffer = await readBytes(handle, 0, want);
    // 少数编码器把 MP4 的 moov 放在文件尾部，头部找不到时补读一段尾部。
    if (buffer.length >= 8 && buffer.toString("latin1", 4, 8) === "ftyp" && !findBox(buffer, 0, buffer.length, "moov") && stats.size > buffer.length) {
      const tailStart = Math.max(0, stats.size - 1024 * 1024);
      const tail = await readBytes(handle, tailStart, stats.size - tailStart);
      buffer = Buffer.concat([buffer, tail]);
    }
    return { buffer, tagLength };
  } finally {
    await handle.close();
  }
}

async function readBytes(handle, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

async function readId3v1(file, size) {
  if (size < 128) return {};
  const handle = await open(file, "r");
  try {
    const buffer = await readBytes(handle, size - 128, 128);
    if (buffer.toString("latin1", 0, 3) !== "TAG") return {};
    return {
      title: decodeLatinOrGb(buffer.subarray(3, 33)),
      artist: decodeLatinOrGb(buffer.subarray(33, 63)),
      album: decodeLatinOrGb(buffer.subarray(63, 93)),
      year: decodeLatinOrGb(buffer.subarray(93, 97)),
    };
  } finally {
    await handle.close();
  }
}

function guessFromName(file) {
  const base = path.basename(file, path.extname(file));
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(" - ") };
  return { title: base };
}

function clean(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/* ------------------------------------------------------------------ *
 * 编码处理：中文老歌常见 GBK/GB18030，必须容错
 * ------------------------------------------------------------------ */

function decodeText(buffer, encoding) {
  if (!buffer?.length) return "";
  if (encoding === 3) return decodeUtf8(buffer);
  if (encoding === 1) {
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return decodeWith("utf-16be", buffer.subarray(2));
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return decodeWith("utf-16le", buffer.subarray(2));
    return decodeWith("utf-16le", buffer);
  }
  if (encoding === 2) return decodeWith("utf-16be", buffer);
  return decodeLatinOrGb(buffer);
}

function decodeWith(label, buffer) {
  try {
    return new TextDecoder(label).decode(buffer).replace(/\u0000+$/g, "");
  } catch {
    return buffer.toString("latin1");
  }
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\u0000+$/g, "");
  } catch {
    return decodeLatinOrGb(buffer);
  }
}

function decodeLatinOrGb(buffer) {
  const slice = buffer.subarray ? buffer : Buffer.from(buffer);
  if (!slice.some((byte) => byte >= 0x80)) return slice.toString("latin1").replace(/\u0000+$/g, "");
  // UTF-8 有严格的字节结构校验，先试它；合法的 GBK 文本几乎不可能通过 UTF-8 校验，反之不然。
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    if (!utf8.includes("\ufffd")) return utf8.replace(/\u0000+$/g, "");
  } catch { /* 不是合法 UTF-8，继续尝试 GBK */ }
  const gb = decodeWith("gb18030", slice);
  if (!gb.includes("\ufffd") && gb.trim()) return gb;
  return slice.toString("latin1").replace(/\u0000+$/g, "");
}

/* ------------------------------------------------------------------ *
 * ID3v2（MP3）
 * ------------------------------------------------------------------ */

function syncSafeInt(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21) | ((buffer[offset + 1] & 0x7f) << 14) | ((buffer[offset + 2] & 0x7f) << 7) | (buffer[offset + 3] & 0x7f);
}

function parseId3v2(buffer) {
  if (buffer.length < 10 || buffer.toString("latin1", 0, 3) !== "ID3") return null;
  const version = buffer[3];
  const flags = buffer[5];
  const size = syncSafeInt(buffer, 6);
  const end = Math.min(10 + size, buffer.length);
  let offset = 10;
  if (flags & 0x40) {
    if (version >= 4) offset += syncSafeInt(buffer, offset);
    else offset += 4 + buffer.readUInt32BE(offset);
  }
  const tags = {};
  let cover = null;
  const lyrics = { synced: null, unsynced: null };
  while (offset + 10 <= end) {
    const id = buffer.toString("latin1", offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = version >= 4 ? syncSafeInt(buffer, offset + 4) : buffer.readUInt32BE(offset + 4);
    if (frameSize <= 0 || offset + 10 + frameSize > end) break;
    const frame = buffer.subarray(offset + 10, offset + 10 + frameSize);
    const encoding = frame[0];
    const content = frame.subarray(1);
    if (id === "TIT2" || id === "TT2") tags.title = decodeText(content, encoding);
    else if (id === "TPE1" || id === "TP1") tags.artist = decodeText(content, encoding);
    else if (id === "TALB" || id === "TAL") tags.album = decodeText(content, encoding);
    else if (id === "TRCK" || id === "TRK") tags.track = decodeText(content, encoding);
    else if (id === "TCON" || id === "TCO") tags.genre = decodeText(content, encoding);
    else if (id === "TDRC" || id === "TYER" || id === "TYE" || id === "TDRL") tags.year = decodeText(content, encoding);
    else if (id === "APIC" || id === "PIC") cover = parseApic(content, encoding, id === "PIC") || cover;
    else if (id === "USLT" || id === "ULT") lyrics.unsynced = parseUslt(content, encoding) || lyrics.unsynced;
    else if (id === "SYLT" || id === "SLT") lyrics.synced = parseSylt(content, encoding) || lyrics.synced;
    offset += 10 + frameSize;
  }
  return { tags, cover, lyrics: buildLyrics(lyrics), duration: null, end: 10 + size };
}

function parseApic(content, encoding, legacy) {
  let offset = 0;
  let mime = "image/jpeg";
  if (legacy) {
    const format = content.toString("latin1", 0, 3).toUpperCase();
    mime = format === "PNG" ? "image/png" : "image/jpeg";
    offset = 3;
  } else {
    const stop = content.indexOf(0, 0);
    const raw = content.toString("latin1", 0, stop < 0 ? content.length : stop).trim().toLowerCase();
    if (raw.includes("png")) mime = "image/png";
    else if (raw.includes("webp")) mime = "image/webp";
    else if (raw.includes("gif")) mime = "image/gif";
    else mime = "image/jpeg";
    offset = (stop < 0 ? content.length : stop) + 1;
  }
  offset += 1; // picture type
  offset = skipEncodedString(content, offset, encoding);
  const data = content.subarray(offset);
  if (!data.length || data.length > maxCoverBytes) return null;
  return { mime, data };
}

function parseUslt(content, encoding) {
  let offset = 3; // language
  offset = skipEncodedString(content, offset, encoding);
  const text = decodeText(content.subarray(offset), encoding).trim();
  return text || null;
}

function parseSylt(content, encoding) {
  if (content.length < 6) return null;
  const timestampFormat = content[3];
  let offset = 5; // language(3) + timestamp format(1) + content type(1)
  offset = skipEncodedString(content, offset, encoding);
  const entries = [];
  while (offset < content.length) {
    const start = offset;
    const stop = findEncodedTerminator(content, offset, encoding);
    if (stop < 0) break;
    const text = decodeText(content.subarray(start, stop), encoding);
    offset = stop + (encoding === 1 || encoding === 2 ? 2 : 1);
    if (offset + 4 > content.length) break;
    const stamp = content.readUInt32BE(offset);
    offset += 4;
    const time = timestampFormat === 2 ? stamp / 1000 : stamp;
    if (text.trim()) entries.push({ time, text });
  }
  return entries.length ? entries : null;
}

function skipEncodedString(content, offset, encoding) {
  const stop = findEncodedTerminator(content, offset, encoding);
  if (stop < 0) return content.length;
  return stop + (encoding === 1 || encoding === 2 ? 2 : 1);
}

function findEncodedTerminator(content, offset, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let index = offset; index + 1 < content.length; index += 2) {
      if (content[index] === 0 && content[index + 1] === 0) return index;
    }
    return -1;
  }
  return content.indexOf(0, offset);
}

/** 把内嵌歌词统一成 { kind, source, lines } 结构。 */
function buildLyrics({ synced, unsynced }) {
  if (unsynced) {
    const parsed = parseLrc(unsynced);
    if (parsed.lines.length) return { kind: parsed.kind, source: "embedded", lines: parsed.lines };
    return null;
  }
  if (synced?.length) {
    return {
      kind: "line",
      source: "embedded-sync",
      lines: synced.map((entry) => ({ time: round(entry.time), text: entry.text, words: null })),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * MP3 时长（Xing / Info 头，回退 CBR 估算）
 * ------------------------------------------------------------------ */

const mpegVersions = { 3: { name: 1, sampleRates: [44100, 48000, 32000] }, 2: { name: 2, sampleRates: [22050, 24000, 16000] }, 0: { name: 2.5, sampleRates: [11025, 12000, 8000] } };
const mpegLayers = { 3: 1, 2: 2, 1: 3 };
const bitrateTables = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function parseFrameHeader(buffer, offset) {
  if (offset + 4 > buffer.length) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buffer[offset + 1] >> 3) & 0x03;
  const layerBits = (buffer[offset + 1] >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleIndex = (buffer[offset + 2] >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const version = mpegVersions[versionBits];
  const layer = mpegLayers[layerBits];
  const bitrate = (bitrateTables[`${version.name === 1 ? 1 : 2}-${layer}`] || [])[bitrateIndex];
  if (!bitrate) return null;
  const channelMode = (buffer[offset + 3] >> 6) & 0x03;
  const samples = layer === 1 ? 384 : layer === 2 ? 1152 : version.name === 1 ? 1152 : 576;
  return { version: version.name, layer, bitrate: bitrate * 1000, sampleRate: version.sampleRates[sampleIndex], channelMode, samples };
}

function mp3Duration(buffer, start, fileSize) {
  const limit = Math.min(buffer.length - 4, start + 256 * 1024);
  for (let offset = Math.max(0, start); offset < limit; offset += 1) {
    const header = parseFrameHeader(buffer, offset);
    if (!header) continue;
    const tagOffset = offset + (header.version === 1 ? (header.channelMode === 3 ? 17 : 32) : (header.channelMode === 3 ? 9 : 17));
    const tag = buffer.toString("latin1", tagOffset, tagOffset + 4);
    if (tag === "Xing" || tag === "Info") {
      const flags = buffer.readUInt32BE(tagOffset + 4);
      if (flags & 0x01) {
        const frames = buffer.readUInt32BE(tagOffset + 8);
        if (frames > 0) return (frames * header.samples) / header.sampleRate;
      }
    }
    if (header.bitrate > 0 && fileSize > start) return ((fileSize - start) * 8) / header.bitrate;
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * MP4 / M4A
 * ------------------------------------------------------------------ */

function* boxes(buffer, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    yield { type, start: offset + header, end: offset + size };
    offset += size;
  }
}

function findBox(buffer, start, end, type) {
  if (start >= end) return null;
  for (const box of boxes(buffer, start, end)) if (box.type === type) return box;
  return null;
}

function parseMp4(buffer) {
  const moov = findBox(buffer, 0, buffer.length, "moov");
  if (!moov) return null;
  const result = { tags: {}, cover: null, lyrics: null, duration: null };
  const mvhd = findBox(buffer, moov.start, moov.end, "mvhd");
  if (mvhd) {
    const version = buffer[mvhd.start];
    const timescale = version === 1 ? buffer.readUInt32BE(mvhd.start + 20) : buffer.readUInt32BE(mvhd.start + 12);
    const duration = version === 1 ? Number(buffer.readBigUInt64BE(mvhd.start + 24)) : buffer.readUInt32BE(mvhd.start + 16);
    if (timescale > 0 && duration > 0) result.duration = duration / timescale;
  }
  let ilst = null;
  const udta = findBox(buffer, moov.start, moov.end, "udta");
  if (udta) {
    const meta = findBox(buffer, udta.start, udta.end, "meta");
    if (meta) ilst = findBox(buffer, meta.start + 4, meta.end, "ilst");
  }
  if (!ilst) {
    const meta = findBox(buffer, moov.start, moov.end, "meta");
    if (meta) ilst = findBox(buffer, meta.start + 4, meta.end, "ilst");
  }
  if (!ilst) return result;
  const text = (payload) => decodeUtf8(payload);
  for (const item of boxes(buffer, ilst.start, ilst.end)) {
    const data = findBox(buffer, item.start, item.end, "data");
    if (!data || data.start + 8 > data.end) continue;
    const payload = buffer.subarray(data.start + 8, data.end);
    if (item.type === "\u00a9nam") result.tags.title = text(payload);
    else if (item.type === "\u00a9ART" || item.type === "aART") result.tags.artist = text(payload);
    else if (item.type === "\u00a9alb") result.tags.album = text(payload);
    else if (item.type === "\u00a9day") result.tags.year = text(payload);
    else if (item.type === "\u00a9gen") result.tags.genre = text(payload);
    else if (item.type === "\u00a9lyr") result.lyrics = parseMp4Lyrics(text(payload));
    else if (item.type === "trkn" && payload.length >= 4) result.tags.track = String(payload.readUInt16BE(2));
    else if (item.type === "covr" && !result.cover && payload.length && payload.length <= maxCoverBytes) {
      const kind = buffer.readUInt32BE(data.start) & 0x00ffffff;
      result.cover = { mime: kind === 14 ? "image/png" : kind === 13 ? "image/jpeg" : "image/jpeg", data: Buffer.from(payload) };
    }
  }
  return result;
}

function parseMp4Lyrics(value) {
  const parsed = parseLrc(value);
  if (parsed.lines.length) return { kind: parsed.kind, source: "embedded", lines: parsed.lines };
  return null;
}

/* ------------------------------------------------------------------ *
 * FLAC
 * ------------------------------------------------------------------ */

function parseFlac(buffer) {
  let offset = 4;
  const result = { tags: {}, cover: null, lyrics: null, duration: null };
  let lyricsText = null;
  while (offset + 4 <= buffer.length) {
    const header = buffer[offset];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    const start = offset + 4;
    const end = Math.min(start + length, buffer.length);
    if (type === 0 && start + 18 <= end) {
      const high = buffer.readUInt32BE(start + 10);
      const low = buffer.readUInt32BE(start + 14);
      const sampleRate = (high >>> 12) & 0xfffff;
      const totalSamples = (high & 0x0f) * 0x100000000 + low;
      if (sampleRate > 0 && totalSamples > 0) result.duration = totalSamples / sampleRate;
    } else if (type === 4) {
      Object.assign(result.tags, parseVorbisComment(buffer, start, end));
    } else if (type === 6) {
      const picture = parseFlacPicture(buffer, start, end);
      if (picture && !result.cover) result.cover = picture;
    }
    if (last) break;
    offset = end;
  }
  lyricsText = result.tags.lyrics || result.tags.unsyncedlyrics;
  delete result.tags.lyrics;
  delete result.tags.unsyncedlyrics;
  if (lyricsText) {
    const parsed = parseLrc(lyricsText);
    if (parsed.lines.length) result.lyrics = { kind: parsed.kind, source: "embedded", lines: parsed.lines };
  }
  return result;
}

function parseVorbisComment(buffer, start, end) {
  const tags = {};
  let offset = start;
  if (offset + 4 > end) return tags;
  const vendorLength = buffer.readUInt32LE(offset);
  offset += 4 + vendorLength;
  if (offset + 4 > end) return tags;
  const count = buffer.readUInt32LE(offset);
  offset += 4;
  for (let index = 0; index < count && offset + 4 <= end; index += 1) {
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    if (length < 0 || offset + length > end) break;
    const entry = buffer.toString("utf8", offset, offset + length);
    offset += length;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    if (!value) continue;
    if (key === "title") tags.title = value;
    else if (key === "artist") tags.artist = value;
    else if (key === "album") tags.album = value;
    else if (key === "date") tags.year = value;
    else if (key === "tracknumber") tags.track = value;
    else if (key === "genre") tags.genre = value;
    else if (key === "lyrics" || key === "unsyncedlyrics") tags.lyrics = value;
  }
  return tags;
}

function parseFlacPicture(buffer, start, end) {
  if (start + 8 > end) return null;
  const mimeLength = buffer.readUInt32BE(start + 4);
  let offset = start + 8 + mimeLength;
  if (offset + 4 > end) return null;
  const mime = buffer.toString("latin1", start + 8, start + 8 + mimeLength) || "image/jpeg";
  const descriptionLength = buffer.readUInt32BE(offset);
  offset += 4 + descriptionLength + 16;
  if (offset + 4 > end) return null;
  const dataLength = buffer.readUInt32BE(offset);
  offset += 4;
  if (dataLength <= 0 || offset + dataLength > end || dataLength > maxCoverBytes) return null;
  return { mime, data: Buffer.from(buffer.subarray(offset, offset + dataLength)) };
}

/* ------------------------------------------------------------------ *
 * WAV
 * ------------------------------------------------------------------ */

function parseWavDuration(buffer) {
  if (buffer.length < 12) return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("latin1", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 12 <= buffer.length) byteRate = buffer.readUInt32LE(start + 8);
    else if (id === "data") { dataSize = size; break; }
    offset = start + size + (size % 2);
  }
  if (byteRate > 0 && dataSize > 0) return dataSize / byteRate;
  return null;
}

/* ------------------------------------------------------------------ *
 * LRC 歌词解析（含增强 LRC 逐字时间戳）
 * ------------------------------------------------------------------ */

export function parseLrc(value) {
  const raw = typeof value === "string" ? value : "";
  const entries = [];
  let offsetSeconds = 0;
  const timeRe = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const meta = line.match(/^\[(ar|ti|al|by|offset|re|ve|length|au):([^\]]*)\]\s*$/i);
    if (meta) {
      if (meta[1].toLowerCase() === "offset") offsetSeconds = (Number(meta[2]) || 0) / 1000;
      continue;
    }
    const times = [];
    let cursor = 0;
    let match;
    while ((match = timeRe.exec(line.slice(cursor)))) {
      times.push(toSeconds(match));
      cursor += match[0].length;
    }
    if (!times.length) continue;
    const content = line.slice(cursor);
    const words = parseWordTags(content);
    const text = content.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").trim();
    if (!text && !words) continue;
    for (const time of times) {
      entries.push({ time: round(time), text, words: words ? words.map((word) => ({ time: round(word.time), text: word.text })) : null });
    }
  }
  entries.sort((left, right) => left.time - right.time);
  if (offsetSeconds) {
    for (const entry of entries) {
      entry.time = round(Math.max(0, entry.time - offsetSeconds));
      if (entry.words) for (const word of entry.words) word.time = round(Math.max(0, word.time - offsetSeconds));
    }
  }
  const kind = entries.some((entry) => entry.words?.length) ? "word" : "line";
  return { kind, lines: entries };
}

function parseWordTags(content) {
  const re = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  const marks = [];
  let match;
  while ((match = re.exec(content))) marks.push({ time: toSeconds(match), index: match.index, end: match.index + match[0].length });
  if (!marks.length) return null;
  const words = [];
  for (let index = 0; index < marks.length; index += 1) {
    const start = marks[index].end;
    const stop = index + 1 < marks.length ? marks[index + 1].index : content.length;
    const text = content.slice(start, stop);
    if (text) words.push({ time: marks[index].time, text });
  }
  return words.length ? words : null;
}

function toSeconds(match) {
  const minutes = Number(match[1]) || 0;
  const seconds = Number(match[2]) || 0;
  const fractionRaw = match[3] || "";
  const fraction = fractionRaw ? Number(`0.${fractionRaw}`) : 0;
  return minutes * 60 + seconds + fraction;
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * 同名 .lrc 歌词文件
 * ------------------------------------------------------------------ */

async function readSidecarLyrics(file) {
  const base = file.slice(0, file.length - path.extname(file).length);
  for (const candidate of [`${base}.lrc`, `${base}.LRC`]) {
    try {
      const info = await stat(candidate);
      if (!info.isFile() || info.size > 1024 * 1024) continue;
      const handle = await open(candidate, "r");
      try {
        const buffer = await readBytes(handle, 0, info.size);
        const text = decodeLyricFile(buffer);
        const parsed = parseLrc(text);
        if (parsed.lines.length) return { kind: parsed.kind, source: "lrc", lines: parsed.lines };
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
  }
  return null;
}

function decodeLyricFile(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return decodeWith("utf-8", buffer.subarray(3));
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return decodeWith("utf-16le", buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return decodeWith("utf-16be", buffer.subarray(2));
  return decodeLatinOrGb(buffer);
}

/* ------------------------------------------------------------------ *
 * HTTP 输出：封面、歌词、音频流
 * ------------------------------------------------------------------ */

export async function sendCover(response, file) {
  const entry = await loadTrack(file);
  if (!entry.cover) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    return response.end(JSON.stringify({ error: "没有内嵌封面" }));
  }
  response.writeHead(200, {
    "content-type": entry.cover.mime,
    "content-length": entry.cover.data.length,
    "cache-control": "private, max-age=86400",
  });
  response.end(entry.cover.data);
}

export async function sendLyrics(file) {
  const entry = await loadTrack(file);
  return entry.lyrics || { kind: "none", source: null, lines: [] };
}

export async function sendAudio(request, response, file) {
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error("音频文件不存在"), { status: 404 });
  const type = audioMime(file);
  const total = info.size;
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, {
      "content-type": type,
      "content-length": total,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=86400",
    });
    return pipeFile(file, response);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!match) {
    response.writeHead(416, { "content-range": `bytes */${total}` });
    return response.end();
  }
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null) {
    const suffix = end ?? 0;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    end = end === null ? total - 1 : Math.min(end, total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    response.writeHead(416, { "content-range": `bytes */${total}` });
    return response.end();
  }
  response.writeHead(206, {
    "content-type": type,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${total}`,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=86400",
  });
  return pipeFile(file, response, start, end);
}

function pipeFile(file, response, start = 0, end = undefined) {
  const stream = createReadStream(file, end === undefined ? { start } : { start, end });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

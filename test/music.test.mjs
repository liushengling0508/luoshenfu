import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { audioMime, buildLibrary, insideDirectory, isAudioFile, loadTrack, parseLrc, sendAudio, sendCover, scanDirectory } from "../server/music.mjs";

async function tempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/* ---------------- 合成音频文件构造工具 ---------------- */

function syncSafe(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function id3Frame(id, payload) {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function id3Text(text, encoding = 0) {
  const data = encoding === 0 ? Buffer.from(text, "latin1") : Buffer.from(text, "utf8");
  return id3Frame("TIT2", Buffer.concat([Buffer.from([encoding]), data]));
}

function id3Tag(frames, version = 3) {
  const body = Buffer.concat(frames);
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([version, 0, 0]), syncSafe(body.length)]);
  return Buffer.concat([header, body]);
}

function mp3Frame() {
  // MPEG1 Layer III / 128kbps / 44100Hz / stereo
  return Buffer.from([0xff, 0xfb, 0x90, 0x00]);
}

function textFrame(id, value, encoding = 3) {
  return id3Frame(id, Buffer.concat([Buffer.from([encoding]), Buffer.from(value, "utf8")]));
}

function apicFrame(bytes) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from("image/png\0", "latin1"), Buffer.from([3]), Buffer.from("\0", "latin1"), bytes]);
  return id3Frame("APIC", payload);
}

function usltFrame(text) {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from("chi", "latin1"), Buffer.from("\0", "latin1"), Buffer.from(text, "utf8")]);
  return id3Frame("USLT", payload);
}

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function mp4Data(value) {
  // data atom：typeIndicator(4) + locale(4) + payload
  const payload = Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), Buffer.from(value, "utf8")]);
  return box("data", payload);
}

function mp4File({ title, artist, cover }) {
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload.writeUInt32BE(1000, 12); // timescale
  mvhdPayload.writeUInt32BE(180000, 16); // duration → 180 秒
  const mvhd = box("mvhd", mvhdPayload);
  const items = [box("\u00a9nam", mp4Data(title)), box("\u00a9ART", mp4Data(artist))];
  if (cover) {
    const data = Buffer.concat([Buffer.from([0, 0, 0, 14]), Buffer.alloc(4), Buffer.from(cover)]);
    items.push(box("covr", box("data", data)));
  }
  const ilst = box("ilst", Buffer.concat(items));
  const meta = box("meta", Buffer.concat([Buffer.alloc(4), ilst]));
  const udta = box("udta", meta);
  const moov = box("moov", Buffer.concat([mvhd, udta]));
  return Buffer.concat([box("ftyp", Buffer.from("M4A isom", "latin1")), moov]);
}

function flacFile({ title, artist, sampleRate = 44100, totalSamples = 441000 }) {
  const streamInfo = Buffer.alloc(34);
  const high = (sampleRate << 12) | (1 << 9) | (15 << 4);
  streamInfo.writeUInt32BE(high >>> 0, 10);
  streamInfo.writeUInt32BE(totalSamples >>> 0, 14);
  const streamBlock = Buffer.concat([Buffer.from([0x00, 0, 0, 34]), streamInfo]);

  const comments = ["TITLE=" + title, "ARTIST=" + artist].map((entry) => {
    const value = Buffer.from(entry, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value.length, 0);
    return Buffer.concat([length, value]);
  });
  const vendor = Buffer.from("luoshenfu", "utf8");
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendor.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length, 0);
  const commentBody = Buffer.concat([vendorLength, vendor, count, ...comments]);
  const commentBlock = Buffer.concat([Buffer.from([0x84, 0, 0, commentBody.length]), commentBody]);
  return Buffer.concat([Buffer.from("fLaC", "latin1"), streamBlock, commentBlock]);
}

/* ---------------- 歌词解析 ---------------- */

test("普通 LRC 解析出行级时间轴", () => {
  const result = parseLrc("[ti:洛神赋]\n[00:12.34]翩若惊鸿\n[00:15.50]婉若游龙");
  assert.equal(result.kind, "line");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].time, 12.34);
  assert.equal(result.lines[0].text, "翩若惊鸿");
  assert.equal(result.lines[1].time, 15.5);
  assert.equal(result.lines[0].words, null);
});

test("增强 LRC 解析出逐字时间戳", () => {
  const result = parseLrc("[00:12.34]<00:12.34>洛<00:12.51>神<00:12.68>赋");
  assert.equal(result.kind, "word");
  assert.equal(result.lines[0].text, "洛神赋");
  assert.deepEqual(result.lines[0].words.map((word) => word.text), ["洛", "神", "赋"]);
  assert.equal(result.lines[0].words[1].time, 12.51);
});

test("一行多个时间标签展开为多条歌词", () => {
  const result = parseLrc("[00:10.00][01:20.00]重复的副歌");
  assert.equal(result.lines.length, 2);
  assert.deepEqual(result.lines.map((line) => line.time), [10, 80]);
});

test("offset 标签按毫秒提前歌词", () => {
  const result = parseLrc("[offset:500]\n[00:10.00]早半秒");
  assert.equal(result.lines[0].time, 9.5);
});

test("按时间排序并忽略元数据行", () => {
  const result = parseLrc("[ar:某人]\n[00:20.00]后\n[00:05.00]前");
  assert.deepEqual(result.lines.map((line) => line.text), ["前", "后"]);
});

/* ---------------- 工具函数 ---------------- */

test("音频扩展名与 MIME 识别", () => {
  assert.equal(isAudioFile("/tmp/a.MP3"), true);
  assert.equal(isAudioFile("/tmp/a.flac"), true);
  assert.equal(isAudioFile("/tmp/a.txt"), false);
  assert.equal(audioMime("/tmp/a.m4a"), "audio/mp4");
  assert.equal(audioMime("/tmp/a.flac"), "audio/flac");
});

test("目录穿越被 insideDirectory 拦截", () => {
  assert.equal(insideDirectory("/music", "/music/a/b.mp3"), true);
  assert.equal(insideDirectory("/music", "/music"), true);
  assert.equal(insideDirectory("/music", "/music-evil/a.mp3"), false);
  assert.equal(insideDirectory("/music", "/etc/passwd"), false);
});

/* ---------------- 目录扫描 ---------------- */

test("递归扫描只收集音频文件并忽略隐藏项", async () => {
  const root = await tempRoot("luoshenfu-music-scan-");
  try {
    await mkdir(path.join(root, "专辑"), { recursive: true });
    await mkdir(path.join(root, ".cache"), { recursive: true });
    await writeFile(path.join(root, "a.mp3"), "x");
    await writeFile(path.join(root, "专辑", "b.flac"), "x");
    await writeFile(path.join(root, "专辑", "cover.jpg"), "x");
    await writeFile(path.join(root, ".hidden.mp3"), "x");
    await writeFile(path.join(root, ".cache", "c.mp3"), "x");
    const { files } = await scanDirectory(root);
    assert.deepEqual(files.map((file) => path.relative(root, file)).sort(), ["a.mp3", "专辑/b.flac"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------- ID3v2 ---------------- */

test("解析 ID3v2 标题、艺术家、专辑、封面与内嵌歌词", async () => {
  const root = await tempRoot("luoshenfu-music-id3-");
  try {
    const file = path.join(root, "song.mp3");
    const coverBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const tag = id3Tag([
      textFrame("TIT2", "洛神赋"),
      textFrame("TPE1", "曹植"),
      textFrame("TALB", "魏晋"),
      apicFrame(coverBytes),
      usltFrame("[00:01.00]翩若惊鸿"),
    ]);
    await writeFile(file, Buffer.concat([tag, mp3Frame(), Buffer.alloc(4096)]));

    const entry = await loadTrack(file);
    assert.equal(entry.meta.title, "洛神赋");
    assert.equal(entry.meta.artist, "曹植");
    assert.equal(entry.meta.album, "魏晋");
    assert.equal(entry.cover.mime, "image/png");
    assert.deepEqual(entry.cover.data, coverBytes);
    assert.equal(entry.lyrics.kind, "line");
    assert.equal(entry.lyrics.lines[0].text, "翩若惊鸿");
    assert.equal(entry.lyrics.source, "embedded");
    assert.ok(entry.meta.duration > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GBK 编码的 ID3 文本可正确解码", async () => {
  const root = await tempRoot("luoshenfu-music-gbk-");
  try {
    const file = path.join(root, "gbk.mp3");
    // encoding=0 但内容是 GBK 的「你好」，这是中文老歌的常见情况。
    const frame = id3Frame("TIT2", Buffer.concat([Buffer.from([0]), Buffer.from([0xc4, 0xe3, 0xba, 0xc3])]));
    await writeFile(file, Buffer.concat([id3Tag([frame]), mp3Frame()]));
    const entry = await loadTrack(file);
    assert.equal(entry.meta.title, "你好");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("同名 .lrc 歌词优先于内嵌歌词", async () => {
  const root = await tempRoot("luoshenfu-music-lrc-");
  try {
    const file = path.join(root, "song.mp3");
    await writeFile(file, Buffer.concat([id3Tag([textFrame("TIT2", "歌"), usltFrame("[00:01.00]内嵌")]), mp3Frame()]));
    await writeFile(path.join(root, "song.lrc"), "[00:02.00]同名文件\n");
    const entry = await loadTrack(file);
    assert.equal(entry.lyrics.source, "lrc");
    assert.equal(entry.lyrics.lines[0].text, "同名文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------- MP4 / FLAC ---------------- */

test("解析 M4A 的标题、艺术家、时长与封面", async () => {
  const root = await tempRoot("luoshenfu-music-mp4-");
  try {
    const file = path.join(root, "song.m4a");
    await writeFile(file, mp4File({ title: "M4A 标题", artist: "歌手", cover: Buffer.from([1, 2, 3, 4]) }));
    const entry = await loadTrack(file);
    assert.equal(entry.meta.title, "M4A 标题");
    assert.equal(entry.meta.artist, "歌手");
    assert.equal(entry.meta.duration, 180);
    assert.equal(entry.cover.mime, "image/png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("解析 FLAC 的 Vorbis 注释与 STREAMINFO 时长", async () => {
  const root = await tempRoot("luoshenfu-music-flac-");
  try {
    const file = path.join(root, "song.flac");
    await writeFile(file, flacFile({ title: "FLAC 标题", artist: "歌手" }));
    const entry = await loadTrack(file);
    assert.equal(entry.meta.title, "FLAC 标题");
    assert.equal(entry.meta.artist, "歌手");
    assert.equal(entry.meta.duration, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------- 媒体库与 HTTP 输出 ---------------- */

test("buildLibrary 返回带元数据的曲目列表", async () => {
  const root = await tempRoot("luoshenfu-music-lib-");
  try {
    await writeFile(path.join(root, "one.mp3"), Buffer.concat([id3Tag([textFrame("TIT2", "第一首")]), mp3Frame()]));
    await mkdir(path.join(root, "子目录"), { recursive: true });
    await writeFile(path.join(root, "子目录", "two.flac"), flacFile({ title: "第二首", artist: "某人" }));
    const library = await buildLibrary(root);
    assert.equal(library.tracks.length, 2);
    const first = library.tracks.find((track) => track.name === "one.mp3");
    assert.equal(first.title, "第一首");
    assert.equal(first.folder, "");
    const second = library.tracks.find((track) => track.name === "two.flac");
    assert.equal(second.title, "第二首");
    assert.equal(second.folder, "子目录");
    assert.equal(second.hasCover, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("封面接口输出内嵌图片字节", async () => {
  const root = await tempRoot("luoshenfu-music-cover-");
  try {
    const file = path.join(root, "cover.mp3");
    const coverBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await writeFile(file, Buffer.concat([id3Tag([apicFrame(coverBytes)]), mp3Frame()]));
    const chunks = [];
    const response = { writeHead() {}, end(value) { chunks.push(value); } };
    await sendCover(response, file);
    assert.deepEqual(Buffer.concat(chunks), coverBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("音频接口支持 Range 请求返回 206", async () => {
  const root = await tempRoot("luoshenfu-music-range-");
  try {
    const file = path.join(root, "stream.mp3");
    const payload = Buffer.from("0123456789abcdefghij", "utf8");
    await writeFile(file, payload);
    const server = http.createServer((request, response) => { void sendAudio(request, response, file); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const full = await fetch(`http://127.0.0.1:${port}/`, {});
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("accept-ranges"), "bytes");
      assert.equal(await full.text(), payload.toString("utf8"));

      const partial = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: "bytes=0-3" } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get("content-range"), `bytes 0-3/${payload.length}`);
      assert.equal(await partial.text(), "0123");

      const suffix = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: "bytes=-4" } });
      assert.equal(suffix.status, 206);
      assert.equal(await suffix.text(), "ghij");

      const invalid = await fetch(`http://127.0.0.1:${port}/`, { headers: { range: "bytes=999-1000" } });
      assert.equal(invalid.status, 416);
    } finally {
      server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

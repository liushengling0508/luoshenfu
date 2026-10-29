// 所有 Git 操作统一走参数数组，绝不拼接 Shell 字符串，且始终使用 `--` 分隔路径。
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GIT = process.env.LUOSHENFU_GIT || "/usr/bin/git";
const MAX_DIFF_BYTES = 512 * 1024;
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "洛神赋快照",
  GIT_AUTHOR_EMAIL: "snapshot@luoshenfu.local",
  GIT_COMMITTER_NAME: "洛神赋快照",
  GIT_COMMITTER_EMAIL: "snapshot@luoshenfu.local",
};

function git(cwd, args, { timeout = 120_000, maxBuffer = 16 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(GIT, ["-C", cwd, ...args], { timeout, maxBuffer, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env } }, (error, stdout, stderr) => {
      if (error && error.code === "ENOENT") return reject(new Error("系统未找到 git 命令"));
      if (error) return reject(Object.assign(new Error((stderr || "").trim() || error.message), { stdout, stderr, status: error.code }));
      resolve({ stdout, stderr });
    });
  });
}

async function attempt(cwd, args, options) {
  try { const result = await git(cwd, args, options); return { ok: true, ...result }; }
  catch (error) { return { ok: false, stdout: error.stdout || "", stderr: (error.stderr || error.message || "").trim(), code: error.status }; }
}

export function resolveInside(root, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error("文件路径不能为空");
  if (candidate.includes("\0")) throw new Error("文件路径无效");
  const base = path.resolve(root);
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("文件不在任务工作区内，已拒绝操作");
  return resolved;
}

export async function isGitRepository(directory) {
  const result = await attempt(directory, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

export async function headCommit(directory) {
  const result = await attempt(directory, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
}

export async function isWorktreeDirty(directory) {
  const result = await attempt(directory, ["-c", "diff.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return result.ok ? result.stdout.length > 0 : false;
}

export function parseStatusZ(stdout) {
  const entries = [];
  const tokens = String(stdout || "").split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    entries.push({ index: code[0], worktree: code[1], path: entry.slice(3) });
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") index += 1;
  }
  return entries;
}

export function parseNumstatZ(stdout) {
  const stats = new Map();
  for (const record of String(stdout || "").split("\0")) {
    if (!record) continue;
    const [added, deleted, ...rest] = record.split("\t");
    const file = rest.join("\t");
    if (!file) continue;
    const binary = added === "-" || deleted === "-";
    stats.set(file, {
      additions: binary ? null : Number(added),
      deletions: binary ? null : Number(deleted),
      binary,
    });
  }
  return stats;
}

function classify(entry) {
  if (entry.index === "?" && entry.worktree === "?") return "untracked";
  if (entry.index === "A" || entry.worktree === "A") return "added";
  if (entry.index === "D" || entry.worktree === "D") return "deleted";
  return "modified";
}

export async function inspectChanges(directory, baseCommit) {
  if (!baseCommit) return { available: false, reason: "任务没有可用的基准提交，无法比较变更", files: [] };
  const status = await attempt(directory, ["-c", "diff.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return { available: false, reason: status.stderr || "无法读取 Git 状态", files: [] };
  const numstat = await attempt(directory, ["diff", "--numstat", "-z", "--no-renames", baseCommit]);
  const stats = numstat.ok ? parseNumstatZ(numstat.stdout) : new Map();
  const files = parseStatusZ(status.stdout).map((entry) => {
    const stat = stats.get(entry.path) || { additions: null, deletions: null, binary: false };
    return {
      path: entry.path,
      status: classify(entry),
      staged: entry.index !== " " && entry.index !== "?",
      unstaged: entry.worktree !== " " && entry.worktree !== "?",
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
    };
  });
  // 未跟踪文件不在 diff numstat 里，单独统计增删行数。
  await Promise.all(files.filter((file) => file.status === "untracked").map(async (file) => {
    const absolute = resolveInside(directory, file.path);
    const result = await attempt(directory, ["diff", "--no-index", "--numstat", "--", "/dev/null", absolute]);
    const match = result.stdout.match(/^(\d+|-)\t(\d+|-)\t/m);
    if (!match) return;
    file.binary = match[1] === "-";
    file.additions = match[1] === "-" ? null : Number(match[1]);
    file.deletions = match[2] === "-" ? null : Number(match[2]);
  }));
  return { available: true, baseCommit, files };
}

async function isTracked(directory, relativePath) {
  return (await attempt(directory, ["ls-files", "--error-unmatch", "--", relativePath])).ok;
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

export async function fileDiff(directory, baseCommit, relativePath) {
  resolveInside(directory, relativePath);
  const tracked = await isTracked(directory, relativePath);
  if (tracked) {
    const result = await attempt(directory, ["diff", "--no-color", "--unified=3", baseCommit, "--", relativePath]);
    return shapeDiff(result, relativePath, true);
  }
  // 未跟踪文件：在临时索引里用 intent-to-add 标记后生成 patch，路径保持相对，且不触碰真实索引。
  const indexFile = path.join(os.tmpdir(), `luoshenfu-diff-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(directory, ["read-tree", "HEAD"], { env });
    await git(directory, ["add", "-N", "--", relativePath], { env });
    const result = await attempt(directory, ["diff", "--no-color", "--unified=3", "--", relativePath], { env });
    return shapeDiff(result, relativePath, false);
  } finally {
    await unlink(indexFile).catch(() => {});
  }
}

function shapeDiff(result, relativePath, tracked) {
  const binary = /^Binary files /m.test(result.stdout) || result.stdout.includes("GIT binary patch");
  let diff = binary ? "" : result.stdout;
  let truncated = false;
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    diff = `${Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8").replace(/\uFFFD+$/u, "")}\n…（Diff 过大，已截断显示）`;
    truncated = true;
  }
  if (!tracked && !binary && !diff.trim()) diff = "";
  return { path: relativePath, tracked, binary, diff, truncated, error: !result.ok && !binary && !diff ? result.stderr : null };
}

// 在指定提交区间内比较文件差异，用于「按执行批次」查看某一次执行改了什么。
export async function rangeFileDiff(directory, fromCommit, toCommit, relativePath) {
  resolveInside(directory, relativePath);
  const result = await attempt(directory, ["diff", "--no-color", "--unified=3", fromCommit, toCommit, "--", relativePath]);
  return shapeDiff(result, relativePath, true);
}

// 用临时索引把当前工作区（含未跟踪文件）打成一个快照提交，不触碰工作区、真实索引或用户分支。
export async function snapshotWorktree(directory, parentCommit, refName = null) {
  const indexFile = path.join(os.tmpdir(), `luoshenfu-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile, ...SNAPSHOT_IDENTITY };
  try {
    const head = await attempt(directory, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.ok && head.stdout.trim()) await git(directory, ["read-tree", "HEAD"], { env });
    await git(directory, ["add", "-A", "--", "."], { env });
    const tree = (await git(directory, ["write-tree"], { env })).stdout.trim();
    if (!tree) throw new Error("无法写入快照树");
    const commit = (await git(directory, ["commit-tree", tree, "-p", parentCommit, "-m", "luoshenfu snapshot"], { env })).stdout.trim();
    if (refName) await attempt(directory, ["update-ref", refName, commit]);
    return commit;
  } finally {
    await unlink(indexFile).catch(() => {});
  }
}

export async function inspectRangeChanges(directory, fromCommit, toCommit) {
  const status = await attempt(directory, ["diff", "--name-status", "-z", "--no-renames", fromCommit, toCommit]);
  if (!status.ok) return { available: false, reason: status.stderr || "无法读取该批次的变更", files: [] };
  const numstat = await attempt(directory, ["diff", "--numstat", "-z", "--no-renames", fromCommit, toCommit]);
  const stats = numstat.ok ? parseNumstatZ(numstat.stdout) : new Map();
  const tokens = String(status.stdout || "").split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const code = tokens[index][0];
    const file = tokens[index + 1];
    const stat = stats.get(file) || { additions: null, deletions: null, binary: false };
    files.push({
      path: file,
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      staged: false, unstaged: false,
      additions: stat.additions, deletions: stat.deletions, binary: stat.binary,
    });
  }
  return { available: true, from: fromCommit, to: toCommit, files };
}

export async function deleteSnapshotRefs(projectDirectory, taskId) {
  const listed = await attempt(projectDirectory, ["for-each-ref", "--format=%(refname)", `refs/luoshenfu/snapshots/${taskId}/`]);
  if (!listed.ok) return 0;
  let removed = 0;
  for (const ref of listed.stdout.split("\n").map((item) => item.trim()).filter(Boolean)) {
    if (await attempt(projectDirectory, ["update-ref", "-d", ref]).then((result) => result.ok)) removed += 1;
  }
  return removed;
}

async function recycle(absolute, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try { await rename(absolute, destination); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    await copyFile(absolute, destination);
    await unlink(absolute);
  }
  return destination;
}

export async function restoreFiles(directory, baseCommit, relativePaths, { recycleRoot, taskId }) {
  if (!baseCommit) throw new Error("任务没有可用的基准提交，无法撤销变更");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  for (const relativePath of relativePaths) {
    const absolute = resolveInside(directory, relativePath);
    if (!await isTracked(directory, relativePath)) {
      if (!await exists(absolute)) { results.push({ path: relativePath, action: "missing" }); continue; }
      const target = await recycle(absolute, path.join(recycleRoot, taskId, stamp, relativePath));
      results.push({ path: relativePath, action: "recycled", recoveredTo: target });
      continue;
    }
    const inBase = (await attempt(directory, ["cat-file", "-e", `${baseCommit}:${relativePath}`])).ok;
    const restore = await attempt(directory, ["restore", `--source=${baseCommit}`, "--staged", "--worktree", "--", relativePath]);
    if (restore.ok) { results.push({ path: relativePath, action: inBase ? "restored" : "removed" }); continue; }
    if (!inBase) {
      await attempt(directory, ["rm", "--quiet", "--force", "--cached", "--", relativePath]);
      if (await exists(absolute)) {
        const target = await recycle(absolute, path.join(recycleRoot, taskId, stamp, relativePath));
        results.push({ path: relativePath, action: "recycled", recoveredTo: target });
      } else results.push({ path: relativePath, action: "un-staged" });
      continue;
    }
    results.push({ path: relativePath, action: "failed", error: restore.stderr || "git restore 失败" });
  }
  return results;
}

export function runGit(cwd, args, options) { return git(cwd, args, options); }
export function tryGit(cwd, args, options) { return attempt(cwd, args, options); }
export { GIT };

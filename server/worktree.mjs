// Worktree 隔离：每个根任务一个独立工作树，流程任务与后续对话复用同一个工作树。
// 创建失败、非 Git 仓库或缺少 HEAD 时明确降级，绝不假装已隔离，也绝不写入原项目目录。
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { headCommit, isGitRepository, isWorktreeDirty, tryGit } from "./git.mjs";

const BRANCH_PATTERN = /^luoshenfu\/task-\d+-[0-9a-z]{8}$/;

// 任务级选择优先，其次使用全局默认；三态：true=隔离、false=直接、undefined=跟随默认。
export function resolveWorktreeMode(requested, defaultEnabled = true) {
  if (requested === true) return "isolate";
  if (requested === false) return "direct";
  return defaultEnabled ? "isolate" : "direct";
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function samePath(left, right) {
  try { return (await realpath(left)) === (await realpath(right)); }
  catch { return path.resolve(left) === path.resolve(right); }
}

export class WorktreeManager {
  constructor({ store, dataDirectory }) {
    this.store = store;
    this.dataDirectory = path.resolve(dataDirectory);
    this.locks = new Map();
  }

  owner(task) {
    if (!task) return null;
    if (task.root_id) return this.store.task(task.root_id) || task;
    return task;
  }

  branchFor(task) {
    const short = String(task.id).replace(/[^0-9a-z]/gi, "").toLowerCase().slice(0, 8) || "00000000";
    const branch = `luoshenfu/task-${Number(task.number)}-${short}`;
    if (!BRANCH_PATTERN.test(branch)) throw new Error("生成的 Worktree 分支名不合法");
    return branch;
  }

  directoryFor(task) {
    return path.join(this.dataDirectory, "worktrees", String(task.project_id), String(task.id));
  }

  // 任务真正可用的工作目录：Worktree 生效时指向工作树，否则回退到原项目目录。
  workspaceFor(task) {
    const owner = this.owner(task) || task;
    if (owner.worktree_status === "active" && owner.worktree_path && path.isAbsolute(owner.worktree_path)) return owner.worktree_path;
    return task.workspace || this.store.project(task.project_id)?.workspace || task.workspace;
  }

  async prepare(task) {
    const owner = this.owner(task) || task;
    if (this.locks.has(owner.id)) return this.locks.get(owner.id);
    const work = this.#prepare(owner).finally(() => this.locks.delete(owner.id));
    this.locks.set(owner.id, work);
    return work;
  }

  #workspaceOf(task) {
    if (task.workspace) return path.resolve(task.workspace);
    const project = this.store.project(task.project_id);
    if (!project?.workspace) throw new Error("任务缺少可用的项目目录");
    return path.resolve(project.workspace);
  }

  async #prepare(owner) {
    if (owner.kind && owner.kind !== "task") return this.#persist(owner, { status: "unavailable", note: "项目会话不启用 Worktree 隔离" });
    if (owner.worktree_mode === "direct") {
      const note = "你选择了直接使用原项目目录";
      this.store.setWorktreeStatus(owner.id, "disabled", note);
      return { taskId: owner.id, status: "disabled", path: null, branch: owner.worktree_branch || null, baseCommit: owner.base_commit || null, note };
    }
    const workspace = this.#workspaceOf(owner);
    if (!await isGitRepository(workspace)) return this.#persist(owner, { status: "unavailable", note: "原项目不是 Git 仓库，未启用 Worktree 隔离" });
    const currentHead = await headCommit(workspace);
    if (!currentHead) return this.#persist(owner, { status: "unavailable", note: "仓库还没有可用提交（HEAD），未启用 Worktree 隔离" });
    // 复用任务最初记录的基准提交，保证「相对任务基准的变更」在多次启用/禁用后仍然一致。
    const baseCommit = owner.base_commit || currentHead;
    const directory = this.directoryFor(owner);
    const branch = owner.worktree_branch || this.branchFor(owner);
    const dirty = await isWorktreeDirty(workspace);
    const note = dirty ? "原项目未提交的修改不会自动带入 Worktree" : null;

    if (owner.worktree_status === "active" && owner.worktree_path && await samePath(owner.worktree_path, directory) && await this.#isWorktree(directory)) {
      return this.#persist(owner, { status: "active", path: directory, branch, baseCommit, note });
    }
    if (await exists(directory)) return this.#persist(owner, { status: "unavailable", note: `Worktree 目录已存在但不是有效工作树：${directory}`, branch, baseCommit });

    const branchExists = (await tryGit(workspace, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    const added = branchExists
      ? await tryGit(workspace, ["worktree", "add", directory, branch])
      : await tryGit(workspace, ["worktree", "add", "-b", branch, directory, baseCommit]);
    if (!added.ok) return this.#persist(owner, { status: "unavailable", note: `创建 Worktree 失败：${added.stderr || "未知错误"}`, branch, baseCommit });
    if (!await this.#isWorktree(directory)) return this.#persist(owner, { status: "unavailable", note: "Worktree 创建后校验失败，未启用隔离", branch, baseCommit });
    return this.#persist(owner, { status: "active", path: directory, branch, baseCommit, note });
  }

  async #isWorktree(directory) {
    if (!await exists(directory)) return false;
    const top = await tryGit(directory, ["rev-parse", "--show-toplevel"]);
    return top.ok && await samePath(top.stdout.trim(), directory);
  }

  async remove(task) {
    const owner = this.owner(task) || task;
    if (!owner.worktree_path) throw new Error("当前任务没有可移除的 Worktree");
    const directory = path.resolve(owner.worktree_path);
    const root = `${this.dataDirectory}${path.sep}`;
    if (!directory.startsWith(root)) throw new Error("Worktree 路径不在应用数据目录内，已拒绝删除");
    if (await exists(directory)) {
      if (await isWorktreeDirty(directory)) throw new Error("Worktree 中仍有未撤销的变更，已拒绝删除；请先在“变更”页撤销全部变更");
      const removed = await tryGit(this.#workspaceOf(owner), ["worktree", "remove", directory]);
      if (!removed.ok) throw new Error(`移除 Worktree 失败：${removed.stderr || "未知错误"}`);
    }
    await tryGit(this.#workspaceOf(owner), ["worktree", "prune"]);
    return this.#persist(owner, { status: "removed", branch: owner.worktree_branch, baseCommit: owner.base_commit, note: "Worktree 已移除" });
  }

  snapshot(task) {
    const owner = this.owner(task) || task;
    return {
      status: owner.worktree_status || "unavailable",
      path: owner.worktree_path || null,
      branch: owner.worktree_branch || null,
      baseCommit: owner.base_commit || null,
      note: owner.worktree_note || null,
    };
  }

  #persist(owner, info) {
    this.store.setWorktree(owner.id, {
      worktree_path: info.path || null,
      worktree_branch: info.branch || null,
      base_commit: info.baseCommit || null,
      worktree_status: info.status,
      worktree_note: info.note || null,
    });
    return { taskId: owner.id, status: info.status, path: info.path || null, branch: info.branch || null, baseCommit: info.baseCommit || null, note: info.note || null };
  }
}

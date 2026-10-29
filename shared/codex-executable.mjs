// Adapted from Codex Taskboard (Apache-2.0), commit 2a6970a2.
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function executable(candidate) {
  try { accessSync(candidate, constants.X_OK); return candidate; } catch { return null; }
}

// 官方 ChatGPT / Codex App 在不同版本里换过内置 codex 的位置：
// 旧版是 Resources/codex，新版改为 Resources/codex-cli/bin/codex（真正的二进制在 CodexCLI.app 内）。
function appCandidates(application, root) {
  const resources = path.join(root, application, "Contents", "Resources");
  return [
    path.join(resources, "codex"),
    path.join(resources, "codex-cli", "bin", "codex"),
    path.join(resources, "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
  ];
}

export function codexExecutableCandidates(env = process.env, home = os.homedir(), roots = ["/Applications", path.join(home, "Applications")]) {
  const candidates = [];
  for (const application of ["ChatGPT.app", "Codex.app"]) {
    for (const root of roots) {
      candidates.push(...appCandidates(application, root));
    }
  }
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, "codex"));
  }
  return candidates;
}

export function resolveCodexExecutable(env = process.env, home = os.homedir(), roots) {
  if (env.CODEX_EXECUTABLE?.trim()) return env.CODEX_EXECUTABLE.trim();
  for (const candidate of codexExecutableCandidates(env, home, roots)) {
    const found = executable(candidate);
    if (found) return found;
  }
  return "codex";
}

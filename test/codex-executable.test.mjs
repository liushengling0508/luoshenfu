import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexExecutableCandidates, resolveCodexExecutable } from "../shared/codex-executable.mjs";

test("候选路径覆盖 ChatGPT.app 新旧两种 codex 布局", () => {
  const candidates = codexExecutableCandidates({ PATH: "/usr/bin:/bin" }, "/Users/example");
  assert.ok(candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex"));
  assert.ok(candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"));
  assert.ok(candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
  assert.ok(candidates.includes("/Users/example/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex"));
  assert.ok(candidates.includes("/usr/bin/codex"));
});

test("新版 ChatGPT.app 把 codex 放进 codex-cli/bin 时仍能找到", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-codex-"));
  try {
    const binary = path.join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o755);
    assert.equal(resolveCodexExecutable({ PATH: "" }, os.homedir(), [root]), binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧版 Resources/codex 仍优先，显式 CODEX_EXECUTABLE 最优先", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-codex-"));
  try {
    const legacy = path.join(root, "Codex.app", "Contents", "Resources", "codex");
    const current = path.join(root, "Codex.app", "Contents", "Resources", "codex-cli", "bin", "codex");
    for (const binary of [legacy, current]) {
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, "#!/bin/sh\nexit 0\n");
      await chmod(binary, 0o755);
    }
    assert.equal(resolveCodexExecutable({ PATH: "" }, os.homedir(), [root]), legacy);
    assert.equal(resolveCodexExecutable({ PATH: "", CODEX_EXECUTABLE: "/custom/codex" }, os.homedir(), [root]), "/custom/codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("完全找不到时保留 PATH 兜底命令", () => {
  assert.equal(resolveCodexExecutable({ PATH: "" }, "/nonexistent-home", []), "codex");
});

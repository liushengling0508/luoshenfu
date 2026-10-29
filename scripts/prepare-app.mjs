import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeVersion = "24.21.0";
const archiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
const archiveSha256 = "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, "dist/runtime-cache");
const archive = path.join(cache, archiveName);
const extracted = path.join(cache, `node-v${nodeVersion}-darwin-arm64`);
const binary = path.join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const resources = path.join(root, "src-tauri/resources/app");

async function exists(file) { try { await stat(file); return true; } catch { return false; } }
async function sha256(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
function run(command, args, options = {}) { const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options }); if (result.status !== 0) throw new Error(result.stderr || `${command} failed`); }

await mkdir(cache, { recursive: true });
if (!(await exists(archive)) || await sha256(archive) !== archiveSha256) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`);
  if (!response.ok) throw new Error(`Node.js download failed: ${response.status}`);
  const temporary = `${archive}.download`;
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  await rename(temporary, archive);
}
if (await sha256(archive) !== archiveSha256) throw new Error("Node.js archive checksum mismatch");
if (!(await exists(path.join(extracted, "bin/node")))) run("/usr/bin/tar", ["-xzf", archive, "-C", cache]);
await mkdir(path.dirname(binary), { recursive: true });
const sourceNode = path.join(extracted, "bin/node");
if (!(await exists(binary)) || await sha256(binary) !== await sha256(sourceNode)) {
  const nextBinary = `${binary}.new`;
  await copyFile(sourceNode, nextBinary);
  await chmod(nextBinary, 0o755);
  await rename(nextBinary, binary);
}

if (!process.argv.includes("--runtime-only")) {
  await rm(resources, { recursive: true, force: true });
  await mkdir(resources, { recursive: true });
  await Promise.all([
    cp(path.join(root, "server"), path.join(resources, "server"), { recursive: true }),
    cp(path.join(root, "shared"), path.join(resources, "shared"), { recursive: true }),
    copyFile(path.join(root, "package.json"), path.join(resources, "package.json")),
    copyFile(path.join(root, "package-lock.json"), path.join(resources, "package-lock.json")),
    copyFile(path.join(root, "LICENSE"), path.join(resources, "LICENSE")),
    copyFile(path.join(root, "NOTICE"), path.join(resources, "NOTICE")),
  ]);
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: resources });
  await mkdir(path.join(resources, "licenses"), { recursive: true });
  await copyFile(path.join(extracted, "LICENSE"), path.join(resources, "licenses/Node-LICENSE"));
  await copyFile(path.join(resources, "node_modules/@deepseek-ai/dsh/LICENSE"), path.join(resources, "licenses/Deepseek-Harness-LICENSE"));
}
console.log(`Prepared Node.js ${nodeVersion} arm64${process.argv.includes("--runtime-only") ? "" : " and app resources"}`);

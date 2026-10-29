import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = path.join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
if (!existsSync(node)) {
  const prepared = spawnSync(process.execPath, [path.join(root, "scripts/prepare-app.mjs"), "--runtime-only"], { cwd: root, stdio: "inherit" });
  if (prepared.status !== 0) process.exit(prepared.status || 1);
}
const server = spawn(node, [path.join(root, "server/index.mjs"), "--dev"], {
  cwd: root,
  env: { ...process.env, LUOSHENFU_PORT: "47844", LUOSHENFU_TOKEN: "dev-token", LUOSHENFU_DATA_DIR: path.join(root, ".data-dev"), LUOSHENFU_RESOURCE_DIR: root },
  stdio: "inherit",
});
const web = spawn("npm", ["run", "dev:web"], { cwd: root, stdio: "inherit" });
const stop = () => { server.kill("SIGTERM"); web.kill("SIGTERM"); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.once("exit", (code) => { web.kill("SIGTERM"); process.exit(code || 0); });
web.once("exit", (code) => { server.kill("SIGTERM"); process.exit(code || 0); });

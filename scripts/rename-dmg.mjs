import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "src-tauri/target/aarch64-apple-darwin/release/bundle/dmg");
const source = path.join(directory, "洛神赋_1.0.2_aarch64.dmg");
const destination = path.join(directory, "洛神赋_1.0.2_arm64.dmg");
try { await stat(source); await rename(source, destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
console.log(destination);

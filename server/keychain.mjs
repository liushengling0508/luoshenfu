import { spawn } from "node:child_process";

// Deepseek 支持多账号：service 不变，用 keychain 的 account 字段区分账号（值为账号 UUID）。
// 历史版本只有一个固定 account "api-key"，迁移时会被读出来搬进新账号，然后删除。
export const LEGACY_ACCOUNT = "api-key";
const SERVICES = {
  deepseek: "com.lochacha.luoshenfu.deepseek",
  workbench: "com.lochacha.luoshenfu.workbench",
};

function security(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `security exited ${code}`)));
  });
}

async function saveKey(service, account, key) {
  await security(["add-generic-password", "-U", "-s", service, "-a", account, "-w", key]);
}

async function readKey(service, account) {
  try { return await security(["find-generic-password", "-s", service, "-a", account, "-w"]); }
  catch { return null; }
}

async function deleteKey(service, account) {
  try { await security(["delete-generic-password", "-s", service, "-a", account]); } catch {}
}

export const saveDeepseekKey = (key, account) => saveKey(SERVICES.deepseek, account || LEGACY_ACCOUNT, key);
export const readDeepseekKey = (account) => readKey(SERVICES.deepseek, account || LEGACY_ACCOUNT);
export const deleteDeepseekKey = (account) => deleteKey(SERVICES.deepseek, account || LEGACY_ACCOUNT);

export const saveWorkbenchKey = (key) => saveKey(SERVICES.workbench, LEGACY_ACCOUNT, key);
export const readWorkbenchKey = () => readKey(SERVICES.workbench, LEGACY_ACCOUNT);
export const deleteWorkbenchKey = () => deleteKey(SERVICES.workbench, LEGACY_ACCOUNT);

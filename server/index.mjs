import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Store } from "./database.mjs";
import { Runner, supportedLanguages } from "./runner.mjs";
import { deleteDeepseekKey, deleteWorkbenchKey, readDeepseekKey, readWorkbenchKey, saveDeepseekKey, saveWorkbenchKey } from "./keychain.mjs";
import { WorkbenchSync, WORKBENCH_MEMBERS, parseWorkbenchMembers } from "./workbench.mjs";
import { useComputer } from "./computer.mjs";
import { openArguments } from "./open-target.mjs";
import { fileDiff, inspectChanges, inspectRangeChanges, rangeFileDiff, restoreFiles } from "./git.mjs";
import { resolveWorktreeMode } from "./worktree.mjs";
import { buildLibrary, clearMusicCache, insideDirectory, isAudioFile, sendAudio, sendCover, sendLyrics } from "./music.mjs";
import { imageFileName, sniffImageMime } from "./media.mjs";
import { ask, askStream, defaultModel, supportedModels } from "./assistant.mjs";
import { defaultVoice, isSpeaking, listChineseVoices, speak, stopSpeaking } from "./speech.mjs";

// 本地 sidecar 的可用性优先：未捕获的异常/拒绝只记录，不让 Node 按默认策略直接退出。
// 历史上一次未处理的 Promise 拒绝就让整个本地服务消失，界面所有请求都变成 Load failed，只能重开 App。
// uncaughtException 后继续运行通常有风险，但对本地服务来说「带病活着」远好过「直接消失」。
process.on("unhandledRejection", (reason) => {
  console.error(`[luoshenfu] 未处理的 Promise 拒绝：${reason?.stack || reason}`);
});
process.on("uncaughtException", (error) => {
  console.error(`[luoshenfu] 未捕获异常：${error?.stack || error}`);
});

const development = process.argv.includes("--dev");
const port = Number(process.env.LUOSHENFU_PORT || 47844);
const token = process.env.LUOSHENFU_TOKEN || (development ? "dev-token" : "");
if (!token) throw new Error("LUOSHENFU_TOKEN is required");
const dataDirectory = path.resolve(process.env.LUOSHENFU_DATA_DIR || path.join(process.cwd(), ".data-dev"));
const resourceDirectory = path.resolve(process.env.LUOSHENFU_RESOURCE_DIR || process.cwd());
const store = new Store(dataDirectory, { secrets: [token] });
const clients = new Set();
const baseUrl = `http://127.0.0.1:${port}`;
const workbench = new WorkbenchSync({ store, readKey: readWorkbenchKey, onPulled(result) {
  if (result.taskIds.length) void preparePulledWorktrees(result.taskIds);
  broadcast("changed", {});
} });
const broadcast = (type, data) => {
  const wire = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(wire);
  workbench.kick();
};
const runner = new Runner({ store, dataDirectory, resourceDirectory, token, baseUrl, broadcast });

const server = http.createServer(async (request, response) => {
  setCors(request, response);
  if (request.method === "OPTIONS") return response.writeHead(204).end();
  const url = new URL(request.url, baseUrl);
  if (url.pathname === "/health") return json(response, 200, { ok: true });
  if (!authorized(request, url)) return json(response, 401, { error: "未授权的本地请求" });

  try {
    if (request.method === "GET" && url.pathname === "/api/events") return openEvents(request, response);
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      const projectId = url.searchParams.get("projectId");
      return json(response, 200, { projects: store.projects(), tasks: store.tasks(projectId, false), chats: [], archivedTotal: store.archiveCount(projectId), unreadActivities: store.unreadActivityCount() });
    }
    if (request.method === "GET" && url.pathname === "/api/chats") {
      const projectId = text(url.searchParams.get("projectId"), "项目", 100);
      required(store.project(projectId), "项目不存在");
      return json(response, 200, store.chatPage(projectId, Number(url.searchParams.get("page") || 1)));
    }
    if (request.method === "GET" && url.pathname === "/api/archives") {
      const projectId = text(url.searchParams.get("projectId"), "项目", 100);
      required(store.project(projectId), "项目不存在");
      return json(response, 200, store.archivePage(projectId, Number(url.searchParams.get("page") || 1), url.searchParams.get("query") || ""));
    }
    if (request.method === "GET" && url.pathname === "/api/settings") return json(response, 200, await runner.accountSnapshot());
    if (request.method === "POST" && url.pathname === "/api/settings/language") return json(response, 200, setLanguage(await body(request)));
    if (request.method === "POST" && url.pathname === "/api/settings/notifications") return json(response, 200, setSystemNotifications(await body(request)));
    if (request.method === "POST" && url.pathname === "/api/settings/worktree") return json(response, 200, setWorktreeEnabled(await body(request)));

    // ---- 本机音乐播放器 ----
    if (request.method === "GET" && url.pathname === "/api/music/settings") return json(response, 200, await musicSettings());
    if (request.method === "POST" && url.pathname === "/api/music/settings") return json(response, 200, await setMusicSettings(await body(request)));
    if (request.method === "GET" && url.pathname === "/api/music/library") return json(response, 200, await musicLibrary());
    // 这里必须 await：handler 是 async 但 createServer 不等待它，
    // 少一个 await 就会让 reject 绕过下面的 try/catch，直接杀掉整个本地服务进程。
    if (request.method === "GET" && url.pathname === "/api/music/stream") return await sendAudio(request, response, await musicFile(url.searchParams.get("path")));
    if (request.method === "GET" && url.pathname === "/api/music/cover") return await sendCover(response, await musicFile(url.searchParams.get("path")));
    if (request.method === "GET" && url.pathname === "/api/music/lyrics") return json(response, 200, await sendLyrics(await musicFile(url.searchParams.get("path"))));
    if (request.method === "GET" && url.pathname === "/api/music/playlists") return json(response, 200, store.musicPlaylists());
    if (request.method === "POST" && url.pathname === "/api/music/playlists") return json(response, 201, store.createMusicPlaylist(text((await body(request)).name, "歌单名称", 100)));
    let musicMatch = url.pathname.match(/^\/api\/music\/playlists\/([^/]+)$/);
    if (musicMatch && request.method === "PATCH") { required(store.musicPlaylist(musicMatch[1]), "歌单不存在"); return json(response, 200, store.renameMusicPlaylist(musicMatch[1], text((await body(request)).name, "歌单名称", 100))); }
    if (musicMatch && request.method === "DELETE") { required(store.musicPlaylist(musicMatch[1]), "歌单不存在"); store.deleteMusicPlaylist(musicMatch[1]); return json(response, 200, { ok: true }); }
    musicMatch = url.pathname.match(/^\/api\/music\/playlists\/([^/]+)\/items$/);
    if (musicMatch && request.method === "POST") return json(response, 200, addMusicItems(musicMatch[1], await body(request)));
    if (musicMatch && request.method === "DELETE") return json(response, 200, removeMusicItem(musicMatch[1], await body(request, true)));
    musicMatch = url.pathname.match(/^\/api\/music\/playlists\/([^/]+)\/order$/);
    if (musicMatch && request.method === "POST") return json(response, 200, orderMusicItems(musicMatch[1], await body(request)));

    if (request.method === "GET" && url.pathname === "/api/activities") return json(response, 200, store.activities(Number(url.searchParams.get("page") || 1)));
    if (request.method === "POST" && url.pathname === "/api/activities/read-all") { const changed = store.readAllActivities(); broadcast("changed", {}); return json(response, 200, { ok: true, changed }); }
    if (request.method === "POST" && url.pathname === "/api/activities/clear-read") { const changed = store.clearReadActivities(); broadcast("changed", {}); return json(response, 200, { ok: true, changed }); }
    const activityMatch = url.pathname.match(/^\/api\/activities\/([^/]+)\/read$/);
    if (activityMatch && request.method === "POST") { required(store.readActivity(activityMatch[1]), "活动不存在"); broadcast("changed", {}); return json(response, 200, { ok: true }); }
    if (request.method === "POST" && url.pathname === "/api/open-target") {
      const input = await body(request);
      if (input.app === "terminal") {
        const requested = text(input.target, "打开目标", 8192);
        if (!path.isAbsolute(requested)) throw new Error("只支持本地绝对路径");
        const directory = path.resolve(requested);
        if (!(await stat(directory)).isDirectory()) throw new Error("终端目录不存在");
        spawn("/usr/bin/open", ["-a", "Terminal", directory], { detached: true, stdio: "ignore" }).unref();
        return json(response, 200, { ok: true });
      }
      if (input.app === "notification-settings") {
        // macOS 一旦拒绝通知授权就不会再次弹窗，只能把用户送到系统设置的「通知」面板。
        // 优先定位到本应用，旧版本系统再逐级降级为通用通知面板。
        const bundleId = process.env.LUOSHENFU_BUNDLE_ID || "com.lochacha.luoshenfu";
        const candidates = [
          `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`,
          "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
          "x-apple.systempreferences:com.apple.preference.notifications",
        ];
        if (!candidates.some((target) => spawnSync("/usr/bin/open", [target], { stdio: "ignore" }).status === 0)) throw new Error("无法打开系统通知设置，请手动前往「系统设置 → 通知」");
        return json(response, 200, { ok: true });
      }
      const args = openArguments(input.target);
      if (args[0] === "-R") await stat(args[1]);
      spawn("/usr/bin/open", args, { detached: true, stdio: "ignore" }).unref();
      return json(response, 200, { ok: true });
    }
    // ---- 贾维斯：日常问答与语音播报 ----
    // 问答直接调 Deepseek，不经过 runner；播报用系统 say，全程离线且不消耗额度。
    if (request.method === "POST" && url.pathname === "/api/assistant/ask") {
      const input = await body(request);
      return json(response, 200, await ask(
        text(input.question, "问题", 4000),
        Array.isArray(input.history) ? input.history : [],
        typeof input.model === "string" ? input.model : undefined,
        store.activeDeepseekAccountId(),
      ));
    }
    if (request.method === "GET" && url.pathname === "/api/assistant/models") return json(response, 200, { models: supportedModels, default: defaultModel });
    // 流式问答：正文增量与工具调用实时下发，贾维斯可以边生成边播报，不用等整段写完。
    if (request.method === "POST" && url.pathname === "/api/assistant/stream") {
      const input = await body(request);
      let question;
      try {
        question = text(input.question, "问题", 4000);
      } catch (error) {
        return json(response, 400, { error: error.message });
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (type, data) => {
        if (response.writableEnded) return;
        try { response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端已断开 */ }
      };
      try {
        const result = await askStream(
          question,
          Array.isArray(input.history) ? input.history : [],
          typeof input.model === "string" ? input.model : undefined,
          store.activeDeepseekAccountId(),
          send,
        );
        send("done", { answer: result.answer, model: result.model, tools: result.tools });
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : String(error) });
      } finally {
        response.end();
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/speech/speak") {
      const input = await body(request);
      return json(response, 200, await speak(
        text(input.text, "播报内容", 2000),
        typeof input.voice === "string" ? input.voice : undefined,
        // 流式分段播报传 interrupt: false，排队说完；默认打断上一段。
        { interrupt: input.interrupt !== false },
      ));
    }
    if (request.method === "GET" && url.pathname === "/api/speech/voices") {
      // ?refresh=1 跳过期缓存。用户刚在系统设置里下载完语音时用得上，
      // 否则要等缓存过期才看得到。
      const voices = await listChineseVoices(url.searchParams.get("refresh") === "1");
      return json(response, 200, { voices, default: await defaultVoice() });
    }
    if (request.method === "POST" && url.pathname === "/api/speech/stop") return json(response, 200, { stopped: stopSpeaking() });
    if (request.method === "GET" && url.pathname === "/api/speech/status") return json(response, 200, { speaking: isSpeaking() });

    if (request.method === "POST" && url.pathname === "/api/attachments") return json(response, 201, await saveAttachment(await body(request)));
    if (request.method === "POST" && url.pathname === "/api/projects") return json(response, 201, await createProject(await body(request)));
    if (request.method === "POST" && url.pathname === "/api/chats") return json(response, 201, createChat(await body(request)));
    if (request.method === "POST" && url.pathname === "/api/tasks") return json(response, 201, await createTask(await body(request)));

    let match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (match && request.method === "GET") {
      store.readTask(match[1]);
      // 详情默认只回最近 300 条事件，历史用 beforeId 续拉；避免一次返回几十 MB。
      const eventLimit = Number(url.searchParams.get("eventLimit") || 300);
      const beforeId = Number(url.searchParams.get("beforeId") || 0) || null;
      const task = required(store.taskDetail(match[1], { eventLimit, beforeId }), "任务不存在");
      return json(response, 200, { ...task, actual_runtime: runner.actualRuntime(task), active: runner.isTaskActive(match[1]), flow_active: runner.isFlowBusy(match[1]) });
    }
    if (match && request.method === "PATCH") return json(response, 200, await updateTask(match[1], await body(request)));
    if (match && request.method === "DELETE") return json(response, 200, await deleteTask(match[1]));
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/skills$/);
    if (match && request.method === "GET") { const task = required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); return json(response, 200, task.provider === "codex" ? await runner.codex.listSkills(task.workspace) : []); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/worktree$/);
    if (match && request.method === "GET") { required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); return json(response, 200, runner.worktreeInfo(match[1])); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/worktree\/remove$/);
    if (match && request.method === "POST") { required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); return json(response, 200, await runner.removeWorktree(match[1])); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/changes$/);
    if (match && request.method === "GET") { const task = required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); return json(response, 200, await taskChanges(task, url.searchParams.get("run") || null)); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/changes\/file$/);
    if (match && request.method === "GET") { const task = required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); return json(response, 200, await changesFile(task, url.searchParams.get("path") || "", url.searchParams.get("run") || null)); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/changes\/revert$/);
    if (match && request.method === "POST") { const task = required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); return json(response, 200, await revertTaskChanges(task, await body(request, true))); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    if (match && request.method === "GET") { required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); return json(response, 200, taskLogs(match[1], url.searchParams)); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (match && request.method === "POST") { required(store.taskDetail(match[1], { eventLimit: 1 }), "任务不存在"); const result = await runner.resumeTask(match[1]); broadcast("changed", { taskId: match[1] }); return json(response, 200, result); }
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(run|messages|cancel|open)$/);
    if (match && request.method === "POST") return json(response, 200, await taskAction(match[1], match[2], await body(request, true)));
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/queue\/(\d+)(?:\/(guide))?$/);
    if (match && request.method === "DELETE" && !match[3]) { required(store.deleteQueuedMessage(match[1], Number(match[2])), "排队消息不存在"); broadcast("changed", { taskId: match[1] }); return json(response, 200, { ok: true }); }
    if (match && request.method === "POST" && match[3] === "guide") return json(response, 200, await runner.guideQueued(match[1], Number(match[2])));

    match = url.pathname.match(/^\/api\/events\/(\d+)\/attachments\/(\d+)(?:\/(copy))?$/);
    if (match && request.method === "GET" && !match[3]) return await sendAttachment(response, Number(match[1]), Number(match[2]));
    if (match && request.method === "POST" && match[3] === "copy") return json(response, 200, await copyAttachment(Number(match[1]), Number(match[2]), await body(request)));

    // 任务说明里的附件不在事件上，需要独立入口给界面预览与另存。
    match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attachments\/(\d+)(?:\/(copy))?$/);
    if (match && request.method === "GET" && !match[3]) return await sendTaskAttachment(response, match[1], Number(match[2]));
    if (match && request.method === "POST" && match[3] === "copy") return json(response, 200, await copyTaskAttachment(match[1], Number(match[2]), await body(request)));

    match = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (match && request.method === "POST") { const input = await body(request); required(input.decision !== undefined, "请选择或审批后继续"); await runner.respondApproval(match[1], input.decision); return json(response, 200, { ok: true }); }

    if (request.method === "POST" && url.pathname === "/api/codex/login") return json(response, 200, await runner.codex.login());
    if (request.method === "POST" && url.pathname === "/api/codex/logout") return json(response, 200, await runner.codex.logout());
    if (request.method === "POST" && url.pathname === "/api/codex/reset") {
      const input = await body(request);
      const creditId = required(typeof input.creditId === "string" && input.creditId.trim(), "请选择要使用的重置机会");
      const result = await runner.codex.consumeRateLimitReset(randomUUID(), creditId);
      broadcast("account", {});
      return json(response, 200, result);
    }
    // ---- Deepseek 多账号 ----
    if (request.method === "GET" && url.pathname === "/api/deepseek/accounts") { void runner.scheduleAccountRefresh(); return json(response, 200, deepseekAccountsPayload()); }
    if (request.method === "POST" && url.pathname === "/api/deepseek/accounts") return json(response, 201, await createDeepseekAccount(await body(request)));
    match = url.pathname.match(/^\/api\/deepseek\/accounts\/([^/]+)$/);
    if (match && request.method === "PATCH") return json(response, 200, renameDeepseekAccount(match[1], await body(request)));
    if (match && request.method === "DELETE") return json(response, 200, await removeDeepseekAccount(match[1]));
    match = url.pathname.match(/^\/api\/deepseek\/accounts\/([^/]+)\/(activate|test|key)$/);
    if (match && request.method === "POST" && match[2] === "activate") return json(response, 200, await runner.switchDeepseekAccount(match[1]));
    if (match && request.method === "POST" && match[2] === "test") return json(response, 200, await testDeepseekAccount(match[1]));
    if (match && request.method === "PUT" && match[2] === "key") return json(response, 200, await setDeepseekAccountKey(match[1], await body(request)));
    // 旧接口：等价于对当前账号操作，保持兼容。
    if (request.method === "POST" && url.pathname === "/api/deepseek/key") return json(response, 200, await setDeepseekKey(await body(request)));
    if (request.method === "DELETE" && url.pathname === "/api/deepseek/key") return json(response, 200, await deleteActiveDeepseekAccount());
    if (request.method === "POST" && url.pathname === "/api/deepseek/test") return json(response, 200, await testDeepseekAccount(store.activeDeepseekAccountId()));
    if (request.method === "POST" && url.pathname === "/api/workbench/key") return json(response, 200, await setWorkbenchKey(await body(request)));
    if (request.method === "DELETE" && url.pathname === "/api/workbench/key") { await deleteWorkbenchKey(); store.setSetting("workbench.configured", "false"); store.setSetting("workbench.lastFour", ""); store.setSetting("workbench.user", ""); store.setSetting("workbench.projectId", ""); return json(response, 200, { ok: true }); }
    if (request.method === "POST" && url.pathname === "/api/workbench/test") return json(response, 200, await workbench.test());
    if (request.method === "GET" && url.pathname === "/api/workbench/assignment-options") return json(response, 200, await workbench.assignmentOptions());
    if (request.method === "POST" && url.pathname === "/api/workbench/project") return json(response, 200, await setWorkbenchProject(await body(request)));
    // 成员名单供改派下拉使用；me 是当前开发台登录名，用于在列表里标出自己。
    if (request.method === "GET" && url.pathname === "/api/workbench/members") return json(response, 200, { members: workbenchMembers(), default: WORKBENCH_MEMBERS, me: store.setting("workbench.user", "") });
    if (request.method === "POST" && url.pathname === "/api/workbench/members") return json(response, 200, setWorkbenchMembers(await body(request)));
    if (request.method === "POST" && url.pathname === "/api/workbench/assign") return json(response, 200, await assignWorkbenchTask(await body(request)));
    // 反向拉取：把工作台未开始的待办任务写入当前项目，落到「待执行」列。
    if (request.method === "POST" && url.pathname === "/api/workbench/pull") {
      return json(response, 200, await workbench.pullBound());
    }
    // 恢复被本地删除过的问题：从忽略列表移除，下次拉取会重新带入。
    if (request.method === "POST" && url.pathname === "/api/workbench/restore") {
      const externalId = text((await body(request)).externalId, "问题 ID", 200);
      const result = store.restoreWorkbenchIssues([externalId]);
      broadcast("changed", {});
      return json(response, 200, result);
    }

    match = url.pathname.match(/^\/api\/mcp\/([a-z_]+)$/);
    if (match && request.method === "POST") return json(response, 200, await mcpCall(match[1], request.headers["x-luoshenfu-task"], await body(request)));
    return json(response, 404, { error: "接口不存在" });
  } catch (error) {
    // 流式响应（音频、附件）可能已经发过头了，此时再写 JSON 头会二次抛错，
    // 而二次错误发生在 catch 之外，会直接拖垮整个本地服务进程。
    if (response.headersSent) { response.destroy(); return; }
    const status = error.code === "DANGER_CONFIRMATION_REQUIRED" ? 409 : error.status || 400;
    return json(response, status, { error: error.message, code: error.code });
  }
});

function authorized(request, url) {
  const candidate = request.headers["x-luoshenfu-token"] || url.searchParams.get("token") || "";
  const left = Buffer.from(String(candidate));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function setCors(request, response) {
  const origin = request.headers.origin;
  const allowed = !origin || ["http://localhost:1421", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(origin);
  if (origin && allowed) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-headers", "content-type,x-luoshenfu-token,x-luoshenfu-task");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("vary", "Origin");
}

function openEvents(request, response) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  response.write("event: ready\ndata: {}\n\n");
  clients.add(response);
  request.once("close", () => clients.delete(response));
}

async function body(request, optional = false) {
  let source = "";
  for await (const chunk of request) {
    source += chunk;
    if (source.length > 36 * 1024 * 1024) throw Object.assign(new Error("请求内容过大"), { status: 413 });
  }
  if (!source && optional) return {};
  try { return JSON.parse(source || "{}"); } catch { throw new Error("请求 JSON 无效"); }
}

function json(response, status, value) {
  const output = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(output), "cache-control": "no-store" });
  response.end(output);
}

function required(value, message) { if (!value) throw Object.assign(new Error(message), { status: 404 }); return value; }
function text(value, name, max = 5000) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name}不能为空`); if (value.length > max) throw new Error(`${name}过长`); return value.trim(); }
function oneOf(value, values, name) { if (!values.includes(value)) throw new Error(`${name}无效`); return value; }

async function createProject(input) {
  const workspace = path.resolve(text(input.workspace, "工作目录", 2000));
  if (!(await stat(workspace)).isDirectory()) throw new Error("工作目录不存在");
  return store.createProject({ name: text(input.name, "项目名称", 100), workspace });
}

function createChat(input) {
  required(store.project(input.projectId), "项目不存在");
  const provider = oneOf(input.provider || "codex", ["codex", "deepseek"], "智能体");
  const chat = store.createChat({
    projectId: input.projectId,
    provider,
    model: typeof input.model === "string" ? input.model : null,
    effort: typeof input.effort === "string" ? input.effort : "high",
    permission: oneOf(input.permission || "danger-full-access", ["read-only", "workspace-write", "danger-full-access"], "执行权限"),
  });
  broadcast("changed", { taskId: chat.id });
  return store.taskDetail(chat.id);
}

function taskInput(input) {
  required(store.project(input.projectId), "项目不存在");
  const permission = oneOf(input.permission || "workspace-write", ["read-only", "workspace-write", "danger-full-access"], "执行权限");
  if (permission === "danger-full-access" && !input.dangerConfirmed) throw Object.assign(new Error("创建完整访问任务前需要确认一次"), { code: "DANGER_CONFIRMATION_REQUIRED" });
  const defaultIsolate = store.setting("worktree.enabled", "true") !== "false";
  return {
    projectId: input.projectId,
    title: text(input.title, "任务标题", 200),
    description: typeof input.description === "string" ? input.description.slice(0, 20_000) : "",
    provider: input.provider ? oneOf(input.provider, ["codex", "deepseek"], "执行者") : null,
    model: typeof input.model === "string" ? input.model : null,
    effort: typeof input.effort === "string" ? input.effort : null,
    permission,
    autoExecute: Boolean(input.autoExecute),
    worktreeMode: resolveWorktreeMode(input.worktreeMode, defaultIsolate),
  };
}

async function createTask(input) {
  const clean = taskInput(input);
  // 任务说明里的图片随任务一起保存，执行时作为需求输入交给智能体。
  clean.attachments = await resolveAttachments(input.attachments);
  const assignment = input.workbenchSync ? await validateWorkbenchAssignment(input.workbenchAssignment) : null;
  if (input.kind === "workflow") {
    clean.stages = [
      workflowStage(input.stages?.design, "codex", "design"),
      workflowStage(input.stages?.implementation, "deepseek", "implementation"),
      workflowStage(input.stages?.verification, "codex", "verification"),
    ];
  }
  const result = input.kind === "workflow" ? store.createWorkflow(clean) : store.createStandalone({ ...clean, phase: "standalone" });
  if (assignment) store.enableWorkbenchSync(input.kind === "workflow" ? result.root.id : result.id, assignment);
  // 预先准备 Worktree，失败时安全降级为原项目目录，不阻断任务创建。
  try { await runner.prepareWorktree(input.kind === "workflow" ? result.root.id : result.id); }
  catch (error) { console.error(`[luoshenfu] Worktree 准备失败：${error.message}`); }
  broadcast("changed", {});
  if (input.kind === "workflow" && clean.autoExecute) void runner.runTask(result.root.id);
  else if (input.kind !== "workflow" && clean.autoExecute && clean.provider) void runner.runTask(result.id);
  return input.kind === "workflow" ? { ...result, root: store.task(result.root.id) } : store.task(result.id);
}

async function validateWorkbenchAssignment(input) {
  if (!await readWorkbenchKey()) throw new Error("请先在设置中配置工作台 API Key");
  const projectId = String(input?.projectId || "").trim();
  const requirementId = input?.requirementId == null ? null : String(input.requirementId).trim();
  const kind = oneOf(input?.kind, ["development", "test"], "工作台任务类型");
  const options = await workbench.assignmentOptions();
  const projects = options.projects || options.data?.projects || [];
  const requirements = options.requirements || options.data?.requirements || [];
  const project = projects.find((item) => String(item.id) === projectId);
  if (!project) throw new Error("请选择有效的开发台项目");
  if (project.task_only) {
    if (requirementId) throw new Error("该开发台项目不需要大需求");
  } else if (!requirements.some((item) => String(item.id) === requirementId && String(item.project_id) === projectId)) {
    throw new Error("请选择属于该项目的大需求");
  }
  return { projectId, requirementId: project.task_only ? null : requirementId, kind };
}

// 拉取任务后在后台准备 Worktree：逐个串行，避免同一仓库 git worktree 并发写入冲突。
async function preparePulledWorktrees(taskIds) {
  for (const taskId of taskIds) {
    try { await runner.prepareWorktree(taskId); }
    catch (error) { console.error(`[luoshenfu] Worktree 准备失败：${error.message}`); }
  }
}

function workflowStage(input, provider, phase) {
  const value = input || {};
  return { provider: value.provider ? oneOf(value.provider, ["codex", "deepseek"], `${phase}阶段执行者`) : provider, phase, model: typeof value.model === "string" ? value.model : null, effort: typeof value.effort === "string" ? value.effort : null };
}

async function updateTask(id, input) {
  const task = required(store.task(id), "任务不存在");
  if (input.worktreeMode !== undefined) {
    return runner.setWorktreeMode(id, input.worktreeMode ? "isolate" : "direct");
  }
  const changes = {};
  if (input.title !== undefined) changes.title = text(input.title, "任务标题", 200);
  if (input.description !== undefined) {
    if (typeof input.description !== "string") throw new Error("任务说明无效");
    const description = input.description.trim();
    if (description.length > 20_000) throw new Error("任务说明过长");
    changes.description = description;
  }
  if (input.attachments !== undefined) changes.attachments = JSON.stringify(await resolveAttachments(input.attachments));
  if (input.status) changes.status = oneOf(input.status, ["todo", "running", "in_review", "blocked", "done", "canceled"], "状态");
  if (input.provider !== undefined) changes.provider = input.provider ? oneOf(input.provider, ["codex", "deepseek"], "执行者") : null;
  if (input.permission) changes.permission = oneOf(input.permission, ["read-only", "workspace-write", "danger-full-access"], "执行权限");
  if (typeof input.model === "string" || input.model === null) changes.model = input.model;
  if (typeof input.effort === "string" || input.effort === null) changes.reasoning_effort = input.effort;
  if (input.archived !== undefined) {
    if (input.archived && task.status !== "done") throw new Error("只有已完成任务可以归档");
    changes.archived = Boolean(input.archived);
    changes.archived_at = input.archived ? new Date().toISOString() : null;
  }
  if (input.kind !== undefined) {
    if (input.kind !== "workflow") throw new Error("任务类型无效");
    const stages = [
      workflowStage(input.stages?.design, "codex", "design"),
      workflowStage(input.stages?.implementation, "deepseek", "implementation"),
      workflowStage(input.stages?.verification, "codex", "verification"),
    ];
    const result = store.convertStandaloneToWorkflow(id, changes, stages);
    broadcast("changed", { taskId: id });
    return store.taskDetail(result.root.id, { eventLimit: 100 });
  }
  const updated = store.updateTask(id, changes);
  // 阶段状态被手动改动（标记完成、恢复）后，根任务状态要按各阶段真实状态回算，避免流程停在执行中。
  if (changes.status !== undefined && task.root_id) store.syncWorkflowStatus(task.root_id);
  // 流程任务的标题/说明/说明配图在创建时复制到各阶段；根任务改了要同步过去，否则重新执行仍用旧内容。
  if (task.is_root && (changes.title !== undefined || changes.description !== undefined || changes.attachments !== undefined)) {
    const phaseName = { design: "设计", implementation: "实施", verification: "验证" };
    for (const stage of store.taskDetail(id, { eventLimit: 1 }).children) {
      store.updateTask(stage.id, {
        ...(changes.title !== undefined ? { title: `${changes.title} · ${phaseName[stage.phase] || stage.phase}` } : {}),
        ...(changes.description !== undefined ? { description: changes.description } : {}),
        ...(changes.attachments !== undefined ? { attachments: changes.attachments } : {}),
      });
    }
  }
  broadcast("changed", { taskId: id });
  return updated;
}

async function taskAction(id, action, input) {
  const task = required(store.taskDetail(id, { eventLimit: 1 }), "任务不存在");
  if (action === "run" || action === "messages") {
    const options = { planMode: Boolean(input.planMode), skill: typeof input.skill === "string" ? input.skill : "", attachments: await resolveAttachments(input.attachments) };
    return action === "messages" && runner.activeRunInfo(id).active ? runner.queueTask(id, input.message, options) : runner.runTask(id, input.message, options);
  }
  if (action === "cancel") { await runner.cancel(id); return { ok: true }; }
  if (action === "open") { spawn("/usr/bin/open", [task.workspace], { detached: true, stdio: "ignore" }).unref(); return { ok: true }; }
}

function worktreeOwner(task) { return task.root_id ? store.task(task.root_id) || task : task; }

async function taskChanges(task, runId = null) {
  const owner = worktreeOwner(task);
  const batches = runner.changeBatches(task.id);
  if (owner.worktree_status !== "active" || !owner.worktree_path) return { available: false, reason: owner.worktree_note || "当前任务没有启用 Worktree 隔离", files: [], batches };
  try {
    if (runId) {
      const batch = batches.find((item) => item.runId === runId);
      if (!batch) return { available: false, reason: "该次执行没有变更快照", files: [], batches };
      const range = await inspectRangeChanges(owner.worktree_path, batch.previous, batch.snapshot);
      return { ...range, batch, batches };
    }
    return { ...(await inspectChanges(owner.worktree_path, owner.base_commit)), batches };
  } catch (error) { return { available: false, reason: error.message, files: [], batches }; }
}

async function changesFile(task, relativePath, runId = null) {
  const owner = worktreeOwner(task);
  if (owner.worktree_status !== "active" || !owner.worktree_path) throw Object.assign(new Error(owner.worktree_note || "当前任务没有启用 Worktree 隔离"), { status: 400 });
  if (!relativePath) throw new Error("缺少文件路径");
  if (runId) {
    const batch = runner.changeBatches(task.id).find((item) => item.runId === runId);
    if (!batch) throw Object.assign(new Error("该次执行没有变更快照"), { status: 404 });
    const range = await inspectRangeChanges(owner.worktree_path, batch.previous, batch.snapshot);
    if (!range.available) throw Object.assign(new Error(range.reason), { status: 400 });
    if (!range.files.some((file) => file.path === relativePath)) throw Object.assign(new Error("文件不在该次执行的变更列表中"), { status: 404 });
    return rangeFileDiff(owner.worktree_path, batch.previous, batch.snapshot, relativePath);
  }
  const current = await inspectChanges(owner.worktree_path, owner.base_commit);
  if (!current.available) throw Object.assign(new Error(current.reason), { status: 400 });
  if (!current.files.some((file) => file.path === relativePath)) throw Object.assign(new Error("文件不在当前变更列表中"), { status: 404 });
  return fileDiff(owner.worktree_path, owner.base_commit, relativePath);
}

async function revertTaskChanges(task, input) {
  const owner = worktreeOwner(task);
  if (owner.worktree_status !== "active" || !owner.worktree_path) throw Object.assign(new Error(owner.worktree_note || "当前任务没有启用 Worktree 隔离，已拒绝对原项目执行撤销"), { status: 400 });
  const current = await inspectChanges(owner.worktree_path, owner.base_commit);
  if (!current.available) throw Object.assign(new Error(current.reason), { status: 400 });
  const known = new Set(current.files.map((file) => file.path));
  const requested = Array.isArray(input.paths) ? input.paths.filter((item) => typeof item === "string" && item) : [];
  const targets = requested.length ? requested : [...known];
  if (!targets.length) return { results: [], available: true, files: current.files };
  for (const item of targets) if (!known.has(item)) throw new Error(`文件不在当前变更列表：${item}`);
  const results = await restoreFiles(owner.worktree_path, owner.base_commit, targets, { recycleRoot: path.join(dataDirectory, "recycle"), taskId: owner.id });
  runner.log({ taskId: owner.id, stream: "recovery", level: "warn", text: `已撤销 ${results.length} 个文件：${targets.slice(0, 20).join("、")}${targets.length > 20 ? " 等" : ""}` });
  const next = await inspectChanges(owner.worktree_path, owner.base_commit);
  broadcast("changed", { taskId: owner.id });
  return { results, available: next.available, files: next.files || [], reason: next.reason };
}

function taskLogs(taskId, params) {
  const allowed = ["stdout", "stderr", "tool", "command", "status", "system", "error", "recovery"];
  const streams = String(params.get("streams") || "").split(",").map((item) => item.trim()).filter((item) => allowed.includes(item));
  const after = params.get("after");
  const before = params.get("before");
  return store.logPage(taskId, {
    after: after ? Number(after) : null,
    before: before ? Number(before) : null,
    limit: Number(params.get("limit") || 300),
    streams,
    query: params.get("q") || "",
  });
}

function setSystemNotifications(input) {
  const enabled = input.enabled !== false;
  store.setSetting("notifications.system", enabled ? "true" : "false");
  broadcast("account", {});
  return { system: enabled };
}

function setWorktreeEnabled(input) {
  const enabled = input.enabled !== false;
  store.setSetting("worktree.enabled", enabled ? "true" : "false");
  broadcast("account", {});
  return { enabled };
}

/* ---------------- 本机音乐播放器 ---------------- */

async function musicSettings() {
  const enabled = store.setting("music.enabled", "false") === "true";
  const directory = store.setting("music.directory", "");
  if (!directory) return { enabled, directory: "", status: "unset" };
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) return { enabled, directory, status: "missing" };
  return { enabled, directory, status: "ready" };
}

async function setMusicSettings(input) {
  if (input.enabled !== undefined) store.setSetting("music.enabled", input.enabled ? "true" : "false");
  if (input.directory !== undefined) {
    const value = typeof input.directory === "string" ? input.directory.trim() : "";
    if (!value) store.setSetting("music.directory", "");
    else {
      const directory = path.resolve(value.slice(0, 4000));
      const info = await stat(directory).catch(() => null);
      if (!info?.isDirectory()) throw new Error("音乐目录不存在或无法访问");
      store.setSetting("music.directory", directory);
    }
    clearMusicCache();
  }
  broadcast("account", {});
  return musicSettings();
}

async function musicLibrary() {
  const directory = store.setting("music.directory", "");
  if (!directory) return { directory: "", status: "unset", tracks: [], truncated: false, error: null };
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) return { directory, status: "missing", tracks: [], truncated: false, error: null };
  const library = await buildLibrary(directory);
  // 区分「目录为空」与「系统拒绝读取」，前端才能给出正确的引导。
  const status = library.error ? "denied" : library.tracks.length ? "ready" : "empty";
  return { directory, status, tracks: library.tracks, truncated: library.truncated, error: library.error || null };
}

function musicFile(value) {
  const directory = store.setting("music.directory", "");
  if (!directory) throw Object.assign(new Error("尚未选择音乐目录"), { status: 400 });
  const file = path.resolve(text(value, "音频路径", 4000));
  if (!insideDirectory(directory, file)) throw Object.assign(new Error("只能访问音乐目录内的文件"), { status: 403 });
  if (!isAudioFile(file)) throw new Error("不是支持的音频文件");
  return file;
}

function musicPaths(input) {
  const paths = Array.isArray(input.paths) ? input.paths : [];
  if (!paths.length) throw new Error("请选择要操作的曲目");
  if (paths.length > 5000) throw new Error("一次最多操作 5000 首曲目");
  return paths.map((item) => musicFile(item));
}

function addMusicItems(playlistId, input) {
  required(store.musicPlaylist(playlistId), "歌单不存在");
  return store.addMusicItems(playlistId, musicPaths(input));
}

function removeMusicItem(playlistId, input) {
  required(store.musicPlaylist(playlistId), "歌单不存在");
  if (typeof input.path !== "string" || !input.path) throw new Error("请选择要移除的曲目");
  return { removed: store.removeMusicItem(playlistId, musicFile(input.path)) };
}

function orderMusicItems(playlistId, input) {
  required(store.musicPlaylist(playlistId), "歌单不存在");
  const paths = musicPaths(input);
  return store.setMusicItems(playlistId, paths);
}

async function saveAttachment(input) {
  const match = typeof input.data === "string" && input.data.match(/^data:([^;,]*);base64,(.+)$/i);
  if (!match) throw new Error("附件内容无效");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > 25 * 1024 * 1024) throw new Error("附件不能超过 25MB");
  const name = typeof input.name === "string" ? path.basename(input.name).slice(0, 255) : "附件";
  const extension = path.extname(name).slice(0, 16).replace(/[^.a-z0-9_-]/gi, "") || ".bin";
  const directory = path.join(dataDirectory, "attachments");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${Date.now()}-${randomUUID()}${extension}`);
  await writeFile(file, data);
  return { path: file, name, mime: match[1].toLowerCase().slice(0, 100) || "application/octet-stream" };
}

async function sendAttachment(response, eventId, index) {
  return sendAttachmentFile(response, required(store.eventAttachment(eventId, index), "附件不存在"));
}

async function sendTaskAttachment(response, taskId, index) {
  return sendAttachmentFile(response, required(store.taskAttachment(taskId, index), "附件不存在"));
}

async function sendAttachmentFile(response, item) {
  const file = path.resolve(item.path);
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error("附件不存在"), { status: 404 });
  response.writeHead(200, { "content-type": item.mime, "content-length": info.size, "cache-control": "private, max-age=3600" });
  createReadStream(file).pipe(response);
}

async function copyAttachment(eventId, index, input) {
  const item = required(store.eventAttachment(eventId, index), "附件不存在");
  const destination = path.resolve(text(input.destination, "保存位置", 4000));
  await copyFile(path.resolve(item.path), destination);
  return { ok: true };
}

async function copyTaskAttachment(taskId, index, input) {
  const item = required(store.taskAttachment(taskId, index), "附件不存在");
  const destination = path.resolve(text(input.destination, "保存位置", 4000));
  await copyFile(path.resolve(item.path), destination);
  return { ok: true };
}

async function resolveAttachments(input) {
  if (!Array.isArray(input)) return [];
  return Promise.all(input.slice(0, 10).map(async (item) => {
    const file = path.resolve(text(item?.path, "附件路径", 4000));
    const info = await stat(file);
    if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error("附件不存在或超过 25MB");
    return { path: file, name: typeof item.name === "string" ? item.name.slice(0, 255) : path.basename(file), mime: typeof item.mime === "string" ? item.mime.slice(0, 100) : mimeForFile(file) };
  }));
}

function mimeForFile(file) {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json" })[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function setLanguage(input) {
  const language = oneOf(input.language, supportedLanguages, "回复语言");
  runner.setLanguage(language);
  broadcast("account", {});
  return { language };
}

function deepseekAccountsPayload() {
  return {
    activeId: store.activeDeepseekAccountId(),
    accounts: store.deepseekAccounts().map((account) => ({
      id: account.id, alias: account.alias, lastFour: account.last_four,
      balance: runner.balanceCache.get(account.id) || null,
    })),
  };
}

// 首次启动把历史单账号密钥迁移成「默认账号」，之后一律走多账号。
async function migrateDeepseekAccounts() {
  const accounts = store.deepseekAccounts();
  if (accounts.length) {
    if (!store.deepseekAccount(store.activeDeepseekAccountId())) store.setActiveDeepseekAccount(accounts[0].id);
    return;
  }
  const legacy = await readDeepseekKey();
  if (!legacy) return;
  const account = store.createDeepseekAccount({ id: randomUUID(), alias: "默认账号", lastFour: legacy.slice(-4) });
  await saveDeepseekKey(legacy, account.id);
  await deleteDeepseekKey();
  store.setActiveDeepseekAccount(account.id);
  console.log(`[luoshenfu] 已把原有 Deepseek API Key 迁移为账号「${account.alias}」`);
}

function uniqueDeepseekAlias() {
  const base = "默认账号";
  if (!store.deepseekAccountByAlias(base)) return base;
  let index = 2;
  while (store.deepseekAccountByAlias(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

async function createDeepseekAccount(input) {
  const alias = text(input.alias, "账号别名", 24);
  if (store.deepseekAccountByAlias(alias)) throw new Error("账号别名已存在，请换一个");
  const key = text(input.key, "API Key", 500);
  if (key.length < 12) throw new Error("API Key 格式不正确");
  // 新账号默认会切换为当前账号；切换需要重建运行时，执行中切换会打断任务，所以直接拒绝。
  if (input.activate !== false && runner.hasActiveDeepseekRun()) throw new Error("请先停止正在执行的 Deepseek 任务，再新增并切换账号");
  const account = store.createDeepseekAccount({ id: randomUUID(), alias, lastFour: key.slice(-4) });
  await saveDeepseekKey(key, account.id);
  if (input.activate !== false) {
    store.setActiveDeepseekAccount(account.id);
    await runner.deepseek.reset();
  }
  broadcast("account", {});
  void runner.scheduleAccountRefresh();
  return { ...deepseekAccountsPayload(), account: { id: account.id, alias: account.alias, lastFour: account.last_four } };
}

function renameDeepseekAccount(id, input) {
  const account = required(store.deepseekAccount(id), "账号不存在");
  const alias = text(input.alias, "账号别名", 24);
  const existing = store.deepseekAccountByAlias(alias);
  if (existing && existing.id !== account.id) throw new Error("账号别名已存在，请换一个");
  store.renameDeepseekAccount(account.id, alias);
  broadcast("account", {});
  return deepseekAccountsPayload();
}

async function setDeepseekAccountKey(id, input) {
  const account = required(store.deepseekAccount(id), "账号不存在");
  const key = text(input.key, "API Key", 500);
  if (key.length < 12) throw new Error("API Key 格式不正确");
  if (id === store.activeDeepseekAccountId()) await runner.resetDeepseekRuntime();
  await saveDeepseekKey(key, account.id);
  store.updateDeepseekAccountKey(account.id, key.slice(-4));
  broadcast("account", {});
  void runner.scheduleAccountRefresh();
  return deepseekAccountsPayload();
}

async function removeDeepseekAccount(id) {
  const account = required(store.deepseekAccount(id), "账号不存在");
  const active = id === store.activeDeepseekAccountId();
  if (active) await runner.resetDeepseekRuntime();
  await deleteDeepseekKey(account.id);
  store.deleteDeepseekAccount(account.id);
  runner.balanceCache.delete(account.id);
  if (active) {
    const next = store.deepseekAccounts()[0];
    store.setActiveDeepseekAccount(next ? next.id : "");
  }
  broadcast("account", {});
  void runner.scheduleAccountRefresh();
  return { ok: true, ...deepseekAccountsPayload() };
}

async function testDeepseekAccount(id) {
  const account = required(store.deepseekAccount(id), "账号不存在");
  const key = await readDeepseekKey(account.id);
  if (!key) throw new Error("该账号没有可用的 API Key");
  const response = await fetch("https://api.deepseek.com/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Deepseek 连接失败（${response.status}）`);
  const payload = await response.json();
  const models = (payload.data || []).map((model) => model.id);
  // 只有当前账号的模型列表才写回运行时缓存，避免测试别的账号污染当前配置。
  if (id === store.activeDeepseekAccountId()) {
    runner.deepseek.modelCache = models.map((model) => ({ id: model, name: model, provider: "deepseek" }));
    store.setSetting("deepseek.models", JSON.stringify(runner.deepseek.modelCache));
    broadcast("account", {});
  }
  return { ok: true, models, activeId: store.activeDeepseekAccountId() };
}

async function setDeepseekKey(input) {
  const key = text(input.key, "API Key", 500);
  if (key.length < 12) throw new Error("API Key 格式不正确");
  let id = store.activeDeepseekAccountId();
  if (id && store.deepseekAccount(id)) {
    await runner.resetDeepseekRuntime();
    store.updateDeepseekAccountKey(id, key.slice(-4));
  } else {
    const account = store.createDeepseekAccount({ id: randomUUID(), alias: uniqueDeepseekAlias(), lastFour: key.slice(-4) });
    id = account.id;
    store.setActiveDeepseekAccount(id);
    await runner.deepseek.reset();
  }
  await saveDeepseekKey(key, id);
  broadcast("account", {});
  void runner.scheduleAccountRefresh();
  return { configured: true, lastFour: key.slice(-4), ...deepseekAccountsPayload() };
}

async function deleteActiveDeepseekAccount() {
  const id = store.activeDeepseekAccountId();
  if (!id) return { ok: true, ...deepseekAccountsPayload() };
  return removeDeepseekAccount(id);
}

async function setWorkbenchKey(input) {
  const key = text(input.key, "API Key", 500);
  if (key.length < 24) throw new Error("API Key 格式不正确");
  await saveWorkbenchKey(key);
  store.setSetting("workbench.configured", "true");
  store.setSetting("workbench.lastFour", key.slice(-4));
  return { configured: true, lastFour: key.slice(-4) };
}

async function setWorkbenchProject(input) {
  if (!await readWorkbenchKey()) throw new Error("请先配置 Lo查查工作台 API Key");
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  if (projectId) required(store.project(projectId), "项目不存在");
  store.setSetting("workbench.projectId", projectId);
  return { projectId: projectId || null };
}

// 可改派的负责人名单：默认开发台文档给出的 4 人，用户可在设置里维护，存 workbench.members（JSON 数组）。
function workbenchMembers() {
  return parseWorkbenchMembers(store.setting("workbench.members", ""));
}

function setWorkbenchMembers(input) {
  const raw = Array.isArray(input?.members) ? input.members : [];
  const members = [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  if (!members.length) throw new Error("负责人名单至少保留一个");
  // 负责人是开发台登录名，限制字符集避免把奇怪内容写进设置或请求体。
  if (members.some((name) => !/^[A-Za-z0-9_.-]{1,64}$/.test(name))) throw new Error("负责人只支持字母、数字、下划线、点和短横线");
  store.setSetting("workbench.members", JSON.stringify(members));
  return { members };
}

// 删除任务：已关联开发台的任务，先把开发台任务软删除（archive），成功后再删本地。
// 开发台删除失败时不删本地，避免留下「开发台还挂着、本地已无关联」的孤儿任务。
async function deleteTask(id) {
  required(store.task(id), "任务不存在");
  const links = store.workbenchLinks(id);
  const dismissed = [];
  let workbenchDeleted = 0;
  for (const link of links) {
    // 问题没有可用的归档接口：删除只做本地忽略，避免下次拉取又把它带回来。
    if (link.external_kind === "issue") { dismissed.push(link.external_id); continue; }
    await workbench.remove(link.external_id);
    workbenchDeleted += 1;
  }
  if (dismissed.length) store.dismissWorkbenchIssues(dismissed);
  const worktree = await runner.releaseWorktree(id);
  const deleted = store.deleteTask(id);
  broadcast("changed", {});
  return { ok: true, deleted, worktree, workbenchDeleted };
}

// 改派：只允许已关联开发台的任务。改派成功后本地副本彻底删除（开发台任务保留，只是换了负责人），
// 所以不需要给任务加「已指派给他人」的标记。
async function assignWorkbenchTask(input) {
  const taskId = text(input.taskId, "任务 ID", 100);
  const assignee = oneOf(input.assignee, workbenchMembers(), "负责人");
  const task = required(store.task(taskId), "任务不存在");
  const link = store.workbenchLinks(taskId)[0];
  if (!link) throw new Error("只有已关联 Lo查查工作台的任务才能改派");
  await workbench.assign(link.external_id, assignee, link.external_kind);
  const worktree = await runner.releaseWorktree(task.id);
  const deleted = store.deleteTask(task.id);
  broadcast("changed", {});
  return { ok: true, assignee, deleted, worktree };
}

async function mcpCall(name, taskId, input) {
  const task = required(store.taskDetail(taskId), "MCP 当前任务不存在");
  if (name === "get_task") return task;
  if (name === "workbench_me") return workbench.test();
  if (name === "workbench_assignment_options") return workbench.assignmentOptions();
  if (name === "workbench_list_tasks") return workbench.listTasks({
    status: input.status ? oneOf(input.status, ["todo", "doing", "review", "done", "block"], "开发台状态") : "",
    includeArchived: input.include_archived !== false,
    page: Math.max(0, Math.floor(Number(input.page) || 0)),
  });
  if (name === "workbench_create_task") {
    const assignment = await validateWorkbenchAssignment({ projectId: input.project_id, requirementId: input.requirement_id, kind: input.kind });
    return workbench.createTask({
      title: text(input.title, "任务标题", 120), detail: text(input.detail, "任务说明", 2000),
      priority: oneOf(input.priority || "P2", ["P0", "P1", "P2"], "优先级"),
      ...(input.repo ? { repo: text(input.repo, "仓库", 80) } : {}),
      project_id: assignment.projectId, requirement_id: assignment.requirementId, kind: assignment.kind,
    });
  }
  if (name === "workbench_update_task") {
    const patch = {};
    if (input.status !== undefined) patch.status = oneOf(input.status, ["todo", "doing", "review", "done", "block"], "开发台状态");
    if (input.title !== undefined) patch.title = text(input.title, "任务标题", 120);
    if (input.detail !== undefined) patch.detail = text(input.detail, "任务说明", 2000);
    if (!Object.keys(patch).length) throw new Error("请提供要修改的标题、说明或状态");
    return workbench.updateTask(text(input.task_id, "开发台任务 ID", 200), patch);
  }
  if (name === "list_my_tasks") return store.tasks(task.project_id).filter((item) => item.parent_id === task.id || item.id === task.parent_id);
  if (name === "create_subtask") {
    if (store.delegationDepth(task.id) >= 3) throw new Error("派单深度已达到 3");
    const provider = task.provider === "codex" ? "deepseek" : "codex";
    const child = store.createDelegatedTask(task, { provider, title: text(input.title, "子任务标题", 200), description: typeof input.description === "string" ? input.description.slice(0, 20_000) : "", idempotencyKey: text(input.idempotency_key, "幂等键", 200) });
    store.addEvent(task.id, store.activeRun(task.id)?.id, { type: "delegation", title: `已派给 ${provider === "codex" ? "Codex" : "Deepseek"}`, content: `#${child.number} ${child.title}` });
    broadcast("changed", { taskId: child.id });
    if (child.auto_execute && !store.activeRun(child.id)) void runner.runTask(child.id);
    return child;
  }
  if (name === "report_progress") {
    const progress = Math.max(0, Math.min(100, Number(input.progress)));
    store.updateTask(task.id, { progress });
    store.addEvent(task.id, store.activeRun(task.id)?.id, { type: "progress", title: `进度 ${progress}%`, content: typeof input.message === "string" ? input.message : "" });
    broadcast("event", { taskId: task.id });
    return { ok: true, progress };
  }
  if (name === "send_task_message") {
    const target = required(store.task(input.task_id), "目标任务不存在");
    if (target.project_id !== task.project_id || !(target.id === task.parent_id || target.parent_id === task.id)) throw new Error("只能给同项目的父任务或直接子任务发消息");
    store.addEvent(target.id, store.activeRun(target.id)?.id, { type: "notification", title: `来自任务 #${task.number}`, content: text(input.message, "消息", 5000) });
    broadcast("event", { taskId: target.id });
    return { ok: true };
  }
  if (name === "complete_task") { runner.forceOutcome(task.id, "completed", text(input.summary, "完成摘要", 10_000)); return { ok: true }; }
  if (name === "block_task") { runner.forceOutcome(task.id, "blocked", text(input.reason, "阻塞原因", 10_000)); return { ok: true }; }
  if (name === "attach_image") {
    const file = path.resolve(text(input.path, "图片路径", 4000));
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error("图片不存在或无法读取");
    if (info.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20MB");
    // 必须按内容判断类型：harness 的附件文件名是内容哈希、没有扩展名，
    // 只看扩展名会被界面当成普通文件，图片就显示不出来。
    const mime = await sniffImageMime(file);
    if (!mime) throw new Error("不是支持的图片格式（PNG / JPEG / WebP / GIF）");
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 200) : imageFileName(file, mime);
    store.addEvent(task.id, store.activeRun(task.id)?.id, {
      type: "message", role: "assistant",
      content: typeof input.caption === "string" ? input.caption.slice(0, 2000) : "",
      // 只引用原文件、不复制：harness 已经按内容哈希存过一份，再复制一份纯属冗余。
      raw: { attachments: [{ path: file, name, mime }] },
    });
    broadcast("event", { taskId: task.id });
    return { ok: true, shown: name, note: file.startsWith(os.tmpdir()) ? "该图片位于临时目录，系统清理后会失效；需要长期保留请先另存到持久位置" : undefined };
  }
  if (name.startsWith("computer_")) { await runner.authorizeComputer(task.id); return useComputer(name, input); }
  throw Object.assign(new Error("未知的洛神赋 MCP 工具"), { status: 404 });
}

await migrateDeepseekAccounts();

server.listen(port, "127.0.0.1", () => { console.log(`洛神赋本地服务：${baseUrl}`); workbench.kick(); });
const parentPid = process.ppid;
const parentWatch = development ? null : setInterval(() => { if (process.ppid !== parentPid) void shutdown(); }, 1_000);
parentWatch?.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentWatch) clearInterval(parentWatch);
  server.close();
  for (const client of clients) client.end();
  await runner.close();
  workbench.close();
  store.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultVoice, isSpeaking, listChineseVoices, stopSpeaking } from "../server/speech.mjs";
import { defaultModel, supportedModels } from "../server/assistant.mjs";

async function waitForServer(baseUrl, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const probe = await fetch(`${baseUrl}/api/snapshot`, { headers: { "x-luoshenfu-token": "not-our-token" } });
        if (probe.status === 401) return true;
      }
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * 起一个隔离的本地服务。
 * 注意：这里刻意只调用不会真正发声的路径——测试时突然念出声音会吓到人。
 */
async function withServer(run) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "luoshenfu-voice-data-"));
  const port = 51000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = "voice-test-token";
  const server = spawn(process.execPath, ["server/index.mjs", "--dev"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, LUOSHENFU_PORT: String(port), LUOSHENFU_TOKEN: token, LUOSHENFU_DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    assert.ok(await waitForServer(baseUrl, Date.now() + 20_000), `本地服务未能启动。日志：\n${logs}`);
    const headers = { "content-type": "application/json", "x-luoshenfu-token": token };
    await run({ baseUrl, headers });
  } finally {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

test("音色列表只包含真正装了语音数据的，默认值也在其中", async () => {
  const voices = await listChineseVoices();
  assert.ok(voices.length > 0, "系统里应当至少有一个可用的中文语音");
  for (const voice of voices) {
    // 音色名会作为参数传给 say，不能含会破坏命令行的字符。
    assert.match(voice.name, /^[A-Za-z][A-Za-z0-9 _-]*$/, `音色名不该含特殊字符：${voice.name}`);
    // 未安装的音色不该出现在列表里：`say -v '?'` 会报出它们，
    // 但合成结果是空音频，选中就"没声音"。
    assert.equal(voice.available, true, `${voice.name} 未安装语音数据，不该出现在列表里`);
  }

  const chosen = await defaultVoice();
  assert.ok(voices.some((item) => item.name === chosen), `默认音色 ${chosen} 必须来自可用列表`);

  // 没有正在播报时，停止操作应当是安全的空操作。
  assert.equal(isSpeaking(), false);
  assert.equal(stopSpeaking(), false);
});

test("模型列表只暴露官方放开的模型，且默认值在列表内", () => {
  assert.ok(supportedModels.length > 0);
  assert.ok(supportedModels.some((item) => item.id === defaultModel), "默认模型必须来自支持列表");
  for (const item of supportedModels) {
    assert.match(item.id, /^deepseek-[a-z0-9-]+$/);
    assert.ok(item.name && item.hint, `${item.id} 缺少展示名或说明`);
  }
});

test("语音接口拒绝空文本与超长文本，且不触发播报", async () => {
  await withServer(async ({ baseUrl, headers }) => {
    const speak = (body) => fetch(`${baseUrl}/api/speech/speak`, { method: "POST", headers, body: JSON.stringify(body) });

    // 空文本会被 text() 校验拦下——这两条路径都不会真的让系统发声。
    assert.equal((await speak({ text: "" })).status, 400);
    assert.equal((await speak({ text: "   " })).status, 400);
    assert.equal((await speak({ text: "x".repeat(2001) })).status, 400);

    const status = await (await fetch(`${baseUrl}/api/speech/status`, { headers })).json();
    assert.equal(status.speaking, false);
  });
});

test("问答接口拒绝空问题与超长问题", async () => {
  await withServer(async ({ baseUrl, headers }) => {
    const ask = (body) => fetch(`${baseUrl}/api/assistant/ask`, { method: "POST", headers, body: JSON.stringify(body) });

    // 只走校验路径：不触发真实 API 调用，否则每跑一次测试都要花用户的额度。
    // 钥匙串是全局的，测试机往往已经配好了 Key，所以不能假设"必然报未配置"。
    assert.equal((await ask({ question: "" })).status, 400);
    assert.equal((await ask({ question: "   " })).status, 400);
    assert.equal((await ask({ question: "x".repeat(4001) })).status, 400);

    const payload = await (await ask({ question: "" })).json();
    assert.match(payload.error, /问题/);
  });
});

test("流式问答接口同样拒绝空问题与超长问题", async () => {
  await withServer(async ({ baseUrl, headers }) => {
    const stream = (body) => fetch(`${baseUrl}/api/assistant/stream`, { method: "POST", headers, body: JSON.stringify(body) });

    // 校验失败必须是普通的 400 JSON，而不是先开一条 SSE 再报错。
    assert.equal((await stream({ question: "" })).status, 400);
    assert.equal((await stream({ question: "   " })).status, 400);
    assert.equal((await stream({ question: "x".repeat(4001) })).status, 400);
  });
});

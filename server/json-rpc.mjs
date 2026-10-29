import { spawn } from "node:child_process";

export class JsonRpcProcess {
  constructor(command, args, options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = "";
  }

  async start() {
    if (this.child) return;
    const child = spawn(this.command, this.args, { env: this.options.env, cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8").on("data", (chunk) => this.handleChunk(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => this.options.onStderr?.(chunk));
    // 旧实现只按 this.child 判断“已启动”。spawn 失败后 child 仍留在字段里，
    // 下次重试会跳过启动、把请求写进不存在的进程，最后误报成 “initialize timed out”。
    child.once("exit", (code, signal) => { if (this.child === child) this.failAll(new Error(`${this.command} exited (${signal || code})`)); });
    try {
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    } catch (error) {
      if (this.child === child) this.child = null;
      throw error;
    }
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  request(method, params, timeout = 60_000) {
    // 运行时没起来时立即失败，别让调用方白等到超时。
    if (!this.child) return Promise.reject(new Error(`${method} failed: runtime is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  respond(id, result, error) { this.send(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }); }
  send(message) { this.child?.stdin.write(`${JSON.stringify(message)}\n`); }

  handleChunk(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.handle(JSON.parse(line)); } catch (error) { this.options.onStderr?.(`Invalid JSON-RPC: ${error.message}\n`); }
    }
  }

  async handle(message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      return message.error ? pending.reject(new Error(message.error.message || `${pending.method} failed`)) : pending.resolve(message.result);
    }
    if (typeof message.method !== "string") return;
    if (Object.hasOwn(message, "id")) {
      try { this.respond(message.id, await this.options.onRequest?.(message)); }
      catch (error) { this.respond(message.id, null, { code: -32000, message: error.message }); }
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.options.onExit?.(error);
    this.child = null;
  }

  async close() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode != null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (child.exitCode == null) child.kill("SIGKILL");
  }
}

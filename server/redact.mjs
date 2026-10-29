// 日志与通知脱敏：在写入数据库前执行一次，在返回给前端前再执行一次。
const SECRET_PATTERNS = [
  // Deepseek / OpenAI 风格的密钥
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  // GitHub 令牌
  /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/g,
  // 请求头
  /(\b(?:proxy-)?authorization\b\s*[:=]\s*)([^\r\n]+)/gi,
  /(\b(?:set-)?cookie\b\s*[:=]\s*)([^\r\n]+)/gi,
  // 环境变量 / 配置风格的敏感赋值
  /((?:[A-Za-z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL)S?)\s*[:=]\s*)("?[^"'\s,;]+"?)/gi,
];

const BINARY_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export function createRedactor({ secrets = [] } = {}) {
  const literals = [...new Set(secrets.filter((value) => typeof value === "string" && value.length >= 6))];
  return {
    text(value) {
      let output = value == null ? "" : String(value);
      for (const literal of literals) output = output.split(literal).join("[已脱敏]");
      for (const pattern of SECRET_PATTERNS) {
        output = output.replace(pattern, (match, prefix) => (prefix === undefined ? "[已脱敏]" : `${prefix}[已脱敏]`));
      }
      return output;
    },
  };
}

// 确保写入数据库和返回前端的文本既不泄露密钥，也不会因为二进制/超大内容而丢失整条日志。
export function sanitizeLogText(value, { maxLine = 4000, maxBytes = 64 * 1024 } = {}) {
  const source = value == null ? "" : String(value);
  if (!source) return "";
  if (BINARY_PATTERN.test(source)) return `[二进制或不可打印内容，原始长度 ${source.length} 字节，已省略]`;
  const lines = source.split("\n").map((line) => (line.length > maxLine ? `${line.slice(0, maxLine)} …（本行过长已截断）` : line));
  let output = lines.join("\n");
  if (Buffer.byteLength(output) > maxBytes) {
    const buffer = Buffer.from(output);
    output = `${buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "")}\n…（单条日志过大，已按 ${maxBytes} 字节截断）`;
  }
  return output;
}

export function redactText(value) {
  return createRedactor().text(sanitizeLogText(value));
}

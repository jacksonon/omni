/**
 * 密钥脱敏（redaction）：把会话持久化/回放路径里的密钥形状文本替换为占位符。
 *
 * 对标 Codex「secrets redacted from displayed commands/replayed history」——
 * 防止 API key、Bearer token、私钥等通过会话 JSONL、write-diff sidecar 泄漏到
 * 磁盘或历史回放里。默认开启（config `redactSecrets: false` 关闭）。
 *
 * 设计原则：
 *  - 只匹配「明显的密钥形状」（前缀/长度/字符集），不误伤普通代码；
 *  - 递归遍历结构化消息（content 可能是字符串或 parts 数组）；
 *  - 纯函数，可在任意端调用（session 落盘、事件记录、测试）。
 */

/** 替换占位符（与 sandbox 的 __OMNI_MASKED__ 区分：这是持久化层脱敏） */
export const REDACTED = '[REDACTED]';

let enabled = true;

/** 配置开关（loadConfig 时调用；默认开） */
export function setSecretRedaction(value: boolean): void {
  enabled = value;
}

export function secretRedactionEnabled(): boolean {
  return enabled;
}

/** 常见密钥形状（按顺序应用；替换保留可读前缀，如 `Bearer [REDACTED]`） */
const PATTERNS: Array<[RegExp, string | ((...args: any[]) => string)]> = [
  // 私钥块（RSA/EC/OPENSSH/PGP…）：整块替换
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`],
  // OpenAI / Anthropic / Moonshot 等：sk-… / sk-ant-… / sk-proj-…
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g, REDACTED],
  // Bearer token（保留 Bearer 前缀）
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REDACTED}`],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // GitHub tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  // GitLab PAT
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // Slack
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  // Google API key
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, REDACTED],
  // 环境变量/JSON 字段风格：KEY/TOKEN/SECRET/PASSWORD = <tokenish>
  [
    /\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*)\s*[:=]\s*(["']?)([A-Za-z0-9_\-./+=]{8,})\2/g,
    (match, name, quote, value) => {
      // 值必须同时含字母与数字（排除 process.env.NAME、长单词等误伤）
      if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return match;
      // 排除已知占位符/引用样式
      if (/^\.|^env\.|REDACTED|MASKED/i.test(value)) return match;
      return `${name}=${quote}${REDACTED}${quote}`;
    },
  ],
];

/** 对单段文本脱敏（导出给事件记录等直接使用） */
export function redactText(text: string): string {
  if (!enabled || !text) return text;
  let out = text;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement as any);
  }
  return out;
}

/** 递归脱敏任意值（对象/数组/字符串；用于消息体，避免 JSON 序列化后被破坏） */
export function redactDeep<T>(value: T): T {
  if (!enabled) return value;
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}

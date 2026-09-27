/**
 * 会话 retained 警告（codex /warnings + F2 对等：TUI `WarningEntry` retained 历史）。
 * 行式终端没有警告视图——启动期 MCP 建连失败、未信任目录降级、代理失败等
 * 打印一次即滚走；这里进程级保留（上限 50），`/warnings` 随时回看。
 * 无依赖（tools/main 均可 import，无循环）。
 */
export interface SessionWarning {
  /** 警告来源（mcp/trust/network/…，展示用短标签） */
  source: string;
  /** 警告正文（纯文本一两句，不带 ANSI） */
  message: string;
  /** 产生时间（Date.now） */
  time: number;
}

const MAX_WARNINGS = 50;
const warnings: SessionWarning[] = [];

/** 追加一条会话警告（超上限丢最旧） */
export function pushWarning(source: string, message: string): void {
  const text = `${message ?? ''}`.trim();
  if (!text) return;
  warnings.push({ source: source || 'warn', message: text, time: Date.now() });
  while (warnings.length > MAX_WARNINGS) warnings.shift();
}

/** retained 警告快照（调用方只读；/warnings 渲染用） */
export function sessionWarnings(): SessionWarning[] {
  return [...warnings];
}

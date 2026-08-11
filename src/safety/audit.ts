/**
 * 审计日志：每次工具调用（含审批结果）追加落盘。
 *
 * 位置：$XDG_CONFIG_HOME/omni/audit.log（默认 ~/.config/omni/audit.log）。
 * 由 Safety.record 调用（fire-and-forget，不阻塞 Agent 主循环）。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 审计日志路径（尊重 XDG_CONFIG_HOME） */
export function auditLogPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', 'audit.log');
}

export interface AuditEntry {
  /** 工具名 */
  tool: string;
  /** 人类可读参数摘要（formatToolCall） */
  summary: string;
  /** 决策：allow / approved / rejected / deny:<原因> */
  decision: string;
  /** 执行结果（有执行时）：是否成功 */
  ok?: boolean;
  /** 返回字符数 */
  chars?: number;
}

let dirReady: Promise<void> | null = null;

/** 确保日志目录存在（只做一次） */
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(path.dirname(auditLogPath()), { recursive: true }).then(
      () => undefined,
      () => undefined // 目录创建失败 → 审计静默跳过（不打扰主流程）
    );
  }
  return dirReady;
}

/** 写一条审计记录（异步追加；失败静默——审计不能拖垮主流程） */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await ensureDir();
    const ts = new Date().toISOString();
    const line = `[${ts}] ${entry.decision}\ttool=${entry.tool}\tsummary=${JSON.stringify(entry.summary)}` +
      (entry.ok !== undefined ? `\tok=${entry.ok}` : '') +
      (entry.chars !== undefined ? `\tchars=${entry.chars}` : '') +
      '\n';
    await appendFile(auditLogPath(), line, 'utf8');
  } catch {
    // 审计失败不打扰主流程
  }
}

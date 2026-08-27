/**
 * 会话状态 / 上下文 / 导出 / 诊断 等命令的共享逻辑（/status /context /export /doctor /config）。
 *
 * 纯函数/无 UI：TUI commands.ts 与 CLI interactive.ts 双端复用，只返回文本行，
 * 由调用方决定 pushLine / console.log。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { OmniConfig } from '../config/index.js';
import { formatTokenCount, type ContextWindowInfo } from '../config/model-context.js';
import type { TokenUsage } from '../output/types.js';

/** /status 的输入（调用方从 state / runOpts 组装） */
export interface StatusInput {
  model: string;
  permission: string;
  planMode: boolean;
  reasoningEffort?: string;
  /** token 用量（console 模式不跟踪可不传） */
  tokens?: TokenUsage;
  /** 会话文件路径（无会话持久化 = null） */
  sessionPath?: string | null;
  /** 已加载的脚手架 system 消息（记忆/技能/预载），用于提示当前上下文构成 */
  scaffolds: { memory: boolean; skills: boolean; preload: boolean };
  /** 已加载的项目记忆文件路径清单（嵌套各层级；/status 展示） */
  memoryFiles?: string[];
  /** 是否已加载全局记忆 */
  globalMemory?: boolean;
  /** OS 级沙箱档位（'off' 或缺省不显示） */
  sandbox?: string;
  /** 工作区是否受信任（未信任 → 只读降级，显示警示） */
  trusted?: boolean;
  /** 当前生效的上下文窗口（数据源自动档：手动配置 > models.dev 查表 > 兑底） */
  contextWindow?: ContextWindowInfo;
}

/** 从消息里提取已加载记忆文件的路径清单（`[项目记忆 AGENTS.md：<path>]` 前缀） */
export function memoryFilesFromMessages(messages: ChatCompletionMessageParam[]): string[] {
  return messages
    .filter((m): m is ChatCompletionMessageParam & { content: string } =>
      m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[项目记忆')
    )
    .map((m) => {
      const mm = m.content.match(/\[项目记忆 AGENTS\.md：(.+?)\]/);
      return mm ? mm[1] : null;
    })
    .filter((x): x is string => !!x);
}

/** /status：一行汇总当前会话状态 */
export function statusReport(s: StatusInput): string[] {
  const lines = [
    `当前会话状态：`,
    `· 模型：${s.model}`,
    `· 权限：${s.permission}${s.planMode ? '（计划模式）' : ''}${s.trusted === false ? '（未信任目录 → 只读）' : ''}`,
    `· 思考级别：${s.reasoningEffort || '（未设置，用模型默认）'}`,
    ...(s.contextWindow ? [`· 上下文窗口：${formatTokenCount(s.contextWindow.value)} tokens（${s.contextWindow.label}）`] : []),
    s.tokens
      ? `· token 用量：${s.tokens.total}（prompt ${s.tokens.prompt} + completion ${s.tokens.completion}）`
      : '· token 用量：（console 模式不跟踪，TUI 底部显示）',
  ];
  if (s.sandbox && s.sandbox !== 'off') lines.push(`· 沙箱：${s.sandbox}`);
  if (s.sessionPath) lines.push(`· 会话文件：${path.basename(s.sessionPath)}`);
  lines.push(
    `· 上下文脚手架：${[
      s.scaffolds.memory ? '记忆' : null,
      s.scaffolds.skills ? '技能' : null,
      s.scaffolds.preload ? '预载文件' : null,
    ]
      .filter(Boolean)
      .join(' / ') || '无'}`
  );
  // 嵌套 AGENTS.md 清单（渐进披露增强）：展示每层文件路径
  if (s.memoryFiles && s.memoryFiles.length > 0) {
    const globalMark = s.globalMemory ? '（+ 全局记忆）' : '';
    lines.push(`· 项目记忆文件（${s.memoryFiles.length} 层${globalMark}）：`);
    for (const f of s.memoryFiles) lines.push(`  · ${f}`);
  } else if (s.globalMemory) {
    lines.push('· 项目记忆文件：无（已加载全局记忆）');
  }
  return lines;
}

/** /context：上下文用量（消息数 + token 估算 + 已加载脚手架 + 压缩建议 + 窗口占比） */
export function contextReport(
  messages: ChatCompletionMessageParam[],
  summarizeAt: number,
  contextWindow?: ContextWindowInfo,
  compressRatio?: number
): string[] {
  const scaffold = messages.filter(
    (m): m is ChatCompletionMessageParam & { content: string } =>
      m.role === 'system' && typeof m.content === 'string' && /^\[(项目记忆|全局记忆|已发现技能|已按任务预载)/.test(m.content)
  );
  const users = messages.filter((m) => m.role === 'user').length;
  const assistants = messages.filter((m) => m.role === 'assistant').length;
  const tools = messages.filter((m) => m.role === 'tool').length;
  const chars = messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
    0
  );
  // 粗略 token 估算：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token——取 2 字符/token 折中
  const estTokens = Math.round(chars / 2);
  const lines = [
    `上下文：${messages.length} 条消息（user ${users} · assistant ${assistants} · tool ${tools}）`,
    `· 文本量约 ${estTokens} token（按字符估算，含脚手架）`,
    `· 已加载脚手架：${scaffold.length > 0 ? scaffold.map((m) => m.content.split('\n')[0]).join('、') : '无'}`,
  ];
  if (contextWindow) {
    const pct = Math.min(100, Math.round((estTokens / contextWindow.value) * 100));
    const budget = Math.floor(contextWindow.value * (compressRatio ?? 0.7));
    lines.push(`· 模型窗口：${formatTokenCount(contextWindow.value)} token（${contextWindow.label}）`);
    lines.push(`· 压缩预算：估算 ≈ ${pct}% 窗口${budget > 0 ? `，超过 ${Math.round(budget)} token（× ${(compressRatio ?? 0.7).toFixed(2)} 占比）自动压缩` : '（自动按占比触发关闭）'}`);
  }
  if (summarizeAt > 0) {
    lines.push(
      messages.length > summarizeAt
        ? `· 已超过自动压缩阈值 ${summarizeAt}，建议 /compact 压缩旧消息`
        : `· 距自动压缩阈值 ${summarizeAt} 还差 ${summarizeAt - messages.length} 条（/compact 可手动压缩）`
    );
  }
  return lines;
}

/** 脚手架 system 前缀（记忆/技能/预载）——与 session.ts 的 SKIP_PREFIXES 保持一致 */
const SCAFFOLD_PREFIXES = ['[项目记忆', '[全局记忆', '[已发现技能', '[已按任务预载'] as const;

/** 检查 messages 里是否已注入某类脚手架 system 消息 */
export function scaffoldLoaded(messages: ChatCompletionMessageParam[], prefix: string): boolean {
  return messages.some(
    (m): boolean =>
      m.role === 'system' && typeof m.content === 'string' && (m.content as string).startsWith(prefix)
  );
}

/** /status 用：从 messages 检测已加载脚手架 */
export function detectScaffolds(messages: ChatCompletionMessageParam[]): {
  memory: boolean;
  skills: boolean;
  preload: boolean;
} {
  return {
    memory: scaffoldLoaded(messages, '[项目记忆') || scaffoldLoaded(messages, '[全局记忆'),
    skills: scaffoldLoaded(messages, '[已发现技能'),
    preload: scaffoldLoaded(messages, '[已按任务预载'),
  };
}

/** /export：把当前会话导出为 Markdown 文件（.omni/ 目录），返回文件路径 */
export function exportSession(
  messages: ChatCompletionMessageParam[],
  cwd: string
): string | null {
  const dir = path.join(cwd, '.omni');
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `export-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
    const roleLabel: Record<string, string> = {
      system: '系统',
      user: '用户',
      assistant: '助手',
      tool: '工具',
    };
    const md: string[] = ['# Omni 会话导出', ''];
    for (const m of messages) {
      if (typeof m.content !== 'string' || !m.content) continue;
      const c: string = m.content;
      // 脚手架 system 消息（记忆/技能/预载）不导出
      if (m.role === 'system' && SCAFFOLD_PREFIXES.some((p) => c.startsWith(p))) continue;
      md.push(`## ${roleLabel[m.role] ?? m.role}`, '', '```', c, '```', '');
    }
    writeFileSync(file, md.join('\n'), 'utf8');
    return file;
  } catch {
    return null;
  }
}

/** 当前生效的配置文件路径（按优先级返回候选，文件类 source；环境变量/CLI 不是文件） */
export function configFileCandidates(cfg: OmniConfig): string[] {
  const out: string[] = [];
  const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const global = path.join(home, 'omni', 'omni.json');
  if (existsSync(global)) out.push(global);
  const custom = process.env.OMNI_CONFIG;
  if (custom && existsSync(custom)) out.push(path.resolve(custom));
  return out;
}

/** /config：列出配置文件候选 + 打开编辑器（console 模式传入 editor 才真正 spawn，TUI 只给路径） */
export function configReport(cfg: OmniConfig): string[] {
  const lines = [`配置文件（按优先级）：`, `· 全局：${path.join(os.homedir(), '.config', 'omni', 'omni.json')}`];
  const project = existsSync(path.join(process.cwd(), 'omni.json'))
    ? 'omni.json'
    : existsSync(path.join(process.cwd(), 'omni.jsonc'))
      ? 'omni.jsonc'
      : null;
  lines.push(`· 项目：${project ? path.join(process.cwd(), project) : '（无，可复制 omni.example.jsonc 创建）'}`);
  lines.push(`· 自定义：${process.env.OMNI_CONFIG || '（未设置 OMNI_CONFIG）'}`);
  lines.push(`· 配置来源：${cfg.sources.join(' → ')}`);
  return lines;
}

/** 用 $EDITOR（缺省 vi）打开文件；返回是否成功启动 */
export function openInEditor(file: string): boolean {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const r = spawnSync(editor, [file], { stdio: 'inherit' });
  return r.error === undefined;
}

/** /doctor：环境诊断（node/bun/API Key/端点连通性/配置/MCP/技能/会话） */
export async function doctorReport(cfg: OmniConfig): Promise<string[]> {
  const lines = [`环境诊断：`];
  lines.push(`· Node：${process.version}${process.execPath}`);
  const bun = spawnSync('bun', ['--version'], { timeout: 5000 });
  lines.push(`· Bun：${bun.error ? '未安装（TUI 打包/原生二进制需要）' : bun.stdout.toString().trim()}`);
  lines.push(`· API Key：${cfg.apiKey ? '已配置（' + cfg.apiKey.slice(0, 4) + '…）' : '未配置！设置 OMNI_API_KEY 或配置文件 apiKey'}`);
  // 端点连通性：GET baseURL/models，任何 HTTP 响应（含 404）都算可达
  if (cfg.baseURL) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/models`, { signal: ctrl.signal });
      clearTimeout(timer);
      lines.push(`· 端点可达：${cfg.baseURL}（HTTP ${res.status}）`);
    } catch {
      lines.push(`· 端点不可达：${cfg.baseURL}（5 秒超时/连接失败）`);
    }
  }
  lines.push(
    `· 配置来源：${cfg.sources.length > 0 ? cfg.sources.join(' → ') : '（仅默认值）'}`,
    `· MCP 服务器：${cfg.mcpServers ? Object.keys(cfg.mcpServers).length : 0} 个配置`,
    `· 权限档位：${cfg.permission} · 子代理：${cfg.allowSubagents ? `启用（步数上限 ${cfg.maxSubagentSteps}）` : '关闭'}`,
    `· 思考级别：${cfg.reasoningEffort || '（未设置）'} · 支持选项：${
      cfg.reasoningEffortOptions?.length
        ? cfg.reasoningEffortOptions.join(' / ')
        : '自动（按模型数据源推导）'
    }`,
    `· 模型：${cfg.model}${cfg.models ? ` + 配置端点 ${Object.keys(cfg.models).length} 个` : ''}`
  );
  return lines;
}

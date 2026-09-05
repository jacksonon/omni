/**
 * 轨迹投影层（阶段 1，纯函数——console/web 文本账本消费）。
 *
 * 设计：**事件日志是唯一事实源**（`src/agent/events.ts` 的 TrajEvent 序列），
 * 本文件只做**派生投影**——把事件序列折叠成人类可读的轨迹行（TraceRow），
 * 不持有状态、不依赖 UI。
 *
 * 折叠规则（foldTrace，按事件流式累积，输出按 seq 有序）：
 *   · turn/start → 开一回合（后续事件归入该回合；turn 号单调递增）
 *   · turn/end   → 回合收尾（reason 附在回合行尾；未配对 = 进行中）
 *   · user/message → 用户行（interrupt 标记 ↑）
 *   · request/header → 记为请求步（step 索引；tools 为空 = 纯对话请求）
 *   · assistant/message → 回答步（正文首行 + usage/耗时副信息）
 *   · tool/call + tool/result → 按 callId 配对成工具步（结果未到 = 进行中）
 *   · compact → 压缩行（移除 N 条）
 *
 * 行类型（TraceRow.kind）：
 *   · turn    回合标题（含结果标记：✓ 完成 / ⚠ 中止 / ✗ 错误 / ⌛ 超步数）
 *   · user    用户消息
 *   · request LLM 请求
 *   · answer  assistant 消息
 *   · tool    工具调用
 *   · subagent 子代理生命周期（第六节 P1：嵌套树——start/step/end 折叠成一行
 *             带缩进与完成标记，text 前缀按 depth 画树形连接线）
 *   · compact 上下文压缩
 *   · empty   空白分隔
 */
import type { TrajEvent } from './events.js';

/** 轨迹行类型 */
export type TraceRowKind = 'turn' | 'user' | 'request' | 'answer' | 'tool' | 'subagent' | 'compact' | 'empty';

/** 折叠后的一条轨迹行 */
export interface TraceRow {
  kind: TraceRowKind;
  /** 所属回合号（turn/start 行本身也算该回合） */
  turn: number;
  /** 主要文本（已本地格式化；工具步 = `工具名 摘要参数`） */
  text: string;
  /** 副文本（一行右侧或下一行的补充信息；可为空串） */
  sub?: string;
  /** 该步耗时 ms（assistant llmMs / tool call→result 间隔）；null = 未知 */
  durMs?: number | null;
  /** 轮结束标记（回合行专用） */
  done?: string;
  /** 展开详情（点击详情/账本 full 模式用）；undefined = 无详情 */
  detail?: string[];
}

/** 轮结束标记映射（reason → 展示字符） */
const REASON_MARK: Record<string, string> = {
  completed: '✓',
  aborted: '⚠',
  error: '✗',
  'max-steps': '⌛',
};

/** 毫秒格式化（本地展示用；<10s 一位小数，≥10s 整数，≥60s 分:秒） */
export function fmtMs(ms: number): string {
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/** 单事件 → 文本（request/header、user 等的首行摘要） */
function eventText(e: TrajEvent): string {
  switch (e.k) {
    case 'user/message':
      return e.text.split('\n')[0];
    case 'request/header':
      return `${e.tools.length > 0 ? e.tools.join(' · ') : '对话请求'} · ${e.messages} 条消息`;
    case 'assistant/message':
      return e.text.split('\n')[0] || '（无正文）';
    case 'tool/call': {
      let args: string;
      try {
        const obj = JSON.parse(e.args);
        const key = ['path', 'command', 'query', 'name'].find((k) => typeof obj?.[k] === 'string');
        args = key ? obj[key] : JSON.stringify(obj);
      } catch {
        args = e.args;
      }
      return `${e.name} ${args}`;
    }
    case 'tool/result':
      return `${e.ok ? '✓' : '✗'} ${e.chars} 字符`;
    case 'compact':
      return `上下文压缩 · 移除 ${e.removed} 条`;
    case 'subagent/start':
      return `子代理 ${e.name} · ${e.task.split('\n')[0]}`;
    case 'subagent/end':
      return `${e.ok ? '✓' : '✗'} ${e.steps} 步 · ${fmtMs(e.durationMs)}`;
    default:
      return e.k;
  }
}

/**
 * 事件序列 → 轨迹行（纯函数，无副作用）。
 * 工具步按 callId 配对：call 开步（result 未到 = durMs null）、result 填耗时/字数。
 */
export function foldTrace(events: TrajEvent[]): TraceRow[] {
  const rows: TraceRow[] = [];
  let curTurn = 0;
  const toolByCall = new Map<string, { step: number; name: string; args: string; time: number }>();
  // 子代理（第六节 P1）：id → 当前折叠行下标 + 信息（step 事件更新进度、end 收尾）
  const subById = new Map<string, { rowIdx: number; depth: number; name: string }>();
  /** 按 depth 画树形缩进：`└─ ` 一层一层（子代理嵌套树） */
  const indent = (depth: number, mark: string): string => `${'  '.repeat(depth)}${depth > 0 ? mark : ''}`;

  for (const e of events) {
    switch (e.k) {
      case 'turn/start':
        curTurn = e.turn;
        rows.push({ kind: 'turn', turn: curTurn, text: `轮 ${curTurn}`, done: undefined });
        break;
      case 'turn/end':
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].kind === 'turn' && rows[i].turn === e.turn) {
            rows[i].done = REASON_MARK[e.reason] ?? '?';
            if (e.detail) rows[i].detail = [e.detail];
            break;
          }
        }
        break;
      case 'user/message':
        rows.push({
          kind: 'user',
          turn: curTurn,
          text: (e.source === 'interrupt' ? '↑ ' : '') + eventText(e),
          // 多行正文的其余行做详情（点击展开查看完整内容）
          detail: e.text.split('\n').length > 1 ? e.text.split('\n').slice(1) : undefined,
        });
        break;
      case 'request/header':
        rows.push({
          kind: 'request',
          turn: curTurn,
          text: eventText(e),
          // 完整工具列表做详情（text 首行可能被面板截断）
          detail: e.tools.length > 0 ? [`调用工具: ${e.tools.join(' · ')}`] : undefined,
        });
        break;
      case 'assistant/message': {
        const head = eventText(e);
        const sub: string[] = [];
        if (e.usage) {
          const parts = [`入 ${e.usage.input}`, `出 ${e.usage.output}`];
          if (e.usage.cached > 0) parts.push(`缓存 ${e.usage.cached}`);
          sub.push(parts.join(' · '));
        }
        sub.push(`LLM ${fmtMs(e.llmMs)}${e.firstTokenMs != null ? ` · 首 token ${fmtMs(e.firstTokenMs)}` : ''}`);
        const bodyLines = e.text.split('\n');
        rows.push({
          kind: 'answer',
          turn: curTurn,
          text: head,
          sub: sub.join(' · '),
          durMs: e.llmMs,
          // 完整正文其余行做详情（首行 + 截断后点击展开全文）
          detail: bodyLines.length > 1 ? bodyLines.slice(1) : undefined,
        });
        break;
      }
      case 'tool/call':
        toolByCall.set(e.callId, { step: e.step, name: e.name, args: e.args, time: e.time });
        rows.push({
          kind: 'tool',
          turn: curTurn,
          text: eventText(e),
          durMs: null,
          // 完整参数 JSON 做详情（text 只取首个字符串字段）
          detail: [e.args],
        });
        break;
      case 'tool/result': {
        const call = toolByCall.get(e.callId);
        if (!call) break; // 结果先于 call（异常）→ 忽略
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (r.kind === 'tool' && r.turn === curTurn && r.text.startsWith(call.name + ' ')) {
            r.durMs = e.time - call.time;
            r.sub = `${e.ok ? '✓' : '✗'} ${e.chars} 字符 · ${fmtMs(e.time - call.time)}`;
            break;
          }
        }
        break;
      }
      case 'compact':
        rows.push({ kind: 'compact', turn: curTurn, text: eventText(e) });
        break;
      case 'subagent/start':
        // 嵌套树根节点：带缩进的行（深度用树形连接线表达）；detail 存完整任务文本
        rows.push({
          kind: 'subagent',
          turn: curTurn,
          text: `${indent(e.depth, '└─ ')}${e.name} · ${e.task.split('\n')[0] || '（委托任务）'}`,
          detail: e.task.split('\n').length > 1 ? e.task.split('\n').slice(1) : undefined,
        });
        subById.set(e.id, { rowIdx: rows.length - 1, depth: e.depth, name: e.name });
        break;
      case 'subagent/step': {
        // 更新进行中的子代理行：`⠋ 步 N/M`（同 id 行内更新，不新增行）
        const s = subById.get(e.id);
        if (!s) break;
        const row = rows[s.rowIdx];
        if (row && row.kind === 'subagent') {
          row.text = `${indent(s.depth, '└─ ')}${s.name} · ⠋ 步 ${e.step}/${e.maxSteps}`;
        }
        break;
      }
      case 'subagent/end': {
        // 收尾：`✓/✗ N 步 · 耗时`（完成标记 + 结果摘要做 detail）
        const s = subById.get(e.id);
        if (!s) break;
        const row = rows[s.rowIdx];
        if (row && row.kind === 'subagent') {
          row.text = `${indent(s.depth, '└─ ')}${s.name} · ${e.ok ? '✓' : '✗'} ${e.steps} 步 · ${fmtMs(e.durationMs)}`;
          row.sub = e.summary.split('\n')[0] || undefined;
          row.detail = [...(row.detail ?? []), ...e.summary.split('\n').slice(1).filter(Boolean)];
        }
        subById.delete(e.id);
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

/** 相邻非 empty 行之间插空行（账本排版用；连续 turn 行只在首个前插） */
export function withSeparators(rows: TraceRow[]): TraceRow[] {
  const out: TraceRow[] = [];
  let prevKind = '';
  for (const r of rows) {
    if (r.kind === 'empty') continue;
    if (out.length > 0 && r.kind !== prevKind && !(prevKind === 'turn' && r.kind === 'turn')) {
      out.push({ kind: 'empty', turn: r.turn, text: '' });
    }
    out.push(r);
    prevKind = r.kind;
  }
  return out;
}

/**
 * 轨迹账本文本（console `/trace` 用；每行一行 TraceRow）。
 * 回合行：`轮 1 ✓`；用户/回答/工具带缩进；工具步含耗时。
 */
export function buildTraceTextLines(events: TrajEvent[], opts: { full?: boolean } = {}): string[] {
  const rows = foldTrace(events);
  const lines: string[] = [];
  for (const r of withSeparators(rows)) {
    switch (r.kind) {
      case 'empty':
        lines.push('');
        break;
      case 'turn':
        lines.push(`${r.text}${r.done ? ' ' + r.done : ''}`);
        break;
      case 'user':
        lines.push(`  ❯ ${r.text}`);
        break;
      case 'request':
        lines.push(`  · ${r.text}`);
        break;
      case 'answer':
        lines.push(`  · ${r.text}`);
        if (opts.full && r.sub) lines.push(`      ${r.sub}`);
        break;
      case 'tool':
        lines.push(`  · ${r.text}${r.sub ? '  ' + r.sub : ''}`);
        if (opts.full && r.detail) for (const d of r.detail) lines.push(`      ${d}`);
        break;
      case 'subagent':
        // 子代理嵌套树（text 已含缩进树形线）：主行 + 副行（结果摘要）+ 详情（完整任务/摘要）
        lines.push(`  · ${r.text}${r.sub ? '  ' + r.sub : ''}`);
        if (opts.full && r.detail) for (const d of r.detail) lines.push(`      ${d}`);
        break;
      case 'compact':
        lines.push(`  · ${r.text}`);
        break;
    }
  }
  return lines;
}

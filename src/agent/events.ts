/**
 * 轨迹事件层（阶段 1，对标 deepseek-harness 的 SessionEvent 时间线日志思路）。
 *
 * 核心设计：**append-only 事件日志是唯一事实源**——消息历史 / 轨迹账单（/trace）
 * 均为派生投影。事件带 `s`（seq，单调连续，恢复后从历史最大值继续）与 `time`
 * （epoch ms）；类型覆盖一轮 Agent 运行的全部关键节点：
 *
 *   · turn/start | turn/end —— 轮生命周期（end 带 reason：completed/aborted/error/max-steps）
 *   · user/message           —— 用户消息（source：user 用户提交 / interrupt steer 打断）
 *   · request/header         —— 每轮 LLM 请求快照（工具名列表 + 消息数；轻量版，不存全文）
 *   · assistant/message      —— 完成的消息（正文 + usage + LLM 墙钟 / 首 token 延迟）
 *   · tool/call | tool/result—— 工具调用配对（callId = OpenAI 工具调用 id，天然配对）
 *   · compact                —— 上下文摘要压缩（移除 N 条）
 *
 * 持久化：事件行以 `{"t":"ev","e":{...}}` 追加进**现有会话文件**（与 `{"t":"m"}`
 * 消息行共存）——loadSession 只处理 meta/m 行、天然跳过，恢复逻辑零改动；
 * 恢复时 EventRecorder.open 从文件读回历史事件（seq 续号），轨迹面板/账本无缝衔接。
 *
 * 驱动方：**loop.ts**（主循环直驱，不依赖 Output/UI——单任务模式也记录）；
 * flush 时机由交互循环的 persistTurn 携带（每轮对话结束落盘一次，批量追加）。
 */
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** 轮结束原因（对标 dsh 的 completed/aborted/blocked/error/max-tokens，按 omni 语义精简） */
export type TrajTurnReason = 'completed' | 'aborted' | 'error' | 'max-steps';

interface TrajBase {
  /** 全局单调序号（恢复历史后续号，永不重复） */
  s: number;
  /** epoch ms */
  time: number;
}

/** 一次 LLM 请求的 token 用量（assistant/message 携带） */
export interface TrajUsage {
  input: number;
  cached: number;
  output: number;
}

export type TrajEvent =
  | (TrajBase & { k: 'turn/start'; turn: number })
  | (TrajBase & { k: 'turn/end'; turn: number; reason: TrajTurnReason; detail?: string })
  | (TrajBase & { k: 'user/message'; text: string; source: 'user' | 'interrupt' })
  | (TrajBase & {
      k: 'assistant/message';
      step: number;
      text: string;
      usage?: TrajUsage;
      llmMs: number;
      firstTokenMs: number | null;
    })
  | (TrajBase & { k: 'tool/call'; step: number; callId: string; name: string; args: string })
  | (TrajBase & { k: 'tool/result'; callId: string; ok: boolean; chars: number })
  | (TrajBase & { k: 'request/header'; step: number; model: string; tools: string[]; messages: number })
  | (TrajBase & { k: 'compact'; removed: number });

/** 事件（去元数据版，供记录入参使用）：分发保留 k 判别——`Omit<联合, ...>` 会把
 *  联合折叠成单对象类型（keyof 是并集），对象字面量判别失效；distribute 后逐成员 Omit */
type StripMeta<U> = U extends unknown ? Omit<U, 's' | 'time'> : never;
type PushEvent = StripMeta<TrajEvent>;

/**
 * 事件记录器：内存累积（轨迹投影源）+ 批量落盘（会话文件追加 `{"t":"ev"}` 行）。
 * 单任务模式无会话文件 → 仍记录内存（供 eval 等复用），flush 为 no-op。
 */
export class EventRecorder {
  /** 全部事件（含恢复的历史；阶段 2 轨迹投影直接读它） */
  events: TrajEvent[] = [];
  /** 当前轮号（turn/start 递增；恢复后从历史最大值继续） */
  turn = 0;

  private seq = 0;
  private flushed = 0;

  constructor(
    readonly file?: string | null,
    /** 实时事件监听（headless stream-json 输出用：每个事件立即回调） */
    private onEvent?: (e: TrajEvent) => void
  ) {}

  /** 打开记录器（可选会话文件 + 实时事件监听）：读回历史事件 + seq/turn 续号 */
  static async open(file?: string | null, onEvent?: (e: TrajEvent) => void): Promise<EventRecorder> {
    const rec = new EventRecorder(file, onEvent);
    if (file && existsSync(file)) {
      try {
        const raw = await readFile(file, 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // 损坏行跳过
          }
          const e = parsed?.e;
          if (parsed?.t === 'ev' && e && typeof e.s === 'number' && typeof e.k === 'string') {
            rec.events.push(e as TrajEvent);
            if (e.s > rec.seq) rec.seq = e.s;
            if (e.k === 'turn/start' && typeof e.turn === 'number') {
              rec.turn = Math.max(rec.turn, e.turn);
            }
          }
        }
      } catch {
        // 读失败静默（不打扰恢复流程）
      }
    }
    rec.flushed = rec.events.length;
    return rec;
  }

  private push(e: PushEvent): void {
    const ev = { ...e, s: ++this.seq, time: Date.now() } as TrajEvent;
    this.events.push(ev);
    // headless stream-json：每个事件实时输出（不落盘也触发——单任务模式无会话文件）
    this.onEvent?.(ev);
  }

  /** 轮开始（runAgent 开头调用一次；返回本轮号——loop 打断继续时轮号不变） */
  turnStart(): number {
    this.turn += 1;
    this.push({ k: 'turn/start', turn: this.turn });
    return this.turn;
  }

  turnEnd(reason: TrajTurnReason, detail?: string): void {
    this.push({ k: 'turn/end', turn: this.turn, reason, ...(detail ? { detail } : {}) });
  }

  /** 用户消息（source=interrupt 表示 steer 打断插入当前轮） */
  user(text: string, source: 'user' | 'interrupt' = 'user'): void {
    this.push({ k: 'user/message', text: text.slice(0, 2000), source });
  }

  /** 每轮 LLM 请求快照（step 轮次 / model / 可调工具名列表 / 消息数） */
  requestHeader(step: number, model: string, tools: string[], messages: number): void {
    this.push({ k: 'request/header', step, model, tools, messages });
  }

  assistant(
    step: number,
    text: string,
    usage: TrajUsage | undefined,
    llmMs: number,
    firstTokenMs: number | null
  ): void {
    this.push({
      k: 'assistant/message',
      step,
      text: text.slice(0, 4000),
      ...(usage ? { usage } : {}),
      llmMs,
      firstTokenMs,
    });
  }

  toolCall(step: number, callId: string, name: string, args: string): void {
    this.push({ k: 'tool/call', step, callId, name, args: args.slice(0, 1000) });
  }

  toolResult(callId: string, ok: boolean, chars: number): void {
    this.push({ k: 'tool/result', callId, ok, chars });
  }

  compact(removed: number): void {
    this.push({ k: 'compact', removed });
  }

  /** 把尚未落盘的事件批量追加进会话文件（失败静默——轨迹丢失不影响会话恢复） */
  async flush(): Promise<void> {
    if (!this.file || this.flushed >= this.events.length) return;
    const lines = this.events.slice(this.flushed).map((e) => JSON.stringify({ t: 'ev', e }));
    try {
      await appendFile(this.file, lines.join('\n') + '\n', 'utf8');
      this.flushed = this.events.length; // 写成功才推进（失败下次重试）
    } catch {
      // 静默失败（不打扰对话）
    }
  }
}
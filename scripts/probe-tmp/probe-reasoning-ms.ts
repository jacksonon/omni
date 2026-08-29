/**
 * 探针：思考耗时持久化与恢复回放（stats-restore D2/D4）
 * 1. buildAssistantMessage 传给 reasoning + reasoningMs → assistant 消息落盘带两字段；
 *    stripNonStandardFields 剥离两字段（不发 API）。
 * 2. TuiOutput.onThinkingRestored(text, ms) → 回放 thinking 块（内容 + 耗时头行）。
 * 3. onThinkingRestored 缺 ms → 无耗时（旧会话）。
 */
import { buildAssistantMessage, stripNonStandardFields } from '../../src/agent/messages.js';
import { TuiOutput } from '../../src/tui/output.js';
import { createTuiState } from '../../src/tui/state.js';

let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
}

// ---- 1. 组装 + 剥离 ----
const toolCalls = new Map<number, { id: string; name: string; args: string }>();
const msg = buildAssistantMessage('正文回答', toolCalls, '我先分析任务', 4321) as unknown as Record<string, unknown>;
check('assistant 消息带 reasoning', msg.reasoning === '我先分析任务');
check('assistant 消息带 reasoningMs=4321', msg.reasoningMs === 4321);
// reasoning 空 / ms 空 → 不挂 reasoningMs
const noMs = buildAssistantMessage('正文', toolCalls, '思考') as unknown as Record<string, unknown>;
check('ms 缺省不挂 reasoningMs', noMs.reasoningMs === undefined);
const noReason = buildAssistantMessage('正文', toolCalls) as unknown as Record<string, unknown>;
check('无 reasoning 不挂字段', noReason.reasoning === undefined && noReason.reasoningMs === undefined);
check('ms<=0 不挂', (buildAssistantMessage('正文', toolCalls, '思考', -5) as unknown as Record<string, unknown>).reasoningMs === undefined);

// 剥离：带两字段 → 剥离两字段；无 reasoning → 原样返回（同引用）
const stripped = stripNonStandardFields([{ role: 'assistant', content: '正文' } as never].map(
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment */
  () => msg as never
));
check('strip 剥离 reasoning', (stripped[0] as unknown as Record<string, unknown>).reasoning === undefined);
check('strip 剥离 reasoningMs', (stripped[0] as unknown as Record<string, unknown>).reasoningMs === undefined);
const raw = [{ role: 'assistant', content: '正文' } as never];
check('无 reasoning 的消息 strip 原样返回', stripNonStandardFields(raw)[0] === raw[0]);

// ---- 2. TuiOutput 回放 ----
const state = createTuiState();
const session = { paint: async () => {} } as never;
const out = new TuiOutput(state, { showThinking: true }, session as never);
out.onThinkingRestored('历史思考内容\n第二行', 2500);
const restored = state.lines.filter((l) => l.kind === 'thinking');
check('onThinkingRestored 回放 thinking 块', restored.length === 1, `count=${restored.length}`);
const tl = restored[0];
check('thinking 块内容=历史思考', tl.text === '历史思考内容\n第二行');
check('thinking 块 thinkingMs=2500（耗时头行）', tl.thinkingMs === 2500);
check('thinking 块已结束（非 running）', tl.thinkingRunning !== true);

// 缺 ms（旧会话）→ thinkingMs undefined（无耗时头行）
const state2 = createTuiState();
const out2 = new TuiOutput(state2, { showThinking: true }, session as never);
out2.onThinkingRestored('旧思考');
const oldest = state2.lines.find((l) => l.kind === 'thinking');
check('旧会话（无 ms）thinkingMs undefined', oldest && oldest.thinkingMs === undefined);

// showThinking=false → 不回放思考（与实时行为对齐）
const state3 = createTuiState();
const out3 = new TuiOutput(state3, { showThinking: false }, session as never);
out3.onThinkingRestored('不应显示', 100);
check('showThinking=false 不回放思考', !state3.lines.some((l) => l.kind === 'thinking'));

console.log(failed === 0 ? '\n探针全部通过 ✓' : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
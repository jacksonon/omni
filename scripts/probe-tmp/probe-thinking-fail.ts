/**
 * 探针：create 失败/取消后 thinkingShown 残留 → 下一轮 thinking 模块行为
 * 直接驱动 TuiOutput 事件序列（等价 loop 失败路径）。
 */
import { TuiOutput } from '../../src/tui/output.js';
import { createTuiState } from '../../src/tui/state.js';

const state = createTuiState();
const session = { paint: async () => {} } as never;
const out = new TuiOutput(state, { showThinking: true }, session as never);

// 模拟 create 失败：onRound（预建空行）→ onRequestFailed（无 finishThinking——loop 229 分支）
out.onRound(0, 5);
out.onRequestFailed(new Error('Connection error'));
console.log('--- 失败后 ---');
state.lines.forEach((l, i) => console.log(`[${i}] ${l.kind} ${JSON.stringify(l.text?.slice(0, 40))}`));

// 下一轮用户发消息
out.onUserMessage('再来一次');
out.onRound(1, 5);
// 本轮思考内容到达
out.thinking.write('这一轮的思考内容');
out.thinking.write('，继续补充');
out.thinking.finish();
console.log('--- 下一轮后 ---');
state.lines.forEach((l, i) => console.log(`[${i}] ${l.kind} ${JSON.stringify(l.text?.slice(0, 40))}`));

const thinking = state.lines.filter((l) => l.kind === 'thinking');
const content = thinking.filter((l) => l.text.includes('这一轮的思考内容'));
console.log(`\nthinking 行数: ${thinking.length}，含本轮内容: ${content.length > 0}`);
console.log('thinkingShown 残留: ' + (out.thinking as unknown as { shown: boolean }).shown);

if (content.length > 0 && thinking.length === 1) {
  console.log('✓ 失败路径：本轮思考内容保留');
} else {
  console.log(`✗ 异常：${thinking.length > 1 ? '残留空行未清（多个 thinking 行）' : '本轮思考内容丢失'}`);
}

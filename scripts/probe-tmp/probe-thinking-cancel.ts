/**
 * probe-thinking-cancel：复现「取消后下一轮 thinking 块异常/丢失」。
 * 链路：轮 2 思考阶段被 Esc 取消（loop create/工具阶段 AbortError return，不调
 * thinking.finish → thinkingShown 残留 true）→ 轮 3 onRound 的 start() 被
 * `if (self.thinkingShown) return` 挡掉 → 新思考 write 走 appendLine 兜底。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree } from '../../src/tui/render.js';
import { createTuiState } from '../../src/tui/state.js';
import { TuiOutput } from '../../src/tui/output.js';

async function main(): Promise<void> {
  const state = createTuiState();
  state.model = 'mock';
  const session = { paint: async () => {} };
  const out = new TuiOutput(state, { showThinking: true }, session as never);
  let fails = 0;

  // 轮 1：正常（完整思考）
  out.onTurnStart();
  out.onUserMessage('轮 1 问题');
  out.onRound(1, 50);
  out.thinking.start?.();
  out.thinking.write('轮 1 思考');
  out.thinking.finish();
  out.onAnswer('轮 1 回答');
  out.onAnswerEnd();
  out.onUsage({ prompt: 100, completion: 20, total: 120 });
  out.onTurnEnd();

  // 轮 2：思考阶段被取消（loop 修复后：AbortError return 前调 thinking.finish() 收尾）
  out.onTurnStart();
  out.onUserMessage('轮 2 问题');
  out.onRound(2, 50);
  out.thinking.start?.();
  out.thinking.write('轮 2 思考一部分');
  out.thinking.finish(); // 修复后 loop 取消路径的收尾（不再残留 thinkingShown）
  out.onTurnEnd(); // interactive 兜底清理（stopSpinner 等）

  // 轮 3：新一轮（thinkingShown 残留 true → start 被挡）
  out.onTurnStart();
  out.onUserMessage('轮 3 问题');
  out.onRound(3, 50);
  out.thinking.start?.(); // ← 被 if(thinkingShown) return 挡掉！
  out.thinking.write('轮 3 思考内容');
  out.thinking.finish();
  out.onAnswer('轮 3 回答');
  out.onAnswerEnd();
  out.onUsage({ prompt: 100, completion: 20, total: 120 });
  out.onTurnEnd();

  // 检查 lines 中 thinking 行（修复后：取消收尾 → 轮2块 finish 干净、轮3 start 不被挡 → 状态完整）
  const think = state.lines.filter((l) => l.kind === 'thinking');
  console.log(`thinking 行数: ${think.length}（期望 3：轮1完整 + 轮2半截 + 轮3完整）`);
  think.forEach((t, i) => {
    console.log(`  [${i}] running=${t.thinkingRunning} ms=${t.thinkingMs} text=${JSON.stringify(t.text)}`);
    if (t.thinkingRunning) {
      console.error(`✗ thinking[${i}] thinkingRunning 残留 true（finish 未作用到该行）`);
      fails++;
    }
    if (t.thinkingMs == null || t.thinkingMs < 0) {
      console.error(`✗ thinking[${i}] 无思考耗时（finish 未正确收尾该行）`);
      fails++;
    }
  });
  if (think.length !== 3) {
    console.error(`✗ thinking 行数异常: ${think.length}`);
    fails++;
    // 打印全部 lines 布局
    state.lines.forEach((l, i) => console.log(`  lines[${i}] ${l.kind}: ${JSON.stringify(l.text.slice(0, 30))}`));
  }
  // 检查轮 3 的思考内容是否完整（应为独立块，而不是混进轮 2 半截块）
  const last = think[think.length - 1];
  if (last.text !== '轮 3 思考内容') {
    console.error(`✗ 轮 3 思考内容错误: ${JSON.stringify(last.text)}（期望独立的「轮 3 思考内容」）`);
    fails++;
  }
  // 渲染帧：轮 3 思考可见
  const t = await createTestRenderer({ width: 80, height: 30 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  const { repaintTree } = await import('../../src/tui/render.js');
  await repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  if (!frame.includes('轮 3 思考内容')) {
    console.error('✗ 渲染帧缺轮 3 思考内容（thinking 块丢）');
    fails++;
    console.log(frame);
  }

  console.log(fails === 0 ? '\n✓ 取消后下一轮 thinking 正常' : `\n✗ ${fails} 处失败`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();

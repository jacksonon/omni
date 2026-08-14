import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { TuiOutput } from '../../src/tui/output.js';

async function main(): Promise<void> {
  const t = await createTestRenderer({ width: 64, height: 30 });
  const s = createTuiState();
  const tree = mountTree(t.renderer, s, { withInput: true });
  const out = new TuiOutput(s, { showThinking: true }, {
    paint: async () => { repaintTree(t.renderer, tree, s, { withInput: true }); await t.renderOnce(); },
  } as never);

  // 真实事件序列：用户消息 → 思考1（流式）→ 工具步骤（running）→ 工具结果 → 思考2 → 回答
  out.onUserMessage('你好');
  out.thinking.write('我需要先分析任务，');
  out.thinking.write('然后规划执行步骤。');
  out.thinking.finish();
  out.onToolStep(0, 10, 'run_command', '$ echo mock-ok');
  out.onToolResult(true, 14, ['退出码: 0', 'mock-ok']);
  out.thinking.write('命令执行成功，');
  out.thinking.write('现在总结结果。');
  out.thinking.finish();
  out.onAnswer('任务完成。');
  out.onAnswerEnd();
  await out.flush();

  t.captureCharFrame().split('\n').forEach((l, i) => console.log(`${String(i).padStart(2)}: [${l}]`));
  process.exit(0);
}
main();

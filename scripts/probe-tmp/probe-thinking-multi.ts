/**
 * probe-thinking-multi：复现「对话轮次一多，thinking 区域块总会丢」。
 * 模拟真实 loop 事件序列（多轮：user → onRound 预建 thinking → write → finish →
 * 工具卡片 → answer → tokens/meta），逐轮检查 state.lines 中 thinking 行与渲染帧。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree } from '../../src/tui/render.js';
import { createTuiState } from '../../src/tui/state.js';
import { TuiOutput } from '../../src/tui/output.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const state = createTuiState();
  state.model = 'mock';
  const session = { paint: async () => {} };
  const out = new TuiOutput(state, { showThinking: true }, session as never);
  let fails = 0;

  const ROUNDS = 5;
  for (let r = 1; r <= ROUNDS; r++) {
    out.onTurnStart();
    out.onUserMessage(`第 ${r} 轮问题`);
    out.onRound(1, 50);
    out.thinking.start?.();
    await sleep(5); // spinner 帧间隙（真实环境思考前等待）
    out.thinking.write(`第 ${r} 轮思考内容第一段\n第二段`);
    out.thinking.finish();
    out.onToolStep(r, 50, 'list_directory', '* List .');
    out.onToolResult(true, 42, ['55 个文件']);
    out.onAnswer(`第 ${r} 轮回答`);
    out.onAnswerEnd();
    out.onUsage({ prompt: 100 + r, completion: 20 + r, total: 120 + r * 2 });
    out.onTurnEnd();
  }

  // 1) lines 里 thinking 行数应为 ROUNDS（每轮一个非空思考块）
  const thinkLines = state.lines.filter((l) => l.kind === 'thinking');
  console.log(`thinking 行数: ${thinkLines.length}（期望 ${ROUNDS}）`);
  if (thinkLines.length !== ROUNDS) {
    console.error(`✗ 有 thinking 行丢失！lines=${state.lines.length}`);
    fails++;
  }
  // 2) 每行内容完整
  for (let i = 0; i < thinkLines.length; i++) {
    const t = thinkLines[i];
    const expect = `第 ${i + 1} 轮思考内容第一段\n第二段`;
    if (t.text !== expect) {
      console.error(`✗ thinking[${i}] 内容错误: ${JSON.stringify(t.text)}（期望 ${JSON.stringify(expect)}）`);
      fails++;
    }
    if (t.thinkingRunning) {
      console.error(`✗ thinking[${i}] 未 finish（thinkingRunning 残留 true）`);
      fails++;
    }
  }
  // 3) 渲染帧：最新思考块头行 + 内容可见（视口内尾部窗口）
  const t = await createTestRenderer({ width: 80, height: 30 });
  const tree = mountTree(t.renderer, state, { withInput: true });
  const { repaintTree } = await import('../../src/tui/render.js');
  await repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  const hasHead = frame.includes('- thinking');
  const hasContent = frame.includes('第 5 轮思考内容第一段');
  const hasAnswer = frame.includes('第 5 轮回答');
  console.log(`帧: - thinking=${hasHead} · 第5轮思考内容=${hasContent} · 第5轮回答=${hasAnswer}`);
  if (!hasHead || !hasContent || !hasAnswer) {
    console.error('✗ 渲染帧缺 thinking 头行/内容（thinking 区域块丢）');
    fails++;
    console.log(frame);
  }
  // 4) 每行实际下标与状态（排查错位）
  state.lines.forEach((l, i) => {
    if (l.kind === 'thinking') console.log(`  lines[${i}] thinking: running=${l.thinkingRunning} ms=${l.thinkingMs} text=${JSON.stringify(l.text.slice(0, 20))}`);
  });

  console.log(fails === 0 ? '\n✓ 多轮正常流程 thinking 不丢' : `\n✗ ${fails} 处失败`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();

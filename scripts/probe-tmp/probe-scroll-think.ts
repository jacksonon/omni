/**
 * probe-scroll-think：验证「上滚残留 → 新轮次 thinking 不可见（丢）」及修复。
 * 多轮后内容超视口 → 用户上滚（scrollTop=0）→ 新一轮 thinking 在视口外（丢）；
 * 修复 A（pending/steer 回底）后 scrollTop 置 null → 最新 thinking 重新可见。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree } from '../../src/tui/render.js';
import { createTuiState, pushLine } from '../../src/tui/state.js';
import { computeRows } from '../../src/tui/rows.js';

async function main(): Promise<void> {
  const state = createTuiState();
  state.model = 'mock';
  let fails = 0;
  // 5 轮内容：每轮 user + thinking（含长内容）+ answer（超视口）
  for (let r = 1; r <= 5; r++) {
    pushLine(state, { kind: 'user', text: `第 ${r} 轮问题` });
    pushLine(state, {
      kind: 'thinking',
      text: `第 ${r} 轮思考内容 `.repeat(8),
      thinkingRunning: false,
      thinkingMs: 100,
    });
    pushLine(state, { kind: 'answer', text: `第 ${r} 轮回答` });
    pushLine(state, { kind: 'meta', text: '' });
  }
  const height = 20;
  const width = 80;

  // 1) 跟随模式：最新 thinking（第 5 轮）可见
  state.scrollTop = null;
  let rows = computeRows(state, { height, width }, { withInput: true });
  let frameText = rows.map((r) => r.text).join('\n');
  console.log(`跟随模式: 第5轮思考可见=${frameText.includes('第 5 轮思考内容')} 第5轮回答可见=${frameText.includes('第 5 轮回答')}`);
  if (!frameText.includes('第 5 轮思考内容')) { console.error('✗ 跟随模式最新思考不可见'); fails++; }

  // 2) 上滚（scrollTop=0 看历史）→ 最新思考被裁出视口（用户视角「丢」）
  state.scrollTop = 0;
  rows = computeRows(state, { height, width }, { withInput: true });
  frameText = rows.map((r) => r.text).join('\n');
  console.log(`上滚模式: 第5轮思考可见=${frameText.includes('第 5 轮思考内容')} 首行可见=${frameText.includes('第 1 轮问题')}`);
  if (frameText.includes('第 5 轮思考内容')) { console.error('✗ 上滚后最新思考仍可见（窗口未上移）'); fails++; }
  // 修复 A 模拟：新消息开始回底
  state.scrollTop = null;
  rows = computeRows(state, { height, width }, { withInput: true });
  frameText = rows.map((r) => r.text).join('\n');
  console.log(`回底后: 第5轮思考可见=${frameText.includes('第 5 轮思考内容')}`);
  if (!frameText.includes('第 5 轮思考内容')) { console.error('✗ 回底后最新思考仍不可见'); fails++; }

  // 3) 渲染帧（跟随）：最新思考块头行 + 内容完整
  const t = await createTestRenderer({ width, height });
  const tree = mountTree(t.renderer, state, { withInput: true });
  const { repaintTree } = await import('../../src/tui/render.js');
  await repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  console.log(`渲染帧: - thinking=${frame.includes('- thinking')} 第5轮内容=${frame.includes('第 5 轮思考内容')}`);
  if (!frame.includes('第 5 轮思考内容')) { console.error('✗ 渲染帧最新思考不可见'); fails++; }

  console.log(fails === 0 ? '\n✓ 上滚残留语义确认（修复 A 回底后新内容可见）' : `\n✗ ${fails} 处失败`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();

/** 模型 sheet 的实际渲染与共享命令路由回归；无 API key、不连接用户 broker。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { closeMenu, handleMenuKey, openModelMenu, pickRemoteMenu } from '../src/tui/commands-menus.js';
import { mountTree, repaintTree, handleTuiMouseEvent, type TuiKey } from '../src/tui/render.js';
import { modelMenuRows } from '../src/tui/rows.js';
import { createTuiState, pushLine } from '../src/tui/state.js';
import { themeFor } from '../src/tui/theme.js';
import { visualWidth } from '../src/tui/width.js';
import { runRemoteCommand } from '../src/server/terminal.js';
import type { ServerSession } from '../src/server/client.js';
import type { Output } from '../src/output/types.js';

const key = (name: string) => ({ name } as TuiKey);
const names = ['deepseek-v4.1-flash-1017', 'gemma4:31b', 'nemotron-3-ultra', 'mimo-v2.6:9b',
  'mimo-v2.6:9b-q4_K_M', 'deepseek-v4.1-flash', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna',
  'commandcode/meta/muse-spark-1.3-contributor'];
const endpoints = names.map(name => ({ name, provider: 'wanmei' }));

async function main(): Promise<void> {
  for (const mode of ['dark', 'light'] as const) {
    for (const [width, height] of [[96, 32], [64, 24], [36, 20], [48, 24]]) {
      const test = await createTestRenderer({ width, height });
      try {
        const state = createTuiState();
        state.themeMode = mode;
        state.model = names[8]!;
        state.provider = 'wanmei';
        if (width === 48) {
          state.language = 'en';
          pushLine(state, { kind: 'user', text: 'Existing conversation' });
        }
        const historyCount = state.lines.length;
        const result = pickRemoteMenu(state, '/model', names, state.model, endpoints);
        const tree = mountTree(test.renderer, state, { withInput: true });
        await test.renderOnce();
        assert.equal(state.ask, null);
        assert.equal(state.menu!.options[state.menu!.selectedIndex]!.value, `wanmei\u0000${state.model}`);
        const frame = test.captureCharFrame();
        assert.ok(frame.includes(width === 48 ? 'current' : '当前'));
        assert.ok(frame.includes('gpt-6-luna'));
        assert.ok(!frame.includes('[ ]') && !frame.includes('单选') && !frame.includes('自定义'));
        const spans = test.captureSpans();
        const selected = spans.lines.flatMap(line => line.spans).find(span => span.text.includes('gpt-6-luna') && span.bg.toInts()[2] === 235);
        assert.ok(selected, '选中项必须实际渲染整行蓝底');
        assert.deepEqual(selected.fg.toInts().slice(0, 3), [255, 255, 255]);
        const rows = modelMenuRows(state.menu!, width - 3, 'zh', 4, themeFor(state));
        assert.ok(rows.every(row => visualWidth(row.text) <= width - 3));
        assert.ok((tree.menuOverlay!.top as number) >= 1);
        assert.ok(tree.menuOverlay!.screenY + tree.menuOverlay!.height < tree.footerBox!.screenY);
        const dir = process.env.OMNI_UI_REVIEW_DIR;
        if (dir && width === 96) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `model-${mode}.json`), JSON.stringify({
            cols: spans.cols, rows: spans.rows,
            lines: spans.lines.map(line => line.spans.map(span => ({
              text: span.text, width: span.width, fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes,
            }))),
          }));
        }
        // 长列表走到末项，再缩窄窗口，点击映射必须仍对应实际选项。
        handleMenuKey(key('down'), state);
        repaintTree(test.renderer, tree, state, { withInput: true });
        await test.renderOnce();
        const last = state.menu!.selectedIndex;
        assert.equal(state.menu!.options[last]!.value, `wanmei\u0000${names[9]}`);
        test.resize(Math.max(32, width - 10), height);
        repaintTree(test.renderer, tree, state, { withInput: true });
        await test.renderOnce();
        const row = tree.menuRowMap.indexOf(last);
        assert.ok(row >= 0);
        handleTuiMouseEvent({ type: 'down', button: 0, x: tree.menuOverlay!.screenX + 3,
          y: tree.menuOverlay!.screenY + row }, tree, state, width - 10, async () => {});
        assert.equal(await result, names[9]);
        assert.equal(state.model, names[8], '服务端确认前不改变本地模型');
        const cancelled = pickRemoteMenu(state, '/model', names, state.model, endpoints);
        handleMenuKey(key('escape'), state);
        assert.equal(await cancelled, null);
        assert.equal(state.lines.length, historyCount);
      } finally { test.renderer.destroy(); }
    }
  }
  const state = createTuiState();
  state.model = names[8]!; // provider 缺失时仍能选中分组后的当前模型。
  openModelMenu(state, names, endpoints);
  assert.equal(state.menu!.currentValue, `wanmei\u0000${names[8]}`);
  const commands: string[] = [];
  const remote = { status: { model: names[8], models: endpoints, permission: 'safe' },
    command: async (command: string) => { commands.push(command); return ['switched']; } } as unknown as ServerSession;
  const output = { askUser: () => { throw new Error('/model 不应使用 ask_user'); } } as unknown as Output;
  const run = () => runRemoteCommand(remote, '/model', output, (_title, values, current, head) =>
    pickRemoteMenu(state, head, values, current, endpoints));
  const confirmed = run();
  assert.equal(commands.length, 0);
  handleMenuKey(key('down'), state);
  handleMenuKey(key('return'), state);
  assert.deepEqual(await confirmed, ['switched']);
  assert.deepEqual(commands, [`/model ${names[9]}`]);
  const cancelled = run();
  closeMenu(state);
  assert.deepEqual(await cancelled, []);
  assert.equal(commands.length, 1, '取消不发送任何命令');
  console.log('TUI model sheet: light/dark, long names, grouped current, scrolling, resize, mouse, remote confirm/cancel passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

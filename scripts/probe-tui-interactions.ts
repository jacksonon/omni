/** TUI 交互审计回归：实际渲染、命中范围、长提问窗口、跨类交互取消和共享状态。 */
import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { handleMenuKey, openModelMenu } from '../src/tui/commands-menus.js';
import { mountTree, repaintTree, handleTuiMouseEvent, onAskKeyPress, type TuiKey, type TuiSession } from '../src/tui/render.js';
import { createTuiState, pushLine } from '../src/tui/state.js';
import { TuiOutput } from '../src/tui/output.js';
import { syncRemoteTuiState } from '../src/tui/remote-state.js';
import { runTuiInteractive } from '../src/tui/interactive.js';
import type { ServerSession } from '../src/server/client.js';
import type { RunOptions } from '../src/agent/types.js';

const key = (name: string, sequence = '') => ({ name, sequence, preventDefault: () => {} } as TuiKey);
const pause = () => new Promise<void>(resolve => queueMicrotask(resolve));
const request = (name: string) => ({ tool: name, summary: name, reason: 'test' });

async function main(): Promise<void> {
  for (const mode of ['light', 'dark'] as const) {
    for (const height of [20, 24, 32]) {
      const test = await createTestRenderer({ width: 64, height });
      try {
        const state = createTuiState(); state.themeMode = mode;
        state.ask = { question: '请选择会话', options: Array.from({ length: 30 }, (_, i) => `会话 ${i + 1}`),
          multiple: true, selected: new Set(), custom: '', cursor: 0 };
        const tree = mountTree(test.renderer, state, { withInput: true });
        await test.renderOnce();
        const checkFrame = () => {
          const lines = test.captureCharFrame().split('\n');
          assert.ok(lines.some(line => line.includes('确认')) && lines.some(line => line.includes('自定义')));
          const confirm = [...tree.askRects].find(([, action]) => action.kind === 'confirm')![0];
          assert.ok(confirm >= 0 && confirm < height);
          assert.ok(lines[confirm]!.includes('确认'), '确认命中行须对应实际渲染位置');
          assert.ok(tree.footerBox!.screenY + tree.footerBox!.height <= height, '输入区须在视口内');
        };
        checkFrame();
        state.ask.cursor = 29;
        repaintTree(test.renderer, tree, state, { withInput: true }); await test.renderOnce();
        checkFrame();
        assert.ok(test.captureCharFrame().includes('会话 30'));
        const last = [...tree.askRects].find(([, action]) => action.idx === 29)![0];
        handleTuiMouseEvent({ type: 'down', button: 0, x: 0, y: last }, tree, state, 64, async () => {});
        assert.equal(state.ask.selected.size, 0, '面板外同一行点击不能勾选');
        handleTuiMouseEvent({ type: 'down', button: 0, x: 10, y: last }, tree, state, 64, async () => {});
        assert.ok(state.ask.selected.has(29));
        onAskKeyPress(key('', '中😀'), state, tree, () => {});
        assert.equal(state.ask.cursor, 30);
        onAskKeyPress(key('backspace'), state, tree, () => {});
        assert.equal(state.ask.custom, '中');
        onAskKeyPress(key('home', '\x1b[H'), state, tree, () => {});
        assert.equal(state.ask.custom, '中', '导航控制序列不能进入自定义文本');
        state.ask = null;
        state.model = 'a'; openModelMenu(state, ['a', 'b']);
        repaintTree(test.renderer, tree, state, { withInput: true }); await test.renderOnce();
        const menuRow = tree.menuRowMap.indexOf(1);
        handleTuiMouseEvent({ type: 'down', button: 0, x: 0, y: tree.menuOverlay!.screenY + menuRow }, tree, state, 64, async () => {});
        assert.ok(state.menu); assert.equal(state.model, 'a');
        assert.equal(handleMenuKey(key('x', 'x'), state), true, '模态菜单须消费未识别按键');
        state.menu = null; tree.input!.setText('/');
        repaintTree(test.renderer, tree, state, { withInput: true }); await test.renderOnce();
        const suggestY = tree.suggestRect!.top + tree.suggestRowMap.findIndex(index => index >= 0);
        handleTuiMouseEvent({ type: 'down', button: 0, x: 0, y: suggestY }, tree, state, 64, async () => {});
        assert.equal(tree.input!.plainText, '/', '联想面板外点击不能回填命令');
      } finally { test.renderer.destroy(); }
    }
  }
  const state = createTuiState();
  const test = await createTestRenderer({ width: 80, height: 32 });
  const tree = mountTree(test.renderer, state, { withInput: true });
  const out = new TuiOutput(state, { showThinking: true }, { paint: async () => {} } as TuiSession);
  try {
    out.onTurnStart();
    const current = new AbortController(); const queued = new AbortController();
    const approval = out.requestApproval(request('one'), current.signal);
    const ask = out.askUser('queued ask', ['a', 'b'], false, queued.signal);
    assert.ok(state.approval); assert.equal(state.ask, null, '审批与提问不能同时显示');
    queued.abort(); assert.equal(await ask, null); assert.equal(state.approval!.tool, 'one');
    let secondSettled = false;
    const nextAsk = out.askUser('next ask', ['a', 'b'], false).then(value => { secondSettled = true; return value; });
    const stale = state.approvalResolve!;
    state.approvalResolve!(true);
    onAskKeyPress(key('return'), state, tree, () => {}); // 同一 keypress 的第二个监听器。
    assert.equal(secondSettled, false); assert.equal(state.ask, null);
    assert.equal(await approval, true); await pause();
    assert.equal(state.ask!.question, 'next ask');
    stale(false); assert.equal(state.ask!.question, 'next ask', '迟到旧 resolver 不得关闭下一张卡片');
    const nextApproval = out.requestApproval(request('two'));
    const cancelledAsk = out.askUser('cancelled queued ask', ['a', 'b'], false, queued.signal);
    assert.equal(await cancelledAsk, null);
    out.onTurnEnd();
    assert.equal(await nextAsk, null); assert.equal(await nextApproval, false); await pause();
    assert.equal(state.ask, null); assert.equal(state.approval, null);
    assert.equal(await out.requestApproval(request('already aborted'), queued.signal), false);
    const abortActive = new AbortController();
    const active = out.askUser('active ask', ['a', 'b'], false, abortActive.signal);
    const pendingApproval = out.requestApproval(request('three'));
    abortActive.abort(); assert.equal(await active, null); await pause();
    assert.equal(state.approval!.tool, 'three'); assert.equal(state.ask, null);
    state.approvalResolve!(false); assert.equal(await pendingApproval, false);
    const replayApprovalController = new AbortController(); const replayAskController = new AbortController();
    let replayResolved = false;
    const replayApproval = out.requestApproval(request('restored pending'), replayApprovalController.signal).then(value => { replayResolved = true; return value; });
    const replayAsk = out.askUser('restored queued ask', ['a', 'b'], false, replayAskController.signal);
    out.onAnswer('Previously completed history'); out.onAnswerEnd(); out.onTurnEnd(); await pause();
    assert.equal(replayResolved, false, '历史回放收尾不能拒绝正在等待的恢复审批');
    assert.equal(state.approval!.tool, 'restored pending');
    replayApprovalController.abort(); replayAskController.abort();
    assert.equal(await replayApproval, false); assert.equal(await replayAsk, null);
    const runOpts = { models: [], cfg: {} } as unknown as RunOptions;
    const remote = { id: 'remote-test', status: { model: 'new-model', models: [{ name: 'new-model', provider: 'new-provider' }],
      permission: 'read', reasoningEffort: 'low', reasoningEffortOptions: ['low'], activeVariant: 'fast',
      contextLimit: 64000, cwd: '/new/workspace', language: 'en', showThinking: false } } as unknown as ServerSession;
    pushLine(state, { kind: 'thinking', text: 'old thinking' });
    state.provider = 'old-provider';
    syncRemoteTuiState(remote, runOpts, state, out);
    assert.equal(state.provider, 'new-provider'); assert.equal(state.activeVariant, 'fast');
    assert.equal(state.cwd, '/new/workspace'); assert.equal(state.language, 'en');
    assert.equal(state.thinkingShow, false); assert.equal(out.showThinking, false);
    assert.equal(runOpts.showThinking, false); assert.equal(state.contextLimit, 64000);
    repaintTree(test.renderer, tree, state, { withInput: true }); await test.renderOnce();
    assert.ok(!test.captureCharFrame().includes('old thinking'));
    remote.status = { model: 'unknown', models: [], showThinking: true };
    syncRemoteTuiState(remote, runOpts, state, out);
    assert.equal(state.provider, ''); assert.equal(state.activeVariant, null); assert.equal(state.contextLimit, 0);
    remote.status = { model: 'old', models: [{ name: 'old' }, { name: 'new', reasoningEffort: 'medium', variant: 'stale' }], showThinking: true };
    const remoteOptions = { remote, models: remote.status.models, tools: [], context: { autoMemory: false }, cfg: {} } as unknown as RunOptions;
    const session = { input: tree.input, paint: async () => {}, onKeyPress: () => () => {} } as unknown as TuiSession;
    const interaction = runTuiInteractive({} as never, 'old', [], remoteOptions, out, session, state);
    await pause();
    remote.status = { ...remote.status, model: 'new', reasoningEffort: 'low', activeVariant: 'fast', contextLimit: 64000 };
    syncRemoteTuiState(remote, remoteOptions, state, out);
    state.applyModelSwitch!();
    assert.equal(state.reasoningEffort, 'low'); assert.equal(state.activeVariant, 'fast'); assert.equal(state.contextLimit, 64000);
    tree.input!.setText('/exit'); tree.input!.submit(); await interaction;
  } finally { await out.flush(); await pause(); test.renderer.destroy(); }
  console.log('TUI interactions: long ask windows, pointer bounds, modal keys, Unicode, cancellable serial prompts and remote state passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree, handleTuiMouseEvent } from '../src/tui/render.js';
import { createTuiState, pushLine } from '../src/tui/state.js';
import { OMNI_MARK_AXES, randomOmniMarkAxis, omniMarkFrame } from '../src/tui/omni-mark.js';
for (const height of [20, 32]) {
  const t = await createTestRenderer({ width: 80, height });
  const state = createTuiState();
  const tree = mountTree(t.renderer, state, { withInput: true });
  await t.renderOnce();
  const cell = tree.omniCells[0]!;
  assert.equal(tree.omniTitle!.visible, true);
  assert.ok(Math.abs(cell.screenX + cell.width / 2 - 40) <= 1);
  handleTuiMouseEvent({ type: 'down', button: 0, x: cell.screenX + 9, y: cell.screenY + 4 }, tree, state, 80, async () => {});
  assert.ok(state.markSpinStartedAt > 0);
  const click = () => handleTuiMouseEvent({ type: 'down', button: 0, x: cell.screenX + 9, y: cell.screenY + 4 }, tree, state, 80, async () => {});
  for (let i = 0; i < 30; i++) {
    const previous = state.markSpinAxis;
    click();
    assert.notEqual(state.markSpinAxis, previous);
  }
  for (const axis of OMNI_MARK_AXES) {
    assert.deepEqual(omniMarkFrame(1, axis), omniMarkFrame(0));
    assert.notDeepEqual(omniMarkFrame(0.13, axis), omniMarkFrame(0));
    const choices = new Set(Array.from({ length: 60 }, (_, i) => randomOmniMarkAxis(axis, () => i / 60)));
    assert.equal(choices.size, OMNI_MARK_AXES.length - 1);
    assert.ok(!choices.has(axis));
  }
  assert.notDeepEqual(omniMarkFrame(0), omniMarkFrame(0.25));
  state.markSpinStartedAt = Date.now() - 1300;
  repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  assert.ok(t.captureCharFrame().includes(omniMarkFrame()[4]!));
  pushLine(state, { kind: 'user', text: 'hello' });
  repaintTree(t.renderer, tree, state, { withInput: true });
  await t.renderOnce();
  assert.equal(tree.omniTitle!.visible, false);
  t.renderer.destroy();
}
console.log('Omni mark: centered, clickable, rotating, settled, hidden after conversation');

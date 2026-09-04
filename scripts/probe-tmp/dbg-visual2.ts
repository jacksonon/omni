import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState, pushLine, openCmdPanel, pushCmdLine } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { openThemeMenu } from '../../src/tui/commands.js';
// 1) 联想下拉（/m，无分组、空格分隔描述、贴输入区）
{
  const s = createTuiState(); s.version = '0.1.0'; s.model = 'mock';
  pushLine(s, { kind: 'user', text: 'hi' }); s.status = 'ok';
  const t = await createTestRenderer({ width: 64, height: 20 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  await t.renderOnce();
  tree.input?.setText('/m'); repaintTree(t.renderer, tree, s, { withInput: true }); await t.renderOnce();
  console.log('=== 联想 /m ===');
  console.log(t.captureCharFrame() as string);
}
// 2) 主题菜单面板
{
  const s = createTuiState(); s.version = '0.1.0'; s.model = 'mock';
  pushLine(s, { kind: 'user', text: 'hi' }); s.status = 'ok';
  openThemeMenu(s);
  const t = await createTestRenderer({ width: 64, height: 20 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  await t.renderOnce();
  console.log('=== 主题面板 ===');
  console.log(t.captureCharFrame() as string);
}
// 3) 命令输出面板
{
  const s = createTuiState(); s.version = '0.1.0'; s.model = 'mock';
  pushLine(s, { kind: 'user', text: 'hi' }); s.status = 'ok';
  openCmdPanel(s, '/status'); pushCmdLine(s, '模型 mock'); pushCmdLine(s, '权限 safe');
  const t = await createTestRenderer({ width: 80, height: 24 });
  mountTree(t.renderer, s, { withInput: true });
  await t.renderOnce();
  console.log('=== 命令面板 ===');
  console.log(t.captureCharFrame() as string);
}
// 4) hero 居中模式（无对话）+ 联想下拉：验证面板贴住居中灰块、宽度与输入区一致
{
  const s = createTuiState(); s.version = '0.1.0'; s.model = 'mock';
  const t = await createTestRenderer({ width: 64, height: 24 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  await t.renderOnce();
  tree.input?.setText('/m'); repaintTree(t.renderer, tree, s, { withInput: true }); await t.renderOnce();
  console.log('=== hero 联想 /m ===');
  console.log(t.captureCharFrame() as string);
}
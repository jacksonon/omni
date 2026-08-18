/**
 * Ctrl+C 行为探针：输入框有内容时清空输入框（不退出）；输入框为空/无输入框时才应退出。
 * 直接调用 handleCtrlCKey 纯函数（startTui 的 onCtrlC 注册的同一真实代码路径），
 * 并用真实 Textarea（mountTree 建树）验证 setText('') 清空生效。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, handleCtrlCKey } from '/Users/os/Downloads/omni/src/tui/render.js';
import { createTuiState } from '/Users/os/Downloads/omni/src/tui/state.js';

async function main() {
  let ok = true;
  const check = (cond: boolean, msg: string): void => {
    console.log(`${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) ok = false;
  };

  const t = await createTestRenderer({ width: 64, height: 24 });
  const state = createTuiState();

  // —— 交互模式（withInput）——
  const tree = mountTree(t.renderer, state, { withInput: true });
  const input: any = tree.input;
  const ctrlC = { name: 'c', sequence: '\x03', ctrl: true };
  const plainC = { name: 'c', sequence: 'c' };

  // 1. 非 Ctrl+C 按键 → null（不消费）
  check(handleCtrlCKey(plainC, input) === null, '普通 c 键返回 null（不消费）');

  // 2. 输入框有内容 + Ctrl+C → 'clear' 且输入框被清空
  input.setText('hello world');
  const r1 = handleCtrlCKey(ctrlC, input);
  check(r1 === 'clear', '输入框有内容时 Ctrl+C 返回 clear（不退出）');
  check(input.plainText === '', '输入框内容被清空');

  // 3. 清空后输入框为空 + Ctrl+C → 'exit'
  const r2 = handleCtrlCKey(ctrlC, input);
  check(r2 === 'exit', '输入框为空时 Ctrl+C 返回 exit（退出）');

  // 4. 多行内容同样整框清空
  input.setText('line1\nline2');
  const r3 = handleCtrlCKey(ctrlC, input);
  check(r3 === 'clear' && input.plainText === '', '多行内容同样整框清空');

  // —— 单任务模式（withInput=false，无输入框）——
  const tree2 = mountTree(t.renderer, createTuiState(), { withInput: false });
  check(tree2.input === null, '单任务模式无输入框');
  check(handleCtrlCKey(ctrlC, tree2.input) === 'exit', '无输入框时 Ctrl+C 返回 exit（退出）');

  if (!ok) {
    console.log('✗ 存在失败断言');
    process.exit(1);
  }
  console.log('✓ Ctrl+C 清空输入框探针全部通过');
  process.exit(0);
}
void main();

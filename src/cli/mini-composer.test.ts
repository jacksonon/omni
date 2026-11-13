import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { installMiniComposer } from './mini-composer.js';
import type { MiniInputKey } from './mini-input.js';

test('mini composer：@ 提及渲染内联文件菜单，Tab/Enter 插入并标记 miniHandled', () => {
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mc-mention-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export {}\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');

  const prevInTty = process.stdin.isTTY;
  const prevOutTty = process.stdout.isTTY;
  const origWrite = process.stdout.write;
  const origCols = (process.stdout as { columns?: number }).columns;
  const origRows = (process.stdout as { rows?: number }).rows;
  const outChunks: string[] = [];

  class FakeRl extends EventEmitter {
    line = '';
    cursor = 0;
    prevRows = 0;
    closed = false;
    getCursorPos() {
      return { rows: 0, cols: 2 + this.cursor };
    }
    _refreshLine() {}
    _ttyWrite(_s: string, _key?: MiniInputKey) {}
    _writeToOutput(_s: string) {}
  }

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  (process.stdout as { write: unknown }).write = ((chunk: string | Uint8Array) => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;

  process.chdir(dir);
  const rl = new FakeRl();
  let composer: ReturnType<typeof installMiniComposer> = null;
  try {
    composer = installMiniComposer(rl, () => ({ model: 'mock', plan: false, running: false }));
    assert.ok(composer, 'TTY 下应安装 mini composer');

    // 输入 `@` 后刷新，内联菜单应展示「文件」与 `@README.md` / `@src/`
    rl.line = '看 @';
    rl.cursor = rl.line.length;
    rl._refreshLine();
    const firstPaint = stripVTControlCharacters(outChunks.join(''));
    assert.ok(firstPaint.includes('文件'), '应展示内联 @ 文件菜单标题');
    assert.ok(firstPaint.includes('@src/'), '应包含目录候选');
    assert.ok(firstPaint.includes('tab/enter 插入'), '页脚提示应反映插入语义');

    // 用 down/enter 选中目录 `@src/`：插入时不加空格，继续保留菜单列出目录内容
    outChunks.length = 0;
    const enterKey: MiniInputKey = { name: 'return' };
    rl._ttyWrite('\r', enterKey);
    // 确认菜单首项是文件夹或文件，继续补输入 `@src/m` 后 Enter 插入 `src/main.ts `
    assert.equal(enterKey.miniHandled, true, 'Enter 选择 @ 候选用完应标记 miniHandled');
    assert.ok(rl.line.startsWith('看 @'), '应在行内插入而非提交发送');

    rl.line = '看 @src/m';
    rl.cursor = rl.line.length;
    outChunks.length = 0;
    const tabKey: MiniInputKey = { name: 'tab' };
    rl._ttyWrite('\t', tabKey);
    assert.equal(tabKey.miniHandled, true, 'Tab 选择 @ 候选用完应标记 miniHandled');
    assert.equal(rl.line, '看 @src/main.ts ', '文件候选插入后带尾空格');
  } finally {
    composer?.dispose();
    process.chdir(prevCwd);
    process.stdout.write = origWrite;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevInTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: prevOutTty, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: origCols, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

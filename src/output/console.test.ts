import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { ConsoleOutput } from './console.js';
import { createSpinner, isTTY } from '../ui.js';

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const origWrite = process.stdout.write;
  (process.stdout as { write: unknown }).write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join('');
}

test('ConsoleOutput：run_command 与 web_fetch 不产生孤立底边框，Bash 与 $ 之间保留空格', () => {
  const out = new ConsoleOutput({ showThinking: false, stream: true });
  const raw = captureStdout(() => {
    out.onToolStep(0, 10, 'run_command', '$ echo hello', { command: 'echo hello' }, 1);
    out.onToolResult(true, 5, ['hello', '退出码: 0'], undefined, 1);
    out.onToolStep(0, 10, 'web_fetch', '* Fetch https://example.com', { url: 'https://example.com' }, 2);
    out.onToolResult(true, 128, ['Example Domain'], undefined, 2);
  });
  const plain = stripVTControlCharacters(raw);
  assert.ok(plain.includes('● Bash $ echo hello'), 'Bash 与 $ 之间应有空格');
  assert.ok(plain.includes('│ hello'), '命令行输出应带 │ 前缀');
  assert.ok(plain.includes('✓ 执行成功 · 5 字符'), '命令行结果应清晰收敛');
  assert.ok(plain.includes('→ Explored — 1 fetch'), 'web_fetch 头部保留 Explored 风格');
  assert.ok(plain.includes('* Fetch https://example.com (128 chars)'), 'web_fetch 结果单行展示');
  assert.ok(!plain.includes('╰─'), 'run_command 与 web_fetch 不应输出无顶框的孤立底边框');
});

test('ConsoleOutput：并行工具按 toolSeq 乱序完成仍正确配对，且失败文件操作打印错误', () => {
  const out = new ConsoleOutput({ showThinking: false, stream: true });
  const raw = captureStdout(() => {
    out.onToolStep(0, 10, 'web_search', '* Search alpha', { query: 'alpha' }, 10);
    out.onToolStep(0, 10, 'web_search', '* Search beta', { query: 'beta' }, 11);
    // 11 先于 10 完成
    out.onToolResult(true, 20, ['res-beta'], undefined, 11);
    out.onToolResult(true, 15, ['res-alpha'], undefined, 10);
    // 失败的文件修改与读取
    out.onToolStep(1, 10, 'edit_file', '← Edit missing.ts', { path: 'missing.ts' }, 12);
    out.onToolResult(false, 22, ['错误：找不到要替换的文本'], undefined, 12);
    out.onToolStep(1, 10, 'read_file', '* Read none.ts', { path: 'none.ts' }, 13);
    out.onToolResult(false, 12, ['错误：文件不存在'], undefined, 13);
  });
  const plain = stripVTControlCharacters(raw);
  const betaIdx = plain.indexOf('* Search beta');
  const betaResIdx = plain.indexOf('res-beta');
  const alphaIdx = plain.indexOf('* Search alpha');
  const alphaResIdx = plain.indexOf('res-alpha');
  assert.ok(betaIdx >= 0 && betaResIdx > betaIdx, 'toolSeq=11 结果应紧随其自身卡片');
  assert.ok(alphaResIdx > betaResIdx && alphaResIdx > alphaIdx, 'toolSeq=10 晚到也应配回 * Search alpha');
  assert.ok(plain.includes('✗ 错误：找不到要替换的文本'), '失败的 edit_file 应输出错误摘要');
  assert.ok(plain.includes('✗ 错误：文件不存在'), '失败的 read_file 应输出错误摘要');
});

test('ConsoleOutput：onAnswerEnd 不在已换行或空答案后追加多余空行', () => {
  const out = new ConsoleOutput({ showThinking: false, stream: true });
  const raw = captureStdout(() => {
    out.onAnswerEnd(); // 无正文
    out.onAnswer('line1\n');
    out.onAnswerEnd();
  });
  assert.equal(raw, 'line1\n');
});

test('createSpinner：空消息 stop() 不向 stderr 多写换行', () => {
  if (!isTTY) return;
  const chunks: string[] = [];
  const origErr = process.stderr.write;
  (process.stderr as { write: unknown }).write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const sp = createSpinner('loading');
    chunks.length = 0;
    sp.stop('');
  } finally {
    process.stderr.write = origErr;
  }
  assert.equal(chunks.join(''), '\r\x1b[K');
});

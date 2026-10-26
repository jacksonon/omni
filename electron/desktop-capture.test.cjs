'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_IMAGE_BYTES, MAX_TEXT_CHARS, readClipboardPayload, chooseScreenSource, captureErrorMessage, normalizeDraft } = require('./desktop-capture.cjs');
const emptyImage = { isEmpty: () => true };
test('导入文本保留内容并显式标出截断，兼容异步 clipboard API', async () => {
  const source = '错误：missing SDK\n' + 'x'.repeat(MAX_TEXT_CHARS);
  const result = await readClipboardPayload({ readImage: async () => emptyImage, readText: async () => source });
  assert.equal(result.kind, 'text');
  assert.equal(result.content, source.slice(0, MAX_TEXT_CHARS));
  assert.equal(result.truncated, true);
  assert.equal(result.size, Buffer.byteLength(source));
});
test('图片优先且不会把同一次剪贴板的 URL 作为额外文本上传', async () => {
  let readText = false;
  const png = Buffer.from('clipboard png bytes');
  const result = await readClipboardPayload({ readImage: () => ({ isEmpty: () => false, toPNG: () => png }), readText: () => { readText = true; return 'https://example.com/image'; } });
  assert.equal(result.kind, 'image');
  assert.equal(result.dataUrl, 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(readText, false);
});
test('空剪贴板与超限图片返回可见错误', async () => {
  await assert.rejects(readClipboardPayload({ readImage: () => emptyImage, readText: () => '   ' }), /没有可导入/);
  await assert.rejects(readClipboardPayload({ readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(MAX_IMAGE_BYTES + 1) }) }), /超过 4MB/);
});
test('多显示器精确匹配，空截图或无法确定来源时不误截其它显示器', () => {
  const a = { display_id: '1', thumbnail: { isEmpty: () => false } }, b = { display_id: '2', thumbnail: { isEmpty: () => false } };
  assert.equal(chooseScreenSource([a, b], { id: 2 }), b);
  assert.equal(chooseScreenSource([{ ...a, display_id: '' }], { id: 2 }).display_id, '');
  assert.throws(() => chooseScreenSource([a, b], { id: 3 }), /无法获取/);
  assert.throws(() => chooseScreenSource([{ ...a, thumbnail: emptyImage }], { id: 1 }), /无法获取/);
});
test('截图权限拒绝、尚未授权与非 Error 异常都显示具体可操作的提示', () => {
  for (const status of ['denied', 'restricted', 'not-determined']) assert.match(captureErrorMessage(undefined, status, 'darwin'), /系统设置.*屏幕录制/);
  assert.match(captureErrorMessage('Failed to get sources', 'granted', 'darwin'), /Failed to get sources/);
  assert.match(captureErrorMessage({}, undefined, 'linux'), /系统未返回可用/);
  assert.doesNotMatch(captureErrorMessage({}, undefined, 'linux'), /undefined/);
});
test('工作区草稿完整保留文字、图片和文本附件，同时去除额外字段', () => {
  const result = normalizeDraft({ text: '请修这个报错', secret: 'unused', attachments: [{ id: 'local-id', kind: 'image', name: '截图.png', dataUrl: 'data:image/png;base64,YWJj', size: 3 }, { kind: 'text', name: '报错.txt', content: 'line 1\nline 2', size: 13 }] });
  assert.equal(result.text, '请修这个报错');
  assert.equal(result.attachments[0].dataUrl, 'data:image/png;base64,YWJj');
  assert.equal(result.attachments[1].content, 'line 1\nline 2');
  assert.equal(result.secret, undefined); assert.equal(result.attachments[0].id, undefined);
});
test('工作区草稿拒绝远端图片 URL、异常类型和超限内容', () => {
  const draft = attachments => ({ text: '', attachments });
  assert.throws(() => normalizeDraft(draft([{ kind: 'image', name: 'x', dataUrl: 'https://example.com/private.png' }])), /图片附件无效/);
  assert.throws(() => normalizeDraft(draft([{ kind: 'text', name: 'x', content: 'x'.repeat(MAX_TEXT_CHARS + 101) }])), /文字附件过大/);
  assert.throws(() => normalizeDraft(draft(Array.from({ length: 21 }, () => ({ kind: 'path', name: 'x' })))), /草稿过大/);
  assert.throws(() => normalizeDraft(draft([{ kind: 'file', name: '/secret' }])), /附件格式无效/);
});

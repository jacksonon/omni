'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SHORTCUT, DEFAULT_CLIPBOARD_SHORTCUT, normalizeSettings, fitBounds, isTrustedPage, workspaceUrl } = require('./bot-utils.cjs');
test('保存偏好排除未知字段并拒绝损坏的屏幕位置', () => {
  assert.deepEqual(normalizeSettings({ secret: 'unused', shortcut: '   ', botBounds: { x: NaN }, notifications: false }), { shortcut: DEFAULT_SHORTCUT, clipboardShortcut: DEFAULT_CLIPBOARD_SHORTCUT, openAtLogin: false, notifications: false });
  assert.deepEqual(normalizeSettings({ botBounds: { x: -12.2, y: 0, width: 720, height: 640 } }).botBounds, { x: -12, y: 0, width: 720, height: 640 });
});
test('剪贴板快捷键与普通唤起独立，旧设置自动补默认值', () => {
  assert.equal(normalizeSettings({ shortcut: 'Alt+X' }).clipboardShortcut, DEFAULT_CLIPBOARD_SHORTCUT);
  assert.equal(normalizeSettings({ clipboardShortcut: '  Alt+Y ' }).clipboardShortcut, 'Alt+Y');
  assert.equal(normalizeSettings({ clipboardShortcut: 'x'.repeat(121) }).clipboardShortcut, DEFAULT_CLIPBOARD_SHORTCUT);
});
test('拔掉外接屏后窗口仍完整位于主屏可用区域', () => {
  const area = { x: 0, y: 25, width: 1280, height: 695 };
  assert.deepEqual(fitBounds({ x: 4000, y: -200, width: 1900, height: 1200 }, area, true), area);
  const small = fitBounds(undefined, { x: -1920, y: 0, width: 1920, height: 1080 }, true);
  assert.ok(small.x < 0 && small.x + small.width <= 0);
  const compact = fitBounds(undefined, { x: 0, y: 25, width: 1280, height: 695 }, true, true);
  assert.ok(compact.width <= 720 && compact.height >= 150 && compact.height < 220, 'compact bot 是单输入框高度');
});
test('IPC 仅信任同源 workspace 页面，拒绝外站和伪造前缀', () => {
  const server = 'http://127.0.0.1:3080';
  assert.equal(isTrustedPage(server + '/w/abcd/?bot=1', server), true);
  for (const candidate of ['http://evil.example/w/abcd/', 'http://127.0.0.1:3081/w/abcd/', server + '/w/abcd-evil', server + '/other/', 'file:///etc/passwd']) assert.equal(isTrustedPage(candidate, server), false);
  assert.equal(workspaceUrl(server + '/w/project-1/?bot=1'), server + '/w/project-1');
});

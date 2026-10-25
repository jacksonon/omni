import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { canonicalWorkspace, workspaceId } from './discovery.js';
import { desktopCandidates } from '../cli/bot.js';

test('工作区键使用规范路径，符号链接不能启动第二个同目录 runtime', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'omni-workspace-key-'));
  try {
    const real = path.join(tmp, 'real'); mkdirSync(real);
    const link = path.join(tmp, 'link'); symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(workspaceId(canonicalWorkspace(real)), workspaceId(canonicalWorkspace(link)));
    assert.notEqual(workspaceId(canonicalWorkspace(tmp)), workspaceId(canonicalWorkspace(real)));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('bot 桌面入口显式配置优先，并覆盖 Windows 和 macOS 安装路径', () => {
  assert.equal(desktopCandidates('darwin', '/Users/test', { OMNI_DESKTOP_PATH: '/custom/omni.app' })[0], '/custom/omni.app');
  assert.ok(desktopCandidates('darwin', '/Users/test', {}).includes('/Applications/omni.app'));
  assert.ok(desktopCandidates('win32', 'C:\\Users\\test', { LOCALAPPDATA: 'C:\\Local' }).some((p) => p.endsWith('omni.exe')));
});

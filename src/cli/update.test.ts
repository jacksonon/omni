import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectUpdateInstallation, installBinaryUpdate, isNewerVersion, npmUpdateCommand, runUpdateCommand } from './update.js';
import { VERSION } from '../version.js';
import { completionScript } from './completion.js';

function fixture(t: TestContext): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'omni update test ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function asset(data: string) {
  return {
    name: `omni-${process.platform}-${process.arch}`,
    size: Buffer.byteLength(data),
    digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    browser_download_url: 'https://github.com/jacksonon/omni/releases/download/v999.0.0/' + `omni-${process.platform}-${process.arch}`,
  };
}

test('update：稳定版比较拒绝降级与非法版本，支持预发布转正式版', () => {
  assert.equal(isNewerVersion('0.10.0', '0.9.99'), true);
  assert.equal(isNewerVersion('0.9.7', '0.9.7'), false);
  assert.equal(isNewerVersion('0.9.7', '0.10.0'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.0-beta.1'), true);
  assert.throws(() => isNewerVersion('latest; exit 1', VERSION));
});

test('update：四种 shell 补全均提供命令及 --check', () => {
  for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
    const script = completionScript(shell)!;
    assert.match(script, /update/);
    assert.match(script, /--check/);
  }
});

test('update：识别 npm 嵌套/平铺平台包，保留前缀；本地安装、源码、Electron 不覆盖', t => {
  for (const nested of [true, false]) {
    const root = fixture(t);
    const modules = path.join(root, 'lib/node_modules');
    const packageDir = path.join(modules, '@right-ai/omni');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@right-ai/omni' }));
    const base = nested ? path.join(packageDir, 'node_modules') : modules;
    const binary = path.join(base, 'omnicode-darwin-arm64/bin/omnicode');
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, 'fake binary');
    const detected = detectUpdateInstallation(binary, '/$bunfs/root/omni', 'darwin', 'arm64', false);
    assert.deepEqual(detected, { kind: 'npm', prefix: root, packageDir });
  }
  const root = fixture(t);
  const standalone = path.join(root, 'omni');
  writeFileSync(standalone, 'fake binary');
  assert.deepEqual(detectUpdateInstallation(standalone, '/$bunfs/root/omni', 'darwin', 'arm64', false), { kind: 'binary', target: standalone });
  assert.equal(detectUpdateInstallation(standalone, '/src/index.ts', 'darwin', 'arm64', false).kind, 'unsupported');
  assert.equal(detectUpdateInstallation(standalone, '/$bunfs/root/omni', 'darwin', 'arm64', true).kind, 'unsupported');
  const unknown = path.join(root, 'node_modules/unknown');
  mkdirSync(path.dirname(unknown), { recursive: true });
  writeFileSync(unknown, 'fake binary');
  assert.equal(detectUpdateInstallation(unknown, '/$bunfs/root/omni', 'darwin', 'arm64', false).kind, 'unsupported');
  const localPackage = path.join(root, 'node_modules/@right-ai/omni');
  const localBinary = path.join(localPackage, 'node_modules/omnicode-darwin-arm64/bin/omnicode');
  mkdirSync(path.dirname(localBinary), { recursive: true });
  writeFileSync(localBinary, 'fake binary');
  writeFileSync(path.join(localPackage, 'package.json'), JSON.stringify({ name: '@right-ai/omni' }));
  const local = detectUpdateInstallation(localBinary, '/$bunfs/root/omni', 'darwin', 'arm64', false);
  assert.equal(local.kind, 'unsupported');
  if (local.kind === 'unsupported') assert.match(local.reason, /项目内/);
});

test('update --check：仅请求元数据，不下载、不写安装；旧版本不降级', async t => {
  const root = fixture(t);
  const target = path.join(root, 'omni');
  writeFileSync(target, 'original');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ tag_name: 'v999.0.0', assets: [], draft: false, prerelease: false });
  });
  assert.equal(await runUpdateCommand(['--check'], { kind: 'binary', target }), 0);
  assert.equal(requests, 1);
  assert.equal(readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(readdirSync(root), ['omni']);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tag_name: 'v0.0.1', assets: [] }));
  assert.equal(await runUpdateCommand([], { kind: 'binary', target }), 0);
  assert.equal(readFileSync(target, 'utf8'), 'original');
});

test('update：非法参数、网络错误、错误包名和缺失平台产物均失败，不改安装', async t => {
  const root = fixture(t);
  const target = path.join(root, 'omni');
  writeFileSync(target, 'original');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  assert.equal(await runUpdateCommand(['--bad'], { kind: 'binary', target }), 1);
  assert.equal(await runUpdateCommand(['--check', '--check'], { kind: 'binary', target }), 1);
  assert.equal(await runUpdateCommand(['--check'], { kind: 'binary', target }), 1);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: 'wrong-package', version: '999.0.0' }));
  assert.equal(await runUpdateCommand(['--check'], { kind: 'npm', prefix: root, packageDir: root }), 1);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ tag_name: 'v999.0.0', assets: [] }));
  assert.equal(await runUpdateCommand([], { kind: 'binary', target }), 1);
  assert.equal(readFileSync(target, 'utf8'), 'original');
});

test('update：二进制完整校验与版本探针通过后替换，符号链接仍指向原位置', { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t);
  const target = path.join(root, 'omni');
  const link = path.join(root, 'linked-omni');
  writeFileSync(target, '#!/bin/sh\necho "omni v0.0.1"\n');
  chmodSync(target, 0o755);
  symlinkSync(target, link);
  const data = '#!/bin/sh\necho "omni v999.0.0"\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(data));
  const detected = detectUpdateInstallation(link, '/$bunfs/root/omni', process.platform, process.arch, false);
  assert.equal(detected.kind, 'binary');
  if (detected.kind !== 'binary') throw new Error('expected binary');
  assert.equal(await installBinaryUpdate(detected.target, asset(data), '999.0.0'), true);
  assert.equal(readFileSync(link, 'utf8'), data);
  assert.deepEqual(readdirSync(root).sort(), ['linked-omni', 'omni']);
});

test('update：SHA-256/大小/版本错误与下载中断保留原二进制并清理临时文件', { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t);
  const target = path.join(root, 'omni');
  writeFileSync(target, 'original');
  chmodSync(target, 0o755);
  const data = '#!/bin/sh\necho "omni v999.0.0"\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(data));
  for (const bad of [
    { ...asset(data), digest: undefined },
    { ...asset(data), digest: `sha256:${'0'.repeat(64)}` },
    { ...asset(data), size: data.length - 1 },
    { ...asset(data), size: data.length + 1 },
  ]) {
    await assert.rejects(installBinaryUpdate(target, bad, '999.0.0'));
    assert.equal(readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(readdirSync(root), ['omni']);
  }
  await assert.rejects(installBinaryUpdate(target, asset(data), '998.0.0'), /版本检查/);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('download interrupted')); } })));
  await assert.rejects(installBinaryUpdate(target, asset(data), '999.0.0'), /download interrupted/);
  assert.equal(readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(readdirSync(root), ['omni']);
});

test('update：npm 在原前缀调用自己的 Node/npm，带空格路径安全传参并校验新版本', { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t);
  const packageDir = path.join(root, 'lib/node_modules/@right-ai/omni');
  mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  symlinkSync(process.execPath, path.join(root, 'bin/node'));
  writeFileSync(path.join(packageDir, 'bin/omni.js'), 'console.log("omni v999.0.0")');
  const log = path.join(root, 'invocation.json');
  writeFileSync(path.join(root, 'bin/npm'), `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))`);
  const installed = { kind: 'npm' as const, prefix: root, packageDir };
  const command = npmUpdateCommand(installed, '999.0.0');
  assert.equal(command.command, path.join(root, 'bin/node'));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: '@right-ai/omni', version: '999.0.0' }));
  assert.equal(await runUpdateCommand(['--check'], installed), 0);
  assert.equal(readdirSync(root).includes('invocation.json'), false);
  assert.equal(await runUpdateCommand([], installed), 0);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['install', '-g', '@right-ai/omni@999.0.0', '--prefix', root, '--registry=https://registry.npmjs.org']);
  writeFileSync(path.join(root, 'bin/npm'), 'process.exit(17)');
  assert.equal(await runUpdateCommand([], installed), 1);
});

test('update：双入口帮助与参数错误无需 API Key 或有效配置，不进入 TUI', () => {
  for (const entry of ['src/index.ts', 'src/tui-entry.ts']) {
    const help = spawnSync('node', ['--import', 'tsx', entry, 'update', '--help', '--lang', 'zh'], {
      encoding: 'utf8', env: { ...process.env, OMNI_CONFIG: '/nonexistent/omni.json', OMNI_API_KEY: '', OPENAI_API_KEY: '' },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /omni update \[--check\]/);
    assert.doesNotMatch(help.stdout, /\x1b\[\?1049h/);
    const invalid = spawnSync('node', ['--import', 'tsx', entry, 'update', '--bad'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /omni update/);
  }
});

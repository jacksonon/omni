/** 显式自更新：npm 交回原安装前缀，独立二进制校验后原子替换；不加载用户配置。 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { access, chmod, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { VERSION } from '../version.js';

const exec = promisify(execFile);
const NPM_PACKAGE = '@right-ai/omni';
const REPO = 'jacksonon/omni';
const REGISTRY = 'https://registry.npmjs.org';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export type UpdateInstallation =
  | { kind: 'npm'; prefix: string; packageDir: string }
  | { kind: 'binary'; target: string }
  | { kind: 'unsupported'; reason: string };

/** 只接受真正属于当前可执行文件的 npm 主包，避免把附近无关的 node_modules 误判为安装。 */
export function detectUpdateInstallation(
  executable = process.execPath,
  entry = process.argv[1] ?? '',
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  electron = Boolean(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE),
): UpdateInstallation {
  if (electron) return { kind: 'unsupported', reason: 'Electron 桌面应用请从 GitHub Release 下载新版应用。' };
  const target = realpathSync(executable);
  const platformPackage = platform === 'win32' ? '@right-ai/win32-x64' : `omnicode-${platform}-${arch}`;
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') {
      const packageDir = path.join(dir, '@right-ai', 'omni');
      try {
        const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
        const require = createRequire(path.join(packageDir, 'package.json'));
        const bin = require.resolve(`${platformPackage}/bin/${platform === 'win32' ? 'omnicode.exe' : 'omnicode'}`);
        if (manifest.name === NPM_PACKAGE && realpathSync(bin) === target) {
          const parent = path.dirname(dir);
          // Unix 全局包位于 <prefix>/lib/node_modules；Windows 位于 <prefix>/node_modules。
          if (platform !== 'win32' && path.basename(parent) !== 'lib') {
            return { kind: 'unsupported', reason: '这是项目内的 npm 安装，请在项目中运行 npm install @right-ai/omni@latest。' };
          }
          return { kind: 'npm', prefix: platform === 'win32' ? parent : path.dirname(parent), packageDir };
        }
      } catch { /* 继续找外层全局 node_modules（平台包也可能嵌套安装）。 */ }
    }
    if (dir === path.dirname(dir)) break;
  }
  // npm/其他包管理器管理的文件不能当作独立二进制直接覆盖。
  if (target.split(path.sep).includes('node_modules')) {
    return { kind: 'unsupported', reason: '未识别的包管理器安装，请使用原包管理器更新 Omni。' };
  }
  if (entry.includes('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(entry)) {
    // Homebrew cellar 中的文件由 brew 管理。
    if (target.split(path.sep).includes('Cellar')) {
      return { kind: 'unsupported', reason: 'Homebrew 安装请运行 brew upgrade omni。' };
    }
    return { kind: 'binary', target };
  }
  return { kind: 'unsupported', reason: '当前从源码或 JS 包运行，请使用原安装方式更新；源码请拉取代码后重新构建。' };
}

/** 稳定版比较；同版本预发布可以升级到正式版，禁止把较新版本降级。 */
export function isNewerVersion(latest: string, current: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(latest) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(current)) {
    throw new Error('更新源返回了无效的版本号。');
  }
  const a = latest.split('.').map(BigInt);
  const b = current.split('-')[0]!.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return current.includes('-');
}

export function updateHelp(lang: 'zh' | 'en' = 'en'): string {
  return lang === 'zh'
    ? `用法：omni update [--check]
  omni update          更新到最新稳定版（npm / 独立二进制）
  omni update --check  只检查版本，不修改安装
更新保留配置与会话；已有进程需手动重启。Electron、源码及其他包管理器请按原方式更新。`
    : `Usage: omni update [--check]
  omni update          Update to the latest stable version (npm / standalone binary)
  omni update --check  Check for updates without changing the installation
Config and sessions are preserved. Restart existing processes manually.
Update Electron, source checkouts, and other package managers using their original installation method.`;
}

async function fetchUpdate(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': `omni/${VERSION}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`更新请求失败：HTTP ${response.status}（${new URL(url).hostname}）`);
  return response;
}

interface ReleaseAsset { name: string; size: number; digest?: string; browser_download_url: string }
interface StableRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

/** 下载到同目录临时文件；完整大小与 GitHub SHA-256 均通过后才允许执行或替换。 */
export async function downloadUpdate(asset: ReleaseAsset, destination: string): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) {
    throw new Error('Release 缺少 SHA-256 校验值，已停止更新。请从 GitHub Release 手动安装。');
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1024 * 1024) {
    throw new Error('Release 文件大小无效。');
  }
  const response = await fetchUpdate(asset.browser_download_url);
  if (!response.body) throw new Error('更新下载为空。');
  const file = await open(destination, 'wx', 0o600);
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > asset.size) throw new Error('下载大小超出 Release 声明，已停止更新。');
      hash.update(value);
      await file.writeFile(value);
    }
    if (received !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest!.toLowerCase()) {
      throw new Error('下载不完整或 SHA-256 校验失败，原安装未替换。');
    }
    await file.sync();
  } finally {
    await reader.cancel().catch(() => {});
    await file.close();
  }
}

/** npm 使用当前安装前缀的 Node/npm，不依赖可能已被 nvm 切换的 PATH。 */
export function npmUpdateCommand(installation: Extract<UpdateInstallation, { kind: 'npm' }>, version: string): { command: string; args: string[] } {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无效的更新版本。');
  const windows = process.platform === 'win32';
  const command = path.join(installation.prefix, windows ? 'node.exe' : 'bin/node');
  const npm = windows
    ? path.join(installation.prefix, 'node_modules/npm/bin/npm-cli.js')
    : path.join(installation.prefix, 'bin/npm');
  if (!existsSync(command) || !existsSync(npm)) throw new Error('原安装前缀中找不到 Node/npm，请使用原包管理器更新。');
  return { command, args: [realpathSync(npm), 'install', '-g', `${NPM_PACKAGE}@${version}`, '--prefix', installation.prefix, `--registry=${REGISTRY}`] };
}

async function runNpmUpdate(installation: Extract<UpdateInstallation, { kind: 'npm' }>, version: string): Promise<boolean> {
  const { command, args } = npmUpdateCommand(installation, version);
  // Windows 的平台 exe 由当前进程占用，等退出后再交给 npm 安装。
  if (process.platform === 'win32') {
    const temp = await mkdtemp(path.join(installation.prefix, '.omni-update-'));
    try {
      await scheduleWindowsUpdate({
        command, args, version,
        verifyArgs: [path.join(installation.packageDir, 'bin/omni.js'), '--version'],
      }, temp, path.join(installation.prefix, 'omni-update.log'));
    } catch (err) {
      await rm(temp, { recursive: true, force: true });
      throw err;
    }
    return false;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`npm 更新失败（${signal ?? code}），请检查网络及安装目录权限后重试。`)));
  });
  const { stdout } = await exec(command, [path.join(installation.packageDir, 'bin/omni.js'), '--version'], { timeout: 30_000 });
  if (stdout.trim() !== `omni v${version}`) throw new Error('npm 已结束，但新安装的版本检查未通过，请重新安装。');
  return true;
}

/** Windows 运行中的 exe 无法可靠覆盖：独立 helper 等当前进程退出后替换，失败回滚并留日志。 */
async function scheduleWindowsUpdate(
  operation: { target: string; staged: string } | { command: string; args: string[]; verifyArgs: string[]; version: string },
  temp: string,
  log: string,
): Promise<void> {
  const script = path.join(temp, 'replace.ps1');
  await writeFile(script, `$ErrorActionPreference = 'Stop'
$plan = $env:OMNI_UPDATE_PLAN | ConvertFrom-Json
$backup = Join-Path $plan.temp 'previous.exe'
try {
  Wait-Process -Id $plan.pid -Timeout 60 -ErrorAction SilentlyContinue
  if (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue) { throw 'Omni did not exit; update cancelled.' }
  if ($plan.command) {
    $installArgs = @($plan.args)
    $ErrorActionPreference = 'Continue'
    & $plan.command @installArgs 2>&1 | Out-File -LiteralPath $plan.log
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed. See the log above.' }
    $verifyArgs = @($plan.verifyArgs)
    $version = (& $plan.command @verifyArgs | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne ('omni v' + $plan.version)) { throw 'Installed version check failed.' }
  } else {
    Move-Item -LiteralPath $plan.target -Destination $backup
    try { Move-Item -LiteralPath $plan.staged -Destination $plan.target }
    catch { Move-Item -LiteralPath $backup -Destination $plan.target; throw }
    Remove-Item -LiteralPath $backup -Force
  }
  'Omni updated. Restart existing processes.' | Out-File -LiteralPath $plan.log
} catch {
  $_ | Out-File -LiteralPath $plan.log -Append
} finally {
  if (Test-Path -LiteralPath $backup) {
    ('Previous executable kept at: ' + $backup) | Out-File -LiteralPath $plan.log -Append
  } else {
    Remove-Item -LiteralPath $plan.temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
`, 'utf8');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, OMNI_UPDATE_PLAN: JSON.stringify({ ...operation, temp, log, pid: process.pid }) },
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  console.log(`已安排更新，将在当前命令退出后替换。结果日志：${log}`);
}

export async function installBinaryUpdate(target: string, asset: ReleaseAsset, version: string): Promise<boolean> {
  const before = await stat(target);
  await access(path.dirname(target), constants.W_OK);
  const temp = await mkdtemp(path.join(path.dirname(target), '.omni-update-'));
  let scheduled = false;
  try {
    const staged = path.join(temp, process.platform === 'win32' ? 'omni.exe' : 'omni');
    await downloadUpdate(asset, staged);
    await chmod(staged, before.mode & 0o777);
    const { stdout } = await exec(staged, ['--version'], { timeout: 30_000 });
    if (stdout.trim() !== `omni v${version}`) throw new Error('下载程序的版本检查未通过，原安装未替换。');
    const now = await stat(target);
    if (before.ino !== now.ino || before.mtimeMs !== now.mtimeMs || before.size !== now.size) {
      throw new Error('当前安装已被其他进程修改，请重新运行 update。');
    }
    if (process.platform === 'win32') {
      await scheduleWindowsUpdate({ target, staged }, temp, path.join(path.dirname(target), 'omni-update.log'));
      scheduled = true;
    } else {
      await rename(staged, target);
    }
    return !scheduled;
  } finally {
    if (!scheduled) await rm(temp, { recursive: true, force: true });
  }
}

export async function runUpdateCommand(args: string[], installation?: UpdateInstallation): Promise<number> {
  if (args.some(arg => arg !== '--check') || args.length > 1) {
    console.error(updateHelp('zh'));
    return 1;
  }
  const check = args[0] === '--check';
  try {
    const installed = installation ?? detectUpdateInstallation();
    console.log(`当前版本：v${VERSION}（${installed.kind === 'npm' ? 'npm' : installed.kind === 'binary' ? '独立二进制' : '原安装方式管理'}）`);
    if (!check && installed.kind === 'unsupported') throw new Error(installed.reason);
    let latest: string;
    let release: StableRelease | undefined;
    if (installed.kind === 'npm') {
      const metadata = await (await fetchUpdate(`${REGISTRY}/@right-ai%2Fomni/latest`)).json() as { name: string; version: string };
      if (metadata.name !== NPM_PACKAGE) throw new Error('npm 更新源包名不匹配。');
      latest = metadata.version;
    } else {
      release = await (await fetchUpdate(RELEASE_API)).json() as StableRelease;
      if (release.draft || release.prerelease || !Array.isArray(release.assets) || typeof release.tag_name !== 'string') {
        throw new Error('未找到可用的稳定版 Release。');
      }
      latest = release.tag_name.replace(/^v/, '');
    }
    const newer = isNewerVersion(latest, VERSION);
    console.log(`最新稳定版：v${latest}`);
    if (!newer) { console.log('当前版本已是最新或高于最新稳定版，无需更新。'); return 0; }
    if (check) {
      console.log(installed.kind === 'unsupported' ? installed.reason : '有新版本可用，运行 omni update 安装。');
      return 0;
    }
    console.log(`正在更新：v${VERSION} → v${latest}`);
    if (installed.kind === 'npm') {
      if (!await runNpmUpdate(installed, latest)) return 0;
    } else if (installed.kind === 'binary' && release) {
      const name = `omni-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
      const asset = release.assets.find(item => item.name === name);
      const expected = `https://github.com/${REPO}/releases/download/${release.tag_name}/${name}`;
      if (!asset || asset.browser_download_url !== expected) throw new Error(`Release 缺少当前平台产物：${name}`);
      if (!await installBinaryUpdate(installed.target, asset, latest)) return 0;
    }
    console.log(`已更新至 v${latest}。请重新启动已有会话或 Web 服务以使用新版。`);
    return 0;
  } catch (err) {
    console.error(`更新失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

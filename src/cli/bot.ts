/** CLI 只负责唤起已安装的桌面宿主；不要求用户另外安装系统 Node。 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function desktopCandidates(platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.OMNI_DESKTOP_PATH ? [env.OMNI_DESKTOP_PATH] : [];
  if (platform === 'darwin') return [...explicit, '/Applications/omni.app', path.join(home, 'Applications', 'omni.app')];
  if (platform === 'win32') return [...explicit,
    path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'omni', 'omni.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'omni', 'omni.exe')];
  return [...explicit, path.join(home, '.local', 'bin', 'omni-desktop'), '/opt/omni/omni', '/usr/bin/omni-desktop'];
}

export async function runBotCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('omni bot [--workspace <目录>]\n启动菜单栏/托盘常驻助手，通过全局快捷键快速对话；退出窗口不停止任务。\n需要 Omni 桌面应用；可用 OMNI_DESKTOP_PATH 指定安装位置。');
    return 0;
  }
  const petArgs = args.includes('--pet') ? ['--pet'] : args.includes('--pet-hide') ? ['--pet-hide'] : [];
  const wi = args.includes('--cwd') ? args.indexOf('--cwd') : args.indexOf('--workspace');
  const cwd = wi >= 0 ? path.resolve(args[wi + 1] || '.') : process.cwd();
  const desktop = desktopCandidates().find((p) => existsSync(p));
  let executable: string;
  let launchArgs: string[];
  if (desktop) {
    executable = process.platform === 'darwin' && desktop.endsWith('.app') ? '/usr/bin/open' : desktop;
    launchArgs = executable === '/usr/bin/open' ? ['-a', desktop, '--args', '--bot', '--cwd', cwd, ...petArgs] : ['--bot', '--cwd', cwd, ...petArgs];
  } else {
    // 开发 checkout 使用仓库已有 Electron；发布的 CLI 不会静默下载 GUI。
    const roots = [process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')];
    const root = roots.find((p) => existsSync(path.join(p, 'electron', 'main.cjs')) && existsSync(path.join(p, 'node_modules', 'electron', 'cli.js')));
    if (!root) {
      console.error('未找到 Omni 桌面应用。请安装与你的平台匹配的 Omni 桌面包，或设置 OMNI_DESKTOP_PATH 后重试。');
      return 1;
    }
    // cli.js 需要系统 Node；仅作为源码开发路径，安装版直接启动桌面可执行文件。
    executable = process.execPath;
    launchArgs = [path.join(root, 'node_modules', 'electron', 'cli.js'), root, '--bot', '--cwd', cwd, ...petArgs];
  }
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, launchArgs, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  console.log(petArgs.length ? 'Omni 宠物显示设置已发送到桌面应用。' : 'Omni Bot 已唤起；可从菜单栏/托盘打开对话。');
  return 0;
}

/**
 * omni service —— 本机 Web 服务 / Cloudflare 隧道的生命周期管理。
 *
 * macOS 用 LaunchAgent（登录自启、KeepAlive 自动重启），不弹管理员权限；
 * Linux 用 systemd --user；其它平台明确提示暂不支持。
 *
 * 命令：
 *   omni service install [--tunnel <名称>] [--port 3080] [--host 127.0.0.1]
 *                        [--no-enable] [--no-start]
 *   omni service enable | disable      只控制“登录自启”
 *   omni service start | stop | restart 只控制“当前是否运行”
 *   omni service status
 *   omni service uninstall             删除服务定义（不删隧道/DNS）
 *
 * 设计取舍：
 *   · 服务定义（plist/unit）存 ~/.config/omni/services/；
 *     “自启”= 是否复制到 ~/Library/LaunchAgents/（Linux 为 systemctl enable）；
 *     因此 disable 后仍可手动 start，不需要反复 enable/disable launchd 状态。
 *   · 运行的服务使用已构建的 dist/omni.cjs（稳定入口），改源码后需 npm run build
 *     再 omni service restart。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';

const WEB_LABEL = 'com.omni.web';
const TUNNEL_LABEL = 'com.omni.cloudflared';
const SERVICE_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omni', 'services');
const STATE_FILE = path.join(SERVICE_DIR, 'service.json');
const LAUNCH_AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs');

interface CommandSpec {
  label: string;
  plist: string;
  command: string[];
}

interface ServiceState {
  version: 1;
  platform: 'darwin';
  workdir: string;
  web: CommandSpec & { host: string; port: number };
  tunnel?: CommandSpec & { name: string; config: string };
}

function sh(cmd: string, args: string[], timeout = 15000): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plistXml(label: string, command: string[], workdir?: string): string {
  const args = command.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${workdir ? `  <key>WorkingDirectory</key><string>${xmlEscape(workdir)}</string>\n` : ''}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(LOG_DIR, label + '.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(LOG_DIR, label + '.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function readState(): ServiceState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ServiceState;
  } catch {
    return null;
  }
}

function saveState(state: ServiceState): void {
  mkdirSync(SERVICE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function resolveOmniCommand(): string[] {
  const envBin = process.env.OMNI_SERVICE_BIN?.trim();
  if (envBin) return /\.(c|m)?js$/.test(envBin) ? [process.execPath, path.resolve(envBin)] : [path.resolve(envBin)];
  const dist = path.resolve(process.cwd(), 'dist', 'omni.cjs');
  if (existsSync(dist)) return [process.execPath, dist];
  const which = sh('which', ['omni']);
  if (which.ok && which.stdout) return [which.stdout.split('\n')[0]!];
  throw new Error('找不到 omni 入口：请在仓库根目录运行，或先 npm run build，或设置 OMNI_SERVICE_BIN');
}

function resolveCloudflared(): string {
  for (const p of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared']) {
    if (existsSync(p)) return p;
  }
  const which = sh('which', ['cloudflared']);
  if (which.ok && which.stdout) return which.stdout.split('\n')[0]!;
  throw new Error('找不到 cloudflared：请先 brew install cloudflared');
}

function launchctl(args: string[]): ReturnType<typeof sh> {
  return sh('launchctl', args);
}

function serviceInfo(label: string): { loaded: boolean; running: boolean; pid?: string } {
  const r = launchctl(['print', `gui/${process.getuid?.() ?? 501}/${label}`]);
  if (!r.ok) return { loaded: false, running: false };
  const pid = /\bpid = (\d+)/.exec(r.stdout)?.[1];
  return { loaded: true, running: /state = running/.test(r.stdout), pid };
}

function autoStartPath(label: string): string {
  return path.join(LAUNCH_AGENTS, label + '.plist');
}

function isAutoStart(label: string): boolean {
  return existsSync(autoStartPath(label));
}

function installPlistFile(srcPlist: string, label: string): void {
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  copyFileSync(srcPlist, autoStartPath(label));
}

function bootstrap(label: string, plist: string): boolean {
  const uid = process.getuid?.() ?? 501;
  launchctl(['enable', `gui/${uid}/${label}`]);
  const info = serviceInfo(label);
  if (info.running) return true;
  if (info.loaded) {
    const kick = launchctl(['kickstart', '-k', `gui/${uid}/${label}`]);
    return kick.ok;
  }
  const r = launchctl(['bootstrap', `gui/${uid}`, plist]);
  if (!r.ok) console.error(`  ✗ 启动 ${label} 失败：${r.stderr || r.stdout}`);
  return r.ok;
}

function bootout(label: string): void {
  const uid = process.getuid?.() ?? 501;
  launchctl(['bootout', `gui/${uid}/${label}`]);
}

function printStatus(state: ServiceState | null): void {
  console.log('omni service（macOS LaunchAgent）');
  if (!state) {
    console.log('  未安装：omni service install [--tunnel <名称>]');
    return;
  }
  const webInfo = serviceInfo(state.web.label);
  const webAuto = isAutoStart(state.web.label);
  console.log(
    `  本机 Web   ${webInfo.running ? `running (pid ${webInfo.pid ?? '?'})` : 'stopped'}` +
      `   自启：${webAuto ? 'on' : 'off'}   ${state.web.host}:${state.web.port}`
  );
  if (state.tunnel) {
    const tInfo = serviceInfo(state.tunnel.label);
    const tAuto = isAutoStart(state.tunnel.label);
    console.log(
      `  隧道       ${tInfo.running ? `running (pid ${tInfo.pid ?? '?'})` : 'stopped'}` +
        `   自启：${tAuto ? 'on' : 'off'}   ${state.tunnel.name}`
    );
    const url = readTunnelHostname(state.tunnel.config);
    if (url) console.log(`  公网地址   https://${url}`);
  }
  console.log(`  服务定义   ${SERVICE_DIR}`);
  console.log('  日志       ~/Library/Logs/com.omni.*.log');
}

function readTunnelHostname(config: string): string | null {
  try {
    const text = readFileSync(config, 'utf8');
    return /^\s*-?\s*hostname:\s*(\S+)/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--no-enable' || a === '--no-start') flags[a.slice(2)] = true;
    else if (a === '--tunnel' || a === '--port' || a === '--host' || a === '--config') {
      flags[a.slice(2)] = args[++i] ?? '';
    } else rest.push(a);
  }
  return { flags, rest };
}

function doInstall(state: ServiceState, opts: { enable: boolean; start: boolean }): void {
  mkdirSync(SERVICE_DIR, { recursive: true });
  writeFileSync(state.web.plist, plistXml(state.web.label, state.web.command, state.workdir));
  if (state.tunnel) writeFileSync(state.tunnel.plist, plistXml(state.tunnel.label, state.tunnel.command));
  saveState(state);

  const uid = process.getuid?.() ?? 501;
  if (opts.enable) {
    installPlistFile(state.web.plist, state.web.label);
    if (state.tunnel) installPlistFile(state.tunnel.plist, state.tunnel.label);
  } else {
    // --no-enable：清掉旧的登录自启（包括手工安装的 plist）
    for (const label of [state.web.label, state.tunnel?.label, TUNNEL_LABEL]) {
      if (!label) continue;
      rmSync(autoStartPath(label), { force: true });
      launchctl(['disable', `gui/${uid}/${label}`]);
    }
  }
  if (!state.tunnel) {
    rmSync(path.join(SERVICE_DIR, TUNNEL_LABEL + '.plist'), { force: true });
    rmSync(autoStartPath(TUNNEL_LABEL), { force: true });
  }
  if (opts.start) {
    // 覆盖旧定义后需要重启才会生效
    bootout(state.web.label);
    bootstrap(state.web.label, state.web.plist);
    if (state.tunnel) {
      bootout(state.tunnel.label);
      bootstrap(state.tunnel.label, state.tunnel.plist);
    }
  }
}

function help(): void {
  console.log(`用法：
  omni service install [--tunnel <名称>] [--port <端口>] [--host <地址>] [--no-enable] [--no-start]
      安装服务定义；默认开启登录自启并立即启动
      --tunnel <名称>   同时管理 Cloudflare 命名隧道（读 ~/.cloudflared/config.yml）
      --no-enable       只安装，不设登录自启
      --no-start        只安装，不立即启动
  omni service enable | disable      开/关登录自启（不影响当前运行）
  omni service start | stop | restart 启/停/重启当前服务
  omni service status                查看安装/自启/运行状态
  omni service uninstall             删除服务定义（不删 Cloudflare 隧道和 DNS）

说明：
  · macOS 使用 LaunchAgent（无需 sudo），Linux 使用 systemd --user；
  · 服务跑 dist/omni.cjs，改源码后先 npm run build 再 omni service restart。`);
}

export async function runServiceCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    help();
    return 0;
  }
  if (process.platform !== 'darwin') {
    console.error('omni service 目前仅支持 macOS（LaunchAgent）；Linux/Windows 服务管理待补');
    return 1;
  }

  const state = readState();
  const { flags } = parseFlags(rest);

  if (sub === 'status') {
    printStatus(state);
    return 0;
  }

  if (sub === 'install') {
    const entry = resolveOmniCommand();
    const port = Number(flags.port ?? 3080);
    let host = String(flags.host ?? '127.0.0.1');
    const tunnelName = typeof flags.tunnel === 'string' ? flags.tunnel : '';
    const tunnelConfig = String(flags.config ?? path.join(os.homedir(), '.cloudflared', 'config.yml'));

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error('✗ --port 无效');
      return 1;
    }
    if (tunnelName && host !== '127.0.0.1' && host !== 'localhost') {
      console.log('  · 隧道模式强制只监听 127.0.0.1（避免同时暴露局域网）');
      host = '127.0.0.1';
    }
    const cfg = loadConfig();
    if (!cfg.webAuth && (tunnelName || host !== '127.0.0.1')) {
      console.error('✗ 远程/局域网服务需要账号密码：先运行 omni web auth set');
      return 1;
    }
    if (!cfg.webAuth) console.log('  ⚠️ 未设置账号密码：仅限本机回环访问');

    const workdir = process.cwd();
    // 本机服务直接监督 broker；远程/LAN 监督认证代理（其 Agent 仍在共享 broker）。
    const webCommand = !tunnelName && (host === '127.0.0.1' || host === 'localhost')
      ? [...entry, 'server', '_run', '--port', String(port)]
      : [...entry, 'web', '--host', host, '--port', String(port), '--no-open', '--auth'];
    const next: ServiceState = {
      version: 1,
      platform: 'darwin',
      workdir,
      web: {
        label: WEB_LABEL,
        plist: path.join(SERVICE_DIR, WEB_LABEL + '.plist'),
        command: webCommand,
        host,
        port,
      },
    };
    if (tunnelName) {
      if (!existsSync(tunnelConfig)) {
        console.error(`✗ 找不到隧道配置：${tunnelConfig}`);
        return 1;
      }
      const cf = resolveCloudflared();
      next.tunnel = {
        label: TUNNEL_LABEL,
        plist: path.join(SERVICE_DIR, TUNNEL_LABEL + '.plist'),
        command: [cf, 'tunnel', '--config', tunnelConfig, 'run', tunnelName],
        name: tunnelName,
        config: tunnelConfig,
      };
    }

    doInstall(next, { enable: flags['no-enable'] !== true, start: flags['no-start'] !== true });
    console.log('✓ 已安装 omni service');
    printStatus(next);
    return 0;
  }

  if (sub === 'uninstall') {
    if (state) {
      bootout(state.web.label);
      if (state.tunnel) bootout(state.tunnel.label);
      for (const p of [state.web.plist, state.tunnel?.plist, autoStartPath(state.web.label), state.tunnel ? autoStartPath(state.tunnel.label) : null]) {
        if (p) rmSync(p, { force: true });
      }
    }
    rmSync(STATE_FILE, { force: true });
    console.log('✓ 已删除服务定义（Cloudflare 隧道、DNS、会话数据未删除）');
    return 0;
  }

  if (!state) {
    console.error('✗ 尚未安装服务：先运行 omni service install');
    return 1;
  }

  if (sub === 'enable' || sub === 'disable') {
    const items: CommandSpec[] = [state.web, ...(state.tunnel ? [state.tunnel] : [])];
    for (const it of items) {
      const uid = process.getuid?.() ?? 501;
      if (sub === 'enable') {
        installPlistFile(it.plist, it.label);
        launchctl(['enable', `gui/${uid}/${it.label}`]);
      } else {
        rmSync(autoStartPath(it.label), { force: true });
        launchctl(['disable', `gui/${uid}/${it.label}`]);
      }
    }
    console.log(`✓ 已${sub === 'enable' ? '开启' : '关闭'}登录自启（当前运行状态不变）`);
    printStatus(state);
    return 0;
  }

  if (sub === 'start' || sub === 'stop' || sub === 'restart') {
    const items: CommandSpec[] = [state.web, ...(state.tunnel ? [state.tunnel] : [])];
    if (sub === 'stop' || sub === 'restart') {
      for (const it of items) bootout(it.label);
    }
    if (sub === 'start' || sub === 'restart') {
      let ok = true;
      for (const it of items) ok = bootstrap(it.label, it.plist) && ok;
      if (!ok) return 1;
    }
    console.log(`✓ 已${sub === 'start' ? '启动' : sub === 'stop' ? '停止' : '重启'}`);
    printStatus(state);
    return 0;
  }

  console.error(`未知子命令：${sub}（install / enable / disable / start / stop / restart / status / uninstall）`);
  return 1;
}

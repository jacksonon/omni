/** 各种客户端统一使用的发现/启动入口。启动锁属于用户，不属于某个 GUI 窗口。 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ConfigOverrides } from '../config/index.js';
import { VERSION } from '../version.js';
import { canonicalWorkspace, processAlive, readServerRecord, runtimeDir } from './discovery.js';
import { SERVER_PRODUCT, SERVER_PROTOCOL, type ServerConnection, type ServerRecord } from './protocol.js';

export interface SharedServerOptions {
  cwd?: string;
  port?: number;
  overrides?: ConfigOverrides;
  /** 测试/嵌入宿主可以明确指定启动命令；正常安装自动识别 Node/Bun/原生入口。 */
  command?: { executable: string; args: string[] };
}

export function resolveServerCommand(): { executable: string; args: string[] } {
  const entry = process.argv[1];
  if (entry && /\.(?:[cm]?js|tsx?)$/.test(entry) && existsSync(entry)) {
    // tsx 用 import loader；打包后的 cjs 不需要外部加载器。
    const loaderArgs = /\.tsx?$/.test(entry) && !('Bun' in globalThis)
      ? ['--import', createRequire(path.resolve(entry)).resolve('tsx')] : [];
    return { executable: process.execPath, args: [...loaderArgs, path.resolve(entry)] };
  }
  // Bun compile 把入口嵌进可执行文件，argv[1] 是虚拟文件路径。
  if ((process as unknown as { isBun?: boolean }).isBun || 'Bun' in globalThis) {
    return { executable: process.execPath, args: [] };
  }
  // Electron 启动器显式用 bundled CLI；源码测试则从当前模块找仓库入口。
  const source = fileURLToPath(new URL('../index.js', import.meta.url));
  if (existsSync(source)) return { executable: process.execPath, args: [source] };
  const tsSource = source.replace(/\.js$/, '.ts');
  const loader = path.resolve(path.dirname(tsSource), '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (existsSync(tsSource) && existsSync(loader)) return { executable: process.execPath, args: ['--import', loader, tsSource] };
  throw new Error('无法定位 Omni 服务入口；请使用已安装的 omni 命令或构建 dist/omni.cjs。');
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function probeSharedServer(record: ServerRecord | null): Promise<ServerRecord | null> {
  if (!record || !processAlive(record.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${record.port}/_omni/health`, {
      headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return null;
    const body = await res.json() as Partial<ServerRecord>;
    return body.product === SERVER_PRODUCT && body.protocol === SERVER_PROTOCOL && body.pid === record.pid ? record : null;
  } catch { return null; }
}

async function workspaceConnection(record: ServerRecord, options: SharedServerOptions): Promise<ServerConnection> {
  if (record.version !== VERSION) throw new Error(`共享服务版本为 ${record.version}，客户端为 ${VERSION}；请先 omni server stop，再重试。`);
  const res = await fetch(`http://127.0.0.1:${record.port}/_omni/workspaces`, {
    method: 'POST', headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: canonicalWorkspace(options.cwd ?? process.cwd()), overrides: options.overrides ?? {} }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await res.json() as ServerConnection & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `共享服务工作区启动失败 (${res.status})`);
  return { ...body, token: record.token };
}

export async function ensureSharedServer(options: SharedServerOptions = {}): Promise<ServerConnection> {
  const current = await probeSharedServer(readServerRecord());
  if (current) return workspaceConnection(current, options);
  const lockPath = path.join(runtimeDir(), 'startup.lock');
  const deadline = Date.now() + 45_000;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd); fd = undefined;
      break;
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const found = await probeSharedServer(readServerRecord());
      if (found) return workspaceConnection(found, options);
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; at?: number };
        if (owner.pid && !processAlive(owner.pid)) { rmSync(lockPath, { force: true }); continue; }
      } catch { /* 写入锁内容时短暂为空；不能抢占一个仍在初始化的进程 */ }
      if (Date.now() > deadline) throw new Error('等待共享服务启动锁超时；请检查 omni server status。');
      await delay(100);
    }
  }
  try {
    const found = await probeSharedServer(readServerRecord());
    if (found) return workspaceConnection(found, options);
    const cmd = options.command ?? resolveServerCommand();
    const log = openSync(path.join(runtimeDir(), 'server.log'), 'a', 0o600);
    let spawnError: Error | undefined;
    let exited: number | null | undefined;
    try {
      const child = spawn(cmd.executable, [...cmd.args, 'server', '_run', '--port', String(options.port ?? (Number(process.env.OMNI_WEB_PORT) || 3080))], {
        cwd: canonicalWorkspace(options.cwd ?? process.cwd()), detached: true, windowsHide: true,
        stdio: ['ignore', log, log], env: { ...process.env, OMNI_DEBUG: '', OMNI_SERVER_RUNTIME_DIR: runtimeDir() },
      });
      child.once('error', (error) => { spawnError = error; });
      child.once('exit', (code) => { exited = code; });
      child.unref();
    } finally { closeSync(log); }
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const record = await probeSharedServer(readServerRecord());
      if (record) return workspaceConnection(record, options);
      if (exited !== undefined) throw new Error(`共享服务启动失败（退出码 ${exited}）；请检查端口是否被其它程序占用。日志：${path.join(runtimeDir(), 'server.log')}`);
      await delay(100);
    }
    throw new Error(`共享服务启动超时；日志：${path.join(runtimeDir(), 'server.log')}`);
  } finally { rmSync(lockPath, { force: true }); }
}

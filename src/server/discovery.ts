import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { SERVER_PRODUCT, SERVER_PROTOCOL, type ServerRecord } from './protocol.js';

export function runtimeDir(): string {
  const dir = process.env.OMNI_SERVER_RUNTIME_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omni', 'runtime');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function registryPath(): string { return path.join(runtimeDir(), 'server.json'); }

export function canonicalWorkspace(cwd: string): string {
  const dir = realpathSync(path.resolve(cwd));
  if (!statSync(dir).isDirectory()) throw new Error(`工作目录不是文件夹：${cwd}`);
  return dir;
}

export function workspaceId(cwd: string): string {
  return createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex').slice(0, 24);
}

export function readServerRecord(): ServerRecord | null {
  try {
    const value = JSON.parse(readFileSync(registryPath(), 'utf8')) as ServerRecord;
    if (value.product !== SERVER_PRODUCT || value.protocol !== SERVER_PROTOCOL || !Number.isInteger(value.port)
      || value.port < 1 || value.port > 65535 || typeof value.token !== 'string' || value.token.length < 32
      || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    return value;
  } catch { return null; }
}

export function writeServerRecord(value: ServerRecord): void {
  const dest = registryPath();
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, dest);
  try { chmodSync(dest, 0o600); } catch { /* Windows ACL 沿用用户配置目录 */ }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * 配置文件发现：全局配置目录内查找 + 项目配置从 cwd 向上查找。
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_NAMES = ['omni.json', 'omni.jsonc'];

/** 在单个目录内查找配置文件（omni.json 优先于 omni.jsonc） */
export function findInDir(dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 项目配置发现：从 startDir 向上找，最近的 omni.json(c) 优先；git 根与 home 为边界 */
export function findProjectConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const home = os.homedir();
  for (;;) {
    const found = findInDir(dir);
    if (found) return found;
    if (existsSync(path.join(dir, '.git'))) return null; // git 根为边界，不再向上
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return null;
    dir = parent;
  }
}

/**
 * 工作区信任（workspace trust，对标 Claude Code / Codex）：
 *
 * 首次进入未信任目录时提示用户；未信任 = 只读（read 档位）+ 跳过项目级
 * hooks/skills/子代理定义（防仓库注入恶意配置——项目 omni.json 里可写
 * `PreToolUse` hook 执行任意 shell 命令，.claude/skills 或 .agents/subagents
 * 也可能被仓库植入）。信任清单持久化到 `~/.config/omni/trusted-workspaces.json`
 * （XDG-aware，与 mcp-oauth.json 同目录）。
 *
 * 信任判定：目录本身或任一父目录（到 home 边界）在清单中即信任——
 * 信任一个项目 = 信任其 git 根及其所有子目录。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync as fsRealpath, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TRUST_FILE = 'trusted-workspaces.json';

/** 信任清单文件路径（尊重 XDG_CONFIG_HOME） */
export function trustedWorkspacesFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', TRUST_FILE);
}

/** 规范化目录（绝对化 + 消解符号链接；macOS /tmp→/private/tmp 这类不一致必须对齐，
 * 否则清单与 process.cwd() 永远对不上。失败回退普通绝对路径（fail-closed：顶多误判为未信任）。 */
function normDir(p: string): string {
  const abs = path.resolve(p);
  try {
    return fsRealpath(abs);
  } catch {
    // 路径不存在（如待创建的子目录）：向上找最近存在的祖先消解，再拼回剩余部分
    const rest: string[] = [];
    let cur: string = abs;
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      try {
        return path.join(fsRealpath(parent), ...rest);
      } catch {
        cur = parent;
      }
    }
  }
}

/** 读取信任清单（规范化绝对路径数组；文件缺失/损坏返回空） */
export function loadTrustedWorkspaces(): string[] {
  try {
    const file = trustedWorkspacesFile();
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, 'utf8')) as { workspaces?: unknown } | null;
    const list = Array.isArray(data?.workspaces)
      ? (data.workspaces as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim())
      : [];
    return [...new Set(list.map((p) => normDir(p)))];
  } catch {
    return [];
  }
}

/** 目录是否已信任：本身或任一父目录（到 home 边界）在清单中 */
export function isTrustedWorkspace(dir: string): boolean {
  const trusted = new Set(loadTrustedWorkspaces());
  if (trusted.size === 0) return false;
  const home = os.homedir();
  let cur = normDir(dir);
  for (;;) {
    if (trusted.has(cur)) return true;
    const parent = path.dirname(cur);
    if (parent === cur || cur === home) break;
    cur = parent;
  }
  return false;
}

/** 把目录加入信任清单（去重后落盘；成功返回 true） */
export function addTrustedWorkspace(dir: string): boolean {
  const abs = normDir(dir);
  const list = loadTrustedWorkspaces();
  if (!list.includes(abs)) list.push(abs);
  try {
    mkdirSync(path.dirname(trustedWorkspacesFile()), { recursive: true });
    writeFileSync(trustedWorkspacesFile(), `${JSON.stringify({ workspaces: list }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 从信任清单移除目录（成功返回 true） */
export function removeTrustedWorkspace(dir: string): boolean {
  const abs = normDir(dir);
  const list = loadTrustedWorkspaces().filter((p) => p !== abs);
  try {
    mkdirSync(path.dirname(trustedWorkspacesFile()), { recursive: true });
    writeFileSync(trustedWorkspacesFile(), `${JSON.stringify({ workspaces: list }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

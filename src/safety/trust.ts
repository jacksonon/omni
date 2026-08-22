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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TRUST_FILE = 'trusted-workspaces.json';

/** 信任清单文件路径（尊重 XDG_CONFIG_HOME） */
export function trustedWorkspacesFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', TRUST_FILE);
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
    return [...new Set(list.map((p) => path.resolve(p)))];
  } catch {
    return [];
  }
}

/** 目录是否已信任：本身或任一父目录（到 home 边界）在清单中 */
export function isTrustedWorkspace(dir: string): boolean {
  const trusted = new Set(loadTrustedWorkspaces());
  if (trusted.size === 0) return false;
  const home = os.homedir();
  let cur = path.resolve(dir);
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
  const abs = path.resolve(dir);
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
  const abs = path.resolve(dir);
  const list = loadTrustedWorkspaces().filter((p) => p !== abs);
  try {
    mkdirSync(path.dirname(trustedWorkspacesFile()), { recursive: true });
    writeFileSync(trustedWorkspacesFile(), `${JSON.stringify({ workspaces: list }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

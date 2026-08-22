/**
 * 代码库结构感知（repo map，P1，Aider 方案轻量版）：
 * 扫描源码文件，正则提取函数/类/常量定义行，生成紧凑符号地图注入首轮——
 * 模型无需先 list_directory + read_file 就能对项目结构有概览。
 *
 * · 轻量起步（TODO 注明的方案）：正则提取定义行，不引入 tree-sitter
 * · 限制：最多扫 300 文件、每文件提取前 20 个符号、总符号上限 200
 * · 可配置：config repoMap（默认 true）/ repoMapMaxSymbols
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 支持的源码扩展名（常见语言） */
const SRC_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'vim', 'lua', 'ex', 'exs',
]);

/** 噪音目录（跳过） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.cache', 'vendor', '.venv', '__pycache__', 'target', 'coverage', 'release']);

/** 各语言定义行正则（尽量保守：函数/类/常量/接口） */
const DEF_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:class|interface|struct|enum|trait|impl)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:export\s+)?(?:def|func|fn|sub|public|private|internal)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:async\s+)?(?:default\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(/,
];

/** 从单行提取符号名（返回 null 表示非定义行） */
export function extractSymbol(line: string): string | null {
  for (const re of DEF_PATTERNS) {
    const m = line.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** 递归扫描目录收集源码文件（上限 maxFiles） */
async function collectSourceFiles(dir: string, maxFiles: number, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= maxFiles) break;
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await collectSourceFiles(p, maxFiles - out.length, depth + 1);
      out.push(...sub);
    } else if (e.isFile() && SRC_EXTS.has(path.extname(e.name).slice(1))) {
      out.push(p);
    }
  }
  return out;
}

/** 生成代码库符号地图（每文件：路径 + 前 N 个符号）；返回文本 */
export async function buildRepoMap(
  root = process.cwd(),
  opts: { maxFiles?: number; maxSymbols?: number } = {}
): Promise<string> {
  const maxFiles = opts.maxFiles ?? 300;
  const maxSymbols = opts.maxSymbols ?? 200;
  const files = await collectSourceFiles(root, maxFiles);
  const lines: string[] = [];
  let count = 0;
  for (const f of files) {
    if (count >= maxSymbols) break;
    try {
      const st = await stat(f);
      if (st.size > 200 * 1024) continue; // 跳过超大文件
      const raw = await readFile(f, 'utf8');
      const rel = path.relative(root, f);
      const fileSymbols: string[] = [];
      for (const line of raw.split('\n')) {
        const sym = extractSymbol(line.trim());
        if (sym && sym.length < 40 && !fileSymbols.includes(sym)) {
          fileSymbols.push(sym);
          count++;
          if (fileSymbols.length >= 20 || count >= maxSymbols) break;
        }
      }
      if (fileSymbols.length > 0) {
        lines.push(`${rel}: ${fileSymbols.join(', ')}`);
      }
    } catch {
      // 跳过不可读文件
    }
  }
  return lines.join('\n').slice(0, 30 * 1024);
}

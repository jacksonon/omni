/**
 * search_code：在代码库中搜索文本或正则模式。
 * 优先使用 ripgrep，找不到时退回内置的递归扫描。
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.js';
import { resolvePath } from './util.js';

const MAX_HITS = 50;

export const searchCodeTool: Tool = {
  name: 'search_code',
  description:
    '在代码库中搜索文本或正则模式（优先使用 ripgrep，找不到时退回内置简单扫描）。' +
    '适合"找到 XX 定义在哪里""哪里用到了 XX"这类探索。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的文本或正则表达式' },
      path: { type: 'string', description: '搜索起点目录（默认当前目录）' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern ?? '');
    const dir = resolvePath(String(args.path ?? '.'));

    // 优先使用 ripgrep
    const rg = spawnSync(
      'rg',
      ['-n', '--max-count', '3', '--max-filesize', '512K', '--glob', '!node_modules', '--glob', '!.git', pattern, dir],
      { encoding: 'utf8', timeout: 15_000 }
    );
    if (!rg.error && rg.status !== null) {
      const out = rg.stdout.trim();
      if (!out) return `在 ${dir} 下没有找到匹配。`;
      const lines = out.split('\n');
      return `匹配结果（${lines.length} 处，前 ${MAX_HITS} 处，超出截断）：\n${lines.slice(0, MAX_HITS).join('\n')}`;
    }

    // 兜底：简单递归扫描（只扫常见文本文件；优先正则匹配，非法正则退化为子串匹配）
    const hits: string[] = [];
    let matcher: (line: string) => boolean;
    try {
      const re = new RegExp(pattern);
      matcher = (line) => re.test(line);
    } catch {
      matcher = (line) => line.includes(pattern);
    }
    const walk = async (d: string): Promise<void> => {
      if (hits.length >= MAX_HITS) return;
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          await walk(p);
        } else if (/\.(ts|js|json|md|py|go|rs|java|html|css)$/.test(e.name)) {
          try {
            const content = await fs.readFile(p, 'utf8');
            content.split('\n').forEach((line, i) => {
              if (matcher(line)) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 120)}`);
            });
          } catch {
            /* 忽略无法读取的文件 */
          }
        }
      }
    };
    await walk(dir);
    return hits.length
      ? `匹配结果（前 ${hits.length} 处）：\n${hits.slice(0, MAX_HITS).join('\n')}`
      : `在 ${dir} 下没有找到匹配。`;
  },
};

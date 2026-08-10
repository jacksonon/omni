/**
 * list_directory：列出目录下的文件与子目录。
 */
import { promises as fs } from 'node:fs';
import type { Tool } from './types.js';
import { resolvePath } from './util.js';

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: '列出目录下的文件与子目录。探索项目结构时使用。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（相对或绝对，默认当前目录）' },
    },
  },
  async execute(args) {
    const dir = resolvePath(String(args.path ?? '.'));
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const rows = entries
      .filter((e) => !['node_modules', '.git'].includes(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return rows.length ? rows.join('\n') : '（空目录）';
  },
};

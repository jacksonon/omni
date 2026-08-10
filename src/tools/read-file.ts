/**
 * read_file：读取文件内容并按行号展示。
 */
import { promises as fs } from 'node:fs';
import type { Tool } from './types.js';
import { num, resolvePath } from './util.js';

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取文件内容并按行号展示。适合查看文件全貌或局部内容。' +
    '大文件请用 offset / limit 分段读取，不要一次性读入过多内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对或绝对）' },
      offset: { type: 'integer', description: '起始行号，从 0 开始，默认 0' },
      limit: { type: 'integer', description: '最多读取多少行，默认 200' },
    },
    required: ['path'],
  },
  async execute(args) {
    const filePath = resolvePath(String(args.path ?? ''));
    const offset = Math.max(0, num(args.offset, 0));
    const limit = Math.max(1, num(args.limit, 200));
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const slice = lines.slice(offset, offset + limit);
    const shown = slice.map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
    const more =
      offset + limit < lines.length
        ? `\n...（共 ${lines.length} 行，仅显示第 ${offset + 1}-${offset + slice.length} 行；需要更多请用 offset 继续读取）`
        : '';
    return shown + more;
  },
};

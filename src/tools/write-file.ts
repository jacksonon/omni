/**
 * write_file：创建或整体覆盖写入一个文件。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.js';
import { resolvePath } from './util.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    '创建或整体覆盖写入一个文件。注意：是整体覆盖！写入前请先 read_file 查看现有内容，避免误覆盖。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对或绝对）' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const filePath = resolvePath(String(args.path ?? ''), ctx?.cwd);
    const content = String(args.content ?? '');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    return `已写入 ${filePath}（${Buffer.byteLength(content, 'utf8')} 字节）`;
  },
};

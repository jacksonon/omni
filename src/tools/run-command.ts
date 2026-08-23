/**
 * run_command：在终端执行 shell 命令并返回输出。带超时、输出截断。
 *
 * 安全护栏集成：所有工具调用统一经 Safety.gate 过闸（权限分级 + 危险命令审批 + 审计），
 * 危险命令检测收敛在 safety/policy.ts 单一入口（full 直通 / safe 询问 / ask 全询问 /
 * read 拒绝）——本工具只负责执行，不做二次拦截（否则 full 档位的「任意命令」语义
 * 会被无权限感知的兜底拦截破坏）。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from './types.js';
import { num, truncate } from './util.js';

const execAsync = promisify(exec);

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '在终端执行 shell 命令并返回输出。用于运行测试、安装依赖、执行脚本、查看 git 状态等。' +
    '注意：命令会真实执行且有破坏力，请确认命令安全后再执行。默认超时 30 秒。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，默认 30000，最大 120000' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    const timeout = Math.min(120_000, Math.max(1_000, num(args.timeoutMs, 30_000)));
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx?.cwd ?? process.cwd(),
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return `退出码: 0\n${truncate(out)}`;
    } catch (err: any) {
      const parts = [`退出码: ${err.code ?? 'unknown'}${err.killed ? '（命令超时被终止）' : ''}`];
      if (err.stdout) parts.push(String(err.stdout).trim());
      if (err.stderr) parts.push(String(err.stderr).trim());
      return truncate(parts.join('\n'));
    }
  },
};

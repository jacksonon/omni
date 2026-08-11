/**
 * run_command：在终端执行 shell 命令并返回输出。
 * 带危险命令拦截（规则在 safety/policy.ts，这里做兜底二次拦截）、超时、输出截断。
 *
 * 安全护栏集成：正常流程下 run_command 先经 Safety.gate 过闸（权限分级 + 审批），
 * 这里保留危险命令检查作为**防御性兜底**——即使绕过闸门（如单元测试直接调 execute），
 * 危险命令也不会真的执行。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dangerousCommand } from '../safety/policy.js';
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
  async execute(args) {
    const command = String(args.command ?? '');
    // 防御性兜底拦截（正常流程已被 Safety.gate 处理；见文件头注释）
    const danger = dangerousCommand(command);
    if (danger) return `已拦截：${danger}\n请向用户说明情况，由其手动执行。`;
    const timeout = Math.min(120_000, Math.max(1_000, num(args.timeoutMs, 30_000)));
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.cwd(),
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

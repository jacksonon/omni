/**
 * run_command：在终端执行 shell 命令并返回输出。
 * 带危险命令拦截、超时、输出截断。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from './types.js';
import { num, truncate } from './util.js';

const execAsync = promisify(exec);

/** 危险命令拦截清单：MVP 阶段不提供确认机制，直接拦截并引导用户手动执行 */
const DANGEROUS_COMMANDS: { re: RegExp; msg: string }[] = [
  { re: /(\s|^)rm\s+-[a-z]*r[a-z]*f\s+\//, msg: '禁止对根目录执行 rm -rf' },
  { re: /(\s|^)mkfs/, msg: '禁止格式化磁盘（mkfs）' },
  { re: /(\s|^)dd\s+if=/, msg: '禁止 dd 写盘' },
  { re: /(\s|^)(shutdown|reboot|halt)\b/, msg: '禁止关机/重启命令' },
  { re: /:\(\)\s*\{/, msg: '检测到 fork bomb，已拦截' },
  { re: /(\s|^)git\s+push\b/, msg: 'git push 是不可逆操作，MVP 阶段拦截，需要时请手动执行' },
];

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
    for (const { re, msg } of DANGEROUS_COMMANDS) {
      if (re.test(command)) return `已拦截：${msg}\n请向用户说明情况，由其手动执行。`;
    }
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

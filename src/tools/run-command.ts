/**
 * run_command：在终端执行 shell 命令并返回输出。带超时、输出截断、**实时输出流**。
 *
 * 实时输出（P1-3 / 用户要求"等命令结束才看结果太慢"）：
 * · 通过 child_process.spawn 走 stream → 每收到一行 stdout/stderr 就回调 ctx.onCommandOutput
 * · 渲染端（TUI / Web）订阅后做原地 ANSI 刷新 / DOM 追加，不必等命令结束
 * · 退路：ctx.onCommandOutput 缺省时走 buffer 模式（与旧实现一致）——接口可选
 *
 * 安全护栏集成：所有工具调用统一经 Safety.gate 过闸（权限分级 + 危险命令审批 + 审计），
 * 危险命令检测收敛在 safety/policy.ts 单一入口（full 直通 / safe 询问 / ask 全询问 /
 * read 拒绝）——本工具只负责执行，不做二次拦截（否则 full 档位的「任意命令」语义
 * 会被无权限感知的兜底拦截破坏）。
 */
import { spawn } from 'node:child_process';
import type { Tool } from './types.js';
import { num, truncate } from './util.js';

/** 行级累计：把 stream 拆成完整行，存到 buffer，凑到 \n 才 flush 一行回调 */
function makeLineBuffer(onLine: (line: string, isError: boolean) => void, isError: boolean) {
  let buf = '';
  return (chunk: Buffer | string): void => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx), isError);
      buf = buf.slice(idx + 1);
    }
  };
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '在终端执行 shell 命令并返回输出。用于运行测试、安装依赖、执行脚本、查看 git 状态等。' +
    '注意：命令会真实执行且有破坏力，请确认命令安全后再执行。默认超时 30 秒。' +
    '输出会实时回传到 UI（不必等命令结束）。',
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
    const cwd = ctx?.cwd ?? process.cwd();
    const onLineCb = ctx?.onCommandOutput;

    return new Promise<string>((resolve) => {
      // 强制 shell：模型给的是字符串命令（不是 args 数组），用 `sh -c` 走 shell 语义
      const child = spawn('sh', ['-c', command], { cwd, env: process.env });

      let stdoutBuf = '';
      let stderrBuf = '';
      let killed = false;

      // 行级缓冲：每凑到一行 \n 立即回调（live streaming）——比攒整段更"打字机"
      const handleStdout = makeLineBuffer((line) => {
        if (onLineCb) onLineCb(line, false);
        stdoutBuf += line + '\n';
      }, false);
      const handleStderr = makeLineBuffer((line) => {
        if (onLineCb) onLineCb(line, true);
        stderrBuf += line + '\n';
      }, true);

      child.stdout?.on('data', handleStdout);
      child.stderr?.on('data', handleStderr);

      // 超时：spawn 出去的进程不会被 Promise.race 自动终止，必须显式 kill
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        // 兜底：TERM 不响应时强 KILL
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1500);
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(`退出码: unknown\n${truncate(String(err?.message ?? err))}`);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        // flush 行缓冲里残留的尾巴（最后一行若没 \n）
        if (stdoutBuf && !stdoutBuf.endsWith('\n')) {
          if (onLineCb) onLineCb(stdoutBuf, false);
        }
        if (stderrBuf && !stderrBuf.endsWith('\n')) {
          if (onLineCb) onLineCb(stderrBuf, true);
        }

        const exitInfo = killed
          ? '退出码: killed（命令超时被终止）'
          : signal
            ? `退出码: ${code ?? 'unknown'}（signal: ${signal}）`
            : `退出码: ${code ?? 'unknown'}`;
        const out = [stdoutBuf.trim(), stderrBuf.trim()].filter(Boolean).join('\n');
        if (code === 0) {
          resolve(`${exitInfo}\n${truncate(out)}`);
        } else {
          const parts = [exitInfo];
          if (stdoutBuf.trim()) parts.push(stdoutBuf.trim());
          if (stderrBuf.trim()) parts.push(stderrBuf.trim());
          resolve(truncate(parts.join('\n')));
        }
      });
    });
  },
};

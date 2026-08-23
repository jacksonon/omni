/**
 * 诊断反馈闭环工具（P1，opencode/Cline 方案轻量版）：
 * 编辑完成后运行项目自带 typecheck/lint 取诊断（错误/警告）回传模型自修复。
 *
 * · 先探测 package.json scripts（typecheck → lint → test），无则跳过
 * · 比每次手动 run_command 更聚焦：直接返回诊断摘要
 * · 与 examples/hooks/lint-hook.mjs 互补（PostToolUse 自动 lint）
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.js';

const execAsync = promisify(exec);

/** 探测项目检查命令：typecheck → lint → test（按 package.json scripts）；无返回 null */
export function detectCheckCommand(root: string): { name: string; script: string } | null {
  const pkg = path.join(root, 'package.json');
  if (!existsSync(pkg)) return null;
  try {
    const data = JSON.parse(readFileSync(pkg, 'utf8'));
    const scripts = data?.scripts ?? {};
    for (const name of ['typecheck', 'type-check', 'tsc', 'lint', 'test']) {
      if (typeof scripts[name] === 'string') return { name, script: scripts[name] };
    }
    return null;
  } catch {
    return null;
  }
}

/** 创建 diagnose 工具（cwd 为项目根） */
export function createDiagnoseTool(root: string): Tool {
  return {
    name: 'diagnose',
    description:
      '运行项目的 typecheck/lint（优先 typecheck，降级 lint/test），返回错误/警告摘要。' +
      '编辑代码后调用它获取诊断，据错误自修复——比手动跑命令更聚焦。无检查脚本时返回提示。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'changed'],
          description: 'all = 全量检查（默认）；changed = 仅检查（预留）',
        },
      },
    },
    async execute(_args, ctx) {
      const root2 = ctx?.cwd ?? root;
      const cmd = detectCheckCommand(root2);
      if (!cmd) return '项目没有 typecheck/lint/test 脚本（package.json scripts 缺失）——可用 run_command 手动运行检查工具。';
      try {
        const { stdout, stderr } = await execAsync(`npm run ${cmd.name} --silent`, {
          cwd: root2,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        if (!out) return `✓ ${cmd.name}（${cmd.script}）通过，无诊断输出。`;
        return `### ${cmd.name}（${cmd.script}）诊断输出\n${out.slice(0, 4000)}`;
      } catch (err: any) {
        // 非零退出 = 有错误/警告，捕获输出
        const parts: string[] = [];
        if (err.stdout) parts.push(String(err.stdout).trim());
        if (err.stderr) parts.push(String(err.stderr).trim());
        const out = parts.join('\n');
        if (!out) return `✗ ${cmd.name} 失败（退出码 ${err.code ?? 'unknown'}），无输出`;
        return `### ${cmd.name}（${cmd.script}）失败，诊断如下\n${out.slice(0, 4000)}`;
      }
    },
  };
}

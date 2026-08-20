/**
 * omni web 子命令入口：`omni web [--port <n>] [--host <h>] [--no-open]`
 *
 * 复用现有配置体系（-m/--config/OMNI_* 环境变量等全局 overrides 照常生效），
 * 解析 web 专属参数后启动本地后端服务（REST + SSE）并托管 Web UI。
 */
import { spawn } from 'node:child_process';
import { attachRuntime, prepareRun } from '../main.js';
import { routingOutput, startWebService } from './server.js';
import type { ConfigOverrides } from '../config/index.js';

export interface WebArgs {
  port: number;
  host: string;
  open: boolean;
  help: boolean;
}

/** 解析 `omni web` 子命令参数 */
export function parseWebArgs(args: string[]): WebArgs {
  const out: WebArgs = { port: 3080, host: '127.0.0.1', open: true, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const val = (): string => inline ?? args[++i] ?? '';
    switch (name) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--port':
      case '-p': {
        const n = Number(val());
        if (Number.isInteger(n) && n > 0 && n < 65536) out.port = n;
        break;
      }
      case '--host':
        out.host = val() || '127.0.0.1';
        break;
      case '--no-open':
        out.open = false;
        break;
      default:
        // 未知参数忽略（不阻塞启动）
        break;
    }
  }
  return out;
}

export function printWebHelp(): void {
  console.log(`用法：
  omni web                     启动本地后端服务 + Web 界面（默认 http://127.0.0.1:3080）

Web 服务参数：
  -p, --port <端口>   服务端口（默认 3080）
      --host <地址>   监听地址（默认 127.0.0.1）
      --no-open       不自动打开浏览器

说明：
  · 复用现有配置（模型 / API Key / 权限 / MCP / hooks 等与 omni 一致）；
  · Web UI 支持：多会话 / 流式回复 / 思考与工具调用实时展示 / 审批与提问卡片 /
    模型与权限设置 / 会话标题自动生成；
  · 同一后端服务可供多个浏览器标签页 / 前端访问（REST + SSE 协议）。`);
}

/**
 * 启动 web 服务。
 * routingOutput 已从 server.ts 导出（attachRuntime 的审批/提问路由到当前运行会话）。
 */
export async function runWeb(args: string[], overrides: ConfigOverrides): Promise<void> {
  const parsed = parseWebArgs(args);
  if (parsed.help || args.includes('--help') || args.includes('-h')) {
    printWebHelp();
    return;
  }

  const ctx = prepareRun(overrides);
  // attachRuntime：安全护栏 + 动态工具链 + 上下文选项；审批/提问经 routingOutput
  // 路由到当前运行会话的 WebOutput；hook 输出/子代理事件转发到 SSE
  await attachRuntime(ctx, routingOutput as unknown as import('../output/types.js').Output);

  const server = await startWebService({ ctx, host: parsed.host, port: parsed.port });
  const url = `http://${parsed.host}:${parsed.port}`;
  console.log(`omni v${(await import('../version.js')).VERSION}`);
  console.log('');
  console.log(`  ◉ omni web 已启动：${url}`);
  console.log(`    工作目录：${process.cwd()}`);
  console.log(`    模型：${ctx.runOpts.modelRuntime?.model ?? ctx.cfg.model} · 权限：${ctx.runOpts.permission ?? 'safe'}`);
  console.log('');
  console.log('  Ctrl+C 停止服务。');

  // 自动打开浏览器（可 --no-open 关闭；仅 macOS/Linux，Windows 用 start）
  if (parsed.open) {
    openBrowser(url);
  }

  // 等待关闭信号（SIGINT/SIGTERM 由 server.ts 处理；server 关闭后进程随事件循环退出）
  await new Promise<void>((resolve) => {
    server.on('close', () => resolve());
  });
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // 打不开浏览器不阻塞服务
  }
}
/**
 * MCP（Model Context Protocol）客户端：接入外部工具生态。
 *
 * 协议：JSON-RPC 2.0 over stdio（newline-delimited JSON）——与主进程零依赖，
 * 每个 MCP 服务器是一个独立子进程（command + args + env）。
 *
 * 生命周期：入口启动时发现（initialize 握手 → tools/list → 包装成 Tool 注册进
 * 工具表，名称加 server 前缀防冲突）；进程退出时 kill 子进程。
 * 服务器启动/握手失败 → 只警告并跳过该服务器（fail-open，不阻塞主流程）。
 *
 * 安全：MCP 工具与其他工具一样过 Safety 闸门（权限分级 + 审批 + 审计）——
 * 外部工具的破坏力与 run_command 同级，不该绕过护栏。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { Tool } from './types.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT = 30_000;

/** MCP stdio 客户端：spawn 子进程 + JSON-RPC 请求/通知 + 按 id 匹配响应 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private cfg: McpServerConfig) {}

  /** 启动子进程 + initialize 握手 */
  async start(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('error', () => {
      /* 启动失败由 request 超时/错误路径兜底 */
    });
    child.stderr.on('data', (d: Buffer) => {
      if (process.env.OMNI_DEBUG) console.error(`[MCP:${this.cfg.command}] ${d.toString().trimEnd()}`);
    });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onMessage(line));
    this.lines = rl;
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'omni', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
  }

  private onMessage(line: string): void {
    let msg: { id?: number; error?: { message?: string }; result?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id == null) return; // 服务器主动通知：忽略
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP 请求错误'));
    else p.resolve(msg.result);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时：${method}`));
        }
      }, REQUEST_TIMEOUT);
      // resolve/reject 后清理计时器（reject 不重复触发——pending 已删）
      const origResolve = resolve;
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          origResolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.request('tools/list', {})) as { tools?: McpToolDef[] } | undefined;
    return res?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request('tools/call', { name, arguments: args })) as
      | { content?: { type?: string; text?: string }[]; isError?: boolean }
      | undefined;
    const parts: string[] = [];
    for (const c of res?.content ?? []) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    }
    return { text: parts.join('\n') || '(MCP 工具无文本输出)', isError: !!res?.isError };
  }

  close(): void {
    this.lines?.close();
    this.child?.kill();
    this.child = null;
  }
}

/** 从配置发现 MCP 工具：逐 server 握手 → tools/list → 包装成 Tool（名称加 server 前缀） */
export async function discoverMcpTools(servers?: Record<string, McpServerConfig>): Promise<Tool[]> {
  if (!servers || Object.keys(servers).length === 0) return [];
  const out: Tool[] = [];
  const clients: McpClient[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    let client: McpClient;
    try {
      client = new McpClient(cfg);
      await client.start();
      clients.push(client);
      const defs = await client.listTools();
      const prefix = name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
      for (const def of defs) {
        out.push({
          name: `${prefix}_${def.name}`,
          description: `[MCP:${name}] ${def.description ?? ''}（外部工具，经 MCP 服务器 ${name} 执行；同样受权限/审批管控）`,
          parameters: (def.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          execute: async (args) => {
            const r = await client.callTool(def.name, args);
            return (r.isError ? '错误：' : '') + r.text;
          },
        });
      }
    } catch (err) {
      console.error(
        `⚠️ MCP 服务器「${name}」启动失败：${err instanceof Error ? err.message : err}（已跳过该服务器）`
      );
    }
  }
  if (clients.length > 0) {
    // 进程退出时 kill MCP 子进程（CLI 生命周期内常驻）
    process.on('exit', () => {
      for (const c of clients) c.close();
    });
  }
  return out;
}

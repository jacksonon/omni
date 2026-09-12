/**
 * LSP 导航工具（2026-09 补课，对标 Copilot CLI / Claude Code 的 LSP 能力）：
 * 按需启动语言服务器，提供 definition / hover / references / documentSymbol 四项
 * 窄上下文查询（不把整个文件塞进上下文）。
 *
 * 无第三方依赖：手写最小 LSP 客户端（Content-Length 帧 + JSON-RPC），
 * 服务器探测：typescript-language-server（TS/JS）/ pyright-langserver（Python）。
 * 未安装服务器 → 返回可读提示（引导安装或改用 search_code），不阻塞任务。
 *
 * 只读工具（readOnly: true）：计划模式与权限档位天然放行。
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tool, ToolContext } from './types.js';
import { num, resolvePath } from './util.js';

export type LspAction = 'definition' | 'hover' | 'references' | 'symbols';

/** 语言服务器探测（按扩展名；command/args 供 spawn，缺失 = 未安装） */
export interface LspServerSpec {
  languageId: string;
  command: string;
  args: string[];
}

/**
 * 探测（纯函数，可单测）：按文件扩展名选语言服务器；找不到已知服务器时返回 null。
 * 实际是否安装由 detectInstalledLsp 经 PATH 检查（避免把「未安装」误报成「不支持」）。
 */
export function lspServerSpecFor(file: string): LspServerSpec | null {
  const ext = path.extname(file).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
    return { languageId: ext.includes('x') ? (ext.startsWith('.ts') ? 'typescriptreact' : 'javascriptreact') : ext.startsWith('.ts') ? 'typescript' : 'javascript', command: 'typescript-language-server', args: ['--stdio'] };
  }
  if (ext === '.py' || ext === '.pyi') {
    return { languageId: 'python', command: 'pyright-langserver', args: ['--stdio'] };
  }
  return null;
}

/** PATH 探测（同步轻量：command -v / where） */
export function detectInstalledLsp(spec: LspServerSpec): boolean {
  try {
    if (process.platform === 'win32') execFileSync('where', [spec.command], { stdio: 'ignore' });
    else execFileSync('sh', ['-c', `command -v ${JSON.stringify(spec.command)}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 位置格式化（LSP 0-based line/character → 人类可读 1-based） */
export function formatLspLocation(loc: { uri?: string; range?: { start?: { line?: number; character?: number } } }): string {
  const file = loc.uri?.startsWith('file://') ? decodeURIComponent(new URL(loc.uri).pathname) : (loc.uri ?? '?');
  const line = (loc.range?.start?.line ?? 0) + 1;
  const col = (loc.range?.start?.character ?? 0) + 1;
  return `${file}:${line}:${col}`;
}

/** hover 内容归一化（MarkupContent | MarkedString | MarkedString[]） */
export function formatHover(hover: unknown): string {
  const h = hover as { contents?: unknown } | null;
  const c = h?.contents;
  const one = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as { value?: unknown; language?: unknown };
      if (typeof o.value === 'string') return o.value;
    }
    return '';
  };
  if (Array.isArray(c)) return c.map(one).filter(Boolean).join('\n\n');
  return one(c);
}

/** documentSymbol 归一化（DocumentSymbol[] 或 SymbolInformation[] → 缩进行） */
export function formatSymbols(symbols: unknown): string[] {
  const out: string[] = [];
  const walk = (arr: unknown[], depth: number): void => {
    for (const s of arr) {
      const o = s as { name?: unknown; kind?: unknown; children?: unknown[] };
      if (typeof o?.name !== 'string') continue;
      out.push(`${'  '.repeat(depth)}${kindName(o.kind)} ${o.name}`);
      if (Array.isArray(o.children) && o.children.length > 0) walk(o.children, depth + 1);
    }
  };
  if (Array.isArray(symbols)) walk(symbols, 0);
  return out.slice(0, 200);
}

/** SymbolKind → 简短标签（LSP 枚举） */
function kindName(kind: unknown): string {
  const names = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enumMember', 'struct', 'event', 'operator', 'typeParameter'];
  return typeof kind === 'number' && names[kind] ? names[kind] : 'symbol';
}

/** 最小 LSP 客户端：启动 → initialize → didOpen → 查询 → shutdown（一次性会话） */
class LspSession {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(spec: LspServerSpec, private root: string) {
    this.child = spawn(spec.command, spec.args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.slice(start, start + len).toString('utf8');
      this.buffer = this.buffer.slice(start + len);
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id == null) continue; // 服务器通知/请求：忽略
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'LSP 错误'));
      else p.resolve(msg.result);
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('LSP 会话已关闭'));
        return;
      }
      const id = ++this.seq;
      const json = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP 请求超时：${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    const json = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  }

  close(): void {
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      // 已退出
    }
  }
}

/** 执行一次查询（一次性 LSP 会话） */
async function runLspQuery(
  spec: LspServerSpec,
  file: string,
  root: string,
  action: LspAction,
  line: number,
  character: number
): Promise<unknown> {
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
  const text = await readFile(file, 'utf8');
  const uri = pathToFileURL(file).toString();
  const session = new LspSession(spec, root);
  try {
    await session.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).toString(),
      capabilities: { textDocument: { definition: {}, hover: {}, references: {}, documentSymbol: {} } },
      workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }],
    });
    session.notify('initialized', {});
    session.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: spec.languageId, version: 1, text },
    });
    const position = { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };
    const params = {
      textDocument: { uri },
      ...(action === 'symbols' ? {} : { position }),
    };
    const method =
      action === 'definition'
        ? 'textDocument/definition'
        : action === 'hover'
          ? 'textDocument/hover'
          : action === 'references'
            ? 'textDocument/references'
            : 'textDocument/documentSymbol';
    const res = await session.request(method, action === 'references' ? { ...params, context: { includeDeclaration: true } } : params);
    session.notify('shutdown', {});
    return res;
  } finally {
    session.close();
  }
}

/** 创建 lsp 工具（静态注册表注册；查询窄上下文、只读） */
export function createLspTool(): Tool {
  return {
    name: 'lsp',
    description:
      '语言服务器导航（definition/hover/references/symbols）：按文件+行列位置查询定义跳转、悬停类型/文档、' +
      '引用位置与文件符号列表，返回窄上下文（不读整个文件）。需要本机装有 typescript-language-server（TS/JS）' +
      '或 pyright-langserver（Python）；未安装时返回提示（可改用 search_code）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['definition', 'hover', 'references', 'symbols'],
          description: '查询类型：definition 跳转定义 / hover 悬停信息 / references 引用列表 / symbols 文件符号',
        },
        file: { type: 'string', description: '目标文件路径（相对当前工作目录或绝对路径）' },
        line: { type: 'number', description: '1-based 行号（symbols 可省略）' },
        character: { type: 'number', description: '1-based 列号（缺省 1）' },
        query: { type: 'string', description: '符号名过滤（symbols 可选）' },
      },
      required: ['action', 'file'],
    },
    readOnly: true,
    approvalMode: 'auto',
    execute: async (args, ctx?: ToolContext): Promise<string> => {
      const action = String(args.action ?? '') as LspAction;
      if (!['definition', 'hover', 'references', 'symbols'].includes(action)) {
        return `错误：action 必须是 definition/hover/references/symbols（收到「${String(args.action)}」）`;
      }
      const root = ctx?.cwd ?? process.cwd();
      const file = resolvePath(String(args.file ?? ''), root);
      const spec = lspServerSpecFor(file);
      if (!spec) {
        return `未识别的文件类型：${path.extname(file) || '(无扩展名)'}。当前支持 TS/JS（typescript-language-server）与 Python（pyright-langserver）；其他语言请用 search_code。`;
      }
      if (!detectInstalledLsp(spec)) {
        return `未检测到语言服务器 ${spec.command}（未安装）。安装后可启用 ${action} 查询：npm i -g typescript-language-server typescript（TS/JS）或 npm i -g pyright（Python）。临时替代：search_code。`;
      }
      const line = num(args.line, 1);
      const character = num(args.character, 1);
      try {
        const res = await runLspQuery(spec, file, root, action, line, character);
        if (action === 'definition') {
          const arr = Array.isArray(res) ? res : res ? [res] : [];
          if (arr.length === 0) return `未找到定义：${path.basename(file)}:${line}:${character}`;
          return `定义位置（${arr.length}）：\n` + arr.map((l) => `· ${formatLspLocation(l as never)}`).join('\n');
        }
        if (action === 'hover') {
          const text = formatHover(res);
          if (!text) return `无悬停信息：${path.basename(file)}:${line}:${character}`;
          return text.slice(0, 4000);
        }
        if (action === 'references') {
          const arr = Array.isArray(res) ? res : [];
          if (arr.length === 0) return `未找到引用：${path.basename(file)}:${line}:${character}`;
          return `引用位置（${arr.length}）：\n` + arr.map((l) => `· ${formatLspLocation(l as never)}`).join('\n').slice(0, 4000);
        }
        const symbols = formatSymbols(res);
        if (symbols.length === 0) return `无符号：${path.basename(file)}`;
        const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const filtered = q ? symbols.filter((s) => s.toLowerCase().includes(q)) : symbols;
        return `文件符号（${filtered.length}）：\n` + filtered.join('\n');
      } catch (err) {
        return `LSP 查询失败（${action}）：${err instanceof Error ? err.message : String(err)}。可改用 search_code。`;
      }
    },
  };
}

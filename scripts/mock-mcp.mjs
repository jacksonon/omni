/**
 * mock MCP 服务器（stdio JSON-RPC）：验证 Omni 的 MCP 客户端链路。
 *
 * 协议：newline-delimited JSON-RPC 2.0（与 src/tools/mcp.ts 客户端对应）。
 * 提供两个工具：
 *   · ping —— 返回 `mcp-pong`（验证 tools/call 文本回传）
 *   · add  —— 返回两数之和（验证参数透传）
 *
 * 用法（配合 Omni 配置）：
 *   "mcpServers": { "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] } }
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const TOOLS = [
  {
    name: 'ping',
    description: '返回 pong，用于验证 MCP 链路',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add',
    description: '返回两个数字之和',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  if (msg.id == null) return; // 通知：忽略（initialized）

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.0.1' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {};
    let text;
    let isError = false;
    if (name === 'ping') text = 'mcp-pong';
    else if (name === 'add') text = String(Number(args?.a ?? 0) + Number(args?.b ?? 0));
    else {
      text = `未知工具 ${name}`;
      isError = true;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError } });
    return;
  }
  // 未知方法
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `方法不存在：${msg.method}` } });
});

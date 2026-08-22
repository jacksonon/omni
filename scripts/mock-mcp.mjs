/**
 * mock MCP 服务器（stdio JSON-RPC）：验证 Omni 的 MCP 客户端链路。
 *
 * 协议：newline-delimited JSON-RPC 2.0（与 src/tools/mcp.ts 客户端对应）。
 * 提供：
 *   · ping —— 返回 `mcp-pong`（验证 tools/call 文本回传）
 *   · add  —— 返回两数之和（验证参数透传）
 *   · resources/list —— 返回 mock 资源
 *   · resources/read —— 返回 mock 资源内容
 *   · prompts/list —— 返回 mock 提示词模板
 *   · prompts/get —— 返回 mock 提示词内容
 *   · initialize 返回 instructions（"模拟 MCP 服务器约束"）
 *   · serverInfo —— 返回服务器信息（验证 instructions 能力）
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
  {
    name: 'serverInfo',
    description: '返回服务器信息（名称、版本、能力）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

const RESOURCES = [
  {
    uri: 'mock://config/settings',
    name: 'mock 配置',
    description: '演示配置文件内容',
    mimeType: 'text/plain',
  },
  {
    uri: 'mock://data/readme',
    name: 'mock 说明',
    description: '演示文档内容',
    mimeType: 'text/markdown',
  },
];

const PROMPTS = [
  {
    name: 'mock-review',
    description: '代码审查提示词模板',
    arguments: [
      { name: 'language', description: '编程语言', required: true },
    ],
  },
  {
    name: 'mock-summarize',
    description: '摘要提示词模板（无参数）',
    arguments: [],
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
        capabilities: {
          tools: {},
          resources: { listChanged: false },
          prompts: {},
        },
        serverInfo: { name: 'mock-mcp', version: '0.1.0' },
        instructions: 'mock MCP 服务器约束：所有文件操作须经该服务器、不可直接修改系统文件。',
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
    else if (name === 'serverInfo') text = 'mock-mcp v0.1.0 · 2 工具 · 2 资源 · 2 提示词';
    else {
      text = `未知工具 ${name}`;
      isError = true;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError } });
    return;
  }
  if (msg.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { resources: RESOURCES } });
    return;
  }
  if (msg.method === 'resources/read') {
    const uri = msg.params?.uri ?? '';
    const resource = RESOURCES.find((r) => r.uri === uri);
    if (resource) {
      const text = uri === 'mock://config/settings'
        ? '{\n  "theme": "dark",\n  "language": "zh",\n  "maxSteps": 50\n}'
        : '# Mock MCP 服务器\n\n这是一个演示用的 MCP 服务器。\n\n## 功能\n\n- 工具：ping、add\n- 资源：2 个\n- 提示词模板：2 个';
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri, mimeType: resource.mimeType, text }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `资源不存在：${uri}` } });
    }
    return;
  }
  if (msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: PROMPTS } });
    return;
  }
  if (msg.method === 'prompts/get') {
    const name = msg.params?.name ?? '';
    if (name === 'mock-review') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          description: '代码审查提示词',
          messages: [
            { role: 'system', content: { type: 'text', text: '请审查以下代码，指出问题与改进建议。' } },
            { role: 'user', content: { type: 'text', text: '语言：${language}\n\n```\n（代码内容）\n```' } },
          ],
        },
      });
    } else if (name === 'mock-summarize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          description: '摘要提示词',
          messages: [
            { role: 'system', content: { type: 'text', text: '请把以下内容压缩成 200 字以内的摘要。' } },
          ],
        },
      });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `提示词不存在：${name}` } });
    }
    return;
  }
  // 未知方法
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `方法不存在：${msg.method}` } });
});
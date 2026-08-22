/**
 * 功能测试：MCP 增强（tools/resources/prompts/instructions/审批模式/过滤/HTTP 传输）。
 * 需要 mock-mcp 子进程（stdio），测试完后清理。
 */
import { TestSuite } from './framework.js';
import {
  discoverMcpServers,
  buildMcpTools,
  mcpInstructionsMessage,
  closeMcpClients,
  mcpToolName,
} from '../../src/tools/mcp.js';
import { gateTool } from '../../src/safety/policy.js';

export function mcpSuite(): TestSuite {
  const suite = new TestSuite('MCP 增强（tools/resources/prompts/instructions/审批模式/过滤）');

  suite.test('MCP 发现：tools + resources + prompts + instructions + 工具过滤', async () => {
    const handles = await discoverMcpServers({
      demo: { command: 'node', args: ['scripts/mock-mcp.mjs'] },
      demo2: { command: 'node', args: ['scripts/mock-mcp.mjs'], enabledTools: ['add'], defaultToolsApprovalMode: 'prompt' },
    });
    try {
      suite.assert(handles.length === 2, '发现 2 个 server');
      const demo = handles.find((h) => h.name === 'demo')!;
      const demo2 = handles.find((h) => h.name === 'demo2')!;
      suite.assert(!!demo && !!demo2, '找到 demo / demo2');
      // resources
      suite.assert(demo.resources.length === 2, 'demo 资源 2 个');
      suite.assert(demo.resources.some((r) => r.uri === 'mock://config/settings'), '资源 URI 正确');
      // prompts
      suite.assert(demo.prompts.length === 2, 'demo 提示词 2 个');
      suite.assert(demo.prompts.some((p) => p.name === 'mock-review'), '提示词名正确');
      // instructions
      suite.assert(demo.instructions?.includes('mock MCP 服务器约束') === true, 'instructions 已获取');
      // 工具过滤
      const tools = buildMcpTools(handles);
      suite.assert(tools.some((t) => t.name === 'demo_ping'), 'demo 工具齐全');
      suite.assert(tools.some((t) => t.name === 'demo_read_resource'), 'demo read_resource 辅助工具');
      suite.assert(!tools.some((t) => t.name === 'demo2_ping'), 'demo2 enabledTools 过滤 ping');
      suite.assert(tools.some((t) => t.name === 'demo2_add'), 'demo2 add 保留');
      // 审批模式烘焙
      const demo2Add = tools.find((t) => t.name === 'demo2_add')!;
      suite.assert(demo2Add.approvalMode === 'prompt', 'demo2 审批模式烘焙为 prompt');
    } finally {
      closeMcpClients();
    }
  });

  suite.test('MCP 工具调用：tool/call 链路（ping + add + serverInfo）', async () => {
    const handles = await discoverMcpServers({
      demo: { command: 'node', args: ['scripts/mock-mcp.mjs'] },
    });
    try {
      const tools = buildMcpTools(handles);
      const ping = tools.find((t) => t.name === 'demo_ping')!;
      const add = tools.find((t) => t.name === 'demo_add')!;
      const info = tools.find((t) => t.name === 'demo_serverInfo')!; // mock 工具名保留大小写
      suite.assert(ping !== undefined, 'ping 工具存在');
      const pingRes = await ping.execute({});
      suite.assert(pingRes.includes('mcp-pong'), `ping 返回 mcp-pong（${pingRes}）`);
      const addRes = await add.execute({ a: 2, b: 3 });
      suite.assert(addRes.includes('5'), `add 2+3=5（${addRes}）`);
      // serverInfo 验证
      const infoRes = await info.execute({});
      suite.assert(infoRes.includes('mock-mcp v0.1.0'), `serverInfo 返回版本（${infoRes.slice(0, 60)}）`);
    } finally {
      closeMcpClients();
    }
  });

  suite.test('MCP 资源读取：read_resource 工具（contents + mimeType）', async () => {
    const handles = await discoverMcpServers({
      demo: { command: 'node', args: ['scripts/mock-mcp.mjs'] },
    });
    try {
      const tools = buildMcpTools(handles);
      const rr = tools.find((t) => t.name === 'demo_read_resource')!;
      suite.assert(rr !== undefined, 'read_resource 工具存在');
      const res = await rr.execute({ uri: 'mock://config/settings' });
      suite.assert(res.includes('"theme": "dark"'), '读取资源内容');
      suite.assert(res.includes('mock://config/settings'), '返回带 URI 标注');
      // 不存在的资源：服务器报错 → 工具返回友好错误（不崩溃）
      const noRes = await rr.execute({ uri: 'mock://nonexistent' });
      suite.assert(noRes.includes('读取失败'), `不存在的资源报错（${noRes.slice(0, 60)}）`);
    } finally {
      closeMcpClients();
    }
  });

  suite.test('MCP 提示词获取：get_prompt 工具（messages 回传）', async () => {
    const handles = await discoverMcpServers({
      demo: { command: 'node', args: ['scripts/mock-mcp.mjs'] },
    });
    try {
      const tools = buildMcpTools(handles);
      const gp = tools.find((t) => t.name === 'demo_get_prompt')!;
      suite.assert(gp !== undefined, 'get_prompt 工具存在');
      const res = await gp.execute({ name: 'mock-review' });
      suite.assert(res.includes('请审查以下代码'), '获取提示词内容');
      suite.assert(res.includes('mock-review'), '返回带模板名标注');
      // 不存在的模板
      const noRes = await gp.execute({ name: 'no-such' });
      suite.assert(noRes.includes('获取失败'), `不存在的模板报错（${noRes.slice(0, 60)}）`);
    } finally {
      closeMcpClients();
    }
  });

  suite.test('MCP instructions 拼接：mcpInstructionsMessage', async () => {
    const handles = await discoverMcpServers({
      demo: { command: 'node', args: ['scripts/mock-mcp.mjs'] },
    });
    try {
      const instr = mcpInstructionsMessage(handles);
      suite.assert(instr !== null, 'instructions 非空');
      suite.assert(instr!.includes('mock MCP 服务器约束'), 'instructions 内容');
      suite.assert(instr!.includes('[MCP server instructions：demo]'), 'instructions 带 server 标注');
    } finally {
      closeMcpClients();
    }
  });

  suite.test('MCP mcpToolName 工具名前缀', () => {
    suite.assert(mcpToolName('my-server', 'read_file') === 'my_server_read_file', '连字符替换为下划线');
    suite.assert(mcpToolName('demo', 'ping') === 'demo_ping', '标准前缀');
  });

  return suite;
}
/**
 * MCP 增强探针（mock-mcp）：验证 6 项增强——
 *   A. Resources 协议（resources/list + read 工具）
 *   B. Prompts 协议（prompts/list + get 工具）
 *   C. server instructions 注入系统提示
 *   D. per-tool 审批模式（defaultToolsApprovalMode 烘焙 + gateTool 消费）
 *   E. enabled/disabled 工具白黑名单
 *   F. discoverMcpServers 完整句柄 + buildMcpTools 组装
 *
 * 运行：npx tsx scripts/probe-tmp/probe-mcp-enhanced.ts
 */
import { discoverMcpServers, buildMcpTools, mcpInstructionsMessage, closeMcpClients } from '../../src/tools/mcp.js';
import { gateTool, applyApprovalMode } from '../../src/safety/policy.js';

let failed = 0;
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main(): Promise<void> {
  // 构造两个 server：demo（全功能 + auto）、demo2（enabled 白名单 + prompt 审批）
  const handles = await discoverMcpServers({
    demo: { command: 'node', args: ['scripts/mock-mcp.mjs'] },
    demo2: {
      command: 'node',
      args: ['scripts/mock-mcp.mjs'],
      enabledTools: ['add'],
      defaultToolsApprovalMode: 'prompt',
    },
  });

  console.log('=== A/B/F. 发现句柄 + 工具/资源/提示词组装 ===');
  assert(handles.length === 2, `发现 2 个 server（实际 ${handles.length}）`);
  const demo = handles.find((h) => h.name === 'demo')!;
  const demo2 = handles.find((h) => h.name === 'demo2')!;
  assert(!!demo && !!demo2, '找到 demo / demo2');
  assert(demo.resources.length === 2, `demo 资源 2 个（实际 ${demo.resources.length}）`);
  assert(demo.prompts.length === 2, `demo 提示词 2 个（实际 ${demo.prompts.length}）`);
  assert(demo.instructions?.includes('mock MCP 服务器约束'), 'demo instructions 已获取');

  const tools = buildMcpTools(handles);
  const names = tools.map((t) => t.name);
  assert(names.includes('demo_ping') && names.includes('demo_add'), 'demo 工具完整');
  assert(names.includes('demo_read_resource') && names.includes('demo_get_prompt'), 'demo 资源/提示词辅助工具已注册');
  assert(!names.includes('demo2_ping') && names.includes('demo2_add'), 'demo2 enabledTools 白名单生效（只暴露 add）');
  // enabledTools 只过滤 server 工具；资源/提示词辅助工具（只读）始终注册
  assert(names.filter((n) => n.startsWith('demo2_')).length === 3, 'demo2 = add + read_resource + get_prompt（3 个）');

  console.log('=== D. per-tool 审批模式烘焙 ===');
  const demoPing = tools.find((t) => t.name === 'demo_ping')!;
  const demoAdd = tools.find((t) => t.name === 'demo_add')!;
  const demo2Add = tools.find((t) => t.name === 'demo2_add')!;
  assert((demoPing.approvalMode ?? 'auto') === 'auto', 'demo 工具审批模式 = auto（缺省）');
  assert((demo2Add.approvalMode ?? '') === 'prompt', 'demo2 工具审批模式 = prompt（烘焙）');

  console.log('=== D2. gateTool 消费 per-tool 审批模式 ===');
  // prompt 模式：full 档位也询问
  const gPrompt = gateTool('full', demo2Add, { a: 1, b: 2 });
  assert(gPrompt.needApproval === true, `prompt 模式在 full 档位仍询问（${JSON.stringify(gPrompt)}）`);
  // auto 模式：full 档位放行
  const gAuto = gateTool('full', demoAdd, { a: 1, b: 2 });
  assert(JSON.stringify(gAuto) === JSON.stringify({ allow: true }), `auto 模式在 full 档位放行（${JSON.stringify(gAuto)}）`);
  // ask 档位：auto 工具询问
  const gAsk = gateTool('ask', demoPing, {});
  assert(gAsk.needApproval === true, 'ask 档位下 auto 工具询问');
  // read 档位：MCP 工具（非 readOnly）拒绝
  const gRead = gateTool('read', demoAdd, {});
  assert(gRead.allow === false, 'read 档位下 MCP 写工具拒绝');
  // read 档位：read_resource 辅助工具（readOnly）放行
  const gReadRes = gateTool('read', tools.find((t) => t.name === 'demo_read_resource')!, {});
  assert(gReadRes.allow === true, 'read 档位下 read_resource（readOnly）放行');

  console.log('=== C. instructions 注入系统提示 ===');
  const instr = mcpInstructionsMessage(handles);
  assert(!!instr && instr.includes('mock MCP 服务器约束'), 'instructions 拼接非空');
  assert(instr.includes('[MCP server instructions：demo]'), 'instructions 带 server 名标注');

  console.log('=== E2. applyApprovalMode 纯函数边界 ===');
  // approve 模式：deny 保留（read 硬拒绝不可绕过）
  const deny = { allow: false as const, reason: 'x' };
  const apApprove = applyApprovalMode('approve', deny, demoAdd);
  assert(apApprove.allow === false, 'approve 模式不绕过 read 硬拒绝');
  // approve 模式：allow → 放行
  const apApprove2 = applyApprovalMode('approve', { allow: true }, demoAdd);
  assert(apApprove2.allow === true, 'approve 模式放行 allow');
  // writes 模式：readOnly 放行、非只读询问
  const resTool = tools.find((t) => t.name === 'demo_read_resource')!;
  const apWritesRo = applyApprovalMode('writes', { allow: true }, resTool);
  assert(apWritesRo.allow === true, 'writes 模式只读工具放行');
  const apWritesW = applyApprovalMode('writes', { allow: true }, demoAdd);
  assert(apWritesW.needApproval === true, 'writes 模式写工具询问');

  console.log('=== 工具实际调用（tools/call 链路）===');
  const pingRes = await demoPing.execute({});
  assert(pingRes.includes('mcp-pong'), `ping 调用返回（${pingRes}）`);
  const addRes = await demoAdd.execute({ a: 2, b: 3 });
  assert(addRes.includes('5'), `add 调用返回（${addRes}）`);
  const rr = await tools.find((t) => t.name === 'demo_read_resource')!.execute({ uri: 'mock://config/settings' });
  assert(rr.includes('"theme": "dark"'), `read_resource 返回内容（${rr.slice(0, 50)}）`);
  const gp = await tools.find((t) => t.name === 'demo_get_prompt')!.execute({ name: 'mock-review' });
  assert(gp.includes('代码审查') && gp.includes('请审查以下代码'), `get_prompt 返回模板（${gp.slice(0, 60)}）`);

  closeMcpClients();
  console.log(failed === 0 ? '\n✓✓ MCP 增强探针全部通过' : `\n✗✗ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

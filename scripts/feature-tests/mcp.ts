/**
 * 功能测试：MCP 增强（tools/resources/prompts/instructions/审批模式/过滤/HTTP 传输）。
 * 需要 mock-mcp 子进程（stdio），测试完后清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TestSuite } from './framework.js';
import { runMcpCommand } from '../../src/cli/mcp.js';

const MCP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

  suite.test('顶层 mcp add/remove 写配置（codex mcp 对等；空目录隔离）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-add-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    // 空目录隔离：loadConfigObject 落盘目标不受仓库项目配置污染
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-cwd-'));
    const oldCwd = process.cwd();
    process.chdir(tmpCwd);
    try {
      const { loadConfig } = await import('../../src/config/index.js');
      suite.assert((await runMcpCommand(['add'])) === 1, 'add 缺名非零退出');
      suite.assert((await runMcpCommand(['add', 'bad name!'])) === 1, '非法名拒绝');
      suite.assert((await runMcpCommand(['add', 's1'])) === 1, '缺传输拒绝');
      suite.assert((await runMcpCommand(['add', 's1', '--url', 'notaurl'])) === 1, '非法 URL 拒绝');
      suite.assert((await runMcpCommand(['add', 's1', '--url', 'https://mcp.example.com', '--env', 'A=1'])) === 1, '--env 仅 stdio');
      suite.assert((await runMcpCommand(['add', 's1', '--url', 'https://mcp.example.com', '--env', 'NOEQ'])) === 1, '--env 形态校验');
      suite.assert((await runMcpCommand(['add', 's1', '--url', 'https://mcp.example.com'])) === 0, 'add http 成功');
      suite.assert((await runMcpCommand(['add', 's1', '--url', 'https://x.example.com'])) === 1, '重复名拒绝');
      suite.assert((await runMcpCommand(['add', 's2', '--env', 'K=V', '--', 'npx', '-y', 'x'])) === 0, 'add stdio 成功');
      const cfg = loadConfig();
      const names = Object.keys(cfg.mcpServers ?? {});
      suite.assert(names.includes('s1') && names.includes('s2'), '落盘后可读回');
      suite.assert((cfg.mcpServers as Record<string, { url?: string }>)['s1']?.url === 'https://mcp.example.com', 'http 条目正确');
      const s2 = (cfg.mcpServers as Record<string, { command?: string; env?: Record<string, string> }>)['s2'];
      suite.assert(s2?.command === 'npx' && s2?.env?.['K'] === 'V', 'stdio 条目正确');
      suite.assert((await runMcpCommand(['remove', 'nope'])) === 1, '删不存在的非零退出');
      suite.assert((await runMcpCommand(['remove', 's1'])) === 0, 'remove 成功');
      suite.assert(!Object.keys(loadConfig().mcpServers ?? {}).includes('s1'), '删除落盘');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('顶层 mcp login/logout 登录态（codex mcp 对等；离线可测路径）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-auth-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    // cwd 切空目录：避开仓库 omni.json 的项目层替换（mcpServers 按层覆盖非合并）
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-cwd-'));
    const oldCwd = process.cwd();
    process.chdir(tmpCwd);
    try {
      fs.mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpXdg, 'omni', 'omni.json'),
        JSON.stringify({
          mcpServers: {
            std: { command: 'node', args: ['x.mjs'] },
            remote: { url: 'https://mcp.example.com' },
            dead: { url: 'https://127.0.0.1:9/' },
          },
        })
      );
      const { saveMcpToken, loadMcpToken } = await import('../../src/tools/mcp-oauth.js');
      suite.assert((await runMcpCommand(['login'])) === 1, 'login 缺名非零退出');
      suite.assert((await runMcpCommand(['login', 'nope'])) === 1, 'login 未知服务器非零退出');
      suite.assert((await runMcpCommand(['login', 'std'])) === 1, 'stdio 服务器无需登录');
      suite.assert((await runMcpCommand(['logout', 'nope'])) === 1, 'logout 未知服务器非零退出');
      suite.assert((await runMcpCommand(['logout', 'remote'])) === 0, '无登录态 logout 照常退出码 0');
      await saveMcpToken('https://mcp.example.com', { accessToken: 'tok', expiresAt: Date.now() + 3600_000 });
      suite.assert(((await loadMcpToken('https://mcp.example.com')) !== null), '预置 token 生效');
      suite.assert((await runMcpCommand(['logout', 'remote'])) === 0, 'logout 退出码 0');
      suite.assert(((await loadMcpToken('https://mcp.example.com')) === null), 'logout 清除 token');
      suite.assert((await runMcpCommand(['login', 'dead'])) === 1, '不可达端点快速失败（不抛未捕获异常）');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('mcp --bearer-token-env-var（codex 对等；token 不落盘，{env:} 运行时解析）', async () => {
    const { parseMcpAddArgs } = await import('../../src/cli/mcp.js');
    const r1 = parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--bearer-token-env-var', 'MCP_TOK']);
    suite.assert(
      r1.entry?.headers?.['Authorization'] === 'Bearer {env:MCP_TOK}',
      '落盘形态为引用而非密钥'
    );
    // -- 之后一律当命令体（Unix 约定）：flag 放前面才生效，放后面是命令参数
    suite.assert(parseMcpAddArgs(['s', '--bearer-token-env-var', 'X', '--', 'cmd']).error !== undefined, 'stdio 下拒绝');
    suite.assert(parseMcpAddArgs(['s', '--', 'cmd', '--bearer-token-env-var', 'X']).error === undefined, '-- 之后是命令体不解析');
    suite.assert(parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--bearer-token-env-var', '9bad']).error !== undefined, '非法变量名拒绝');
    // loadConfig 解析：设值则替换，未设则删键
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-env-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-envcwd-'));
    const oldCwd = process.cwd();
    process.chdir(tmpCwd);
    const savedTok = process.env.MCP_TOK;
    try {
      fs.mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpXdg, 'omni', 'omni.json'),
        JSON.stringify({ mcpServers: { r: { url: 'https://m.example.com', headers: { Authorization: 'Bearer {env:MCP_TOK}' } } } })
      );
      const { loadConfig } = await import('../../src/config/index.js');
      process.env.MCP_TOK = 'secret123';
      const c1 = loadConfig();
      suite.assert((c1.mcpServers as Record<string, { headers?: Record<string, string> }>)['r']?.headers?.['Authorization'] === 'Bearer secret123', '设值时解析替换');
      delete process.env.MCP_TOK;
      const c2 = loadConfig();
      suite.assert(!('Authorization' in ((c2.mcpServers as Record<string, { headers?: Record<string, string> }>)['r']?.headers ?? {})), '未设值时删键（fail-closed）');
      // e2e：add 落盘为引用原文
      const { runMcpCommand } = await import('../../src/cli/mcp.js');
      suite.assert((await runMcpCommand(['add', 'rb', '--url', 'https://m.example.com', '--bearer-token-env-var', 'MCP_TOK'])) === 0, 'add bearer 成功');
      // 落盘目标：唯一配置文件源 = XDG 全局（loadConfigObject 取最高优先级文件）
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpXdg, 'omni', 'omni.json'), 'utf8')) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
      suite.assert(onDisk.mcpServers['rb']?.headers?.['Authorization'] === 'Bearer {env:MCP_TOK}', '落盘为引用，密钥不进文件');
    } finally {
      if (savedTok === undefined) delete process.env.MCP_TOK;
      else process.env.MCP_TOK = savedTok;
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('顶层 mcp list/get 只读查看（codex mcp 对等；密钥脱敏）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-cli-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    try {
      // 空配置：list 零服务器
      suite.assert(await runMcpCommand([]) === 0, '空配置 list 退出码 0');
      // 写含密钥的配置：list 显示传输形态，get 脱敏
      fs.mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpXdg, 'omni', 'omni.json'),
        JSON.stringify({
          mcpServers: {
            demo: { command: 'node', args: ['x.mjs'], enabledTools: ['a', 'b'] },
            remote: { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer sk-abcdefghijklmnopqrst' } },
          },
        })
      );
      suite.assert(await runMcpCommand(['list']) === 0, 'list 退出码 0');
      suite.assert(await runMcpCommand(['get']) === 1, 'get 缺名非零退出');
      suite.assert(await runMcpCommand(['get', 'nope']) === 1, 'get 未知服务器非零退出');
      suite.assert(await runMcpCommand(['add', 'x']) === 1, '写操作显式拒绝（指路 TUI/配置文件）');
      // get 经 CLI 子进程验证脱敏（函数内 console 输出同源，此处只验返回码；脱敏断言走 parse 输出捕获）
      const out = await new Promise<string>((resolve) => {
        // cwd=临时目录：避开仓库 omni.json 的项目层替换（mcpServers 按层覆盖非合并）
        const child = spawn('npx', ['tsx', path.join(MCP_ROOT, 'src/index.ts'), 'mcp', 'get', 'remote'], {
          cwd: tmpXdg,
          env: { ...process.env, XDG_CONFIG_HOME: tmpXdg },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve(acc);
        });
      });
      suite.assert(out.includes('https://mcp.example.com'), 'get 输出端点');
      suite.assert(!out.includes('sk-abcdefghijklmnopqrst'), 'get 密钥已脱敏');
      suite.assert(out.includes('[REDACTED]'), '脱敏标记可见');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('MCP mcpToolName 工具名前缀', () => {
    suite.assert(mcpToolName('my-server', 'read_file') === 'my_server_read_file', '连字符替换为下划线');
    suite.assert(mcpToolName('demo', 'ping') === 'demo_ping', '标准前缀');
  });

  return suite;
}
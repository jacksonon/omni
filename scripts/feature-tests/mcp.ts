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

  suite.test('mcp add 成功指引 OAuth 登录（http 无 bearer 才打）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-addhint-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-addhintcwd-'));
    const oldCwd = process.cwd();
    process.chdir(tmpCwd);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      fs.mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      suite.assert((await runMcpCommand(['add', 'h1', '--url', 'https://mcp.example.com'])) === 0, 'add http 成功');
      suite.assert(logs.some((l) => l.includes('omni mcp login h1')), '无 bearer 打登录指引');
      logs.length = 0;
      suite.assert((await runMcpCommand(['add', 'h2', '--url', 'https://mcp.example.com', '--bearer-token-env-var', 'TOK'])) === 0, 'add bearer 成功');
      suite.assert(!logs.some((l) => l.includes('omni mcp login h2')), 'bearer 条目不打指引');
      logs.length = 0;
      suite.assert((await runMcpCommand(['add', 'h3', '--', 'npx', '-y', 'x'])) === 0, 'add stdio 成功');
      suite.assert(!logs.some((l) => l.includes('omni mcp login h3')), 'stdio 条目不打指引');
    } finally {
      console.log = origLog;
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

  suite.test('mcp add --oauth-resource/--oauth-client-registration（codex 对等）', async () => {
    const { parseMcpAddArgs } = await import('../../src/cli/mcp.js');
    const r1 = parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-id', 'cid', '--oauth-resource', 'https://api.example.com', '--oauth-client-registration', 'dcr']);
    suite.assert(r1.entry?.oauthResource === 'https://api.example.com', 'resource 进 entry');
    suite.assert(r1.entry?.oauthClientRegistration === 'dcr', 'registration 进 entry');
    suite.assert(r1.entry?.clientId === 'cid', 'clientId 照常保留');
    const r2 = parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-registration', 'auto']);
    suite.assert(r2.error === undefined && r2.entry?.oauthClientRegistration === undefined, 'auto 不落盘（即缺省）');
    suite.assert(parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-registration', 'bogus']).error !== undefined, '非法策略拒绝');
    suite.assert(parseMcpAddArgs(['s', '--oauth-resource', 'R', '--', 'cmd']).error !== undefined, 'stdio 下 resource 拒绝');
    suite.assert(parseMcpAddArgs(['s', '--oauth-client-registration', 'dcr', '--', 'cmd']).error !== undefined, 'stdio 下 registration 拒绝');
    // 落盘 → loadConfig 回读：clientId 曾被 allowlist 漏丢，此处锁定三字段全存活
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-oauthcfg-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-oauthcwd-'));
    const oldCwd = process.cwd();
    process.chdir(tmpCwd);
    try {
      fs.mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpXdg, 'omni', 'omni.json'),
        JSON.stringify({ mcpServers: { s: {
          url: 'https://m.example.com', clientId: 'cid-9',
          oauthResource: 'https://api.example.com', oauthClientRegistration: 'cimd',
        } } })
      );
      const { loadConfig } = await import('../../src/config/index.js');
      const got = (loadConfig().mcpServers as Record<string, Record<string, unknown>>)['s'] ?? {};
      suite.assert(got['clientId'] === 'cid-9', 'clientId 重载存活（drop bug 回归锁）');
      suite.assert(got['oauthResource'] === 'https://api.example.com', 'oauthResource 重载存活');
      suite.assert(got['oauthClientRegistration'] === 'cimd', 'oauthClientRegistration 重载存活');
      // 非法策略值落盘也被清洗（fail-closed）
      fs.writeFileSync(
        path.join(tmpXdg, 'omni', 'omni.json'),
        JSON.stringify({ mcpServers: { s: { url: 'https://m.example.com', oauthClientRegistration: 'bogus' } } })
      );
      const got2 = (loadConfig().mcpServers as Record<string, Record<string, unknown>>)['s'] ?? {};
      suite.assert(got2['oauthClientRegistration'] === undefined, '非法策略重载清洗');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('mcp add --oauth-client-secret（codex 83b56bc；预注册保密客户端）', async () => {
    const { parseMcpAddArgs } = await import('../../src/cli/mcp.js');
    const { resolveOAuthClientId, isStaleOAuthToken } = await import('../../src/tools/mcp-oauth.js');
    const { redactDeep } = await import('../../src/agent/redact.js');
    // 解析：成对通过 / 缺 id 拒绝 / stdio 拒绝 / 空串拒绝
    const ok = parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-id', 'cid', '--oauth-client-secret', 'shh-1']);
    suite.assert(ok.entry?.clientId === 'cid' && ok.entry?.clientSecret === 'shh-1', 'id+secret 进 entry');
    suite.assert(parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-secret', 'shh-1']).error !== undefined, '缺 clientId 拒绝');
    suite.assert(parseMcpAddArgs(['s', '--oauth-client-secret', 'shh-1', '--', 'cmd']).error !== undefined, 'stdio 下 secret 拒绝');
    suite.assert(parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-id', 'cid', '--oauth-client-secret', '']).error !== undefined, '空 secret 拒绝');
    suite.assert(parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-id', 'cid', '--oauth-client-secret', '   ']).error !== undefined, '空白 secret 拒绝');
    suite.assert(parseMcpAddArgs(['s', '--url', 'https://m.example.com', '--oauth-client-id', '  ', '--oauth-client-secret', 'shh-1']).error !== undefined, '空白 id 配 secret 拒绝');
    // 解析：显式保密对跳过 DCR（无网络）
    const r = await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb', { clientId: 'cid', clientSecret: 'shh-1' });
    suite.assert(r.clientId === 'cid' && r.clientSecret === 'shh-1', '显式 id+secret 直接用');
    const rc = await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb', { clientId: 'https://id.example.com/m', clientSecret: 'shh-2', clientRegistration: 'cimd' });
    suite.assert(rc.clientId === 'https://id.example.com/m' && rc.clientSecret === 'shh-2', 'cimd 不丢配置 secret');
    let ed = '';
    try { await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb', { clientId: 'cid', clientSecret: 'shh-1', clientRegistration: 'dcr' }); }
    catch (e) { ed = (e as Error).message; }
    suite.assert(ed.includes('registration_endpoint'), '显式 dcr 下配置 secret 让路（走注册路径）');
    // 失配判定纯函数
    suite.assert(isStaleOAuthToken(undefined, null) === false, '无配置不判');
    suite.assert(isStaleOAuthToken('a', { accessToken: 't', tokenType: 'Bearer', clientId: 'a' }) === false, '一致不失效');
    suite.assert(isStaleOAuthToken('b', { accessToken: 't', tokenType: 'Bearer', clientId: 'a' }) === true, 'id 变更即失效');
    suite.assert(isStaleOAuthToken('a', { accessToken: 't', tokenType: 'Bearer' }) === false, '旧记录无 clientId 不误伤');
    // 脱敏：裸随机串按键名整值换（形状正则兜不住的形态）
    const deep = redactDeep({ url: 'https://m.example.com', clientSecret: 's3cr3t-no-digits-xyz' }) as Record<string, string>;
    suite.assert(deep['clientSecret'] === '[REDACTED]', 'clientSecret 键整值脱敏');
    suite.assert(deep['url'] === 'https://m.example.com', '非密钥键不动');
    // 落盘 → loadConfig 回读存活
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-secretcfg-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-secretcwd-'));
    const oldCwd = process.cwd();
    process.chdir(tmpCwd);
    try {
      fs.mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpXdg, 'omni', 'omni.json'),
        JSON.stringify({ mcpServers: { s: { url: 'https://m.example.com', clientId: 'cid-9', clientSecret: 'shh-9' } } })
      );
      const { loadConfig } = await import('../../src/config/index.js');
      const got = (loadConfig().mcpServers as Record<string, Record<string, unknown>>)['s'] ?? {};
      suite.assert(got['clientSecret'] === 'shh-9', 'clientSecret 重载存活');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('mcp login 预注册密钥端到端（secret 进交换 + clientId 落记录 + 密钥不落盘）', async () => {
    const { createServer } = await import('node:http');
    const seen: { tokenBody: string } = { tokenBody: '' };
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x/');
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token` }));
      } else if (u.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          seen.tokenBody = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok-456', token_type: 'Bearer', expires_in: 3600 }));
        });
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-presecret-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      const { oauthLogin, loadMcpToken } = await import('../../src/tools/mcp-oauth.js');
      const tok = await oauthLogin(`http://127.0.0.1:${port}`, 'mcp', {
        noBrowser: true,
        clientId: 'pre-reg-id',
        clientSecret: 'shh-1',
        promptCallback: async (info: { state: string }) =>
          `http://127.0.0.1:${port}/cb?code=authcode9&state=${info.state}`,
      });
      const q = new URLSearchParams(seen.tokenBody);
      suite.assert(q.get('client_secret') === 'shh-1', '配置密钥进换 token 请求');
      suite.assert(q.get('client_id') === 'pre-reg-id', '预注册 id 进换 token 请求');
      suite.assert(tok?.clientId === 'pre-reg-id', 'token 记录获得它的 client');
      const saved = await loadMcpToken(`http://127.0.0.1:${port}`);
      suite.assert(saved?.clientId === 'pre-reg-id', 'clientId 持久化可读回');
      // 密钥不进持久化记录：扫 XDG 下全部落盘文件
      const dropped: string[] = [];
      const walk = (d: string): void => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name);
          if (f.isDirectory()) { walk(fp); continue; }
          try { if (fs.readFileSync(fp, 'utf8').includes('shh-1')) dropped.push(fp); } catch { /* 二进制跳过 */ }
        }
      };
      walk(tmpXdg);
      suite.assert(dropped.length === 0, `密钥未落盘（${dropped.join(',') || '干净'}）`);
      // 授权地址不带密钥（只读 id）
      const printed = logs.join('\n');
      const httpAt = printed.indexOf('http');
      suite.assert(httpAt >= 0, '打印了授权地址');
      const aq = new URL(printed.slice(httpAt).trim().split(/\s/)[0] ?? '').searchParams;
      suite.assert(!aq.toString().includes('shh-1'), '授权地址无密钥');
      suite.assert(aq.get('client_id') === 'pre-reg-id', '授权地址带预注册 id');
    } finally {
      console.log = origLog;
      srv.close();
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });
  suite.test('OAuth 纯函数：scope 归一/授权地址/回调解析', async () => {
    const { normalizeScopes, buildAuthorizeUrl, parseCallbackParams } = await import('../../src/tools/mcp-oauth.js');
    suite.assert(normalizeScopes('a,b , c') === 'a b c', '逗号形态归一为空格');
    suite.assert(normalizeScopes('a  b') === 'a b', '空格形态压缩');
    suite.assert(normalizeScopes('') === undefined && normalizeScopes() === undefined, '空回 undefined');
    const u = buildAuthorizeUrl('https://auth.example.com/authorize', {
      clientId: 'cid', redirectUri: 'http://127.0.0.1:1/cb', challenge: 'ch', state: 'st',
      scope: 'a b', resource: 'https://api.example.com',
    });
    const q = new URL(u).searchParams;
    suite.assert(q.get('client_id') === 'cid' && q.get('scope') === 'a b' && q.get('resource') === 'https://api.example.com', 'scope/resource 进地址');
    suite.assert(q.get('code_challenge_method') === 'S256' && q.get('state') === 'st', 'PKCE/state 齐全');
    const u2 = buildAuthorizeUrl('https://auth.example.com/authorize', {
      clientId: 'c', redirectUri: 'http://127.0.0.1:1/cb', challenge: 'x', state: 's',
    });
    suite.assert(!new URL(u2).searchParams.has('scope') && !new URL(u2).searchParams.has('resource'), '缺省不发 scope/resource');
    suite.assert(parseCallbackParams(new URLSearchParams('code=abc&state=s'), 's') === 'abc', '回调取 code');
    for (const [ps, st, why] of [
      ['code=abc&state=x', 's', 'state 不一致抛错'],
      ['state=s', 's', '无 code 抛错'],
    ] as [string, string, string][]) {
      let threw = '';
      try { parseCallbackParams(new URLSearchParams(ps), st); } catch (e) { threw = (e as Error).message; }
      suite.assert(threw !== '', why);
    }
  });

  suite.test('mcp login --no-browser 离线端到端（桩 OAuth 端点 + token 落盘）', async () => {
    const { createServer } = await import('node:http');
    const seen: { authQuery: string; tokenBody: string } = { authQuery: '', tokenBody: '' };
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x/');
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token` }));
      } else if (u.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          seen.tokenBody = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok-123', token_type: 'Bearer', expires_in: 3600 }));
        });
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-nobrowser-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    // 打印的授权地址：桩回调按 state 组地址回填（promptCallback 拿 state 即为此设计）
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      const { oauthLogin, loadMcpToken } = await import('../../src/tools/mcp-oauth.js');
      const tok = await oauthLogin(`http://127.0.0.1:${port}`, 'mcp', {
        noBrowser: true,
        scopes: 'read,write',
        resource: 'https://api.example.com',
        promptCallback: async (info: { state: string }) =>
          `http://127.0.0.1:${port}/cb?code=authcode1&state=${info.state}`,
      });
      suite.assert(tok?.accessToken === 'tok-123', '换 token 成功并返回');
      const printed = logs.join('\n');
      const aq = new URL(printed.slice(printed.indexOf('http')).trim().split(/\s/)[0] ?? '').searchParams;
      seen.authQuery = aq.toString();
      suite.assert(aq.get('scope') === 'read write', 'scopes 归一进授权地址');
      suite.assert(aq.get('resource') === 'https://api.example.com', 'resource 进授权地址');
      suite.assert(new URLSearchParams(seen.tokenBody).get('resource') === 'https://api.example.com', 'resource 进换 token 请求');
      suite.assert(new URLSearchParams(seen.tokenBody).get('code') === 'authcode1', 'code 正确传递');
      const saved = await loadMcpToken(`http://127.0.0.1:${port}`);
      suite.assert(saved?.accessToken === 'tok-123', 'token 持久化可读回');
    } finally {
      console.log = origLog;
      srv.close();
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('mcp login 参数校验（未知旗/非法策略/交互内 no-browser 指路）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-loginflg-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mcp-logincwd-'));
    const oldCwd = process.cwd();
    process.chdir(tmpCwd);
    try {
      fs.mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpXdg, 'omni', 'omni.json'),
        JSON.stringify({ mcpServers: { r: { url: 'https://mcp.example.com' } } })
      );
      suite.assert((await runMcpCommand(['login', 'r', '--bogus'])) === 1, '未知 flag 拒绝');
      suite.assert((await runMcpCommand(['login', 'r', '--oauth-client-registration', 'x'])) === 1, '非法策略拒绝');
      suite.assert((await runMcpCommand(['login'])) === 1, 'login 缺名拒绝');
      // 交互内 no-browser：不等 stdin，直接指路顶层（双 readline 饿死教训）
      suite.assert((await runMcpCommand(['login', 'r', '--no-browser'], {}, { fromInteractive: true })) === 1, '交互内 no-browser 指路顶层');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('sampling 跟随当前模型运行时（/model 切换不 stale）', async () => {
    const { createMcpHandlers } = await import('../../src/tools/mcp.js');
    const seen: string[] = [];
    const stubClient = { chat: { completions: { create: async (p: { model: string }) => {
      seen.push(p.model);
      return { choices: [{ message: { content: 'sampled' }, finish_reason: 'stop' }] };
    } } } };
    let current = 'm-old';
    const h = createMcpHandlers({
      client: stubClient as never,
      model: 'm-old',
      getClient: () => stubClient as never,
      getModel: () => current,
    });
    const msg = [{ role: 'user', content: { type: 'text', text: 'hi' } }];
    const r1 = await h.sample('s', { messages: msg });
    current = 'm-new';
    const r2 = await h.sample('s', { messages: msg });
    suite.assert(seen.join(',') === 'm-old,m-new', '每次 sampling 现取模型（非创建时快照）');
    suite.assert(r2.model === 'm-new' && r1.model === 'm-old', '返回体模型同步');
  });

  suite.test('OAuth 注册策略解析（cimd/dcr/auto，无网络路径）', async () => {
    const { resolveOAuthClientId } = await import('../../src/tools/mcp-oauth.js');
    const r1 = await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb', { clientId: 'https://id.example.com/meta' });
    suite.assert(r1.clientId === 'https://id.example.com/meta', 'auto 显式优先（CIMD URL）');
    const r2 = await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb');
    suite.assert(r2.clientId === 'omni', 'auto 无端点回退 omni');
    let e1 = '';
    try { await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb', { clientRegistration: 'cimd' }); }
    catch (e) { e1 = (e as Error).message; }
    suite.assert(e1.includes('CIMD'), 'cimd 缺 clientId 抛错');
    const r3 = await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb', { clientId: 'https://id.example.com/m', clientRegistration: 'cimd' });
    suite.assert(r3.clientId === 'https://id.example.com/m', 'cimd 显式 URL 通过');
    let e2 = '';
    try { await resolveOAuthClientId({}, 'http://127.0.0.1:1/cb', { clientRegistration: 'dcr' }); }
    catch (e) { e2 = (e as Error).message; }
    suite.assert(e2.includes('registration_endpoint'), 'dcr 无端点抛错（不静默回退）');
  });

  suite.test('mcp --help 子命令帮助（codex mcp --help 对等）', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      suite.assert((await runMcpCommand(['--help'])) === 0, '--help 退出码 0');
      const out = logs.join('\n');
      for (const s of ['list', 'get <名称>', 'add <名称> --url', 'remove <名称>', 'login <名称>', 'logout <名称>', '--oauth-client-secret']) {
        suite.assert(out.includes(s), `帮助含 ${s}`);
      }
      // CLI 分发：taskArgs 剥掉 --help，main 须传字面量（曾实锤透传空数组回落 list）
      const cliOut = await new Promise<string>((resolve) => {
        const child = spawn('npx', ['tsx', path.join(MCP_ROOT, 'src/index.ts'), 'mcp', '--help'], {
          cwd: MCP_ROOT,
          env: { ...process.env },
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
      suite.assert(cliOut.includes('omni mcp <子命令>'), 'CLI 分发进专属帮助（非全局/非 list）');
    } finally {
      console.log = origLog;
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
            remote: { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer sk-abcdefghijklmnopqrst' }, clientId: 'cid-1', clientSecret: 'naked-random-secret-xyz' },
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
      suite.assert(!out.includes('naked-random-secret-xyz'), '裸 clientSecret 按键名脱敏（形状正则兜不住）');
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
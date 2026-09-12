/**
 * 功能测试：2026-09 市场对齐批次（redaction / 会话 pin·archive / /cd / Vim /
 * 子代理信号量 / team 看板与动态工作流 / AI 自动审批 / MCP elicitation·sampling /
 * LSP 纯函数 / 插件系统）。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestSuite } from './framework.js';
import { redactText, redactDeep, setSecretRedaction } from '../../src/agent/redact.js';
import { resolveCdArg } from '../../src/agent/workspace.js';
import { applyVimNormal, vimCurrentLine } from '../../src/tui/vim.js';
import { SubagentSemaphore } from '../../src/agent/semaphore.js';
import { TeamBoard, parseWorkflowPlan, planBatches } from '../../src/agent/team.js';
import { parseAutoReviewVerdict, createAutoReviewer } from '../../src/safety/auto-review.js';
import { createMcpHandlers } from '../../src/tools/mcp.js';
import { lspServerSpecFor, formatHover, formatSymbols, formatLspLocation, detectInstalledLsp } from '../../src/tools/lsp.js';
import {
  createSession,
  appendSessionMessages,
  loadSession,
  listSessions,
  resolveSessionTarget,
  updateSessionMeta,
  sessionIdFromPath,
} from '../../src/agent/session.js';
import {
  createTaskBoardTool,
  createSendMessageTool,
} from '../../src/tools/team-tools.js';
import { Safety } from '../../src/safety/index.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withXdg<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.XDG_CONFIG_HOME;
  const dir = tempDir('omni-xdg-extra-');
  process.env.XDG_CONFIG_HOME = dir;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });
}

export function extras2026Suite(): TestSuite {
  const suite = new TestSuite('2026-09 对齐批次（redaction/pin/cd/vim/team/审批/MCP/LSP/插件）');

  /* ---------------- 密钥脱敏 ---------------- */
  suite.test('redaction：密钥形状替换 + 代码不误伤 + 递归 + 开关', () => {
    suite.assert(redactText('key sk-abcdefghijklmnop1234 end').includes('[REDACTED]'), 'sk- 密钥被替换');
    suite.assert(redactText('Authorization: Bearer abcdefghijklmnop.qrstuvwx').includes('Bearer [REDACTED]'), 'Bearer 保留前缀');
    suite.assert(redactText('AKIAIOSFODNN7EXAMPLE').includes('[REDACTED]'), 'AWS key 被替换');
    suite.assert(redactText('ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('[REDACTED]'), 'GitHub token 被替换');
    const pk = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
    suite.assert(!redactText(pk).includes('MIIEabc'), '私钥块被替换');
    suite.assert(redactText('API_KEY=abc123xyz789').includes('[REDACTED]'), 'env 风格密钥被替换');
    suite.assert(redactText('const token = getToken();').includes('getToken()'), '函数调用不误伤');
    suite.assert(redactText('process.env.API_KEY') === 'process.env.API_KEY', 'env 引用不误伤');
    suite.assert(redactText('$5 and $10').includes('$5'), '价格文本不误伤');
    const deep = redactDeep({ messages: [{ content: 'sk-abcdefghijklmnop1234' }] }) as { messages: { content: string }[] };
    suite.assert(deep.messages[0].content === '[REDACTED]', '递归结构脱敏');
    setSecretRedaction(false);
    suite.assert(redactText('sk-abcdefghijklmnop1234') === 'sk-abcdefghijklmnop1234', '开关关闭后原样');
    setSecretRedaction(true);
  });

  /* ---------------- 会话 pin / archive / 脱敏落盘 ---------------- */
  suite.test('session：pin/archive 排序、归档过滤、目标解析、落盘脱敏', async () => {
    await withXdg(async () => {
      const a = await createSession({ project: process.cwd(), model: 'm' });
      suite.assert(!!a, '创建会话 A');
      await new Promise((r) => setTimeout(r, 5));
      const b = await createSession({ project: process.cwd(), model: 'm' });
      suite.assert(!!b, '创建会话 B');
      // B 置顶 → 列表 B 在 A 前
      await updateSessionMeta(b!, { pinned: true });
      const list1 = await listSessions(process.cwd());
      suite.assert(list1[0].id === sessionIdFromPath(b!), '置顶会话排最前');
      // A 归档 → 默认列表隐藏、includeArchived 可见
      await updateSessionMeta(a!, { archived: true });
      const list2 = await listSessions(process.cwd(), { includeArchived: false });
      suite.assert(!list2.some((s) => s.id === sessionIdFromPath(a!)), '归档默认隐藏');
      const list3 = await listSessions(process.cwd(), { includeArchived: true });
      suite.assert(list3.some((s) => s.id === sessionIdFromPath(a!) && s.archived), 'includeArchived 可见');
      // resolveSessionTarget：完整 id 精确解析 / 错误
      const target = await resolveSessionTarget(sessionIdFromPath(b!), a);
      suite.assert(target.ok && target.file === b, 'resolveSessionTarget 精确解析');
      const bad = await resolveSessionTarget('不存在的会话', b);
      suite.assert(!bad.ok, 'resolveSessionTarget 未命中报错');
      // 落盘脱敏：append 密钥消息 → 原文不含密钥，loadSession 回读为占位符
      await appendSessionMessages(b!, [{ role: 'user', content: 'my key is sk-abcdefghijklmnop1234' }]);
      const raw = readFileSync(b!, 'utf8');
      suite.assert(!raw.includes('sk-abcdefghijklmnop1234'), 'JSONL 不含明文密钥');
      const loaded = await loadSession(b!);
      suite.assert(!!loaded && String(loaded.messages[0].content).includes('[REDACTED]'), '回读为脱敏文本');
      suite.assert(loaded!.meta.pinned === true, 'meta 保留 pinned');
    });
  });

  /* ---------------- /cd 解析 ---------------- */
  suite.test('/cd：空参显示、相对/~、不存在与文件报错', () => {
    const cwd = process.cwd();
    suite.assert(resolveCdArg(undefined, cwd).kind === 'show', '空参 = show');
    const up = resolveCdArg('..', cwd);
    suite.assert(up.kind === 'change' && up.dir === path.resolve(cwd, '..'), '相对路径解析');
    const home = resolveCdArg('~', cwd);
    suite.assert(home.kind === 'change' && home.dir === os.homedir(), '~ 展开');
    const missing = resolveCdArg(path.join(cwd, '__no_such_dir_xyz__'), cwd);
    suite.assert(missing.kind === 'error', '不存在目录报错');
    const file = resolveCdArg('package.json', cwd);
    suite.assert(file.kind === 'error', '文件报错（不是目录）');
  });

  /* ---------------- Vim 纯函数 ---------------- */
  suite.test('vim：移动/编辑/多键前缀', () => {
    const rt = { pending: '', register: '' };
    const text = 'hello world\nsecond line';
    const e1 = applyVimNormal(text, 0, 'w', rt)!;
    suite.assert(e1.cursor === 6, 'w 跳到下一词首');
    const e2 = applyVimNormal(text, 6, 'x', rt)!;
    suite.assert(e2.text === 'hello orld\nsecond line', 'x 删除字符');
    const e3 = applyVimNormal(text, 0, 'd', { pending: '', register: '' })!;
    suite.assert(e3.pending === 'd', 'd 进入多键前缀');
    const e4 = applyVimNormal(text, 0, 'd', { pending: 'd', register: '' })!;
    suite.assert(e4.text === 'second line', 'dd 删除整行');
    const e5 = applyVimNormal(text, 0, 'y', { pending: 'y', register: '' })!;
    suite.assert(e5.register === 'hello world\n', 'yy 写入寄存器');
    const e6 = applyVimNormal('abc', 0, 'A', rt)!;
    suite.assert(e6.insert && e6.cursor === 3, 'A 行尾插入');
    const e7 = applyVimNormal('abc', 1, 'p', { pending: '', register: 'X\n' })!;
    suite.assert(e7.text === 'abc\nX\n', 'p 行后粘贴');
    suite.assert(vimCurrentLine(text, 13).start === 12, 'vimCurrentLine 第二行起点');
    const e8 = applyVimNormal('abc', 0, 'l', rt)!;
    suite.assert(e8.cursor === 1, 'l 右移');
  });

  /* ---------------- 子代理并发信号量 ---------------- */
  suite.test('semaphore：上限排队、释放让位、计数', async () => {
    const sem = new SubagentSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    suite.assert(sem.activeCount === 2 && sem.waitingCount === 0, '两个槽位占用');
    let third = false;
    const p3 = sem.acquire().then((rel) => {
      third = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 10));
    suite.assert(!third && sem.waitingCount === 1, '第三个排队等待');
    r1();
    const r3 = await p3;
    suite.assert(third && sem.activeCount === 2, '释放后第三个获得槽位');
    r3();
    r2();
    suite.assert(sem.activeCount === 0, '全部释放归零');
  });

  /* ---------------- team 看板 + 动态工作流解析 ---------------- */
  suite.test('team：任务板增改认领、消息投递去重、send_message 工具', async () => {
    const runOpts = { team: new TeamBoard() } as never as import('../../src/agent/types.js').RunOptions;
    const board = runOpts.team!;
    board.addTask('实现 API', '第一步');
    board.addTask('写测试');
    suite.assert(board.tasks.length === 2 && board.tasks[0].id === 't1', 'addTask 编号');
    board.updateTask('t1', { status: 'in_progress', owner: 'worker1' });
    suite.assert(board.tasks[0].owner === 'worker1' && board.tasks[0].status === 'in_progress', 'updateTask');
    board.send('worker1', 'main', '需要确认接口字段');
    const first = board.takeMessages('main');
    suite.assert(first.length === 1 && first[0].from === 'worker1', 'takeMessages 收到');
    suite.assert(board.takeMessages('main').length === 0, '已投递不重复');
    const tool = createTaskBoardTool(runOpts);
    const list = await tool.execute({ action: 'list' });
    suite.assert(list.includes('t1') && list.includes('实现 API'), 'task_board list 输出');
    const send = createSendMessageTool(runOpts);
    const sent = await send.execute({ to: 'main', text: 'hi' }, { agentId: 'sub9' });
    suite.assert(sent.includes('sub9') && board.takeMessages('main')[0].text === 'hi', 'send_message 工具投递');
  });

  suite.test('workflow：计划解析容错、依赖清洗、分层批次', () => {
    const plan = parseWorkflowPlan(
      '```json\n{"steps":[{"title":"A","task":"do a"},{"title":"B","task":"do b","dependsOn":[0,0,5]},{"title":"C","task":"do c"}]}\n```'
    );
    suite.assert(!!plan && plan.length === 3, '围栏 JSON 解析 3 步');
    suite.assert(plan![1].dependsOn!.length === 1 && plan![1].dependsOn![0] === 0, '依赖去重且过滤越界');
    const batches = planBatches(plan!);
    suite.assert(batches.length === 2 && batches[0].length === 2 && batches[1][0] === 1, 'A/C 并行、B 第二批');
    suite.assert(parseWorkflowPlan('没有 JSON') === null, '无 JSON 返回 null');
    suite.assert(parseWorkflowPlan('{"steps":[]}') === null, '空步骤返回 null');
    suite.assert(parseWorkflowPlan('{"steps":[{"task":"x"}]}')![0].title === '步骤 1', '缺 title 生成默认');
    const many = parseWorkflowPlan(JSON.stringify({ steps: Array.from({ length: 20 }, (_, i) => ({ task: `t${i}` })) }))!;
    suite.assert(many.length === 12, '步骤上限 12');
  });

  /* ---------------- AI 自动审批 ---------------- */
  suite.test('auto-review：输出解析 + 审阅器 + Safety 闸门短路', async () => {
    suite.assert(parseAutoReviewVerdict('{"decision":"approve","reason":"只读"}')?.approve === true, 'decision=approve');
    suite.assert(parseAutoReviewVerdict('```json\n{"decision":"deny","reason":"敏感"}\n```')?.approve === false, '围栏 deny');
    suite.assert(parseAutoReviewVerdict('{"approve":false,"reason":"x"}')?.approve === false, 'approve 布尔');
    suite.assert(parseAutoReviewVerdict('无法判断') === null, '非 JSON 返回 null');

    // 审阅器：fake client 返回 approve；超时/异常 → null 回退
    const fakeClient = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"decision":"approve","reason":"ok"}' } }] }) } },
    };
    let verdictSeen = '';
    const reviewer = createAutoReviewer({
      client: fakeClient as never,
      model: 'm',
      describeContext: () => ({ cwd: '/tmp', tier: 'safe', sandbox: 'off' }),
      onVerdict: (_r, v) => { verdictSeen = v.reason; },
    });
    const v = await reviewer({ tool: 'run_command', summary: '$ ls', reason: '需要确认' });
    suite.assert(v?.approve === true && verdictSeen === 'ok', '审阅器返回批准并回调');

    // Safety.gate：autoReview 批准 → 直接放行；拒绝 → 拒绝且不回退人工
    const tool = { name: 'run_command', description: '', parameters: {}, execute: async () => '' } as never;
    let humanCalled = false;
    const gateApprove = new Safety({
      tier: 'ask',
      audit: false,
      autoReview: async () => ({ approve: true, reason: '规则允许' }),
      requestApproval: () => { humanCalled = true; return false; },
    });
    const g1 = await gateApprove.gate(tool, { command: 'ls' });
    suite.assert(g1.allow === true && !humanCalled, '自动批准短路人工');
    const gateDeny = new Safety({
      tier: 'ask',
      audit: false,
      autoReview: async () => ({ approve: false, reason: '高风险' }),
      requestApproval: () => { humanCalled = true; return true; },
    });
    const g2 = await gateDeny.gate(tool, { command: 'rm -rf x' });
    suite.assert(!g2.allow && !humanCalled && (g2.reason ?? '').includes('自动审阅拒绝'), '自动拒绝短路人工');
    const gateFallback = new Safety({
      tier: 'ask',
      audit: false,
      autoReview: async () => null,
      requestApproval: () => { humanCalled = true; return true; },
    });
    const g3 = await gateFallback.gate(tool, { command: 'ls' });
    suite.assert(g3.allow && humanCalled, '审阅不可用回退人工');
  });

  /* ---------------- MCP elicitation / sampling ---------------- */
  suite.test('mcp handlers：elicitation 提问映射 + sampling 调用当前模型', async () => {
    const asked: string[] = [];
    const handlers = createMcpHandlers({
      client: {
        chat: { completions: { create: async (p: { messages: { content: string }[] }) => ({ choices: [{ message: { content: `echo:${p.messages[0].content}` }, finish_reason: 'stop' }] }) } },
      } as never,
      model: 'm1',
      askUser: async (q, options) => {
        asked.push(q);
        return { choice: options[0] ?? 'my-input', custom: false, choices: [options[0] ?? 'my-input'] };
      },
    });
    const e1 = await handlers.elicit!('demo', {
      message: '需要部署目标',
      requestedSchema: { properties: { env: { type: 'string', enum: ['prod', 'dev'] }, note: { type: 'string' } } },
    });
    suite.assert(e1.action === 'accept' && (e1.content as Record<string, unknown>).env === 'prod', 'enum 字段取选项');
    suite.assert(asked.length === 2, '逐字段提问');
    const noUser = createMcpHandlers({ client: {} as never, model: 'm', askUser: undefined });
    const e2 = await noUser.elicit!('demo', { message: 'x' });
    suite.assert(e2.action === 'decline', '无 UI = decline');
    const s1 = await handlers.sample!('demo', { messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }], maxTokens: 10 });
    suite.assert(s1.model === 'm1' && (s1.content as { text: string }).text === 'echo:hello', 'sampling 复用当前模型');
  });

  /* ---------------- LSP 纯函数 ---------------- */
  suite.test('lsp：服务器探测/位置/悬停/符号格式化', () => {
    suite.assert(lspServerSpecFor('a.ts')?.command === 'typescript-language-server', 'TS 服务器');
    suite.assert(lspServerSpecFor('a.py')?.command === 'pyright-langserver', 'Python 服务器');
    suite.assert(lspServerSpecFor('a.rs') === null, '未知语言 null');
    const loc = formatLspLocation({ uri: 'file:///tmp/a%20b.ts', range: { start: { line: 4, character: 2 } } });
    suite.assert(loc === '/tmp/a b.ts:5:3', '位置 1-based 转换');
    suite.assert(formatHover({ contents: { kind: 'markdown', value: 'const x: number' } }) === 'const x: number', 'hover markdown');
    suite.assert(formatHover({ contents: ['a', 'b'] }) === 'a\n\nb', 'hover 数组');
    const syms = formatSymbols([{ name: 'Foo', kind: 5, children: [{ name: 'bar', kind: 6 }] }]);
    suite.assert(syms[0] === 'class Foo' && syms[1] === '  method bar', 'documentSymbol 缩进');
    suite.assert(detectInstalledLsp({ languageId: 'x', command: '__omni_no_such_lsp__', args: [] }) === false, '未安装探测 false');
  });

  suite.test('lsp 端到端：PATH 注入 mock 服务器 → definition/hover/symbols', async () => {
    const { createLspTool } = await import('../../src/tools/lsp.js');
    const binDir = tempDir('omni-lsp-bin-');
    const target = path.join(process.cwd(), 'scripts', 'mock-lsp.mjs');
    const shim = path.join(binDir, 'typescript-language-server');
    writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(target)} "$@"\n`, { mode: 0o755 });
    const tmpFile = path.join(tempDir('omni-lsp-src-'), 'demo.ts');
    writeFileSync(tmpFile, 'const x = 1;\nclass Foo {}\n');
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ''}`;
    try {
      const tool = createLspTool();
      const def = await tool.execute({ action: 'definition', file: tmpFile, line: 1, character: 1 });
      suite.assert(def.includes('/mock/def.ts:10:5'), `definition 输出（${def.slice(0, 80)}）`);
      const hover = await tool.execute({ action: 'hover', file: tmpFile, line: 1, character: 1 });
      suite.assert(hover.includes('**x**') && hover.includes('number'), 'hover 输出');
      const syms = await tool.execute({ action: 'symbols', file: tmpFile });
      suite.assert(syms.includes('variable x') && syms.includes('class Foo') && syms.includes('  method bar'), 'documentSymbol 树');
    } finally {
      process.env.PATH = savedPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  /* ---------------- 插件系统 ---------------- */
  suite.test('plugins：安装/卸载/目录安全/内容合并', async () => {
    await withXdg(async () => {
      const { installPlugin, listInstalledPlugins, removePlugin, pluginSkillDirs, pluginAgentDirs, pluginHooks, pluginMcpServers, setEnabledPlugins, safeJoin, readPlugin } = await import('../../src/agent/plugins.js');
      const src = tempDir('omni-plugin-src-');
      mkdirSync(path.join(src, 'skills', 'demo-skill'), { recursive: true });
      writeFileSync(path.join(src, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\nbody\n');
      writeFileSync(
        path.join(src, 'plugin.json'),
        JSON.stringify({
          name: 'demo-plugin',
          version: '1.0.0',
          description: '测试插件',
          skills: ['skills'],
          hooks: { PostToolUse: [{ matcher: 'write_file', command: 'echo ok' }] },
          mcpServers: { demo: { command: 'node', args: ['x.mjs'] } },
        })
      );
      const r = installPlugin(src);
      suite.assert(r.ok && r.name === 'demo-plugin', `安装成功（${r.message}）`);
      const installed = listInstalledPlugins();
      suite.assert(installed.length === 1 && installed[0].manifest.name === 'demo-plugin', 'listInstalled 找到');
      suite.assert(installed[0].manifest.hooks?.PostToolUse?.length === 1, 'hooks 清单解析');
      setEnabledPlugins(['demo-plugin']);
      suite.assert(pluginSkillDirs().length === 1 && existsSync(pluginSkillDirs()[0]), '插件技能目录');
      suite.assert(pluginAgentDirs().length === 0, '无 agents 声明');
      suite.assert(Object.keys(pluginHooks()).includes('PostToolUse'), '插件 hooks 合并');
      suite.assert(!!pluginMcpServers().demo, '插件 MCP 合并');
      suite.assert(safeJoin(installed[0].dir, '../evil') === null, 'safeJoin 拒绝越界');
      suite.assert(readPlugin(src)?.manifest.name === 'demo-plugin', 'readPlugin 源目录');
      setEnabledPlugins([]);
      const rm = removePlugin('demo-plugin');
      suite.assert(rm.ok && listInstalledPlugins().length === 0, 'removePlugin 删除');
      rmSync(src, { recursive: true, force: true });
    });
  });

  /* ---------------- 配置写入（全局开关/插件清单） ---------------- */
  suite.test('config write：persistGlobalBool / persistPluginList', async () => {
    await withXdg(async () => {
      // 全局配置目录需存在（真实场景由 loadConfig/已有文件保证；测试显式创建）
      mkdirSync(path.join(process.env.XDG_CONFIG_HOME!, 'omni'), { recursive: true });
      const { persistGlobalBoolToConfig, persistPluginListToGlobal } = await import('../../src/config/write.js');
      const r1 = persistGlobalBoolToConfig('autoReview', true, '自动审批');
      suite.assert(r1.ok, '写入 autoReview');
      const r2 = persistPluginListToGlobal(['a', 'a', 'b']);
      suite.assert(r2.ok, '写入插件清单');
      const file = r2.file!;
      const obj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      suite.assert(obj.autoReview === true, 'autoReview 落盘');
      suite.assert(Array.isArray(obj.plugins) && (obj.plugins as string[]).length === 2, '去重后 2 个插件');
    });
  });

  /* ---------------- Windows 沙箱状态 ---------------- */
  suite.test('windowsSandbox：显式不支持 + fail-closed 提示', async () => {
    const { windowsSandboxStatus, wrapSandboxCommand } = await import('../../src/safety/sandbox.js');
    const st = windowsSandboxStatus();
    suite.assert(st.supported === false && st.reason.includes('sandboxFailClosed'), 'Windows 状态声明不支持并提示 fail-closed');
    // 非 Windows 平台：read-only 包装受本地沙箱保护（darwin/linux）；Windows 分支逻辑由状态函数覆盖
    const r = wrapSandboxCommand('read-only', process.cwd(), 'echo hi');
    suite.assert(process.platform === 'win32' ? r.protected === false : r.command.length > 0, '沙箱包装可执行');
    if (process.platform === 'win32') suite.assert((r.note ?? '').includes('sandboxFailClosed'), 'Win 降级提示含 fail-closed');
  });

  return suite;
}

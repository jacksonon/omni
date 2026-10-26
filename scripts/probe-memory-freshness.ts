/** 真实模型工具调用链验收：记忆写权限、基线保存及同会话过时提醒。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSharedServer } from '../src/server/manager.js';
import { ServerClient, type ServerConnection } from '../src/server/client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'omni-memory-probe-')));
const requests: any[] = [];
let checks = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function check(label: string, condition: unknown): void {
  assert.ok(condition, label); checks += 1; console.log(`✓ ${label}`);
}
async function until<T>(fn: () => Promise<T | false>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  do { const value = await fn(); if (value) return value; await sleep(35); } while (Date.now() < deadline);
  throw new Error(`等待超时：${label}`);
}

async function main(): Promise<void> {
  let connection: ServerConnection | undefined;
  const mock = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const parsed = JSON.parse(body); requests.push(parsed);
    const last = parsed.messages.at(-1);
    const invoke = last?.role === 'user' && String(last.content).startsWith('create-memory-');
    const topic = String(last?.content).includes('readonly') ? 'probe-readonly' : 'probe-track';
    const base = { id: `memory-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: parsed.model };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = invoke ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: {
      name: 'memory_update', arguments: JSON.stringify({ action: 'save', topic, content: '- tracked.txt 中的开关仍启用。', files: ['tracked.txt'], globs: 'tracked.txt', source: '集成探针会话' }),
    } }] } : { role: 'assistant', content: '记忆探针完成。' };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const port = (mock.address() as { port: number }).port;
    const xdg = path.join(TEMP, 'config'), runtime = path.join(TEMP, 'runtime'), workspace = path.join(TEMP, 'project');
    for (const directory of [xdg, runtime, workspace]) mkdirSync(directory);
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.OMNI_SERVER_RUNTIME_DIR = runtime;
    process.env.OMNI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.OMNI_API_KEY = 'memory-probe-local-only'; process.env.OMNI_MODEL = 'memory-probe';
    for (const key of ['OMNI_CONFIG', 'OMNI_SERVER', 'OMNI_SERVER_TOKEN', 'OMNI_WEB_TOKEN', 'OMNI_WEB_WORKSPACE']) delete process.env[key];
    writeFileSync(path.join(workspace, 'tracked.txt'), 'enabled=true\n');
    writeFileSync(path.join(workspace, 'omni.json'), JSON.stringify({
      autoMemory: false, agentsFile: false, globalAgentsFile: true, repoMap: false, preloadFiles: false,
      skills: false, auditLog: false, providers: { probe: { baseURL: process.env.OMNI_BASE_URL, apiKey: process.env.OMNI_API_KEY, models: { 'memory-probe': {} } } },
    }));
    const { addTrustedWorkspace } = await import('../src/safety/trust.js');
    assert.equal(addTrustedWorkspace(TEMP), true);
    connection = await ensureSharedServer({ cwd: workspace, port: 0, command: {
      executable: process.execPath,
      args: ['--import', createRequire(import.meta.url).resolve('tsx'), path.join(ROOT, 'src/index.ts')],
    } });
    const client = new ServerClient(connection);
    const readonly = await client.createSession({ permission: 'read', autoTitle: false });
    await client.request(`/api/sessions/${readonly.id}/messages`, { text: 'create-memory-readonly', requestId: 'memory-readonly' });
    await until(async () => !(await readonly.snapshot()).status.runningSessions.includes(readonly.id), 'read 模式工具调用结束');
    const schema = requests[0]?.tools?.find((tool: any) => tool.function?.name === 'memory_update')?.function;
    check('共享运行时实际注册 memory_update 与描述/参数', typeof schema?.description === 'string' && schema.parameters.properties.files && schema.parameters.properties.confirm && schema.parameters.properties.verification);
    const readHistory = await readonly.history();
    check('read 权限拒绝模型发起的记忆写入', readHistory.some((message: any) => message.role === 'tool' && /只读|已拦截/.test(message.content)));
    const topics = path.join(xdg, 'omni/memory/topics');
    check('被拒绝的记忆没有落盘', !existsSync(path.join(topics, 'probe-readonly.md')));

    const safe = await client.createSession({ permission: 'safe', autoTitle: false });
    await client.request(`/api/sessions/${safe.id}/messages`, { text: 'create-memory-safe', requestId: 'memory-safe' });
    await until(async () => !(await safe.snapshot()).status.runningSessions.includes(safe.id), 'safe 模式保存结束');
    const topicFile = path.join(topics, 'probe-track.md');
    check('safe 权限通过真实工具创建主题', existsSync(topicFile) && (await safe.history()).some((message: any) => message.role === 'tool' && /已保存记忆主题/.test(message.content)));
    const saved = readFileSync(topicFile, 'utf8');
    check('落盘主题包含来源、文件基线与适用工作区', saved.includes('集成探针会话') && saved.includes('sha256') && saved.includes(workspace));

    await client.request(`/api/sessions/${safe.id}/messages`, { text: '检查 tracked.txt 的经验', requestId: 'memory-unchanged' });
    await until(async () => !(await safe.snapshot()).status.runningSessions.includes(safe.id), '首次主题注入');
    const unchanged = requests.find((request) => request.messages.at(-1)?.content === '检查 tracked.txt 的经验');
    check('下一轮模型自动收到主题与当前基线状态', unchanged?.messages.some((message: any) => typeof message.content === 'string' && message.content.startsWith('[全局记忆主题') && message.content.includes('基线未变化')));

    writeFileSync(path.join(workspace, 'tracked.txt'), 'enabled=false\n');
    await client.request(`/api/sessions/${safe.id}/messages`, { text: '重新检查 tracked.txt 的经验', requestId: 'memory-changed' });
    await until(async () => !(await safe.snapshot()).status.runningSessions.includes(safe.id), '同会话文件变化后注入');
    const changed = requests.find((request) => request.messages.at(-1)?.content === '重新检查 tracked.txt 的经验');
    const system = changed?.messages.filter((message: any) => message.role === 'system' && typeof message.content === 'string').map((message: any) => message.content) ?? [];
    check('同会话修改关联文件后自动标记待复核', system.some((content: string) => content.startsWith('[全局记忆主题') && content.includes('待复核') && content.includes('tracked.txt')));
    check('同会话索引同步待复核且说明历史线索边界', system.some((content: string) => content.includes('probe-track') && content.includes('待复核，仅历史线索')) && system.some((content: string) => content.includes('不可作为当前已验证事实')));
    check('发现变化不自动重建或覆盖原始基线', readFileSync(topicFile, 'utf8') === saved);
    console.log(`\nMemory freshness integration：${checks} 项验收通过。`);
  } finally {
    if (connection) await fetch(`${connection.serverUrl}/_omni/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: '{"force":true}',
    }).catch(() => {});
    mock.closeAllConnections();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await sleep(150); rmSync(TEMP, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

/** 桌面采集附件的真实传输验收：隔离 broker → worker → Chat/Responses → 会话历史。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSharedServer } from '../src/server/manager.js';
import { ServerClient, type ServerConnection } from '../src/server/client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'omni-capture-probe-')));
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const CLIPBOARD = 'TypeError: screenshot-preview is undefined\n请保留这段剪贴板文本。';
const requests: { route: string; body: any }[] = [];
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
    if (!['/v1/chat/completions', '/v1/responses'].includes(req.url ?? '')) {
      res.writeHead(404).end(); return;
    }
    const parsed = JSON.parse(body);
    requests.push({ route: req.url!, body: parsed });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/v1/responses') {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '已收到采集内容。' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } } })}\n\n`);
    } else {
      const base = { id: 'capture-probe', object: 'chat.completion.chunk', created: 0, model: parsed.model };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '已收到采集内容。' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const port = (mock.address() as { port: number }).port;
    const xdg = path.join(TEMP, 'config'), runtime = path.join(TEMP, 'runtime');
    const workspace = path.join(TEMP, 'selected-workspace');
    for (const directory of [xdg, runtime, workspace]) mkdirSync(directory);
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.OMNI_SERVER_RUNTIME_DIR = runtime;
    process.env.OMNI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.OMNI_API_KEY = 'capture-probe-local-only';
    process.env.OMNI_MODEL = 'capture-chat';
    for (const key of ['OMNI_CONFIG', 'OMNI_SERVER', 'OMNI_SERVER_TOKEN', 'OMNI_WEB_TOKEN', 'OMNI_WEB_WORKSPACE']) delete process.env[key];
    const models = Object.fromEntries(['chat', 'responses'].map((protocol) => [`capture-${protocol}`, {
      protocol: protocol === 'chat' ? 'completions' : 'responses',
      modalities: { input: ['text', 'image'], output: ['text'] },
    }]));
    writeFileSync(path.join(workspace, 'omni.json'), JSON.stringify({
      autoMemory: false, agentsFile: false, globalAgentsFile: false, repoMap: false, preloadFiles: false,
      skills: false, auditLog: false, providers: { capture: { baseURL: process.env.OMNI_BASE_URL, apiKey: process.env.OMNI_API_KEY, models } },
    }));
    const { addTrustedWorkspace } = await import('../src/safety/trust.js');
    assert.equal(addTrustedWorkspace(TEMP), true);
    connection = await ensureSharedServer({ cwd: workspace, port: 0, command: {
      executable: process.execPath,
      args: ['--import', createRequire(import.meta.url).resolve('tsx'), path.join(ROOT, 'src/index.ts')],
    } });
    const client = new ServerClient(connection);
    for (const protocol of ['chat', 'responses']) {
      const model = `capture-${protocol}`;
      const session = await client.createSession({ model, autoTitle: false });
      const snapshot = await session.snapshot();
      check(`${protocol} 使用所选工作区`, realpathSync(snapshot.status.cwd) === workspace);
      const attachments = [
        { kind: 'image', name: '截图.png', dataUrl: IMAGE },
        { kind: 'text', name: '剪贴板文本.txt', content: CLIPBOARD },
      ];
      await client.request(`/api/sessions/${session.id}/messages`, {
        text: '修复圈出的报错', attachments, requestId: `capture-${protocol}-first`,
      });
      await until(async () => !(await session.snapshot()).status.runningSessions.includes(session.id), `${protocol} 完成`);
      const captured = requests.find((request) => request.body.model === model);
      assert.ok(captured, `${protocol} 发出了真实模型请求`);
      check(`${protocol} 使用预期协议`, captured.route === (protocol === 'chat' ? '/v1/chat/completions' : '/v1/responses'));
      const user = (protocol === 'chat' ? captured.body.messages : captured.body.input).find((message: any) => message.role === 'user');
      check(`${protocol} 图片数据完整到达模型`, user.content.some((part: any) =>
        protocol === 'chat' ? part.type === 'image_url' && part.image_url.url === IMAGE : part.type === 'input_image' && part.image_url === IMAGE));
      check(`${protocol} 剪贴板文字与指令完整到达模型`, user.content.some((part: any) => part.text?.includes(CLIPBOARD)) && user.content.some((part: any) => part.text === '修复圈出的报错'));
      const history = await session.history();
      const saved = history.find((message) => message.role === 'user') as { content: any[] };
      check(`${protocol} 历史保留附件供重连预览`, saved.content.some((part) => part.type === 'image_url' && part.image_url.url === IMAGE) && saved.content.some((part) => part.text?.includes(CLIPBOARD)));
      const restored = await client.createSession({}, session.id);
      check(`${protocol} 新连接恢复同一附件历史`, JSON.stringify(await restored.history()) === JSON.stringify(history));
      await client.request(`/api/sessions/${session.id}/messages`, {
        text: '', attachments: [{ kind: 'image', name: '仅截图.png', dataUrl: IMAGE }], requestId: `capture-${protocol}-image-only`,
      });
      await until(async () => !(await session.snapshot()).status.runningSessions.includes(session.id), `${protocol} 仅图片完成`);
      const finalHistory = await session.history();
      check(`${protocol} 支持无文字的图片消息`, finalHistory.filter((message) => message.role === 'user').length === 2 && finalHistory.some((message) => message.role === 'assistant' && message.content === '已收到采集内容。'));
    }
    console.log(`\nDesktop capture transport：${checks} 项验收通过。`);
  } finally {
    if (connection) await fetch(`${connection.serverUrl}/_omni/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: '{"force":true}',
    }).catch(() => {});
    mock.closeAllConnections();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await sleep(150);
    rmSync(TEMP, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

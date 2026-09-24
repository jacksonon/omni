/**
 * 会话级动态请求头探针（2026-09）：
 *   A1 parseHeadersInput：对象 / 多行文本 / 空 = 清除 / 未提供 = 保留
 *   A2 createClient fetch 包装：{sessionId} 占位符在请求发出前解析（defaultHeaders 路径）
 *   A3 withRequestSession 会话上下文：解析为该会话 id；嵌套调用继承
 *   A4 上下文外兜底：进程级稳定 id（两次一致、不是字面占位符）
 *   A5 每请求 headers（variants 叠加层路径）同样解析
 *   A6 discoverModels 发现请求带自定义头
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, discoverModels, resolveHeaderPlaceholders, withRequestSession } from '../../src/client.js';
import { parseHeadersInput } from '../../src/config/write.js';

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

async function main(): Promise<void> {
  /* A1 parseHeadersInput */
  console.log('A1 parseHeadersInput');
  const h1 = parseHeadersInput({ 'x-opencode-session': '{sessionId}', 'x-a': ' b ' });
  assert(!!h1 && h1['x-opencode-session'] === '{sessionId}' && h1['x-a'] === 'b', '对象输入解析 + 占位符原样保留');
  const h2 = parseHeadersInput('x-opencode-session: {sessionId}\n# 注释\nbadline\nx-b: 2');
  assert(!!h2 && h2['x-opencode-session'] === '{sessionId}' && h2['x-b'] === '2' && !('badline' in h2), '多行文本解析（注释/非法行跳过）');
  assert(parseHeadersInput({}) === null && parseHeadersInput('') === null, '空输入 = 清除（null）');
  assert(parseHeadersInput(undefined) === undefined, '未提供 = 保留（undefined）');

  /* 捕获请求头的 mock 网关 */
  const seen: Record<string, string>[] = [];
  const server = http.createServer((req, res) => {
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) rec[k] = String(v);
    seen.push(rec);
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-1', object: 'chat.completion', created: 0, model: 'm1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  const client = createClient(
    {
      name: 'm1',
      baseURL,
      apiKey: 'k',
      headers: { 'x-opencode-session': '{sessionId}', 'x-static': 'plain' },
    },
    'k'
  );
  const ask = (opts?: { headers?: Record<string, string> }) =>
    client.chat.completions.create(
      { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: false },
      opts
    );

  /* A2 + A3 */
  console.log('A2/A3 占位符解析 + 会话上下文');
  await withRequestSession('sess-123', () => ask());
  const last = () => seen[seen.length - 1]!;
  assert(last()['x-opencode-session'] === 'sess-123', 'defaultHeaders 占位符解析为当前会话 id');
  assert(last()['x-static'] === 'plain', '静态头原样透传');
  await withRequestSession('sess-123', () => withRequestSession(undefined, () => ask()));
  assert(last()['x-opencode-session'] === 'sess-123', '嵌套调用未指定会话时继承外层 id');
  await withRequestSession('sess-456', async () => {
    await new Promise((r) => setTimeout(r, 5)); // 跨 await 保持上下文
    await ask();
  });
  assert(last()['x-opencode-session'] === 'sess-456', '跨 await 上下文保持（并发会话互不串号）');

  /* A4 上下文外兜底 */
  console.log('A4 进程级兜底 id');
  await ask();
  const fb1 = last()['x-opencode-session'];
  await ask();
  const fb2 = last()['x-opencode-session'];
  assert(!!fb1 && fb1 !== '{sessionId}' && fb1 === fb2, '无上下文 = 稳定兜底 id（不发字面占位符）');

  /* A5 每请求 headers（variants 叠加层） */
  console.log('A5 每请求 headers 解析');
  await withRequestSession('sess-789', () => ask({ headers: { 'x-variant': '{session}' } }));
  assert(last()['x-variant'] === 'sess-789' && last()['x-opencode-session'] === 'sess-789', '每请求 headers 的 {session} 别名同样解析');

  /* A6 discoverModels */
  console.log('A6 discoverModels 带自定义头');
  const ids = await withRequestSession('sess-disc', () =>
    discoverModels({ baseURL, apiKey: 'k', userAgent: 'omni-probe/1.0', headers: { 'x-opencode-session': '{sessionId}' } })
  );
  assert(ids.join(',') === 'm1,m2', '模型列表正常返回');
  assert(last()['x-opencode-session'] === 'sess-disc' && last()['user-agent'] === 'omni-probe/1.0', '发现请求带会话头 + 自定义 UA');

  /* resolveHeaderPlaceholders 纯函数 */
  assert(resolveHeaderPlaceholders(undefined) === undefined, '无头输入返回 undefined');
  const rh = withRequestSession('s1', () => resolveHeaderPlaceholders({ a: '{sessionId}', b: 'x' }));
  assert(!!rh && rh.a === 's1' && rh.b === 'x', 'resolveHeaderPlaceholders 解析正确');

  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

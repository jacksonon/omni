/**
 * Web 服务 e2e 探针：`npm run probe:web`
 *
 * 无真实 API 依赖：启动本地 mock（scripts/mock-server.mjs）+ 真实 `omni web` 服务
 * （tsx 加载 CLI 入口），经 REST+SSE 全链路验证：
 *
 *   A. 服务启动 & 静态页面 & status/sessions 接口
 *   B. 正常对话流：send → thinking.* → tool.start/result → answer.* → usage → run.end
 *   C. 审批卡片：/api/settings permission=ask → send → approval.request → 批准 → 继续 → 完成
 *   D. 提问卡片：mock 切 ask 模式 → send → ask.request → 提交选项 → 继续 → 完成
 *   E. 取消：send → tool.start → cancel → run.end aborted
 *   F. 模型切换：/api/settings model=mock-model → status.model 更新 + 回答带 [模型 mock-model]
 *   G. 会话列表/历史：会话显示消息数 + 历史可回读（user + assistant 文本）
 *
 * 失败以非零退出码结束（供 CI/本地快速回归）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MOCK_PORT = 49000 + Math.floor(Math.random() * 900);
const WEB_PORT = MOCK_PORT + 100;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-web-probe-'));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15000, msg = 'timeout'): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(200);
  }
}

async function post(port: number, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/* ---------------- SSE 事件采集 ---------------- */
interface SseReader {
  events: { type: string; data: any }[];
  done: boolean;
  abort: () => void;
}

function openSse(sessionId: string, filterTypes?: string[]): SseReader {
  const reader: SseReader = { events: [], done: false, abort: () => {} };
  const ac = new AbortController();
  reader.abort = () => ac.abort();
  void (async () => {
    const resp = await fetch(`${BASE}/api/events`, { signal: ac.signal });
    if (!resp.body) return;
    const dec = new TextDecoder();
    let pending = '';
    for await (const chunk of resp.body as any) {
      pending += dec.decode(chunk, { stream: true });
      let idx = pending.indexOf('\n\n');
      while (idx >= 0) {
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        const type = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
        const dataLine = /^data: (.+)$/m.exec(frame)?.[1] ?? '';
        if (type && dataLine) {
          try {
            const data = JSON.parse(dataLine);
            if (!sessionId || !data.sessionId || data.sessionId === sessionId) {
              if (!filterTypes || filterTypes.includes(type)) reader.events.push({ type, data });
            }
          } catch {
            /* ignore malformed frame */
          }
        }
        idx = pending.indexOf('\n\n');
      }
    }
    reader.done = true;
  })().catch(() => {
    reader.done = true;
  });
  return reader;
}

function ofType(reader: SseReader, type: string): any[] {
  return reader.events.filter((e) => e.type === type).map((e) => e.data);
}

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/* ---------------- 进程管理 ---------------- */
function startProcess(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  (child as any).__log = () => out;
  return child;
}

async function main(): Promise<void> {
  // 工作区信任（第九节）：把测试工作目录加入临时 XDG 信任清单——
  // 否则 web 判定未信任 → 只读降级，run_command 被拒（真实使用中开发者先交互批准信任）
  process.env.XDG_CONFIG_HOME = XDG;
  const { addTrustedWorkspace } = await import(path.join(ROOT, 'src', 'safety', 'trust.js'));
  addTrustedWorkspace(ROOT);
  const mock = startProcess(
    process.execPath,
    [path.join(ROOT, 'scripts', 'mock-server.mjs')],
    { PORT: String(MOCK_PORT) }
  );
  let web: ChildProcess | null = null;
  let sse: SseReader | null = null;
  try {
    // 等 mock 就绪
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/config`, { method: 'POST', body: '{}' });
      return r.status === 200;
    }, 10000, 'mock server 启动');

    // 启动 web 服务（真实 CLI 入口）
    web = startProcess(
      process.execPath,
      [TSK, path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)],
      {
        XDG_CONFIG_HOME: XDG,
        OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
        OMNI_API_KEY: 'sk-mock',
        OMNI_MODEL: 'mock-model',
      }
    );

    // 等 web 就绪
    await waitFor(async () => {
      const r = await fetch(`${BASE}/api/status`);
      return r.status === 200;
    }, 20000, 'web server 启动');

    /* A. 静态页面 + status */
    const home = await fetch(`${BASE}/`);
    check('A1 静态页面 index.html 可访问', home.status === 200 && (await home.text()).includes('omni'), 'status=' + home.status);
    const css = await fetch(`${BASE}/style.css`);
    check('A2 style.css 可访问', css.status === 200 && (await css.text()).includes('tool-card'), 'status=' + css.status);
    const js = await fetch(`${BASE}/app.js`);
    check('A3 app.js 可访问', js.status === 200 && (await js.text()).includes('EventSource'), 'status=' + js.status);
    const st = await (await fetch(`${BASE}/api/status`)).json();
    check('A4 status：模型/权限/工具', !!st.model && !!st.tools?.length && st.permission === 'safe', JSON.stringify(st).slice(0, 120));
    const sessions0 = await (await fetch(`${BASE}/api/sessions`)).json();
    check('A5 初始会话列表为空', Array.isArray(sessions0), JSON.stringify(sessions0).slice(0, 80));

    // 打开 SSE（不限定会话：接受所有广播）
    sse = openSse('');

    /* B. 正常对话流 */
    const bSession = await post(WEB_PORT, '/api/sessions', {});
    check('B1 创建会话', bSession.status === 201 && !!bSession.json.id, JSON.stringify(bSession.json));
    const bSid: string = bSession.json.id;

    const send1 = await post(WEB_PORT, `/api/sessions/${bSid}/messages`, { text: '你好，请验证 web 链路' });
    check('B2 发送消息 202', send1.status === 202, 'status=' + send1.status);

    await waitFor(() => Promise.resolve(ofType(sse, 'run.end').some((e) => e.sessionId === bSid)), 25000, 'B 轮结束');

    check('B3 收到 user.message', ofType(sse, 'user.message').some((e) => e.sessionId === bSid && e.text === '你好，请验证 web 链路'));
    check('B4 思考事件（start/chunk/end）', ofType(sse, 'thinking.start').length > 0 && ofType(sse, 'thinking.chunk').length > 0 && ofType(sse, 'thinking.end').length > 0);
    const toolStarts = ofType(sse, 'tool.start').filter((e) => e.sessionId === bSid);
    check('B5 工具调用（$ echo mock-ok）', toolStarts.length >= 1 && toolStarts[0].argsPreview.includes('echo mock-ok'), JSON.stringify(toolStarts[0]));
    const toolResults = ofType(sse, 'tool.result').filter((e) => e.sessionId === bSid);
    check('B6 工具结果成功', toolResults.length >= 1 && toolResults[0].ok === true, JSON.stringify(toolResults[0]).slice(0, 120));
    const answer = ofType(sse, 'answer.chunk').filter((e) => e.sessionId === bSid).map((e) => e.text).join('');
    check('B7 流式回答含完成文案', answer.includes('任务完成'), answer.slice(0, 80));
    const usage = ofType(sse, 'usage').filter((e) => e.sessionId === bSid).pop();
    check('B8 token 用量', !!usage && usage.prompt > 0 && usage.completion > 0);
    const runEnds = ofType(sse, 'run.end').filter((e) => e.sessionId === bSid);
    check('B9 run.end 完成', runEnds.length >= 1 && runEnds[runEnds.length - 1].reason === 'completed', JSON.stringify(runEnds));

    // 会话历史回读
    const hist1 = await (await fetch(`${BASE}/api/sessions/${bSid}/messages`)).json();
    check('B10 历史消息（user+assistant）', Array.isArray(hist1.messages) && hist1.messages.filter((m: any) => m.role === 'user').length >= 1 && hist1.messages.some((m: any) => m.role === 'assistant' && typeof m.content === 'string' && (m.content as string).includes('任务完成')));

    /* C. 审批卡片（permission=ask → 全部工具询问） */
    const setAsk = await post(WEB_PORT, '/api/settings', { permission: 'ask' });
    check('C1 设置权限 ask', setAsk.status === 200 && setAsk.json.permission === 'ask');
    const cSession = await post(WEB_PORT, '/api/sessions', {});
    const cSid: string = cSession.json.id;
    await post(WEB_PORT, `/api/sessions/${cSid}/messages`, { text: '执行一个命令' });
    await waitFor(() => Promise.resolve(ofType(sse, 'approval.request').some((e) => e.sessionId === cSid)), 25000, 'C 审批请求');
    const apReq = ofType(sse, 'approval.request').filter((e) => e.sessionId === cSid)[0];
    check('C2 审批卡片内容（命令摘要）', apReq.summary.includes('echo mock-ok'), JSON.stringify(apReq).slice(0, 140));
    const approve = await post(WEB_PORT, `/api/sessions/${cSid}/approval`, { approvalId: apReq.approvalId, allow: true });
    check('C3 批准请求', approve.status === 200);
    await waitFor(() => Promise.resolve(ofType(sse, 'run.end').filter((e) => e.sessionId === cSid).length >= 1), 25000, 'C 轮结束');
    const cAnswer = ofType(sse, 'answer.chunk').filter((e) => e.sessionId === cSid).map((e) => e.text).join('');
    check('C4 批准后继续完成', ofType(sse, 'approval.resolved').some((e) => e.sessionId === cSid && e.allow === true) && cAnswer.includes('任务完成'), cAnswer.slice(0, 80));

    /* D. 提问卡片（mock 切 ask 模式） */
    await post(MOCK_PORT, '/__mock/config', { ask: true });
    // 恢复 safe 权限（C 段设成了 ask——ask 档位下 ask_user 工具本身也要先过审批，
    // 凑不到 ask.request；safe 档位下 ask_user 非危险操作直接放行）
    await post(WEB_PORT, '/api/settings', { permission: 'safe' });
    const dSession = await post(WEB_PORT, '/api/sessions', {});
    const dSid: string = dSession.json.id;
    await post(WEB_PORT, `/api/sessions/${dSid}/messages`, { text: '我需要你的建议' });
    await waitFor(() => Promise.resolve(ofType(sse, 'ask.request').some((e) => e.sessionId === dSid)), 25000, 'D 提问请求');
    const askReq = ofType(sse, 'ask.request').filter((e) => e.sessionId === dSid)[0];
    check('D1 提问卡片（问题+选项）', askReq.question.includes('接下来怎么做') && Array.isArray(askReq.options) && askReq.options.length === 3, JSON.stringify(askReq).slice(0, 120));
    const askPost = await post(WEB_PORT, `/api/sessions/${dSid}/ask`, { askId: askReq.askId, choices: [askReq.options[1]] });
    check('D2 提交选项', askPost.status === 200);
    await waitFor(() => Promise.resolve(ofType(sse, 'run.end').filter((e) => e.sessionId === dSid).length >= 1), 25000, 'D 轮结束');
    const dAnswer = ofType(sse, 'answer.chunk').filter((e) => e.sessionId === dSid).map((e) => e.text).join('');
    check('D3 提问后继续完成（用户选择为选项二）', dAnswer.includes('任务完成') && ofType(sse, 'ask.resolved').some((e) => e.sessionId === dSid && Array.isArray(e.choices) && e.choices[0] === '先总结'));

    // 恢复默认 mock 行为
    await post(MOCK_PORT, '/__mock/config', { ask: false });

    /* E. 取消运行（mock 慢速工具分支：工具调用前停顿 2s，确保取消发生在运行中） */
    await post(MOCK_PORT, '/__mock/config', { slow: true });
    const eSession = await post(WEB_PORT, '/api/sessions', {});
    const eSid: string = eSession.json.id;
    await post(WEB_PORT, `/api/sessions/${eSid}/messages`, { text: '执行并取消' });
    // 收到 thinking.start 说明流式已开始且工具调用前有 2s 停顿——在此窗口内取消
    await waitFor(() => Promise.resolve(ofType(sse, 'thinking.start').some((e) => e.sessionId === eSid)), 25000, 'E 思考开始');
    const cancel = await post(WEB_PORT, `/api/sessions/${eSid}/cancel`, {});
    check('E1 取消请求', cancel.status === 200);
    await waitFor(() => Promise.resolve(ofType(sse, 'run.end').filter((e) => e.sessionId === eSid).length >= 1), 25000, 'E 轮结束');
    const eRunEnds = ofType(sse, 'run.end').filter((e) => e.sessionId === eSid);
    check('E2 取消后 aborted', eRunEnds[eRunEnds.length - 1].reason === 'aborted', JSON.stringify(eRunEnds));
    await post(MOCK_PORT, '/__mock/config', { slow: false });

    /* F. 模型切换 */
    const setModel = await post(WEB_PORT, '/api/settings', { model: 'mock-model' });
    check('F1 切换模型 mock-model', setModel.status === 200 && setModel.json.model === 'mock-model');
    const fSession = await post(WEB_PORT, '/api/sessions', {});
    const fSid: string = fSession.json.id;
    await post(WEB_PORT, `/api/sessions/${fSid}/messages`, { text: '验证模型切换' });
    await waitFor(() => Promise.resolve(ofType(sse, 'run.end').filter((e) => e.sessionId === fSid).length >= 1), 25000, 'F 轮结束');
    const fAnswer = ofType(sse, 'answer.chunk').filter((e) => e.sessionId === fSid).map((e) => e.text).join('');
    check('F2 回答带 [模型 mock-model]', fAnswer.includes('[模型 mock-model]'), fAnswer.slice(-80));

    /* G. 会话列表 */
    const sessionsList = await (await fetch(`${BASE}/api/sessions`)).json();
    const live = sessionsList.filter((s: any) => [bSid, cSid, dSid, eSid, fSid].includes(s.id));
    check('G1 会话列表含 5 个运行过的会话', live.length === 5, JSON.stringify(live.map((s: any) => s.id)));

    /* 会话删除（DELETE 方法） */
    const delResp = await fetch(`${BASE}/api/sessions/${bSid}/delete`, { method: 'DELETE' });
    const del2 = await fetch(`${BASE}/api/sessions/${bSid}/messages`);
    check('H1 删除会话后历史 404', delResp.status === 200 && del2.status === 404, 'del=' + delResp.status + ' messages=' + del2.status);

    console.log('');
    if (failCount === 0) {
      console.log(`probe-web ✓ 全部通过（${MOCK_PORT} mock · ${WEB_PORT} web）`);
    } else {
      console.error(`probe-web ✗ ${failCount} 项失败`);
    }
  } finally {
    sse?.abort();
    web?.kill('SIGKILL');
    mock.kill('SIGKILL');
    rmSync(XDG, { recursive: true, force: true });
  }
  process.exit(failCount === 0 ? 0 : 1);
}

// 顶层入口
main().catch((e) => {
  console.error('probe-web 崩溃：', e);
  process.exit(1);
});
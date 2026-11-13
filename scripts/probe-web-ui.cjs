/** Web/Electron 输入与浮层回归：真实 DOM、隔离 API/profile，不连接用户 broker。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const http = require('node:http');
  const { app, BrowserWindow, ipcMain } = require('electron');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-web-ui-'));
  app.setPath('userData', temp);
  app.disableHardwareAcceleration();
  const calls = [], sockets = new Set();
  let failSettings = false;
  const status = { version: 'probe', cwd: '/fixture', language: 'zh', webTheme: 'light', model: 'model-a',
    models: [{ name: 'model-a' }, { name: 'model-b' }], tools: [], permission: 'safe',
    reasoningEffortOptions: ['low', 'medium', 'high', 'max'], reasoningEffort: 'medium', contextLimit: 64000 };
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://probe').pathname.replace(/^\/w\/[a-f0-9]+/, '');
    const json = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    calls.push(req.url);
    if (route === '/api/events' || route === '/_omni/pet/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return;
    }
    if (route === '/api/status') return json(status);
    if (route === '/api/sessions') return json([]);
    if (route === '/api/snapshot') return json({ status, sessions: [], pending: [] });
    if (route === '/_omni/pet') return json({ tasks: [], pets: [], settings: { enabled: false } });
    if (route === '/api/settings') return json(failSettings ? { error: 'probe settings rejected' } : status, failSettings ? 503 : 200);
    if (route === '/api/files') return setTimeout(() => json([{ name: 'fixture.ts', path: 'fixture.ts', isDir: false }]), 180);
    if (route === '/api/workspace') return json({ redirectUrl: '/w/abcdef/' });
    if (route.startsWith('/api/')) return json({});
    const name = route === '/' ? 'index.html' : route.slice(1);
    const file = path.join(ROOT, 'web', name);
    if (!name || name.includes('..') || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const preload = path.join(temp, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('omni',{
    hide:()=>ipcRenderer.invoke('probe-desktop','hide'), ready:async()=>{},
    desktopInfo:async()=>({bot:true,compact:false,petChat:false}),
    setSession:async()=>{},takeWorkspaceDraft:async()=>null,
    stageWorkspaceDraft:(target,draft)=>ipcRenderer.invoke('probe-desktop','stage',target,draft),
    onDesktopAction:()=>()=>{},setBotPopoverHeight:async()=>{},expandBotWindow:async()=>{},compactBotWindow:async()=>{}
  });`);
  ipcMain.handle('probe-desktop', (_event, action, ...args) => { calls.push({ action, args }); });
  app.whenReady().then(async () => {
    let win, count = 0, failed = 0;
    const check = (name, value, detail) => { count++; if (!value) failed++; console.log(`${value ? '✓' : '✗'} ${name}${!value && detail ? ' '+JSON.stringify(detail) : ''}`); };
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      win = new BrowserWindow({ width: 1400, height: 760, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload } });
      await win.loadURL(base + '/?bot=1');
      const run = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`);
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      await pause(300);
      // 输入处 Esc 必须只撤下 / 或 @ 浮层，第二次 Esc 才隐藏桌面窗口。
      for (const text of ['/mo', '@']) {
        await run(`input.value=${JSON.stringify(text)};input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();`);
        await pause(250);
        const before = calls.filter(call => call.action === 'hide').length;
        const result = await run(`input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return {cmd:cmdPalette.classList.contains('hidden'),mention:mentionPop.classList.contains('hidden')};`);
        await pause(30);
        check(`${text[0]} 浮层 Esc 关闭且不隐藏 bot`, result.cmd && result.mention && calls.filter(call => call.action === 'hide').length === before, result);
        await run(`input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));`);
        await pause(30);
        check(`${text[0]} 浮层关闭后的第二次 Esc 隐藏 bot`, calls.filter(call => call.action === 'hide').length === before + 1);
      }
      // 普通 Web 的同一条 Esc 也不能穿透成取消任务；中文组合态保持输入浮层。
      await run(`applyDesktopMode(false,false,false);`);
      for (const text of ['/mo', '@web']) {
        await run(`state.session='run-one';state.runningSessions.add('run-one');input.value=${JSON.stringify(text)};input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();`);
        await pause(250);
        const before = calls.filter(call => typeof call === 'string' && call.endsWith('/cancel')).length;
        await run(`input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}));`);
        check(`${text[0]} 浮层组合态 Esc 不关闭`, await run(`return !${text[0] === '/' ? 'cmdPalette' : 'mentionPop'}.classList.contains('hidden');`));
        await run(`input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));`); await pause(30);
        check(`${text[0]} 浮层 Esc 不取消 Web 任务`, calls.filter(call => typeof call === 'string' && call.endsWith('/cancel')).length === before);
        await run(`input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));`); await pause(30);
        check(`${text[0]} 浮层关闭后的 Esc 取消 Web 任务`, calls.filter(call => typeof call === 'string' && call.endsWith('/cancel')).length === before + 1);
      }
      await run(`applyDesktopMode(true,false,false);state.session=null;`);
      for (const next of ['plain text', '/mo']) {
        await run(`input.value='@late-${next[0]}';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));input.value=${JSON.stringify(next)};input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));`);
        await pause(250);
        check(`@ 迟到结果不覆盖 ${next}`, await run(`return mentionPop.classList.contains('hidden');`));
      }
      // 已有草稿在横向 resize 后重算折行高度，内容与光标保持。
      const wide = await run(`input.value='A draft that wraps when the window becomes narrow. '.repeat(3);input.setSelectionRange(5,5);input.dispatchEvent(new Event('input',{bubbles:true}));return {height:input.clientHeight,text:input.value};`);
      win.setContentSize(390, 620); await pause(250);
      const narrow = await run(`return {height:input.clientHeight,scroll:input.scrollHeight,text:input.value,cursor:input.selectionStart};`);
      check('横向缩窄后草稿输入高度适应折行', narrow.height > wide.height && narrow.height >= Math.min(200, narrow.scroll), { wide: wide.height, narrow });
      check('resize 保留草稿和光标', narrow.text === wide.text && narrow.cursor === 5);
      // 服务端拒绝改动时，滑条数值与视觉状态应共同回退。
      failSettings = true;
      await run(`renderModelPop(state.status);openModelPop();const range=document.querySelector('#model-pop .slider-input');range.value='3';range.dispatchEvent(new Event('input'));range.dispatchEvent(new Event('change'));`);
      await pause(100);
      const effort = await run(`const range=document.querySelector('#model-pop .slider-input'),wrap=range.closest('.slider-wrap');return {value:range.value,fill:wrap.style.getPropertyValue('--fill'),active:[...wrap.nextElementSibling.children].findIndex(n=>n.classList.contains('active'))};`);
      check('思考滑条失败后值/填充/高亮同时回退', effort.value === '1' && Math.abs(Number(effort.fill) - 100/3) < .01 && effort.active === 1, effort);
      await run(`const ranges=document.querySelectorAll('#model-pop .slider-input');const range=ranges[1];range.value='3';range.dispatchEvent(new Event('input'));range.dispatchEvent(new Event('change'));`);
      await pause(100);
      const context = await run(`const range=document.querySelectorAll('#model-pop .slider-input')[1],wrap=range.closest('.slider-wrap');return {value:range.value,fill:wrap.style.getPropertyValue('--fill'),active:[...wrap.nextElementSibling.children].findIndex(n=>n.classList.contains('active'))};`);
      check('上下文滑条失败后值/填充/高亮同时回退', context.value === '0' && Number(context.fill) === 0 && context.active === 0, context);
      await run(`const select=document.querySelector('#model-pop select');select.value='model-b';select.dispatchEvent(new Event('change'));`); await pause(100);
      check('模型切换失败后选择器保持服务端当前模型', await run(`return document.querySelector('#model-pop select').value===state.status.model;`));
      // 专属宠物对话切工作区应保留 petChat 查询参数，防止进入普通 bot 布局。
      failSettings = false;
      let navigation = null;
      win.webContents.on('will-navigate', (event, url) => { event.preventDefault(); navigation = url; });
      await run(`applyDesktopMode(true,false,true);input.value='keep draft';await switchWorkspace('/another');`); await pause(100);
      check('宠物对话切工作区保留专属页面模式', !!navigation && new URL(navigation).searchParams.get('petChat') === '1', navigation);
      assert.equal(failed, 0, `${failed}/${count} Web UI checks failed`);
      console.log(`Web UI: ${count} checks passed`);
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally { win?.destroy(); for (const socket of sockets) socket.destroy(); server.close(); app.exit(process.exitCode || 0); }
  });
}

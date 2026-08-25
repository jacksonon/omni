/**
 * omni 桌面应用（Electron 壳）。
 *
 * 原理：ll 起本机后端服务（`dist/omni.cjs web --no-open --port <p>`，用 Electron 自带的
 * Node（ELECTRON_RUN_AS_NODE=1）执行，无需系统安装 Node），等端口就绪后开一个
 * BrowserWindow 指向 http://127.0.0.1:<p>。整个 Agent 栈、页面、协议与 `omni web` 完全一致。
 *
 * 打包：electron-builder 出各平台独立应用（macOS .app/.zip/.dmg、Windows .exe、Linux .AppImage）。
 * 开发：npm run electron:dev（先 npm run bundle 生成 dist/omni.cjs，再 electron .）。
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

/* ---------- 配置 ---------- */
const DEFAULT_PORT = 3080;
const DEV = process.env.OMNI_WEB_DEV === '1';
const ROOT = path.join(__dirname, '..');
const DIST_CJS = path.join(ROOT, 'dist', 'omni.cjs');
const SRC_INDEX = path.join(ROOT, 'src', 'index.ts');
const TSCLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WEB_PORT = process.env.OMNI_WEB_PORT ? Number(process.env.OMNI_WEB_PORT) : DEFAULT_PORT;

let mainWindow = null;
let serverProc = null;
let serverPort = null; // 当前后端端口（菜单选目录走 REST 切换用）
// 后端子进程输出环形缓冲：Windows GUI 应用看不到任何 console 输出，启动失败的
// 真实原因（缺 API Key / 端口占用 / bundle 崩溃堆栈…）全在这里——错误弹窗附上
// 最近几行，同时落盘 userData/backend-latest.log 供用户反馈排查
const OUT_TAIL = [];
const OUT_TAIL_MAX = 80;
let logFile = null;
// 从 Finder/Dock/开始菜单启动时 process.cwd() 可能是 "/"（macOS）或 System32/盘符根
// （Windows）——会话会被记到根目录且 AGENTS.md/配置发现全部失效，此时回退到用户主目录
function saneWorkspace() {
  const home = require('os').homedir();
  if (process.env.OMNI_WEB_WORKSPACE) return process.env.OMNI_WEB_WORKSPACE;
  const cwd = process.cwd();
  const bad = cwd === '/'
    || /^[a-zA-Z]:\\?$/.test(cwd)
    || /^[/\\]windows([/\\].*)?$/i.test(cwd);
  return bad ? home : cwd;
}
let workspace = saneWorkspace();

function recordOutput(stream, d) {
  const s = String(d);
  for (const line of s.split(/\r?\n/)) {
    if (!line.trim()) continue;
    OUT_TAIL.push(line.length > 300 ? line.slice(0, 300) + '…' : line);
  }
  while (OUT_TAIL.length > OUT_TAIL_MAX) OUT_TAIL.shift();
  process.stdout.write(`[omni-web:${stream}] ${s}`);
  if (logFile) {
    try { fs.appendFileSync(logFile, s); } catch { /* 日志失败不影响主流程 */ }
  }
}

/** 最近输出摘要（错误弹窗用）：最多 12 行、每行 ≤160 列 */
function outTailSummary() {
  if (OUT_TAIL.length === 0) return '';
  const lines = OUT_TAIL.slice(-12).map((l) => (l.length > 160 ? l.slice(0, 160) + '…' : l));
  return `\n\n—— 后端最近输出 ——\n${lines.join('\n')}`;
}

function initLogFile() {
  OUT_TAIL.length = 0; // 重启（切换工作目录）时重置缓冲，尾巴只反映本次启动
  try {
    logFile = path.join(app.getPath('userData'), 'backend-latest.log');
    fs.writeFileSync(
      logFile,
      `=== omni backend ${new Date().toISOString()} · port=${serverPort} · cwd=${workspace} ===\n`
    );
  } catch {
    logFile = null; // userData 不可写时静默降级
  }
}

/* ---------- 工具 ---------- */
/** 原生文件夹选择对话框（菜单与页面 preload 共用），返回绝对路径或 null */
function pickDir() {
  const choice = dialog.showOpenDialogSync(mainWindow, {
    title: '选择工作目录（Agent 的工作区）',
    defaultPath: workspace,
    properties: ['openDirectory', 'createDirectory'],
  });
  return choice && choice.filePaths[0] ? choice.filePaths[0] : null;
}

// 页面（Web UI 设置 → 工作目录 → 浏览…）经 preload 触发原生选择
ipcMain.handle('omni:pick-directory', () => pickDir());

/**
 * 菜单「选择工作目录…」：首选调后端 REST /api/workspace 切换（chdir + 重建运行时 +
 * 持久化到全局配置，页面经 SSE 自动刷新，无需重启）；后端不可达或返回错误时
 * 提示后回退进程重启（修复：此前非 ok 响应被静默吞掉，用户不知道切换没生效）。
 */
async function pickAndSwitchWorkspace() {
  const dir = pickDir();
  if (!dir) return;
  workspace = dir;
  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    if (res.ok) return;
    // 后端明确拒绝（如目录不存在）→ 提示原因，不盲目重启（重启也会失败）
    let detail = '';
    try {
      const body = await res.json();
      if (body && body.error) detail = String(body.error);
    } catch { /* 非 JSON 响应忽略 */ }
    dialog.showErrorBox('切换工作目录失败', detail || `后端返回 ${res.status}，请检查目录是否有效。`);
    return;
  } catch {
    // 后端不可达（极端）→ 回退重启
  }
  await restartWithWorkspace(dir);
}

/**
 * 轮询 /api/status 直到服务就绪。
 * 与旧版的区别：不等满超时才报错——后端进程提前退出（缺 API Key、bundle 崩溃、
 * spawn 失败…）立即失败并在错误里附最近输出；超时同样附输出。Windows GUI 应用
 * 看不到 console，这是用户能看到真实失败原因的唯一通道。
 */
function waitForServer(port, timeoutMs, exitPromise, errorPromise) {
  const t0 = Date.now();
  const poll = new Promise((resolve, reject) => {
    let settled = false;
    const tick = () => {
      if (settled) return;
      if (Date.now() - t0 > timeoutMs) {
        settled = true;
        reject(new Error(`后端服务启动超时（${Math.round(timeoutMs / 1000)}s）${outTailSummary()}`));
        return;
      }
      const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1000 }, (res) => {
        res.resume();
        if (!settled) { settled = true; resolve(true); }
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => { if (!settled) setTimeout(tick, 250); });
    };
    tick();
  });
  const exited = exitPromise.then(({ code, sig }) => {
    throw new Error(`后端进程提前退出（code=${code}${sig ? ` · signal=${sig}` : ''}）${outTailSummary()}`);
  });
  const failed = errorPromise.then((err) => {
    throw new Error(`无法启动后端进程：${err.message}${outTailSummary()}`);
  });
  return Promise.race([poll, exited, failed]);
}

async function findFreePort(from) {
  for (let p = from; p < from + 100; p++) {
    const free = await new Promise((resolve) => {
      const srv = require('net').createServer();
      srv.unref();
      srv.on('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error('找不到空闲端口');
}

const SERVER_TIMEOUT_MS = 30_000; // 冷启动预算（AV 首扫 / npx 冷下载都比 mac 慢，20s 偏紧）

async function startServer(port) {
  if (serverProc) return;
  initLogFile();
  // 统一用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）执行后端入口：
  //  dev   → tsx 跑源码（tsx CLI 顶层会再 spawn 系统 node + 加载器，EOF 场景不需要)
  //  pack  → 直接跑 dist/omni.cjs 打包产物（包内自带 Electron 的 Node 运行时）
  const isDev = DEV && fs.existsSync(TSCLI) && fs.existsSync(SRC_INDEX);
  const args = isDev
    ? [TSCLI, SRC_INDEX, 'web', '--no-open', '--port', String(port)]
    : [DIST_CJS, 'web', '--no-open', '--port', String(port)];
  if (!isDev && !fs.existsSync(DIST_CJS)) {
    throw new Error(`缺少 ${DIST_CJS}——请先运行 npm run bundle（或 npm run build）`);
  }
  console.log(`[omni-web] spawn server: ${process.execPath} ${args.join(' ')}（DEV=${DEV} cwd=${workspace}）`);
  serverProc = spawn(process.execPath, args, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OMNI_WEB_DIR: path.join(ROOT, 'web') },
  });
  serverProc.stdout.on('data', (d) => recordOutput('out', d));
  serverProc.stderr.on('data', (d) => recordOutput('err', d));
  // spawn 失败（ENOENT/EACCES）与提前退出都要立即暴露——否则轮询干等满超时，
  // Windows 用户只能看到笼统的「启动超时」而不知道真实原因
  const exitPromise = new Promise((resolve) => {
    serverProc.once('exit', (code, sig) => {
      console.error(`[omni-web] server exited code=${code} sig=${sig}`);
      serverProc = null;
      resolve({ code, sig });
    });
  });
  const errorPromise = new Promise((resolve) => {
    serverProc.once('error', (err) => {
      console.error('[omni-web] spawn error:', err);
      resolve(err);
    });
  });
  try {
    await waitForServer(port, SERVER_TIMEOUT_MS, exitPromise, errorPromise);
  } catch (err) {
    stopServer(); // 清理半死进程（若还活着）
    throw err;
  }
}

function stopServer() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
}

async function createWindow() {
  const port = await findFreePort(WEB_PORT);
  serverPort = port;
  await startServer(port);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'omni',
    backgroundColor: '#111113',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function restartWithWorkspace(dir) {
  if (dir) {
    workspace = dir;
  } else {
    const picked = pickDir();
    if (!picked) return;
    workspace = picked;
  }
  stopServer();
  await createWindow();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '选择工作目录…', click: () => void pickAndSwitchWorkspace() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 生命周期 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      await createWindow();
    } catch (err) {
      const msg = String((err && err.message) || err);
      // 附日志位置：弹窗里放不下的完整输出在 backend-latest.log（Windows 反馈排障的唯一现场）
      const logHint = logFile ? `\n\n完整日志：${logFile}` : '';
      dialog.showErrorBox('omni 启动失败', msg + logHint);
      app.quit();
      return;
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });

  app.on('will-quit', () => {
    stopServer();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

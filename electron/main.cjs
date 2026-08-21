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

const { app, BrowserWindow, Menu, dialog } = require('electron');
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
let workspace = process.env.OMNI_WEB_WORKSPACE || process.cwd();

/* ---------- 工具 ---------- */
function pickWorkspace() {
  const choice = dialog.showOpenDialogSync(mainWindow, {
    title: '选择工作目录（Agent 的工作区）',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (choice && choice.filePaths[0]) {
    workspace = choice.filePaths[0];
    return true;
  }
  return false;
}

/** 轮询 /api/status 直到服务就绪（或超时） */
function waitForServer(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 400 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('timeout', () => req.destroy().destroy());
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error('后端服务启动超时'));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
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

async function startServer(port) {
  if (serverProc) return;
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
  serverProc.stdout.on('data', (d) => process.stdout.write(`[omni-web:out] ${d}`));
  serverProc.stderr.on('data', (d) => process.stdout.write(`[omni-web:err] ${d}`));
  serverProc.on('error', (err) => console.error('[omni-web] spawn error:', err));
  serverProc.on('exit', (code, sig) => {
    console.error(`[omni-web] server exited code=${code} sig=${sig}`);
    serverProc = null;
  });
  await waitForServer(port);
}

function stopServer() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
}

async function createWindow() {
  const port = await findFreePort(WEB_PORT);
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
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function restartWithWorkspace() {
  if (pickWorkspace()) {
    stopServer();
    await createWindow();
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '选择工作目录…', click: () => void restartWithWorkspace() },
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
      dialog.showErrorBox('omni 启动失败', String(err && err.message || err));
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

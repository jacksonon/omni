/**
 * 桌面与 bot 共用 Electron 壳、Web UI 和独立 Omni Server。
 * --bot 常驻托盘，--hidden 登录时不弹窗；退出客户端不终止共享任务。
 */
'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, dialog, ipcMain, screen, Notification, powerMonitor, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeSettings, fitBounds, isTrustedPage, workspaceUrl } = require('./bot-utils.cjs');
const ROOT = path.join(__dirname, '..');
const DIST_CJS = path.join(ROOT, 'dist', 'omni.cjs');
let botMode = process.argv.includes('--bot');
let resident = botMode;
let quitting = false;
let mainWindow = null;
let tray = null;
let connection = null;
let connectPromise = null;
let settings, settingsPath, logPath;
let shortcutRegistered = false;
let status = null;
let recentSessions = [];
let pendingCount = 0;
let connected = false;
let pollTimer, polling = false, observed = false;
let previousRuns = new Map(), seenPending = new Set();
let eventObserver = null;
let failedPolls = 0;
const heldNotifications = new Set();
function workspaceArg(args) {
  const i = args.findIndex(a => a === '--cwd' || a === '--workspace');
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : null;
}
function initialWorkspace() {
  if (workspaceArg(process.argv)) return workspaceArg(process.argv);
  if (process.env.OMNI_WEB_WORKSPACE) return path.resolve(process.env.OMNI_WEB_WORKSPACE);
  const cwd = process.cwd();
  return cwd === '/' || /^[a-zA-Z]:\\?$/.test(cwd) || /^[a-zA-Z]:[\\/]Windows(?:[\\/]|$)/i.test(cwd) ? os.homedir() : cwd;
}
let workspace = initialWorkspace();
function logError(message) {
  // 不写 server ensure stdout，其中含只供主进程使用的认证凭据。
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${String(message)}\n`); } catch {}
}
function saveSettings(value = settings) {
  const tmp = settingsPath + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, settingsPath);
}
function initSettings() {
  settingsPath = path.join(app.getPath('userData'), 'bot-settings.json');
  logPath = path.join(app.getPath('userData'), 'desktop-latest.log');
  try { settings = normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
  catch { settings = normalizeSettings({}); }
}
function emitAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('omni:desktop-action', action);
}
/** Electron 自带 Node 执行 CLI，只等待连接结果；broker 独立驻留。 */
function ensureConnection(dir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DIST_CJS)) { reject(new Error('缺少桌面后端，请重新安装 Omni；开发环境请先运行 npm run bundle。')); return; }
    const child = spawn(process.execPath, [DIST_CJS, 'server', 'ensure', '--json', '--cwd', dir], {
      cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('连接 Omni Server 超时，请运行 omni server status 检查。')); }, 60000);
    child.stdout.on('data', d => { stdout += String(d); if (stdout.length > 128000) { child.kill(); finish(new Error('服务连接返回了异常数据。')); } });
    child.stderr.on('data', d => { stderr = (stderr + String(d)).slice(-4000); });
    child.on('error', err => finish(err));
    child.on('close', code => {
      if (code !== 0) { finish(new Error(stderr.trim() || `启动服务失败（${code}）`)); return; }
      try {
        const value = JSON.parse(stdout.trim()), server = new URL(value.serverUrl), scoped = new URL(value.url);
        if (server.hostname !== '127.0.0.1' || server.protocol !== 'http:' || scoped.origin !== server.origin || !workspaceUrl(value.url) || typeof value.token !== 'string' || !value.token) throw new Error('invalid connection');
        finish(null, value);
      } catch { finish(new Error('服务连接信息无效，请升级 CLI 与桌面应用至同一版本。')); }
    });
  });
}
async function setConnectionCookie() {
  await mainWindow.webContents.session.cookies.set({ url: connection.serverUrl, name: 'omni_broker', value: connection.token, path: '/', httpOnly: true, sameSite: 'strict' });
}
async function connectWorkspace(dir, navigate = true) {
  const previousUrl = connection?.url;
  connection = await ensureConnection(dir);
  workspace = dir; observed = false; previousRuns.clear(); seenPending.clear();
  if (mainWindow) {
    await setConnectionCookie();
    if (navigate || previousUrl !== connection.url) await mainWindow.loadURL(`${connection.url}/?bot=${botMode ? '1' : '0'}`);
  }
  startEventObserver();
  void pollServer();
  return connection;
}
function requestJSON(route) {
  if (!connection) return Promise.reject(new Error('尚未连接服务'));
  return authenticatedJSON(connection.url + route);
}
function authenticatedJSON(url) {
  return fetch(url, { headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(5000) })
    .then(async response => { if (!response.ok) throw new Error(`服务返回 ${response.status}`); return response.json(); });
}
async function openSession(sessionId, scope) {
  if (scope && scope.url !== connection?.url) await connectWorkspace(scope.cwd);
  await showWindow(true, { type: 'session', sessionId });
}
function notify(title, body, sessionId, scope = connection && { url: connection.url, cwd: workspace }) {
  if (!settings.notifications || !Notification.isSupported() || (mainWindow?.isVisible() && mainWindow?.isFocused())) return;
  const note = new Notification({ title, body, icon: path.join(__dirname, 'icon.png'), silent: true });
  heldNotifications.add(note);
  note.on('click', () => { void openSession(sessionId, scope).catch(err => logError(err.message)); });
  note.on('close', () => heldNotifications.delete(note)); note.show();
}
async function pollServer() {
  if (polling || !connection || quitting) return;
  polling = true;
  const current = connection;
  try {
    const [next, sessions, pending, aggregate] = await Promise.all([requestJSON('/api/status'), requestJSON('/api/sessions'), requestJSON('/api/pending'), authenticatedJSON(connection.serverUrl + '/_omni/status').catch(() => null)]);
    if (current !== connection) return;
    connected = true; failedPolls = 0; status = next; workspace = next.cwd || workspace;
    recentSessions = (Array.isArray(sessions) ? sessions : sessions.sessions || []).slice(0, 8).map(s => ({ ...s, scope: { url: current.url, cwd: workspace } }));
    const scopes = Array.isArray(aggregate?.workspaces) ? aggregate.workspaces : [{ url: current.url, cwd: workspace, status: next, pending }];
    const requests = scopes.flatMap(scope => [
      ...(scope.pending?.approvals || []).map(p => ({ ...p, id: scope.url + ':' + p.approvalId, kind: 'approval', scope })),
      ...(scope.pending?.asks || []).map(p => ({ ...p, id: scope.url + ':' + p.askId, kind: 'ask', scope })),
    ]);
    pendingCount = requests.length;
    const active = new Map(scopes.flatMap(scope => (scope.status?.runningSessions || []).map(id => [scope.url + ':' + id, { sessionId: id, scope }])));
    status = { ...next, running: active.size > 0, runningSessions: [...active.keys()] };
    if (observed) {
      for (const [key, run] of previousRuns) if (!active.has(key)) notify('Omni · 任务已结束', recentSessions.find(s => s.id === run.sessionId)?.title || '点击查看对话结果', run.sessionId, run.scope);
      for (const p of requests) if (!seenPending.has(p.id)) notify(p.kind === 'approval' ? 'Omni · 等待审批' : 'Omni · 等待回答', p.summary || p.question || '点击处理后继续任务', p.sessionId, p.scope);
    }
    previousRuns = active; seenPending = new Set(requests.map(p => p.id)); observed = true;
  } catch {
    connected = false;
    if (++failedPolls >= 3 && !connectPromise) { failedPolls = 0; void reconnect(); }
  }
  finally { polling = false; updateTray(); }
}
/** 主进程监听事件，隐藏窗口或渲染器节流时仍能立即提示短任务结束与审批。 */
function startEventObserver() {
  eventObserver?.abort();
  const controller = new AbortController(), current = connection;
  eventObserver = controller;
  void (async () => {
    let cursor = '';
    while (!controller.signal.aborted && !quitting && current === connection) {
      try {
        const response = await fetch(current.url + '/api/events', { headers: { authorization: `Bearer ${current.token}`, ...(cursor ? { 'Last-Event-ID': cursor } : {}) }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('event stream unavailable');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            let type = '', payload = '', id = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim();
              if (line.startsWith('data:')) payload += line.slice(5).trimStart();
              if (line.startsWith('id:')) id = line.slice(3).trim();
            }
            if (id) cursor = id;
            if (!payload || current !== connection) continue;
            let ev; try { ev = JSON.parse(payload); } catch { continue; }
            if (type === 'run.end') {
              previousRuns.delete(current.url + ':' + ev.sessionId);
              notify('Omni · 任务已结束', recentSessions.find(s => s.id === ev.sessionId)?.title || '点击查看对话结果', ev.sessionId);
              void pollServer();
            } else if (type === 'approval.request' || type === 'ask.request') {
              const requestId = current.url + ':' + (ev.approvalId || ev.askId);
              if (!seenPending.has(requestId)) notify(type === 'approval.request' ? 'Omni · 等待审批' : 'Omni · 等待回答', ev.summary || ev.question || '点击处理后继续任务', ev.sessionId);
              seenPending.add(requestId); void pollServer();
            } else if (type === 'status' || type === 'approval.resolved' || type === 'ask.resolved') void pollServer();
          }
          if (buffer.length > 2000000) throw new Error('oversized event frame');
        }
      } catch { /* 恢复连接后按游标补齐，连接状态由轮询更新。 */ }
      if (!controller.signal.aborted && !quitting) await new Promise(resolve => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, 2000);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  })();
}
function trayStatus() {
  if (!connected) return '服务未连接';
  if (pendingCount) return `等待处理 · ${pendingCount}`;
  if (status?.running) return `执行中 · ${status.runningSessions?.length || 1}`;
  return '就绪';
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(`Omni · ${trayStatus()}${shortcutRegistered ? ` · ${settings.shortcut}` : ' · 快捷键不可用'}`);
  if (process.platform === 'darwin') tray.setTitle(pendingCount ? '•' : status?.running ? '·' : '');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Omni · ${trayStatus()}`, enabled: false },
    { label: `快速对话${shortcutRegistered ? ` (${settings.shortcut})` : ''}`, click: () => void showWindow(true) },
    { label: '打开完整窗口', click: () => void showWindow(false) },
    { label: '最近会话', enabled: recentSessions.length > 0, submenu: recentSessions.map(s => ({ label: (s.title || '未命名会话').slice(0, 70), click: () => void openSession(s.id, s.scope).catch(err => logError(err.message)) })) },
    { type: 'separator' },
    { label: '选择工作目录…', click: () => void pickAndSwitchWorkspace() },
    { label: '对话设置…', click: () => void showWindow(true, { type: 'settings' }) },
    { label: '托盘与快捷键设置…', click: () => void showWindow(true, { type: 'desktop-settings' }) },
    { label: '登录时启动', type: 'checkbox', checked: loginEnabled(), enabled: app.isPackaged, click: item => {
      try { setLogin(item.checked); settings.openAtLogin = item.checked; saveSettings(); }
      catch (err) { dialog.showErrorBox('自启设置失败', err.message); } updateTray();
    } },
    ...(!connected ? [{ label: '重新连接服务', click: () => void reconnect() }] : []),
    { type: 'separator' }, { label: '退出 Omni', click: () => app.quit() },
  ]));
}
function registerShortcut(shortcut) {
  try {
    return globalShortcut.register(shortcut, () => {
      if (mainWindow?.isVisible() && mainWindow?.isFocused() && botMode) mainWindow.hide();
      else void showWindow(true);
    });
  } catch { return false; }
}
function linuxLoginPath() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'ai.omni.bot.desktop'); }
function loginEnabled() {
  if (!app.isPackaged) return false;
  try { return process.platform === 'linux' ? fs.existsSync(linuxLoginPath()) : app.getLoginItemSettings().openAtLogin; }
  catch { return settings.openAtLogin; }
}
function setLogin(enabled) {
  if (!app.isPackaged) throw new Error('登录自启需要使用安装后的 Omni 桌面应用。');
  if (process.platform === 'linux') {
    const file = linuxLoginPath();
    if (!enabled) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } return; }
    const executable = process.env.APPIMAGE || process.execPath;
    const escaped = executable.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Omni Bot\nExec="${escaped}" --bot --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
  } else app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === 'win32' ? { path: process.execPath, args: ['--bot', '--hidden'], enabled } : {}) });
}
function desktopInfo() {
  return { bot: botMode, shortcut: settings.shortcut, shortcutRegistered, openAtLogin: loginEnabled(), loginSupported: app.isPackaged, notifications: settings.notifications, platform: process.platform, connected };
}
async function setBotSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('设置格式无效');
  const next = { ...settings };
  // 先验证全部字段，避免后续字段非法时已占用新快捷键。
  if (input.openAtLogin !== undefined && typeof input.openAtLogin !== 'boolean') throw new Error('自启设置无效');
  if (input.notifications !== undefined && typeof input.notifications !== 'boolean') throw new Error('通知设置无效');
  if (input.shortcut !== undefined && (typeof input.shortcut !== 'string' || !input.shortcut.trim() || input.shortcut.length > 120)) throw new Error('请输入有效的快捷键，如 CommandOrControl+Shift+Space。');
  const previousLogin = loginEnabled();
  if (input.openAtLogin !== undefined && input.openAtLogin !== previousLogin) setLogin(input.openAtLogin);
  try {
  if (input.shortcut !== undefined) {
    const candidate = input.shortcut.trim();
    if (candidate !== settings.shortcut || !shortcutRegistered) {
      globalShortcut.unregister(settings.shortcut);
      if (!registerShortcut(candidate)) { shortcutRegistered = registerShortcut(settings.shortcut); throw new Error('该快捷键无法注册，可能已被系统或其它应用占用。请换一个组合。'); }
      shortcutRegistered = true; next.shortcut = candidate;
    }
  }
  if (input.openAtLogin !== undefined) {
    next.openAtLogin = input.openAtLogin;
  }
  if (input.notifications !== undefined) {
    next.notifications = input.notifications;
  }
  saveSettings(next); settings = next; updateTray(); return desktopInfo();
  } catch (err) {
    if (next.shortcut !== settings.shortcut) { globalShortcut.unregister(next.shortcut); shortcutRegistered = registerShortcut(settings.shortcut); }
    if (input.openAtLogin !== undefined && input.openAtLogin !== previousLogin) { try { setLogin(previousLogin); } catch {} }
    updateTray(); throw err;
  }
}
function boundsForMode(bot, nearPointer) {
  const saved = settings[bot ? 'botBounds' : 'fullBounds'];
  const display = nearPointer ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay();
  return fitBounds(nearPointer ? saved && { ...saved, x: undefined, y: undefined } : saved, display.workArea, bot);
}
function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isMaximized()) return;
  settings[botMode ? 'botBounds' : 'fullBounds'] = mainWindow.getBounds();
  try { saveSettings(); } catch (err) { logError(err.message); }
}
async function createWindow() {
  const bot = botMode;
  mainWindow = new BrowserWindow({
    ...boundsForMode(bot, false), minWidth: bot ? 380 : 640, minHeight: bot ? 340 : 480,
    title: bot ? 'Omni Bot' : 'Omni', icon: path.join(__dirname, 'icon.png'), show: false,
    // ChatGPT 式快速窗口：无系统边框/标题栏，透明窗口画圆角卡片，置顶且不占任务栏。
    frame: !bot,
    transparent: bot,
    backgroundColor: bot ? '#00000000' : '#111113',
    hasShadow: true,
    roundedCorners: true,
    alwaysOnTop: bot,
    skipTaskbar: bot,
    fullscreenable: !bot,
    maximizable: !bot,
    minimizable: !bot,
    resizable: true,
    movable: true,
    acceptFirstMouse: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  if (bot && process.platform === 'darwin') mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.on('close', event => { rememberBounds(); if (resident && !quitting) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('moved', rememberBounds); mainWindow.on('resized', rememberBounds);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!connection || !isTrustedPage(url, connection.serverUrl)) event.preventDefault(); });
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    const scoped = workspaceUrl(url);
    if (scoped && connection && scoped !== connection.url) { connection = { ...connection, url: scoped }; observed = false; startEventObserver(); void pollServer(); }
  });
  mainWindow.webContents.on('did-finish-load', () => emitAction({ type: 'mode', bot: botMode }));
  if (!connection) await connectWorkspace(workspace);
  else { await setConnectionCookie(); await mainWindow.loadURL(`${connection.url}/?bot=${botMode ? '1' : '0'}`); }
}
async function showWindow(bot = botMode, action) {
  try {
    if (connectPromise) await connectPromise;
    if (!mainWindow) {
      botMode = bot; connectPromise = createWindow();
      try { await connectPromise; } finally { connectPromise = null; }
    }
    rememberBounds();
    if (bot !== botMode) {
      botMode = bot; mainWindow.setMinimumSize(bot ? 380 : 640, bot ? 340 : 480);
      mainWindow.setBounds(boundsForMode(bot, bot)); mainWindow.setTitle(bot ? 'Omni Bot' : 'Omni'); emitAction({ type: 'mode', bot });
    } else if (!mainWindow.isVisible()) mainWindow.setBounds(boundsForMode(bot, bot));
    if (bot) resident = true;
    mainWindow.setSkipTaskbar(bot);
    mainWindow.setAlwaysOnTop(bot, bot ? 'floating' : 'normal');
    mainWindow.setFullScreenable(!bot);
    mainWindow.setMaximizable(!bot);
    mainWindow.setMinimizable(!bot);
    if (process.platform === 'darwin') {
      mainWindow.setVisibleOnAllWorkspaces(bot, { visibleOnFullScreen: bot });
      app.setActivationPolicy(bot ? 'accessory' : 'regular');
      if (!bot) app.dock?.show();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus(); emitAction(action || { type: 'focus' });
  } catch (err) { logError(err.message); dialog.showErrorBox('Omni 启动失败', `${err.message}\n\n日志：${logPath}`); }
}
async function reconnect() {
  if (connectPromise) return connectPromise;
  connectPromise = connectWorkspace(workspace, false);
  try { await connectPromise; } catch (err) { logError(err.message); } finally { connectPromise = null; }
}
async function pickDir() {
  const choice = await dialog.showOpenDialog(mainWindow || undefined, { title: '选择工作目录', defaultPath: workspace, properties: ['openDirectory', 'createDirectory'] });
  return !choice.canceled && choice.filePaths.length ? choice.filePaths[0] : null;
}
async function pickAndSwitchWorkspace() {
  const dir = await pickDir(); if (!dir) return;
  try { await connectWorkspace(dir); } catch (err) { dialog.showErrorBox('切换工作目录失败', err.message); }
}
function assertSender(event) {
  if (!connection || !mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isTrustedPage(event.senderFrame.url, connection.serverUrl)) throw new Error('不受信任的桌面请求');
}
function installIPC() {
  const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => { assertSender(event); return fn(...args); });
  handle('omni:pick-directory', pickDir); handle('omni:desktop-info', desktopInfo); handle('omni:bot-settings', setBotSettings);
  handle('omni:hide', () => { if (resident) mainWindow?.hide(); }); handle('omni:open-full', () => showWindow(false));
  handle('omni:window-minimize', () => mainWindow?.minimize());
  handle('omni:window-maximize', () => { if (!mainWindow) return; if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); });
  handle('omni:window-close', () => mainWindow?.close());
}
function createTray() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const image = nativeImage.createFromPath(path.join(__dirname, file));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image); tray.on('click', () => void showWindow(true)); tray.on('double-click', () => void showWindow(true)); updateTray();
}
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [
      { label: '快速对话', click: () => void showWindow(true) }, { label: '打开完整窗口', click: () => void showWindow(false) },
      { label: '选择工作目录…', click: () => void pickAndSwitchWorkspace() },
      { label: '托盘与快捷键设置…', click: () => void showWindow(botMode, { type: 'desktop-settings' }) },
      { type: 'separator' }, { role: 'close' }, { role: 'quit', label: '退出 Omni' },
    ] },
    { role: 'editMenu' }, { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }, { role: 'windowMenu' },
  ]));
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    const dir = workspaceArg(argv), bot = argv.includes('--bot');
    if (dir) {
      connectPromise = connectWorkspace(dir);
      connectPromise.finally(() => { connectPromise = null; }).catch(err => logError(err.message));
    }
    void showWindow(bot);
  });
  app.whenReady().then(async () => {
    initSettings(); if (process.platform === 'win32') app.setAppUserModelId('ai.omni.web');
    let loginLaunch = false;
    try { loginLaunch = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin; } catch {}
    if (loginLaunch) { botMode = true; resident = true; }
    if (process.platform === 'darwin') { app.dock?.setIcon(path.join(__dirname, 'icon.png')); if (botMode) app.setActivationPolicy('accessory'); }
    buildMenu(); installIPC(); createTray(); shortcutRegistered = registerShortcut(settings.shortcut);
    connectPromise = createWindow();
    try { await connectPromise; } catch (err) { logError(err.message); dialog.showErrorBox('Omni 启动失败', `${err.message}\n\n日志：${logPath}`); }
    finally { connectPromise = null; }
    updateTray();
    if (!process.argv.includes('--hidden') && !loginLaunch && mainWindow) await showWindow(botMode);
    pollTimer = setInterval(() => void pollServer(), 2000); powerMonitor.on('resume', () => void reconnect());
    screen.on('display-removed', () => { if (mainWindow?.isVisible()) mainWindow.setBounds(boundsForMode(botMode, false)); });
    app.on('activate', () => void showWindow(botMode));
  });
  app.on('before-quit', () => { quitting = true; rememberBounds(); });
  app.on('will-quit', () => { clearInterval(pollTimer); eventObserver?.abort(); globalShortcut.unregisterAll(); for (const note of heldNotifications) note.close(); tray?.destroy(); });
  // server 生命周期独立，Web / TUI / mini 客户端与后台任务继续运行。
  app.on('window-all-closed', () => { if (!resident && process.platform !== 'darwin') app.quit(); });
}

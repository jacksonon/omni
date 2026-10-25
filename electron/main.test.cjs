'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
async function harness(argv = ['--bot', '--hidden'], platform = 'darwin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-desktop-test-'));
  const app = new EventEmitter();
  let ready, win, tray, aggregate = null;
  const notifications = [];
  const shortcuts = new Map(), handlers = new Map(), spawned = [], intervals = [];
  Object.assign(app, {
    requestSingleInstanceLock: () => true, whenReady: () => ({ then: fn => { ready = fn(); return ready; } }),
    getPath: () => dir, isPackaged: false, dock: { setIcon() {}, show() {} },
    setActivationPolicy(policy) { app.policy = policy; }, getLoginItemSettings: () => ({}),
    setAppUserModelId() {}, quit() { app.emit('before-quit'); app.emit('will-quit'); },
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false; this.focused = false; this.bounds = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.session = { cookies: { set: async cookie => { this.cookie = cookie; } } };
      this.webContents.send = (_name, action) => { this.action = action; };
      this.webContents.setWindowOpenHandler = callback => { this.external = callback; };
      win = this;
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-navigate', {}, url); this.webContents.emit('did-finish-load'); }
    isDestroyed() { return false; } isVisible() { return this.visible; } isFocused() { return this.focused; }
    isMinimized() { return false; } isMaximized() { return false; }
    show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focused = true; }
    getBounds() { return { x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height }; }
    setBounds(value) { this.bounds = value; } setMinimumSize() {} setTitle() {} setSkipTaskbar(value) { this.skipTaskbar = value; }
    setAlwaysOnTop(value, level) { this.alwaysOnTop = value; this.alwaysOnTopLevel = level; }
    setVisibleOnAllWorkspaces(value, options) { this.visibleOnAllWorkspaces = value; this.visibleOnFullScreen = options?.visibleOnFullScreen; }
    setFullScreenable(value) { this.fullScreenable = value; }
    setMaximizable(value) { this.maximizable = value; }
    setMinimizable(value) { this.minimizable = value; }
    minimize() { this.minimized = true; }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
  }
  class Tray extends EventEmitter { constructor() { super(); tray = this; } isDestroyed() { return false; } setToolTip(t) { this.tooltip = t; } setTitle() {} setContextMenu(menu) { this.menu = menu; } destroy() {} }
  class Note extends EventEmitter {
    constructor(options) { super(); this.options = options; notifications.push(this); }
    static isSupported() { return true; }
    show() {} close() { this.emit('close'); }
  }
  const electron = {
    app, BrowserWindow: Window, Tray, Notification: Note,
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} },
    globalShortcut: { register: (key, fn) => { if (shortcuts.has(key) || key === 'bad') return false; shortcuts.set(key, fn); return true; }, unregister: key => shortcuts.delete(key), unregisterAll: () => shortcuts.clear() },
    dialog: { showErrorBox: (...value) => { throw Error(value.join(' ')); } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    powerMonitor: new EventEmitter(), screen: Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }), getCursorScreenPoint: () => ({ x: 300, y: 300 }) }),
    shell: { openExternal() {} },
  };
  function fakeSpawn(command, args) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
    spawned.push({ command, args, child });
    setImmediate(() => { child.stdout.emit('data', JSON.stringify({ url: 'http://127.0.0.1:3080/w/abcd', serverUrl: 'http://127.0.0.1:3080', token: 'private-test-token', workspaceId: 'abcd' })); child.emit('close', 0); });
    return child;
  }
  const context = {
    require: name => name === 'electron' ? electron : name === 'node:child_process' ? { spawn: fakeSpawn } : name === 'node:fs' ? { ...fs, existsSync: file => file.endsWith('omni.cjs') || fs.existsSync(file) } : name === './bot-utils.cjs' ? require('./bot-utils.cjs') : require(name),
    __dirname, process: { argv: ['electron', '.', ...argv], env: {}, execPath: '/test/Electron', cwd: () => dir, platform, pid: process.pid },
    URL, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    setInterval: fn => { intervals.push(fn); return 1; }, clearInterval() {},
    fetch: async (url, options) => {
      if (url.endsWith('/api/events')) return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
      return { ok: true, json: async () => url.endsWith('/_omni/status') ? aggregate : url.endsWith('/api/status') ? { cwd: dir, runningSessions: [] } : url.endsWith('/api/pending') ? { approvals: [], asks: [] } : [] };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), context);
  await ready; await new Promise(resolve => setImmediate(resolve));
  return { app, dir, get win() { return win; }, tray, shortcuts, handlers, spawned, context, intervals, notifications, setAggregate(value) { aggregate = value; }, cleanup() { app.quit(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('bot hidden startup, global shortcut, close-to-tray, full window share one renderer', async () => {
  const h = await harness();
  try {
    assert.equal(h.win.visible, false);
    assert.equal(h.win.options.frame, false);
    assert.equal(h.win.options.transparent, true);
    assert.equal(h.win.options.alwaysOnTop, true);
    assert.equal(h.win.options.skipTaskbar, true);
    assert.equal(h.win.options.roundedCorners, true);
    assert.ok(h.win.bounds.height < 220, '初始窗口是单输入框高度');
    assert.equal(h.win.cookie.httpOnly, true);
    assert.equal(h.win.cookie.value, 'private-test-token');
    assert.match(h.win.webContents.mainFrame.url, /\/w\/abcd\/\?bot=1$/);
    h.shortcuts.get('CommandOrControl+Shift+Space')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.win.visible, true);
    assert.equal(h.win.alwaysOnTop, true);
    assert.equal(h.win.visibleOnAllWorkspaces, true);
    assert.equal(h.win.fullScreenable, false);
    assert.equal(h.app.policy, 'accessory');
    let prevented = false;
    h.win.emit('close', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(h.win.visible, false);
    const sender = { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame };
    assert.equal(h.handlers.get('omni:desktop-info')(sender).compact, true);
    await h.handlers.get('omni:bot-expand')(sender);
    assert.ok(h.win.bounds.height > 300, '发送后展开为对话高度');
    assert.equal(h.win.action.compact, false);
    await h.handlers.get('omni:bot-compact')(sender);
    assert.ok(h.win.bounds.height < 220, '新会话/隐藏回到单输入框');
    await h.handlers.get('omni:open-full')(sender);
    assert.equal(h.app.policy, 'regular'); assert.equal(h.win.skipTaskbar, false);
    assert.equal(h.win.alwaysOnTop, false);
    assert.equal(h.win.visibleOnAllWorkspaces, false);
    assert.equal(h.win.fullScreenable, true);
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0].args.includes('--json'), true);
    h.app.quit();
    assert.equal(h.spawned[0].child.killed, undefined);
    assert.equal(h.shortcuts.size, 0);
  } finally { h.cleanup(); }
});
test('untrusted frame rejected, shortcut collision restores previous registered key', async () => {
  const h = await harness([], 'win32');
  try {
    assert.throws(() => h.handlers.get('omni:desktop-info')({ sender: h.win.webContents, senderFrame: { url: 'https://evil.example' } }), /不受信任/);
    const sender = { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame };
    await assert.rejects(h.handlers.get('omni:bot-settings')(sender, { shortcut: 'bad' }), /无法注册/);
    assert.equal(h.shortcuts.has('CommandOrControl+Shift+Space'), true);
    const info = h.handlers.get('omni:desktop-info')(sender);
    assert.equal(info.shortcutRegistered, true);
    assert.equal(info.loginSupported, false);
    await assert.rejects(h.handlers.get('omni:bot-settings')(sender, { shortcut: 'CommandOrControl+Alt+J', notifications: 'invalid' }), /通知设置无效/);
    assert.equal(h.shortcuts.has('CommandOrControl+Shift+Space'), true);
  } finally { h.cleanup(); }
});
test('托盘汇总其它工作区审批，通知点击连接对应工作区', async () => {
  const h = await harness();
  try {
    h.setAggregate({ workspaces: [
      { url: 'http://127.0.0.1:3080/w/abcd', cwd: h.dir, status: { runningSessions: [] }, pending: {} },
      { url: 'http://127.0.0.1:3080/w/other', cwd: h.dir, status: { runningSessions: ['remote-run'] }, pending: { approvals: [{ sessionId: 'remote-run', approvalId: 'ap-remote', summary: '其它工作区审批' }], asks: [{ sessionId: 'remote-run', askId: 'ask-remote', question: '其它工作区提问' }] } },
    ] });
    h.intervals[0](); await new Promise(resolve => setImmediate(resolve));
    assert.match(h.tray.tooltip, /等待处理 · 2/);
    assert.equal(h.notifications.length, 2);
    h.notifications[0].emit('click'); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.spawned.length, 2);
    assert.equal(h.win.action.type, 'session'); assert.equal(h.win.action.sessionId, 'remote-run');
  } finally { h.cleanup(); }
});

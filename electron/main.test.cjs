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
  let ready, win, pet, petChat, tray, aggregate = null;
  const notifications = [];
  let clipboardText = 'fixture error: missing SDK', clipboardReads = 0;
  const captures = [];
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
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.session = { cookies: { set: async cookie => { this.cookie = cookie; } } };
      this.messages = []; this.webContents.send = (name, action) => { this.action = action; this.messages.push({ name, action }); };
      this.webContents.setWindowOpenHandler = callback => { this.external = callback; };
      if (options.title === 'Omni Pet') pet = this;
      else if (options.title === 'Omni · 宠物对话') petChat = this;
      else win = this;
    }
    async loadURL(url) {
      this.webContents.mainFrame.url = url; this.webContents.emit('did-navigate', {}, url); this.webContents.emit('did-finish-load');
      if (this === petChat) await handlers.get('omni:pet-chat')({sender:this.webContents,senderFrame:this.webContents.mainFrame},'ready');
    }
    isDestroyed() { return false; } isVisible() { return this.visible; } isFocused() { return this.focused; }
    isMinimized() { return false; } isMaximized() { return false; }
    show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; this.emit('hide'); } focus() { this.focused = true; }
    showInactive() { this.visible = true; this.emit('show'); }
    setIgnoreMouseEvents(value, options) { this.ignoreMouse = value; this.forwardMouse = options?.forward; }
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
    clipboard: { readImage: () => { clipboardReads++; return { isEmpty: () => true }; }, readText: () => clipboardText },
    desktopCapturer: { getSources: async options => { captures.push({ options, visible: win.visible }); return [{ display_id: '7', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('screen fixture') } }]; } },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    powerMonitor: new EventEmitter(), screen: Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }), getDisplayNearestPoint: () => ({ id: 7, size: { width: 1440, height: 900 }, scaleFactor: 2, workArea: { x: 0, y: 25, width: 1440, height: 875 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }), getCursorScreenPoint: () => ({ x: 300, y: 300 }) }),
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
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: id => { if(id) intervals[id-1]=null; },
    fetch: async (url, options) => {
      if (url.endsWith('/api/events') || url.endsWith('/_omni/pet/events')) return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
      if (url.endsWith('/_omni/pet')) return { ok: true, json: async () => ({ version: 1, tasks: [], pets: [{id:'omni',name:'Omni 小猫',url:''}], settings:{enabled:true,selected:'omni'} }) };
      return { ok: true, json: async () => url.endsWith('/_omni/status') ? aggregate : url.endsWith('/api/status') ? { cwd: dir, runningSessions: [] } : url.endsWith('/api/pending') ? { approvals: [], asks: [] } : [] };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), context);
  await ready; await new Promise(resolve => setImmediate(resolve));
  return { app, dir, screen:electron.screen, get win() { return win; }, get pet() { return pet; }, get petChat(){return petChat;}, get clipboardReads() { return clipboardReads; }, captures, tray, shortcuts, handlers, spawned, context, intervals, notifications, setClipboard(value) { clipboardText = value; }, setAggregate(value) { aggregate = value; }, cleanup() { app.quit(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('bot hidden startup, global shortcut, close-to-tray, full window share one renderer', async () => {
  const h = await harness();
  try {
    assert.equal(h.win.visible, false);
    assert.equal(h.win.options.frame, false);
    assert.equal(h.win.options.transparent, true);
    assert.equal(h.win.options.alwaysOnTop, true);
    assert.equal(h.win.options.skipTaskbar, true);
    assert.equal(h.win.options.roundedCorners, false);
    assert.equal(h.win.options.hasShadow, false);
    assert.ok(h.win.bounds.height < 220, '初始窗口是单输入框高度');
    assert.ok(h.tray.menu.some(item => item.label === '新建会话'), '托盘提供快速新建会话');
    assert.ok(h.tray.menu.some(item => item.label === '查看当前会话'), '托盘可展开当前会话');
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
test('bot 输入与展开态均可隐藏，再唤起保留同一 renderer 与任务宿主', async () => {
  const h = await harness(['--bot']);
  try {
    const sender = { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame };
    const window=h.win,children=h.spawned.length;
    await h.handlers.get('omni:hide')(sender);assert.equal(window.visible,false);
    h.shortcuts.get('CommandOrControl+Shift+Space')();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(window.visible,true);
    await h.handlers.get('omni:bot-expand')(sender);
    await h.handlers.get('omni:hide')(sender);assert.equal(window.visible,false);
    h.shortcuts.get('CommandOrControl+Shift+Space')();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.win,window);assert.equal(window.visible,true);assert.equal(h.spawned.length,children);
    assert.ok(h.spawned.every(x=>!x.child.killed));
  } finally { h.cleanup(); }
});
test('快速窗口菜单向上借位、输入底边固定，关闭/隐藏还原且不污染展开尺寸', async () => {
  const h=await harness(['--bot']);
  try {
    const sender={sender:h.win.webContents,senderFrame:h.win.webContents.mainFrame};
    const resize=height=>h.handlers.get('omni:bot-popover')(sender,height);
    h.win.setBounds({...h.win.getBounds(),y:400});
    const base=h.win.getBounds();
    resize(300);const menu=h.win.getBounds();
    assert.equal(menu.height,base.height+300);assert.equal(menu.y+menu.height,base.y+base.height);
    resize(200);assert.equal(h.win.bounds.height,base.height+200,'反复定位不累加高度');
    resize(0);assert.deepEqual(h.win.getBounds(),base);
    assert.throws(()=>resize(99999),/无效/);assert.throws(()=>resize('300'),/无效/);
    resize(280);await h.handlers.get('omni:hide')(sender);assert.deepEqual(h.win.getBounds(),base);
    await h.handlers.get('omni:bot-expand')(sender);const expanded=h.win.getBounds();
    resize(200);assert.deepEqual(h.win.getBounds(),expanded,'展开态不借位');
  } finally {h.cleanup();}
});
test('普通唤起不读取剪贴板，导入快捷键只预览、截图先隐藏窗口且发送仍需用户操作', async () => {
  const h = await harness();
  try {
    assert.equal(h.clipboardReads, 0);
    h.shortcuts.get('CommandOrControl+Shift+Space')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.clipboardReads, 0);
    h.setClipboard('复制的报错\nnext line');
    h.shortcuts.get('CommandOrControl+Alt+Space')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.clipboardReads, 1);
    assert.equal(h.win.action.type, 'clipboard');
    assert.equal(h.win.action.payload.content, '复制的报错\nnext line');
    const sender = { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame };
    const shot = await h.handlers.get('omni:capture-screen')(sender);
    assert.match(shot.dataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(h.captures.length, 1); assert.equal(h.captures[0].visible, false);
    assert.ok(h.captures[0].options.thumbnailSize.width > 1000);
    assert.equal(h.win.visible, true);
    assert.throws(() => h.handlers.get('omni:read-clipboard')({ sender: h.win.webContents, senderFrame: { url: 'https://evil.example' } }), /不受信任/);
    assert.equal(h.clipboardReads, 1);
  } finally { h.cleanup(); }
});
test('跨工作区草稿只传给同源指定工作区且只读一次，快捷键设置失败回滚两组注册', async () => {
  const h = await harness();
  try {
    const sender = { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame };
    const draft = { text: '修复截图中的报错', attachments: [{ kind: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,YWJj', size: 3 }] };
    assert.throws(() => h.handlers.get('omni:stage-workspace-draft')(sender, 'https://evil.example/w/target/', draft), /地址无效/);
    h.handlers.get('omni:stage-workspace-draft')(sender, 'http://127.0.0.1:3080/w/target/?bot=1', draft);
    await h.win.loadURL('http://127.0.0.1:3080/w/target/?bot=1');
    assert.deepEqual(h.handlers.get('omni:take-workspace-draft')(sender), draft);
    assert.equal(h.handlers.get('omni:take-workspace-draft')(sender), null);
    await assert.rejects(h.handlers.get('omni:bot-settings')(sender, { shortcut: 'Alt+J', clipboardShortcut: 'bad' }), /剪贴板快捷键无法注册/);
    assert.equal(h.shortcuts.has('CommandOrControl+Shift+Space'), true);
    assert.equal(h.shortcuts.has('CommandOrControl+Alt+Space'), true);
    assert.equal(h.shortcuts.has('Alt+J'), false);
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
test('独立宠物不抢焦点、IPC 隔离、移动保存与隐藏恢复', async () => {
  const h = await harness(['--bot', '--pet']);
  try {
    assert.equal(h.pet.visible, true); assert.equal(h.win.visible, false);
    assert.equal(h.pet.options.focusable, false); assert.equal(h.pet.ignoreMouse, true);
    const sender = { sender: h.pet.webContents, senderFrame: h.pet.webContents.mainFrame };
    const primary = { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame };
    await assert.rejects(h.handlers.get('omni:pet-action')(primary, 'chat'), /不受信任/);
    const before = h.pet.getBounds();
    await h.handlers.get('omni:pet-action')(sender, 'move', { dx: -20, dy: -10 });
    await h.handlers.get('omni:pet-action')(sender, 'position');
    assert.equal(h.pet.bounds.x, before.x - 20);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'bot-settings.json'), 'utf8')).petBounds.x, before.x - 20);
    await h.handlers.get('omni:pet-action')(sender, 'hide'); assert.equal(h.pet.visible, false);
    await h.handlers.get('omni:pet-enable')(primary, true); assert.equal(h.pet.visible, true);
    await h.handlers.get('omni:pet-action')(sender, 'chat'); assert.equal(h.petChat.visible, true);assert.equal(h.win.visible,false);
  } finally { h.cleanup(); }
});
test('Linux 无 forward 时保持宠物可点击', async () => {
  const h = await harness(['--bot', '--pet'], 'linux');
  try {
    assert.equal(h.pet.ignoreMouse, false);
    const sender = { sender: h.pet.webContents, senderFrame: h.pet.webContents.mainFrame };
    await h.handlers.get('omni:pet-action')(sender, 'hit', { interactive: false });
    assert.equal(h.pet.ignoreMouse, false);
  } finally { h.cleanup(); }
});
test('小步拖动越过四屏边界，松手后只校正目标屏并保存负坐标',async()=>{
  const h=await harness(['--bot','--pet']);
  try{
    const areas=[{x:0,y:25,width:1440,height:875},{x:-1920,y:0,width:1920,height:1080},{x:1440,y:0,width:2560,height:1440},{x:0,y:-1080,width:1920,height:1080}];
    h.screen.getDisplayMatching=b=>{
      let best=areas[0],overlap=-1;
      for(const area of areas){const n=Math.max(0,Math.min(b.x+b.width,area.x+area.width)-Math.max(b.x,area.x))*Math.max(0,Math.min(b.y+b.height,area.y+area.height)-Math.max(b.y,area.y));if(n>overlap){best=area;overlap=n;}}
      return {workArea:best};
    };
    const sender={sender:h.pet.webContents,senderFrame:h.pet.webContents.mainFrame};
    const action=(name,input)=>h.handlers.get('omni:pet-action')(sender,name,input);
    h.pet.setBounds({x:1200,y:400,width:240,height:286});
    for(let i=0;i<30;i++)await action('move',{dx:20,dy:0});
    assert.equal(h.pet.bounds.x,1800,'原实现会一直被夹在 x=1200');
    await action('position');assert.equal(h.pet.bounds.x,1800);
    for(let i=0;i<40;i++)await action('move',{dx:-60,dy:0});
    await action('position');assert.equal(h.pet.bounds.x,-600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir,'bot-settings.json'),'utf8')).petBounds.x,-600);
    for(let i=0;i<20;i++)await action('move',{dx:40,dy:-60});
    await action('position');assert.equal(h.pet.bounds.x,200);assert.equal(h.pet.bounds.y,-800);
    for(let i=0;i<20;i++)await action('move',{dx:80,dy:60});
    await action('position');assert.equal(h.pet.bounds.x,1800);assert.equal(h.pet.bounds.y,400);
  }finally{h.cleanup();}
});
test('点击宠物只打开独立对话窗，隐藏/重开保留同一页，IPC 与普通 bot 隔离',async()=>{
  const h=await harness(['--bot','--pet']);
  try{
    const sender={sender:h.pet.webContents,senderFrame:h.pet.webContents.mainFrame};
    await h.handlers.get('omni:pet-action')(sender,'chat');
    const chat=h.petChat;assert.ok(chat);assert.equal(chat.visible,true);assert.equal(h.win.visible,false);
    assert.ok(chat.webContents.getURL().includes('petChat=1'));assert.equal(chat.options.webPreferences.nodeIntegration,false);
    h.app.emit('activate');await new Promise(resolve=>setImmediate(resolve));assert.equal(h.win.visible,false,'激活宠物对话不得弹出快捷框');
    const chatSender={sender:chat.webContents,senderFrame:chat.webContents.mainFrame};
    const mainSender={sender:h.win.webContents,senderFrame:h.win.webContents.mainFrame};
    const info=await h.handlers.get('omni:pet-chat')(chatSender,'info');assert.equal(info.petChat,true);assert.equal(info.compact,false);
    await assert.rejects(h.handlers.get('omni:pet-chat')(mainSender,'hide'),/不受信任/);
    await h.handlers.get('omni:pet-chat')(chatSender,'hide');assert.equal(chat.visible,false);
    const url=chat.webContents.getURL();await h.handlers.get('omni:pet-action')(sender,'chat');
    assert.equal(h.petChat,chat);assert.equal(chat.webContents.getURL(),url);assert.equal(h.win.visible,false);
    await h.handlers.get('omni:pet-chat')(chatSender,'session','pet-session');
    await h.handlers.get('omni:pet-chat')(chatSender,'hide');chat.focused=false;
    h.context.notify('任务完成','点击查看','pet-session',{url:'http://127.0.0.1:3080/w/abcd',cwd:h.dir});
    h.notifications.at(-1).emit('click');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(chat.visible,true);assert.equal(h.win.visible,false,'宠物会话通知返回专属窗口');
    h.shortcuts.get('CommandOrControl+Shift+Space')();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.win.visible,true);assert.equal(chat.visible,true,'显式快捷键仍打开普通 bot，宠物对话独立');
  }finally{h.cleanup();}
});
test('系统暂时夹回旧屏时仍累计期望坐标，跨过负 Y 边界后可进入上方屏幕',async()=>{
  const h=await harness(['--bot','--pet']);
  try{
    const set=h.pet.setBounds.bind(h.pet);
    h.pet.setBounds=b=>set(b.y<25&&b.y+b.height/2>=0?{...b,y:25}:b);
    h.pet.setBounds({x:500,y:25,width:240,height:286});
    h.screen.getDisplayMatching=b=>({workArea:b.y<0?{x:0,y:-1080,width:1920,height:1080}:{x:0,y:25,width:1440,height:875}});
    const sender={sender:h.pet.webContents,senderFrame:h.pet.webContents.mainFrame};
    for(let i=0;i<15;i++)await h.handlers.get('omni:pet-action')(sender,'move',{dx:0,dy:-20});
    assert.equal(h.pet.bounds.y,-275,'必须累计输入增量，不能重新读取每帧被系统夹住的窗口位置');
    await h.handlers.get('omni:pet-action')(sender,'position');assert.equal(h.pet.bounds.y,-286);
  }finally{h.cleanup();}
});
test('桌面注视只向受信宠物页发送变化坐标，隐藏/停用/退出释放采样', async () => {
  const h = await harness(['--bot', '--pet']);
  try {
    const sender = { sender: h.pet.webContents, senderFrame: h.pet.webContents.mainFrame };
    const primary = { sender: h.win.webContents, senderFrame: h.win.webContents.mainFrame };
    const action = (name, input) => h.handlers.get('omni:pet-action')(sender, name, input);
    await assert.rejects(h.handlers.get('omni:pet-action')(primary, 'watch-pointer', { enabled:true }), /不受信任/);
    await assert.rejects(action('watch-pointer', { enabled:'yes' }), /无效/);
    assert.equal(h.intervals.filter(Boolean).length, 1, '未请求注视时只有服务轮询');
    await action('watch-pointer', { enabled:true });
    const sample=h.intervals.at(-1);sample();sample();
    const messages=h.pet.messages.filter(m=>m.name==='omni:pet-pointer');
    assert.equal(messages.length,1,'静止鼠标不重复发送');
    assert.equal(messages[0].action.x,300-h.pet.bounds.x);
    assert.equal(messages[0].action.y,300-h.pet.bounds.y);
    await action('hide');assert.equal(h.intervals.filter(Boolean).length,1);
    await h.handlers.get('omni:pet-enable')(primary,true);assert.equal(h.intervals.filter(Boolean).length,2);
    await action('watch-pointer',{enabled:false});assert.equal(h.intervals.filter(Boolean).length,1);
    await action('watch-pointer',{enabled:true});h.app.quit();assert.equal(h.intervals.filter(Boolean).length,0);
  } finally { h.cleanup(); }
});

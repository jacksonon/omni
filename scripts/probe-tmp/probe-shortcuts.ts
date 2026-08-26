/**
 * 探针：Web 快捷键系统纯函数（keyboard-shortcuts-spec.md）。
 *
 * 从 web/app.js 提取 `shortcuts-pure-start/end` 标记内的纯函数块，在 Node 沙箱
 * （stub localStorage / navigator）中直接运行，验证：
 *   A. parseCombo / keyNameFromEvent / comboVariants（平台中立 + ⇧ 上档布局归一化）
 *   B. isModifierOnly / isEditableTarget
 *   C. overrides（localStorage 持久化 round-trip：写入 / 禁用 null / 删除）
 *   D. getBinding（默认键 vs 覆盖 vs 禁用）
 *   E. matchShortcut（裸键编辑态过滤 / 组合键任意焦点生效）
 *   F. findShortcutClash（冲突检测 + 排除自身）
 *   G. formatCombo（macOS ⌘ 系 / 其它平台 Ctrl 系）
 *   H. 注册表完整性（18 个默认键位 + 命令组 push + i18n 键双语齐备）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

/** 内存 localStorage stub */
function makeStore(): { store: Map<string, string>; localStorage: Storage } {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
  return { store, localStorage };
}

function main(): void {
  const src = readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const start = src.indexOf('/* ==== shortcuts-pure-start ====');
  const end = src.indexOf('/* ==== shortcuts-pure-end ====');
  check('纯函数块标记存在', start !== -1 && end !== -1 && end > start);
  if (start === -1 || end === -1) { console.log('probe-shortcuts ✗ 无法提取纯函数块'); process.exit(1); }
  const code = src.slice(start, end);
  const factory = new Function(
    'localStorage', 'navigator',
    code + '\nreturn { parseCombo, keyNameFromEvent, comboVariants, isModifierOnly, isEditableTarget, formatCombo, combosEqual, getShortcutOverrides, setShortcutOverride, getBinding, matchShortcut, findShortcutClash, cheatsheetMatches, PERM_ORDER, GROUP_IDS };'
  );
  const macNav = { platform: 'MacIntel' };
  const winNav = { platform: 'Win32' };
  const M = factory(makeStore().localStorage, macNav);

  console.log('A. 组合键解析与归一化');
  let p = M.parseCombo('Meta+N');
  check('A1 parseCombo Meta+N → mods{Meta} key:n', p && p.key === 'n' && p.mods.has('Meta') && p.mods.size === 1);
  p = M.parseCombo('Shift+Tab');
  check('A2 parseCombo Shift+Tab → key:tab mods{Shift}', p && p.key === 'tab' && p.mods.has('Shift'));
  p = M.parseCombo('Meta+Shift+M');
  check('A3 parseCombo Meta+Shift+M → 双修饰键', p && p.key === 'm' && p.mods.has('Meta') && p.mods.has('Shift'));
  check('A4 parseCombo 裸键 /', (p = M.parseCombo('/')) && p.key === '/' && p.mods.size === 0);
  check('A5 parseCombo 空串 → null', M.parseCombo('') === null);
  check('A6 parseCombo 非字符串 → null', M.parseCombo(undefined) === null);
  check('A7 keyNameFromEvent 字母小写化', M.keyNameFromEvent({ key: 'M', code: 'KeyM' }) === 'm');
  check('A8 keyNameFromEvent 数字', M.keyNameFromEvent({ key: '5', code: 'Digit5' }) === '5');
  check('A9 keyNameFromEvent 标点走 code 映射', M.keyNameFromEvent({ key: '.', code: 'Period' }) === '.');
  check('A10 keyNameFromEvent Slash', M.keyNameFromEvent({ key: '/', code: 'Slash' }) === '/');
  check('A11 keyNameFromEvent 方向键', M.keyNameFromEvent({ key: 'ArrowUp', code: 'ArrowUp' }) === 'ArrowUp');
  check('A12 keyNameFromEvent 空格', M.keyNameFromEvent({ key: ' ', code: 'Space' }) === 'Space');
  let cv = M.comboVariants({ key: 'n', code: 'KeyN', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
  check('A13 comboVariants mac ⌘N → [Meta+n]', cv.length === 1 && cv[0] === 'Meta+n');
  cv = M.comboVariants({ key: 'n', code: 'KeyN', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false });
  check('A14 comboVariants win Ctrl+N → [Meta+n]（平台中立）', cv.length === 1 && cv[0] === 'Meta+n');
  cv = M.comboVariants({ key: '/', code: 'Slash', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true });
  check('A15 ⇧ 上档布局 ⇧7 → [Shift+/, /] 双候选', cv.length === 2 && cv[0] === 'Shift+/' && cv[1] === '/');
  cv = M.comboVariants({ key: 'Tab', code: 'Tab', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true });
  check('A16 ⇧Tab → [Shift+Tab]（非标点无 alt 变体）', cv.length === 1 && cv[0] === 'Shift+Tab');
  check('A18 combosEqual 大小写不敏感（Meta+n ≡ Meta+N）', M.combosEqual('Meta+n', 'Meta+N') && M.combosEqual('/', '/') && !M.combosEqual('Meta+n', 'Meta+m'));
  cv = M.comboVariants({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true });
  check('A17 ⌘⇧, → [Meta+Shift+,, Meta+,] 双候选', cv.length === 2 && cv[0] === 'Meta+Shift+,' && cv[1] === 'Meta+,');

  console.log('B. 修饰键与编辑态判定');
  check('B1 isModifierOnly Meta/Control/Shift/Alt',
    ['Meta', 'Control', 'Shift', 'Alt'].every((k) => M.isModifierOnly({ key: k })) && !M.isModifierOnly({ key: 'a' }));
  check('B2 isEditableTarget INPUT/TEXTAREA/SELECT/contentEditable',
    M.isEditableTarget({ tagName: 'INPUT' }) && M.isEditableTarget({ tagName: 'TEXTAREA' }) && M.isEditableTarget({ tagName: 'SELECT' }) && M.isEditableTarget({ isContentEditable: true }));
  check('B3 isEditableTarget 普通 div / null', !M.isEditableTarget({ tagName: 'DIV' }) && !M.isEditableTarget(null));

  console.log('C. overrides 持久化（localStorage round-trip）');
  const { store, localStorage } = makeStore();
  const Mc = factory(localStorage, macNav);
  Mc.setShortcutOverride(undefined, 'newSession', 'Meta+Shift+N');
  check('C1 写入后可读', Mc.getShortcutOverrides(undefined)['newSession'] === 'Meta+Shift+N');
  check('C2 已落盘到 localStorage', store.get('omni-web-shortcuts-v1') === '{"newSession":"Meta+Shift+N"}');
  Mc.setShortcutOverride(undefined, 'newSession', null);
  check('C3 null = 禁用', Mc.getShortcutOverrides(undefined)['newSession'] === null);
  Mc.setShortcutOverride(undefined, 'newSession', undefined);
  check('C4 undefined = 删除覆盖', !('newSession' in Mc.getShortcutOverrides(undefined)));
  check('C5 损坏 JSON 兜底空对象', Mc.getShortcutOverrides({ getItem: () => '{oops' }) !== null);

  console.log('D. getBinding 默认 / 覆盖 / 禁用');
  const feat = { id: 'newSession', defaultCombo: 'Meta+N' };
  const { localStorage: ls2 } = makeStore();
  const Md = factory(ls2, macNav);
  check('D1 无覆盖用默认键', Md.getBinding(feat, undefined) === 'Meta+N');
  Md.setShortcutOverride(undefined, 'newSession', 'Meta+Shift+N');
  check('D2 覆盖优先', Md.getBinding(feat, undefined) === 'Meta+Shift+N');
  Md.setShortcutOverride(undefined, 'newSession', null);
  check('D3 禁用 → null', Md.getBinding(feat, undefined) === null);
  check('D4 defaultCombo null 的 feature（斜杠命令）→ null', Md.getBinding({ id: 'cmd:/status', defaultCombo: null }, undefined) === null);

  console.log('E. matchShortcut 分发规则');
  const features = [
    { id: 'newSession', defaultCombo: 'Meta+N' },
    { id: 'focusSearch', defaultCombo: '/' },
    { id: 'disabled', defaultCombo: 'Meta+B' },
  ];
  const bindingOf = (f: { id: string; defaultCombo: string | null }) => {
    const o = Mc.getShortcutOverrides(undefined);
    return Object.prototype.hasOwnProperty.call(o, f.id) ? o[f.id] : (f.defaultCombo || null);
  };
  check('E1 组合键在编辑态也命中', M.matchShortcut(features, bindingOf, 'Meta+n', true)?.id === 'newSession');
  check('E2 裸键在编辑态不命中', M.matchShortcut(features, bindingOf, '/', true) === null);
  check('E3 裸键在非编辑态命中', M.matchShortcut(features, bindingOf, '/', false)?.id === 'focusSearch');
  check('E4 无绑定不命中', M.matchShortcut(features, bindingOf, 'Meta+b', false)?.id === 'disabled' && M.matchShortcut(features, bindingOf, 'Meta+x', false) === null);
  const o5 = getOverridesWith(factory, makeStore().localStorage, 'disabled', null);
  const bindingOf5 = (f: { id: string; defaultCombo: string | null }) => (o5[f.id] !== undefined ? o5[f.id] : (f.defaultCombo || null));
  check('E5 禁用后不命中', M.matchShortcut(features, bindingOf5, 'Meta+b', false) === null);

  console.log('F. findShortcutClash 冲突检测');
  check('F1 命中其它已启用绑定', M.findShortcutClash(features, bindingOf, 'focusSearch', 'Meta+n')?.id === 'newSession');
  check('F2 排除自身', M.findShortcutClash(features, bindingOf, 'newSession', 'Meta+n') === null);
  check('F3 无冲突 → null', M.findShortcutClash(features, bindingOf, 'newSession', 'Meta+q') === null);

  console.log('G. formatCombo 展示');
  check('G1 mac Meta+N → ⌘N', factory(makeStore().localStorage, macNav).formatCombo('Meta+N') === '⌘N');
  check('G2 win Meta+Shift+M → Ctrl+Shift+M', factory(makeStore().localStorage, winNav).formatCombo('Meta+Shift+M') === 'Ctrl+Shift+M');
  check('G3 裸键 / → /', M.formatCombo('/') === '/');
  check('G4 ⇧Tab 展示', factory(makeStore().localStorage, macNav).formatCombo('Shift+Tab') === '⇧Tab');
  check('G5 空串 → 空', M.formatCombo('') === '');

  console.log('H. 注册表完整性（源码级）');
  const expectedDefaults: Array<[string, string]> = [
    ['newSession', 'Meta+N'], ['sessionSwitch', 'Meta+K'], ['sessionActions', 'Meta+Shift+A'], ['stopTask', 'Meta+.'],
    ['toggleSidebar', 'Meta+B'], ['focusSearch', '/'], ['cycleTheme', 'Meta+Shift+L'], ['fullscreen', 'Meta+Shift+F'],
    ['scrollTop', 'Meta+ArrowUp'], ['scrollBottom', 'Meta+ArrowDown'], ['copyLastReply', 'Meta+Shift+M'],
    ['copyTitle', 'Meta+Shift+Y'], ['copyId', 'Meta+Shift+U'], ['openModelPanel', 'Meta+M'], ['cyclePermission', 'Shift+Tab'],
    ['openSettings', 'Meta+,'], ['cheatsheet', 'Meta+/'], ['planMode', 'Meta+Shift+P'],
  ];
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
  for (const [id, combo] of expectedDefaults) {
    const re = new RegExp(`id: '${id}'[^\\n]*defaultCombo: '${escRe(combo)}'`);
    check(`H1 注册表 ${id} → ${combo}`, re.test(src), '未在 web/app.js 找到该行');
  }
  check('H2 命令组 push 存在（斜杠命令可录制）', src.includes("SHORTCUT_FEATURES.push({ id: 'cmd:' + c.name"));
  check('H3 旧 ⌘K 新建绑定已移除', !src.includes("const isNew = (e.metaKey || e.ctrlKey)"));
  check('H4 分发器与录制捕获已注册', src.includes("document.addEventListener('keydown', shortcutRecorder, true)") && src.includes("document.addEventListener('keydown', shortcutDispatcher)"));
  const i18nKeys = [
    'settings.shortcuts', 'shortcut.record', 'shortcut.recording', 'shortcut.disabled', 'shortcut.unbound',
    'shortcut.conflict', 'shortcut.restore', 'shortcut.restoreConfirm', 'shortcut.cheatsheetTitle',
    'shortcut.cheatsheetHint', 'shortcut.switchTitle', 'shortcut.switchEmpty', 'shortcut.newSession',
    'shortcut.sessionSwitch', 'shortcut.stopTask', 'shortcut.toggleSidebar', 'shortcut.cycleTheme',
    'shortcut.copyLastReply', 'shortcut.copyTitle', 'shortcut.copyId', 'shortcut.openModelPanel',
    'shortcut.cyclePermission', 'shortcut.openSettings', 'shortcut.cheatsheet', 'shortcut.planMode',
    'shortcut.groupCommands',
  ];
  for (const k of i18nKeys) {
    const count = src.split(`'${k}'`).length - 1;
    check(`H5 i18n ${k} 双语齐备（≥2 处）`, count >= 2, `实际 ${count} 处`);
  }
  const groupCount = (src.match(/group: '([a-z]+)'/g) || []).length;
  check('H6 分组字段存在且覆盖 7 组', groupCount >= 18 + 1, `实际 ${groupCount} 处`);

  console.log('\nI. ⌘/ 速查表可搜索 + 点击跳转设置');
  // 纯函数：id/分组/绑定键/附加文本（功能名+描述）任意命中；多词 AND
  const fNew = { id: 'newSession', group: 'sessions', defaultCombo: 'Meta+N' };
  const fSide = { id: 'toggleSidebar', group: 'view', defaultCombo: 'Meta+B' };
  const fCmd = { id: 'cmd:status', group: 'commands', defaultCombo: null };
  check('I1 按功能 id 命中', M.cheatsheetMatches(fNew, 'newSession', '新建会话'));
  check('I2 按分组命中', M.cheatsheetMatches(fSide, 'view', '切换侧边栏') && !M.cheatsheetMatches(fNew, 'view', '新建会话'));
  check('I3 按绑定键命中（原始 Meta+K 与渲染 ⌘K 都行）', M.cheatsheetMatches({ id: 'sessionSwitch', group: 'sessions', defaultCombo: 'Meta+K' }, 'Meta+K', '会话快速切换') && M.cheatsheetMatches({ id: 'sessionSwitch', group: 'sessions', defaultCombo: 'Meta+K' }, '⌘K', '会话快速切换'));
  check('I4 按附加文本（i18n 功能名/描述）命中 + 大小写不敏感', M.cheatsheetMatches(fSide, 'sidebar', 'Toggle sidebar') && M.cheatsheetMatches(fNew, '新建 会话', '新建会话'));
  check('I5 多词 AND（部分命中不匹配）', M.cheatsheetMatches(fCmd, 'status', '/status 查看会话状态') && !M.cheatsheetMatches(fCmd, 'status model', '/status 查看会话状态'));
  check('I6 空查询全部命中', M.cheatsheetMatches(fNew, '', '任意') && M.cheatsheetMatches(fCmd, '  ', '任意'));
  // 接线：sc-search 输入框在 HTML + input 监听 + 点击跳转函数 + 设置行 data-feature
  const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  check('I7 index.html 有 sc-search 输入框', html.includes('id="sc-search"'));
  check('I8 sc-search input 监听接 openCheatsheet', src.includes("$('#sc-search').addEventListener('input', (e) => { scFilter = e.target.value; openCheatsheet(); })"));
  check('I9 jumpToShortcutSettings 存在且滚动高亮', src.includes('function jumpToShortcutSettings(') && src.includes('sc-highlight'));
  check('I10 速查表行点击跳转接线', src.includes("row.addEventListener('click', () => jumpToShortcutSettings(f.id))"));
  check('I11 设置行带 data-feature 供定位', src.includes("row.dataset.feature = f.id"));
  check('I12 i18n searchPlaceholder/jumpToSettings/noMatch 双语', ['shortcut.searchPlaceholder', 'shortcut.jumpToSettings', 'shortcut.noMatch'].every((k) => (src.split(`'${k}'`).length - 1) >= 2));

  console.log(failCount === 0 ? '\nprobe-shortcuts ✓ 全部通过' : `\nprobe-shortcuts ✗ ${failCount} 项失败`);
  process.exit(failCount === 0 ? 0 : 1);
}

function getOverridesWith(factory: Function, localStorage: Storage, id: string, val: string | null): Record<string, string | null> {
  factory(localStorage, { platform: 'MacIntel' }).setShortcutOverride(undefined, id, val);
  return factory(localStorage, { platform: 'MacIntel' }).getShortcutOverrides(undefined);
}

void main();

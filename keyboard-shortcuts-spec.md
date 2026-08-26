# 功能规格：Web 键盘快捷键系统（侧栏/设置/新建会话/会话切换/主题/权限…）

> 来源：用户需求 —— 「设计并实现快捷键，可以展开收起侧边栏、进入设置界面、创建会话等。你先查一下看看可以有哪些快捷键。」
>
> 本规格基于代码调查 + 四轮用户访谈 + 竞品（ChatGPT / Claude.ai / DeepSeek Harness dsh-shortcuts / opencode）快捷键调研确认。状态：**待实现**（本文件只做设计，不含代码改动）。

---

## 1. 现状调查

### 1.1 已有键盘交互（`web/app.js`）

| 键 | 行为 | 位置 |
|---|---|---|
| `⌘/Ctrl+K` | 新建会话（`sessionRunning()` 时禁用） | 全局 keydown（~2599 行） |
| `/` | 聚焦会话搜索（收起态先展开侧栏）；仅当焦点不在输入框时 | 全局 keydown |
| `Esc` | 逐级关闭：composer popovers → rewind-modal → dirpicker → settings-modal → cmd-panel → cmd-palette → mention-pop → 移动端 `sidebar-open` → 均无时 `cancelCurrentRun()` | 全局 keydown |
| `Enter` / `Shift+Enter` | 发送 / 换行（输入框内） | input keydown（~2561 行） |
| `Enter` / `⌘/Ctrl+Enter`（运行中） | 排队 / steer 打断 | input keydown |
| 输入框内 `/`、`@`、`↑↓`、`Tab`、`Esc` | 斜杠命令联想 / 文件提及导航 | input keydown |

### 1.2 可被快捷键覆盖的动作清单（已核实函数）

- 侧栏切换：`#btn-sidebar-toggle` → `$('#app').classList.toggle('sidebar-collapsed')`（桌面 grid 三列布局）；移动端为 overlay（`sidebar-open`）
- 打开设置：`openSettings()`（`#settings-modal`，左侧 5 分类导航：通用/主题/状态栏/模型配置/关于）
- 新建会话：`newSession()`（`#btn-new` / `#btn-new-brand`）；当前 `⌘K` 绑定带运行中 guard
- 会话选择：`selectSession(id, silent)`（侧栏点击）；会话操作菜单 `showChatActions(e)` / `showSessionActions(e, s)`（分叉 `/fork` / 导出 `/export` / 检查点 `/rewind` / 删除）
- 停止任务：`cancelCurrentRun()`（现状仅 Esc 且需无浮层）
- 主题：`applyTheme(theme)`（`THEME_KEY='omni-web-theme'`，light/dark/system 三态，已持久化 localStorage）
- 模型面板：`openModelPop()` / `closeModelPop()`（`#model-pop`，模型 + 思考级别）
- 权限：`applySettings({ permission })`（read/safe/ask/full，`#permission-pop` 四档）
- 计划模式：`applySettings({ planMode: next })`（`#plan-mode` / `#set-plan` 两个 checkbox 同步，`state.planMode`）
- 斜杠命令：`SLASH_COMMANDS` 30+ 条（`runSlashCommand(cmd)` / `renderCmdPalette`），全部只能输入框 `/` 触发
- 复制：无任何复制快捷键（剪贴板能力缺失）
- 全屏 / 内容区滚动顶底：无

### 1.3 竞品调研结论

| 产品 | 键位 | 备注 |
|---|---|---|
| ChatGPT | `⌘⇧O` 新建、`⌘K` 搜索会话、`⌘⇧S` 侧栏、`⌘⇧F` 全屏、`⌘.` 停止 | `⌘K` = 会话搜索/切换 |
| Claude.ai | `⌘K` 新建/命令面板、`⌘/` 侧栏、`⌘⇧L` 主题 | `⌘K` = 新建 |
| **DeepSeek Harness（dsh-shortcuts 插件）** | `⌘N` 新建、`⌘K` 会话快速切换、`⌘B` 侧栏、`⌘,` 设置、`⌘.` 停止、`⌘⇧L` 主题、`⇧Tab` 权限、`⌘1-9` 模型、`⌘/` 速查表 | 与本界面视觉基线同源；34 预置功能、6 分组、可录制自定义、localStorage 持久化、冲突检测 |
| opencode TUI | `ctrl+x` 前缀键（`ctrl+x n` 新会话、`ctrl+x c` 压缩…） | 终端范式，与 Web 差异大 |

本界面（omni web）是 DeepSeek Harness 视觉基线重构（第一百四十八次），故**跟随 dsh 键位约定**。

---

## 2. 已确认的设计决策（四轮访谈结论）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 范围 | **Web 界面（含 Electron 内嵌页面，同一套 UI）**；TUI 后续再做，注册表架构预留扩展点 |
| D2 | 键位约定 | **跟随 DeepSeek Harness (dsh)**：macOS `⌘` / Win·Linux `Ctrl`（统一 `metaKey \|\| ctrlKey` 判定） |
| D3 | `⌘K` 冲突 | **改 `⌘N` = 新建会话；`⌘K` 改做会话快速切换面板**（对齐 dsh/ChatGPT） |
| D4 | 功能集 | 12 项**全选**：停止任务 / 聚焦搜索 / 主题循环 / 模型面板 / 权限循环 / 计划模式 / 复制回复 / 复制标题 / 复制 ID / 速查表 / 全屏 / 滚动顶底 + **会话操作菜单** |
| D5 | 会话切换 | `⌘K` 快速切换面板：**全部会话（跨工作区）**，输入过滤、↑↓+Enter 选择；**无匹配时 Enter 直接新建**（输入文本作为首条消息） |
| D6 | 模型直选 | **不做 `⌘1-9`**；`⌘M` 打开模型面板 |
| D7 | 发现方式 | **仅 `⌘/` 速查面板**（不做按钮 tooltip 标注、不做文档-only） |
| D8 | 可定制 | **设置页新增「快捷键」tab**：录制 / 清除（Backspace）/ 启用禁用 / 冲突检测 / 恢复默认；`localStorage` 持久化（dsh 同款模式） |
| D9 | 输入时生效 | **`⌘/Ctrl` 组合键在输入框聚焦时照常生效；裸键不触发**（`/`、`⇧Tab` 等聚焦编辑区时不抢焦点） |
| D10 | 弹窗时生效 | **设置等模态弹窗打开时全局快捷键仍生效**；`Esc` 保持现有逐级关闭链（`⌘.` 停止任务无视弹窗） |
| D11 | 主题键行为 | **三态循环 light→dark→system**，切换即保存（复用现有 `THEME_KEY` 持久化） |
| D12 | 权限切换反馈 | **静默切换**（无提示、对话流零污染；权限标签本身随 status 刷新） |
| D13 | 浏览器保留键 | **以 Electron 为准**（应用内自定义菜单可完全拦截）；普通浏览器标签页里系统保留组合（`⌘N`/`⌘T`/`⌘W` 等）无法拦截 → 由设置页重新绑定兜底 |
| D14 | 运行中新建 | `⌘N` 运行中**可用**（Web 已支持多会话并发运行；不打断当前回合） |
| D15 | 移动端 | **不做**（快捷键仅在桌面 grid 布局生效；移动端 `sidebar-open` overlay 不响应 `⌘B`） |
| D16 | 斜杠命令 | **默认不绑键**，但 30+ 条斜杠命令作为「命令」组功能列入设置-快捷键，**用户可自行录制绑定** |
| D17 | 复制键位 | 避开浏览器/DevTools 保留组合：**复制回复 `⌘⇧M`、复制标题 `⌘⇧Y`、复制 ID `⌘⇧U`**（不用 `⌘⇧C/T/I`） |

---

## 3. 详细设计

### A. 快捷键注册表（`SHORTCUT_FEATURES`，单源驱动一切）

放在 `web/app.js`（单文件约定），与 dsh 的 FEATURES 注册表同构——设置页、速查表、冲突检测、持久化、键盘分发全部由注册表自动派生，**新增功能只需加一行**：

```js
const SHORTCUT_FEATURES = [
  // 分组：sessions / view / clipboard / model / permission / system / commands
  { id: 'newSession',   group: 'sessions', labelKey: 'shortcut.newSession',    descKey: 'shortcut.newSessionDesc',
    defaultCombo: 'Meta+N', run: () => newSession().catch((e) => console.error(e)) },
  { id: 'sessionSwitch', group: 'sessions', labelKey: 'shortcut.sessionSwitch', descKey: 'shortcut.sessionSwitchDesc',
    defaultCombo: 'Meta+K', run: toggleSessionSwitch },
  { id: 'sessionActions', group: 'sessions', labelKey: 'shortcut.sessionActions', descKey: 'shortcut.sessionActionsDesc',
    defaultCombo: 'Meta+Shift+A', run: () => { if (state.session) openSessionActionsMenu(null, state.session); } },
  { id: 'stopTask',     group: 'sessions', labelKey: 'shortcut.stopTask',      descKey: 'shortcut.stopTaskDesc',
    defaultCombo: 'Meta+.', run: cancelCurrentRun },
  { id: 'toggleSidebar', group: 'view', labelKey: 'shortcut.toggleSidebar', descKey: 'shortcut.toggleSidebarDesc',
    defaultCombo: 'Meta+B', run: toggleSidebar },
  { id: 'focusSearch',  group: 'view', labelKey: 'shortcut.focusSearch',  descKey: 'shortcut.focusSearchDesc',
    defaultCombo: '/', run: focusSessionSearch },          // 裸键：仅焦点不在编辑区时触发（D9）
  { id: 'cycleTheme',   group: 'view', labelKey: 'shortcut.cycleTheme',   descKey: 'shortcut.cycleThemeDesc',
    defaultCombo: 'Meta+Shift+L', run: cycleTheme },
  { id: 'fullscreen',   group: 'view', labelKey: 'shortcut.fullscreen',   descKey: 'shortcut.fullscreenDesc',
    defaultCombo: 'Meta+Shift+F', run: toggleFullscreen },
  { id: 'scrollTop',    group: 'view', labelKey: 'shortcut.scrollTop',    descKey: 'shortcut.scrollTopDesc',
    defaultCombo: 'Meta+ArrowUp', run: () => scrollMessages('top') },
  { id: 'scrollBottom', group: 'view', labelKey: 'shortcut.scrollBottom', descKey: 'shortcut.scrollBottomDesc',
    defaultCombo: 'Meta+ArrowDown', run: () => scrollMessages('bottom') },
  { id: 'copyLastReply', group: 'clipboard', labelKey: 'shortcut.copyLastReply', descKey: 'shortcut.copyLastReplyDesc',
    defaultCombo: 'Meta+Shift+M', run: copyLastReply },
  { id: 'copyTitle',    group: 'clipboard', labelKey: 'shortcut.copyTitle',    descKey: 'shortcut.copyTitleDesc',
    defaultCombo: 'Meta+Shift+Y', run: copySessionTitle },
  { id: 'copyId',       group: 'clipboard', labelKey: 'shortcut.copyId',       descKey: 'shortcut.copyIdDesc',
    defaultCombo: 'Meta+Shift+U', run: copySessionId },
  { id: 'openModelPanel', group: 'model', labelKey: 'shortcut.openModelPanel', descKey: 'shortcut.openModelPanelDesc',
    defaultCombo: 'Meta+M', run: () => togglePop('#model-pop') },
  { id: 'cyclePermission', group: 'permission', labelKey: 'shortcut.cyclePermission', descKey: 'shortcut.cyclePermissionDesc',
    defaultCombo: 'Shift+Tab', run: cyclePermission },     // 裸键（无 ⌘/Ctrl）：聚焦编辑区不触发（D9）
  { id: 'openSettings', group: 'system', labelKey: 'shortcut.openSettings', descKey: 'shortcut.openSettingsDesc',
    defaultCombo: 'Meta+,', run: openSettings },
  { id: 'cheatsheet',   group: 'system', labelKey: 'shortcut.cheatsheet',   descKey: 'shortcut.cheatsheetDesc',
    defaultCombo: 'Meta+/', run: toggleCheatsheet },
  { id: 'planMode',     group: 'system', labelKey: 'shortcut.planMode',     descKey: 'shortcut.planModeDesc',
    defaultCombo: 'Meta+Shift+P', run: togglePlanMode },   // ⌘⇧P 为实现方提议默认，可重绑
];
// 命令组：SLASH_COMMANDS 每条追加（defaultCombo: null，可录制）
SHORTCUT_FEATURES.push(...SLASH_COMMANDS.map((c) => ({
  id: 'cmd:' + c.name, group: 'commands', labelKey: null, label: c.name, descKey: null,
  desc: c.desc, defaultCombo: null, run: () => runSlashCommand(c.name + ' '),
})));
```

- 组合键用规范字符串存储：`Meta+N` / `Ctrl+Shift+M` / `Shift+Tab` / `/` / `Meta+ArrowUp`；平台无关，展示时 macOS 显示 `⌘`、其余显示 `Ctrl`。
- 纯函数（可单测）：`parseCombo(str)`（→ `{ mods:Set, key }`）、`comboFromEvent(e)`（`e.key` 小写归一化 + `e.code` 兜底标点/方向键；`⇧/` 这类需 Shift 的键按 `e.code` 判定避免布局差异）、`matchCombo(feature, combo)`、`isEditableTarget(el)`（input/textarea/contenteditable/select）。
- `getBindings()`：默认键与 `localStorage['omni-web-shortcuts-v1']` 覆盖合并（`{ [id]: combo | null }`；`null` = 禁用，缺省 = 用默认）。

### B. 全局键盘分发（改造现有全局 keydown）

在现有全局 keydown（~2599 行）之上组合，规则：

1. **纯修饰键按下忽略**（`Meta`/`Ctrl`/`Shift`/`Alt` 单独按下不处理）；`e.repeat` 一律忽略（防长按连发 toggle）。
2. 由 `comboFromEvent(e)` 得到 combo，查 `getBindings()` → 命中 feature：
   - 组合键（含 `⌘`/`Ctrl`）：**任何焦点状态都触发**（D9/D10），`e.preventDefault()` 后 `feature.run()`，`return`。
   - 裸键（`/`、`Shift+Tab`）：`isEditableTarget(document.activeElement)` 时**不触发**（保持原生行为：`/` 进斜杠命令联想、`⇧Tab` 焦点后退）；否则触发。
3. **`Esc` 链保持现有逐级关闭**（新增 `#session-switch-modal`、`#shortcuts-modal` 两个节点并入链尾，位置在 `sidebar-open` 之前）；全部关完且运行中才 `cancelCurrentRun()`。
4. 现有 `⌘/Ctrl+K` 新建绑定**移除**（`⌘K` 改会话切换，D3）；`/` 聚焦搜索逻辑移入注册表 `focusSearch`（裸键，保留「收起态先展开侧栏再聚焦」现有语义）。

### C. `⌘K` 会话快速切换面板（`#session-switch-modal`）

- 居中模态（复用 cmd-panel 视觉风格）：顶部搜索输入框 + 会话列表。
- 数据：`state.sessions`（**全部会话，跨工作区**，D5）；显示标题用现有「首条消息缩略」逻辑（无标题会话不显示「新会话」兜底）。
- 交互：输入即过滤（大小写不敏感，匹配标题）；`↑↓` 移动高亮、`Enter` → `selectSession(id)` 并关闭；**无匹配时 `Enter` → `newSession()` + 以输入文本作首条消息 `doSend(text)`**（D5）；`Esc` 关闭（并入 Esc 链）；鼠标点击同样可选择。`⌘K` 打开/关闭切换；打开时自动聚焦搜索框。

### D. 设置 → 快捷键 pane（D8）

- 设置弹窗左侧导航新增「快捷键」项（新 svg symbol `i-keyboard`），右侧新增 `settings-pane[data-pane="shortcuts"]`。
- 列表按分组渲染全部 feature（含命令组 30+ 斜杠命令），每行：
  - label + desc（i18n）
  - 当前绑定 kbd chip（`⌘N` 样式 / `未绑定` / `已禁用`）
  - 「录制」按钮 + 启用/禁用 checkbox
- **录制流程**：点「录制」→ 该行进入录制态（高亮 + 提示「请按下组合键…」）→ 下一个非纯修饰键 keydown 捕获 → `parseCombo` → **冲突检测**（与其它已启用 feature 比对，重复则 alert 并阻止）→ 写入 overrides → 重渲染；`Esc` 取消录制、`Backspace` 清除绑定（= 禁用）。
- **恢复默认**按钮：confirm 后清空 `localStorage['omni-web-shortcuts-v1']` → 重渲染。
- 持久化键：`omni-web-shortcuts-v1`（dsh 同款命名）。

### E. `⌘/` 快捷键速查面板（`#shortcuts-modal`）

- 居中模态：按分组列出全部 feature + **当前生效绑定**（尊重 overrides/禁用态），底部提示「可在 设置 → 快捷键 重新绑定」。
- `⌘/` 打开/关闭切换；`Esc` 关闭（并入 Esc 链）。
- i18n 中英标题/提示。诊断面板（dsh 的最近按键/权限投影诊断）**不做**（范围外）。

### F. 各功能 `run()` 实现要点

| 功能 | 实现 |
|---|---|
| `newSession` | 直接 `newSession()`（**去掉现状 `if (!sessionRunning())` guard**，D14） |
| `toggleSidebar` | 抽公共 `toggleSidebar()`：`$('#app').classList.toggle('sidebar-collapsed')`（与 `#btn-sidebar-toggle` handler 同逻辑，D15：移动端不响应——handler 内 `if (window.innerWidth <= 760) return` 或按现状仅桌面布局生效） |
| `stopTask` | `cancelCurrentRun()`（无视弹窗状态，D10） |
| `cycleTheme` | 顺序 `['light','dark','system']` 循环：`applyTheme(next)`（复用现有 `THEME_KEY` 持久化，D11） |
| `cyclePermission` | 顺序 `read→safe→ask→full`：`applySettings({ permission: next })` **静默**（D12）；无 `state.status.permission` 时从 read 起 |
| `togglePlanMode` | `const next = !state.planMode; applySettings({ planMode: next })` + 同步 `#plan-mode` / `#set-plan` checked + `updateComposer()`（对齐现有两个 checkbox handler） |
| `openModelPanel` | `togglePop('#model-pop')`（与 `#composer-model` 点击同语义） |
| `copyLastReply` | 取当前会话最后一条助手块文本（DOM：`#messages` 最后一个 assistant 块，或维护 `state.lastAnswerText` 变量随 `answer.chunk` 累积）；`navigator.clipboard.writeText` + `execCommand('copy')` 兜底 |
| `copyTitle` / `copyId` | 从 `state.session` / `state.sessions` 取标题 / id → 剪贴板 |
| `fullscreen` | `document.documentElement.requestFullscreen()` / `document.exitFullscreen()` 切换（`fullscreenchange` 同步状态） |
| `scrollTop` / `scrollBottom` | 内容滚动容器（`.scroll-body`）`scrollTop = 0` / `scrollHeight` |
| `sessionActions` | 抽公共 `openSessionActionsMenu(anchorEl, session)`：`showSessionActions` 重构出锚点参数版（当前 `showSessionActions(e, s)` 用鼠标事件定位菜单，需支持无事件调用，锚点取 `#chat-title` 或居中弹菜单） |
| `focusSearch` | 现状逻辑搬入注册表（收起态先 `remove('sidebar-collapsed')` + 80ms 后聚焦，与 `.session-search` 点击 handler 一致） |

### G. i18n 与样式

- `I18N_ZH` / `I18N_EN` 新增键：`settings.shortcuts`（快捷键）、`shortcut.*`（18 个 feature label/desc + 命令组标题 + 录制/清除/恢复默认/冲突提示/未绑定/已禁用/速查表标题/面板提示等）。
- `web/style.css`：`#session-switch-modal`、`#shortcuts-modal`、`#settings-modal .shortcuts-list` 行布局、kbd chip（`.kbd`：小号等宽 + 圆角底）、录制态高亮、命令组行样式。
- `web/index.html`：settings 导航项 + pane、两个新 modal、`i-keyboard` symbol。

### H. 服务端

**零改动**：会话列表前端已持有（`state.sessions`），⌘K 面板、复制标题/ID 均取前端状态；主题/权限/计划模式走既有 `applySettings` / `applyTheme`。

---

## 4. 兼容与迁移

- `⌘K` 语义变更（新建 → 会话切换）是**唯一行为破坏**；`/` 聚焦搜索、`Esc` 链、输入框 Enter/⌘Enter/斜杠命令联想全部保持。
- 默认键位以 **Electron 为准**（D13）：`⌘N`/`⌘⇧F`/`⌘,` 等在普通浏览器标签页可能被系统拦截 → 用户在设置-快捷键重绑（速查表如实显示当前绑定，不因浏览器拦截而伪装生效）。
- `localStorage['omni-web-shortcuts-v1']` 独立于现有 `omni-web-theme`；缺省（无 key）时全部用默认键位，行为与纯内置版一致。
- 未启用任何快捷键也不影响现有鼠标/键盘交互（注册表 run() 全部复用现有函数）。

---

## 5. 验证计划

1. `node --check web/app.js`；`npm run typecheck`（服务端零改动则纯前端，仍需跑一次确认无泄漏引用）。
2. `npm run probe:web` 回归（SSE/会话/审批链路不受影响）。
3. 新探针 `scripts/probe-tmp/probe-shortcuts.ts`（**纯函数单测**，模拟 KeyboardEvent 形态）：
   - `parseCombo` / `comboFromEvent`：`Meta+N`、`Ctrl+Shift+M`、`Shift+Tab`、`/`（含 ⇧7 布局归一化）、`Meta+ArrowUp`、`Meta+.`（⇧ 变体）各形态；
   - `isEditableTarget`：input/textarea/contenteditable/select/普通 div；
   - 分发规则：组合键在编辑区聚焦时触发、裸键在编辑区不触发、`e.repeat` 忽略、纯修饰键忽略；
   - 注册表完整性：id 唯一、label/labelKey 中英齐全、`defaultCombo` 可解析（`null` 除外）、`run` 存在；
   - overrides：录制写入 → `getBindings` 合并 → 禁用（null）→ 恢复默认清空；冲突检测（同 combo 两个 feature → 拒绝）。
4. `npm run web:sync`（内嵌 `src/web/assets.ts` 同步）。
5. 手动浏览器清单（`npm run dev:web` + Electron 各一遍）：
   - 12+1 个快捷键逐一触发（侧栏/设置/新建/⌘K 选择与无匹配新建/停止/主题三态/模型面板/权限循环/计划模式/复制三件/速查表/全屏/滚动顶底/会话操作菜单）；
   - 设置-快捷键：录制 / Backspace 清除 / 禁用 / 冲突阻止 / 恢复默认 / 刷新后持久化；
   - `⌘K` 面板：过滤、↑↓+Enter、无匹配 Enter 新建发首条、Esc；
   - `⌘/` 速查表显示当前绑定（含自定义）；
   - 回归：输入框内 `/` 斜杠命令联想、`@` 提及、`Enter/⌘Enter` 发送/打断、`Esc` 逐级关闭链、普通浏览器标签页下系统保留键被拦截后重绑生效。
6. 回归 `npm run eval:mock`；`npm run build` 产物冒烟（Electron 壳走内嵌 assets 需 web:sync 后构建）。

---

## 6. 范围外 / 已知限制 / 决策记录

- **TUI 快捷键**：后续做（D1）；注册表 `SHORTCUT_FEATURES` 结构（id/group/label/desc/defaultCombo/run）天然可被 TUI 复用，但本期不做。
- **移动端**：不做（D15）；`⌘B` 在窄屏不展开 overlay 侧栏。
- **按钮 tooltip 标注**：不做（D7 只选速查面板）。
- **`⌘1-9` 模型直选**：不做（D6）。
- **浏览器保留键**：普通标签页无法拦截 `⌘N`/`⌘T`/`⌘W`/`⌘⇧T` 等（D13），以 Electron 为准 + 设置页重绑兜底；速查表不区分「浏览器可拦截」，如实展示绑定。
- **`⇧Tab` 权限循环**：属裸键，输入框聚焦时不触发（D9，走原生焦点后退）；需打字中切权限的用户可在设置页把它重绑为 `⌘⇧` 组合。
- **`⌘/` 非美式键盘**：`/` 键需 Shift 的布局用 `e.code` 归一化（实现要点），速查表显示 `⌘/`。
- **计划模式默认键 `⌘⇧P`**：实现方提议（⌘P 打印被浏览器保留），可在设置页改。
- **复制最后回复**：回答流式未结束时复制的是当前已渲染文本（可接受）；`navigator.clipboard` 在非安全上下文（http://127.0.0.1 例外）可能失败，带 `execCommand` 兜底。
- **Esc 不进入注册表**：保持硬编码逐级关闭链（不提供重绑，避免破坏「Esc 万能关闭」心智）。
- **持久化键** `omni-web-shortcuts-v1`（dsh 同款模式）；未来若做 TUI/多端同步再议。

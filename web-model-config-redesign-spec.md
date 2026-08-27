# Web「设置 → 模型配置」页重设计 Spec

> 状态：✅ 已实现并验证（2026-08-28，浏览器自动化验收通过）
> 来源：2026-08-28 用户访谈（6 轮 ask_user）+ 现有代码走读（`web/index.html` / `web/style.css` / `web/app.js` / `src/web/server.ts` / `src/config/model-context-snapshot.ts`）
> 前置：上一轮已把「组内模型」从折叠卡片改成了二级主从（`55cd27d`），本 Spec 在此之上**整体重排**该页。

---

## 1. 背景与目标

Web 界面「设置 → 模型配置」（`settings-pane[data-pane="apikey"]`）当前布局差、provider 详情存在多处布局异常（裁切/溢出/文字折行/控件回显问题）。用户要求**整页重新设计**，弹窗尺寸保持固定（内部优化），并把**模型能力表（models.dev 快照）**接入——能自动获取的模型列表自动获取、勾选后按本地表数据自动匹配 context 与思考级别。

### 目标

1. 修复所有布局裁切/溢出/折行异常（详见 §3 问题清单）。
2. 重排页面结构，让层级清晰：Provider 选择 → Provider 配置 → 模型管理，一目了然。
3. 适配**大量 provider（>8）与大量模型（>30）**：搜索、过滤、紧凑呈现。
4. 模型能力表联动：编辑表单自动带出/兜底 context 与思考级别档位（标注来源、允许覆盖）。
5. 保持弹窗尺寸（880px 固定），保持现有后端 API 语义，不引入新框架。

### 非目标

- 不改后端存储结构（providers 分组格式不变）。
- 不处理「未分组」扁平旧模型——用户明确「不用考虑过时的结构了」，页面不再展示未分组，也不加迁移提示。
- 不做亮/暗主题专项优化（用户未观察到主题相关问题）。
- 不新增独立「测试连接」按钮（「获取模型列表」已能验证连通性）。

---

## 2. 现状分析（当前结构）

```
settings-pane[data-pane="apikey"]
├─ .settings-pane-title 「模型配置」 + .settings-pane-sub 说明
└─ .providers-layout（flex 1; margin: 14px -26px -26px; border-top）
   ├─ .providers-nav（固定 200px 侧栏）
   │  ├─ #providers-list（.provider-nav-item：图标 + 名称 + 计数）
   │  └─ #btn-provider-new「+ 新建 provider」
   └─ .providers-edit（flex:1; overflow-y:auto）
      ├─ #provider-edit-empty（未选择空态）
      └─ #provider-edit
         ├─ .provider-head（#p-name 输入 / #p-name-static）
         ├─ .settings-group：端点 baseURL / API Key（眼睛显隐）/ User-Agent 三行
         ├─ .provider-actions：获取模型列表 · 删除 · 保存
         ├─ #p-fetch-result（勾选添加）
         ├─ .pm-models-group「组内模型」+ #p-models-count
         └─ .pm-master-detail（上一轮新增）
            ├─ .pm-master：.pm-add-row（#pm-name + 添加）+ #provider-models 列表
            └─ .pm-detail：#pm-detail-empty / #pm-detail-form（选中模型表单）
```

现状痛点根源（走读代码确认）：

- `.providers-layout` 用**负 margin**（`margin: 14px -26px -26px`）实现全出血分栏，与父级 `.settings-content` 的 padding 相互抵消，**任何高度计算偏差都会把内容挤出视口被裁切**（对应问题清单 1/2）。
- `.providers-nav` 固定 200px 侧栏 + `.providers-edit` 右侧所有内容，**横向空间被吃掉**，右侧模型区/徽章/按钮在 880px 弹窗内被挤压（对应 3/4/9）。
- 徽章 `.pm-badge` 等没有 `white-space:nowrap` 与收缩策略，窄容器内**逐字竖排**（对应 3）。
- 标题/帮助文本没有省略号截断与换行策略（对应 4/5/6）。
- 「当前级别」下拉**没有回显兜底**：选项列表为空或当前级别未命中时下拉空白（对应 7）。
- 若干说明浮层（如帮助 tooltip）**无 max-height + 内部滚动 + 防溢出定位**，遮挡左侧表单（对应 2）。

---

## 3. 问题清单（用户访谈逐条记录，按严重度）

### A. 布局裁切类（最严重）

1. **弹窗四边溢出视口被裁切**
   - 顶部：「模型」标签被切掉上半截，只露出字的下半部分。
   - 底部：「继承端点 / 覆盖端点」两个按钮被视口底边切掉一半，基本不可点。
   - 右侧：「gmic-M3」徽章和「添加」按钮贴着/超出右边缘。
   - 根因方向：`.providers-layout` 负 margin + 父容器高度/溢出管理缺失；徽章/按钮无收缩保护。
2. **浮层遮挡左侧表单**：「添加」按钮被说明浮层盖住一半，只剩「添/加」两字竖排挤在极窄条里，文字逐字折行。
   - 根因方向：浮层无 `max-height` + 内部滚动，也无防溢出定位（flip/shift）。

### B. 文字折行 / 截断类

3. **徽章竖排**：标题行的「默认」「gmic-M3」徽章被挤成一字一行竖排（默/认、g/m/i/c…）。
   - 根因：flex 容器宽度不足且徽章没有 `white-space:nowrap` / 收缩策略。
4. **标题换行**：面板标题「MiniMaxAI/MiniMax-M3」折成两行（M3 掉下去）。
   - 根因：标题区未预留宽度/未做省略号截断（缺 `min-width:0` + ellipsis）。
5. **「思考级别选项」值被截断**：输入框里只显示 `low,mediu…`；下方帮助示例 `low,medium,high,xt` 是 `xhigh` 被硬截断成 `xt`——示例文本本身被截断，用户无法照抄格式。
6. **帮助文本排版**：「逗号分隔，如 … 模型只支持这些级别，留空继承全局。」两句话之间缺标点/换行，读起来连成一串。

### C. 控件状态类

7. **「当前级别」下拉框显示为空**：黑色圆角框里没有任何选中值文本，用户看不出当前生效的级别。
   - 根因：默认值未回显或选项列表为空时无占位提示；应接入模型能力表兜底（见 §5）。

### D. 用户明确「不算问题」项

- **apiModel 与显示名重复**（两个字段都显示 MiniMaxAI）——用户判断不算问题，**不做改动**，仅保证新布局中两字段语义说明清晰（apiModel=发请求的真实模型名，显示名=面板友好名）。

### E. 小问题

9. 左上角模型芯片截断可接受，但和右侧被遮的「添加」按钮一起让顶部一行看起来「碎」——新布局统一处理。

---

## 4. 设计决策（含用户「你来定」项的最终决定）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 整体布局方向 | **顶部 Provider 选择条 + 下方主内容（Provider 表单 → 模型管理）**，废除 200px 固定侧栏 | 用户反馈「左右分栏本身不好用」；横向空间全部还给主内容，解决裁切/挤压 |
| Provider 选择控件 | **顶部横向 chip 条**：每个 provider 一个 chip（名称 + 模型计数，可搜索过滤、可横向滚动/换行），+「新建」chip | 数据量大（>8 provider）时比侧栏更省横向、更易扫视；搜索框置于条首 |
| Provider 表单 | 卡片式分节：端点/密钥/UA 用「label 左、输入右」两列行（非现在的整行堆叠），底部操作栏（获取模型列表 · 删除 · 保存） | 行高紧凑、对齐统一 |
| 模型管理 | **表格 + 行内编辑**：列 = 模型名 | apiModel | 默认★ | 思考级别 | context | 操作；常用字段行内直接改，点击行展开高级项（显示名/级别选项/继承·覆盖） | 30+ 模型时表格最紧凑、扫描最快；行内编辑省去「点开表单」；替代上一轮二级主从（用户反馈仍挤） |
| 模型搜索 | 表格上方搜索框，按模型名/apiModel 过滤 | 数据量大必需 |
| 新建 Provider | **就地表单**（保留现状交互）：点「新建」后主区切换为新建表单，保存后进入该 provider | 改动小、流程直接；弹窗内弹窗反而更重 |
| 测试连接 | **不加** | 获取模型列表已能验证连通性 |
| 保存策略 | **显式保存按钮（保持）**，Provider 与模型各自保存；保存成功内联提示 | 防误改、可靠 |
| 能力表联动 | **编辑表单自动补缺 + 标注来源 + 允许覆盖**（见 §5） | 用户强调「用本地表数据匹配 context 和 think level」 |
| 未分组 | **移除**（页面不再展示，不加迁移提示） | 用户明确「不用考虑过时的结构」 |
| 弹窗尺寸 | 保持固定（内部优化） | 用户明确 |

---

## 5. 模型能力表联动（重点）

### 5.1 数据源

现有 `src/config/model-context-snapshot.ts`（models.dev 快照，含每模型 `{c: context 上限, r: 思考级别档位, ro: …}` 与三级匹配逻辑 `model-context.ts`：精确 → 裸 id → 后缀）。这是**服务端**数据；web 前端不直接读。

### 5.2 服务端透出

- 新增/扩展 settings API：`GET /api/settings/model-capabilities?name=<模型名>`（或在现有 `providerDiscover` / `providerModel` 相关响应里附带）。
- 返回 `{ found: boolean, context?: number, effortOptions?: string[] }`，走 `model-context.ts` 同一查表逻辑（`resolveModelContext` 之类，若暂无独立导出则复用它）。
- 模型名带 provider 前缀/组名时按裸 id 匹配（复用现有归一化）。

### 5.3 前端使用（三处）

1. **「当前级别」下拉兜底**：`reasoningEffortOptions` 优先级 = 模型自定义 → provider 级 → **查表档位** → 默认五档 `low,medium,high,xhigh,max`；`reasoningEffort` 回显优先级 = 模型自定义 → provider/全局 → 查表默认档。**保证下拉永不空白**（问题 7）。
2. **编辑表单「上下文」与「思考级别选项」自动补缺**：字段留空时显示查表值的占位（placeholder），并标注「来自 models.dev」小字；用户输入即视为覆盖。
3. **「获取模型列表」勾选添加时**：勾选后添加前，批量按模型名查表，把 `limit.context` / `reasoningEffortOptions` / `reasoningEffort` 自动预填进新模型的编辑表单（未自定义部分），保存后落盘。→ 满足用户「能获取到的自动获取，然后勾选并使用本地表数据匹配 context 和 think level」。

### 5.4 展示标注

- 查表值以占位符 + 灰字「· 来自 models.dev」呈现；用户一旦输入即隐藏标注。
- 不自动改写用户已保存的自定义值（只补缺）。

---

## 6. 目标布局（文字描述 + 草图）

```
┌─ 设置 ────────────────────────────────────────────── 880px ─┐
│ 模型配置                                                   ✕ │
│ 说明文案：配置模型的端点、密钥、推理级别与上下文长度…           │
│ ─────────────────────────────────────────────────────────── │
│ [🔍 搜索 provider…]  [chip: bigmodel ·3] [chip: gmic ·5]   │
│ [chip: MiniMaxAI ·2 …(横向滚动/换行)]        [+ 新建]       │
│ ─────────────────────────────────────────────────────────── │
│ ◆ 当前 Provider：MiniMaxAI                    （编辑中）     │
│ ┌ Provider 配置 ──────────────────────────────────────────┐ │
│ │ baseURL   [ https://api.minimax.chat/v1          ]     │ │
│ │ API Key   [ sk-… ●●●●● ] [👁]                        │ │
│ │ User-Agent[ curl/7.79.1                            ]   │ │
│ │ [获取模型列表]              [删除]  [保存 ✓ 已保存]      │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ◆ 组内模型（5）   [🔍 搜索模型…]   [+ 添加]                  │
│ ┌ 模型表格 ──────────────────────────────────────────────┐ │
│ │ 模型名      apiModel     默认 思考级别  context   操作  │ │
│ │ ▸ MiniMax-M3 MiniMax-M3   ★    medium   128K    ✕     │ │
│ │ ▾ gmic-M3    gmic-M3           high     32K     ✕     │ │
│ │   ├ 显示名 [ gmic-M3 ] 思考级别选项 [low,medium,high…]  │ │
│ │   └ 继承/覆盖 继承端点/覆盖端点  [保存]                  │ │
│ └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
（整个 pane 内容可纵向滚动；顶部 Provider 条固定/吸顶可选）
```

### 6.1 布局要点

- **废除 `.providers-layout` 负 margin 全出血**：改为主内容区正常 padding 内的标准流布局；pane 自身 `overflow-y:auto`，底部留足 padding（修复 1a/1b/1c 裁切）。
- **Provider 选择条**：横向 flex + `flex-wrap`（或横向滚动），chip 带 `white-space:nowrap`、计数徽标、删除角标（hover）；搜索框实时过滤 chip。
- **表单行**：`label(120px) + 输入(flex:1)`，输入框 `min-width:0`，长 URL 不撑破。
- **模型表格**：表头 + 行；行内常用字段直接是输入/下拉/开关；展开行放高级字段；表格容器 `max-height + overflow-y:auto`，表头吸顶（`position:sticky`）。
- **徽章/标题防折行**：所有徽章 `white-space:nowrap; flex:none`；标题/名称 `min-width:0; text-overflow:ellipsis`。
- **浮层规范**：所有说明/帮助浮层统一 `max-height: min(320px, 60vh)` + 内部滚动 + 防溢出定位（开向上方空间不足时翻转），且 `z-index` 不盖住操作区（修复 2）。
- **帮助文本**：补标点/换行，示例不被截断（修复 5/6）——见 §7 i18n。

---

## 7. 详细改动

### 7.1 `web/index.html`

- 重构 `settings-pane[data-pane="apikey"]` 内部结构：
  - `.providers-layout` → `.mc-layout`（正常 padding，`overflow-y:auto`）；
  - 顶部 `.mc-provider-bar`：`#mc-provider-search` 搜索框 + `#mc-provider-chips`（chip 容器，渲染器填充）+ `#btn-provider-new`；
  - `.mc-provider-panel`（原 `#provider-edit` 语义保留）：Provider 配置卡片（表单行改造）+ 操作栏 + `#p-fetch-result`；
  - `.mc-models`：`#mc-model-search` + 添加行（`#pm-name` + `#btn-add-model`）+ `#provider-models` 表格容器；
  - **移除** `#provider-edit-empty` 的空态改为 provider 条空态提示；**移除**「组内模型」旧 `.settings-group` 头部（并入模型区标题）。
- 新 DOM id 前缀 `mc-` 与旧 id 并存映射：`providers-list`→`mc-provider-chips`、`provider-edit`→`mc-provider-panel`、`provider-edit-empty`→`mc-empty`、`provider-models`→保留（改表格渲染）。

### 7.2 `web/style.css`

- 新增 `.mc-*` 样式；删除/停用 `.providers-layout/.providers-nav/.providers-edit/.providers-empty/.pm-master-detail/.pm-master/.pm-detail/.pm-list/.pm-list-row` 中不再使用的部分（保留 `.pm-row/.pm-eff-input/.inherit-toggle/.pm-badge` 复用）。
- 关键约束：
  - pane 内所有滚动容器 `min-height:0`；
  - 徽章 `white-space:nowrap; flex:none`；
  - 文本类 `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`；
  - 表格 `position:sticky` 表头；输入 `min-width:0`；
  - 浮层统一规范（§6.1 末条）。

### 7.3 `web/app.js`

- 状态：`cfgProviderSel / cfgProviderNewName / cfgProviderApiKey` 保留；`cfgModelSel` 改为表格选中行（展开态）。
- 渲染器重构：
  - `renderProvidersNav` → `renderProviderBar(s)`：渲染搜索框过滤后的 chip 列表（名称 + 计数 + 删除角标 + 新建 chip）。
  - `renderProviderEdit` → `renderProviderPanel(s)`：Provider 配置卡片 + 操作栏；**「当前级别」下拉兜底逻辑**（§5.3.1）。
  - `renderProviderModels` → `renderModelTable(s, group, isNew)`：表格行渲染；行内字段（apiModel/思考级别/context）直接绑定；展开行渲染高级字段（显示名/级别选项/继承·覆盖 + 保存）。
  - `fillModelConfigForm` 同步改名/改绑定：`#btn-provider-new`、`#btn-add-model`（添加后自动选中新行并展开）、`#mc-provider-search`/`#mc-model-search` 输入过滤。
- 能力表接入：`fillModelCapabilities(names)` 批量查表 → 填充占位/预填（§5.3）。
- 浮层：帮助 tooltip 统一走浮层组件（max-height + flip）。

### 7.4 `src/web/server.ts`（后端）

- 新增 `GET /api/settings/model-capabilities?name=`（或合并进 `providerDiscover` 响应），返回 `{ found, context, effortOptions }`，复用 `src/config/model-context.ts` 查表逻辑（若无独立导出函数则先抽出 `resolveModelCapabilities(model)` 纯函数，TUI 与 web 共用）。
- `providerDiscover` 响应为每个模型附带 `{ context?, effortOptions? }`（同样查表），供前端勾选添加时直接预填。

### 7.5 `src/web/assets.ts`

- `npm run web:sync` 重新生成内嵌副本（index.html/app.js/style.css 同步后）。

### 7.6 i18n（`web/app.js` I18N_ZH / I18N_EN）

- 新增/调整键：provider 选择条占位（搜索 provider）、模型表格表头（模型名/apiModel/默认/思考级别/context/操作）、来源标注「来自 models.dev」、空态文案（无 provider / 无模型 / 搜索无结果）。
- 修正 `settings.variantsDesc` 帮助文本：两句话之间补句号/换行（修复 6）；确保示例 `low,medium,high,xhigh,max` 不被截断（修复 5，配合布局）。

---

## 8. 获取模型列表流程（新）

1. 点「获取模型列表」→ 调 `providerDiscover`（现有）→ 结果以**紧凑下拉/小面板**呈现（不再占大块区域），带「全选/勾选」。
2. 勾选后点「添加选中」→ 逐个 `providerModel` 落盘（现有语义），**同时**批量调查表 → 对未自定义字段自动预填 context / 思考级别选项。
3. 添加完成后自动选中第一个新模型行并展开其编辑表单，可直接微调后保存。

---

## 9. 边界与兼容

- 后端 providers 格式不变；旧会话/旧文件不受影响。
- 无 provider 时：Provider 条显示空态提示 + 新建 chip 高亮引导。
- 模型名重复添加：沿用现有后端去重/报错语义（`provider.errAdd`）。
- `providerDiscover` 失败/无 baseURL：沿用现有 alert 提示。
- 键盘可达性：chip 可用 Tab 聚焦、Enter 选择；表格行可键盘上下移动、Enter 展开。
- 亮/暗主题：沿用现有 CSS 变量，不专项处理（用户未反馈问题）。
- 搜索过滤大小写不敏感；支持按模型名/apiModel 匹配。

---

## 10. 验收计划（浏览器自动化）

用户指定**浏览器自动化验证**（可用 ego-browser skill / 现有 `npm run dev:web` + mock）：

1. 启动 mock 后端 + `npm run dev:web`，浏览器打开本地 3080 端口。
2. 打开 设置 → 模型配置：
   - 断言无裁切：顶部标题完整、底部「继承/覆盖」可见可点、右侧徽章/按钮不贴边（截图对比，无横向滚动条溢出）。
   - 断言徽章单行、标题省略号不折行。
   - 断言「当前级别」下拉有值（非空）。
   - 断言帮助示例文本完整（`xhigh` 不被截断）。
3. 构造多 provider（≥8）+ 多模型（≥30）的 mock 配置，验证搜索过滤、chip 条滚动/换行、表格滚动 + 表头吸顶。
4. 走「获取模型列表 → 勾选 → 添加」流程，断言新模型自动带出 context / 思考级别（来自 models.dev 表）。
5. 回归：保存 Provider、删除 Provider、设默认、删除模型、行内编辑保存、继承/覆盖切换均可用。
6. 窄屏（≤760px）设置弹窗上下布局下无回归。

---

## 11. 未决问题 / 风险

- **查表函数复用**：`model-context.ts` 当前查询接口是否可直接用于 web 设置（含「按 provider 前缀的模型名」归一化）需实现时确认；必要时抽公共纯函数。
- **表格行内编辑 vs 表单**：行内编辑的保存粒度（每行一个保存按钮 vs 失焦自动保存）——实现时按「显式保存」原则定，倾向每行展开区「保存」按钮。
- **Provider 条吸顶**：是否 sticky 待定（弹窗内整体滚动时吸顶体验更好，但需处理搜索框聚焦）。
- **旧 `settings-providers-spec.md` / `Doc/evolution-log.md`**：实现后需追加一行演进记录，并在 AGENTS.md 相关描述同步。

# 修复规格：Web 输入区拖拽/选择图片与文件 + `+` 号改文件选择器

> 来源：用户需求 ——
> 1. 网页输入区域需要支持拖拽图片、文件（另外需要看 CLI 是否支持拖拽进来的文件图片）；
> 2. 输入区域的 `+` 号按钮，为选择文件、图片按钮，不用额外弹一个 popover 了。
>
> 本规格基于代码调查 + 三轮用户访谈确认。状态：**待实现**（本文件只做设计，不含代码改动）。

---

## 1. 现状调查

- **Web `+` 按钮**（`web/index.html` 96 行 `#btn-attach`）目前打开 `#add-menu` popover（`web/app.js` `renderAddMenu`）：内含「在项目中使用 Work（切换工作区）/ 目标 /goal / 计划模式 / 录制技能」+ 提示「输入 @ 提及文件」——**并非文件选择器**，且 `#add-menu` 里其实没有文件选择/拖拽功能。
- **Web 发送链路**：`doSend(text)`（`web/app.js` 2477 行）→ `POST /api/sessions/:id/messages` 只发纯文本 `{ text }`；服务端 `sendMessage(sid, text)`（`src/web/server.ts` ~440 行，路由 ~1440 行）→ `s.messages.push({ role: 'user', content: prompt })`（字符串）。
- **后端多模态通路已具备**：`src/agent/loop.ts` `messagesHaveImage` 识别 content 数组里的 `image_url` / `input_image` / `image`；1.0 模型层有 `capabilities` / `modalities` 元数据；`buildStatus.models` 已下发到前端。**只差前端采集（拖拽/选择/压缩）+ 消息结构扩展**。
- **CLI**：终端拖文件 = 把文件路径粘贴成文本；现有 `preloadFiles`（`selectRelevantFiles`，`context.ts`）已会自动预载任务文本里出现的文件路径（上限 `preloadMaxFiles` 5、单文件 `preloadMaxBytes` 30KB）。CLI 无原生看图能力（`read_file` 读图是乱码）。

---

## 2. 已确认的设计决策（三轮访谈结论）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 附件语义 | **图片 → 多模态 base64**（`image_url` data URL）；**文本/代码 → 读内容作上下文**（注入用户消息）；**其它二进制 → 插入路径占位符** |
| D2 | 附件展示 | **附件 chips**：输入区附件条（图片缩略图 + 名称/大小），可 `×` 移除，发送时随消息提交 |
| D3 | 多文件 | **支持多选**（一次拖入多个 / 文件选择器 multiple） |
| D4 | `+` 号 popover | **整体移除**（`#add-menu` 删除）；`+` 号 = 纯文件/图片选择器。工作区手动切换（侧栏/设置）、/goal、/plan 走斜杠命令；「录制技能」本就无此功能。用户明确「精简交互，后续再重新设计」 |
| D5 | 图片大小 | **限制 + 前端压缩**：单图 > 4MB 拒绝并提示；canvas 等比缩放长边 ≤1024px 转 JPEG/PNG data URL（控制 base64 体积与上下文占用） |
| D6 | 文本附件 | **注入用户消息 + 30KB 截断**（标注文件名；超限追加「已截断，可用 read_file 定向读取」提示） |
| D7 | 模型兼容 | 拖入图片但当前模型**不支持图片**（`capabilities`/`modalities` 无 image）→ **提示并降级**为路径占位符 |
| D8 | 拖拽区域 | **整个 composer 卡片**可拖放，拖入时高亮边框提示 |
| D9 | CLI | **保持现状**：路径自动预载即够（文本/代码文件拖入即被加载）；不做 CLI 改动 |
| D10 | CLI 图片 | **接受路径局限**：终端无法粘贴二进制，CLI 不做 base64 多模态（需要看图在 Web 端发） |
| D11 | 消息结构 | **扩展 `POST /api/sessions/:id/messages` 接收 `{ text, attachments: [...] }`**，服务端组装 content 数组（含 `image_url` part）或拼接文本，**向后兼容纯文本** |

---

## 3. 详细设计

### A. Web 前端（`web/index.html` + `web/app.js`）

**① `+` 号改文件选择器（D4）**
- `#btn-attach` 点击 → 触发隐藏的 `<input type="file" multiple accept="image/*,text/*,.md,.txt,.json,.js,.ts,.py,…">`（`accept` 宽松：图片 + 常见文本/代码；二进制也可选）。
- 删除 `#add-menu` DOM、`renderAddMenu`、`#btn-attach` 的 popover 打开逻辑、`closeAllComposerPops` 里对 `#add-menu` 的引用（`web/app.js` 1230/2458/2883 行等清理）；`i18n` 的 `composer.attach` 文案改为「选择文件/图片」。

**② 拖拽（D8）**
- composer 卡片（`#composer-card` 或 `#composer-wrap`）监听 `dragover`（`preventDefault` + 加 `.drag-over` 高亮类）/ `dragleave` / `drop`（`preventDefault`，取 `e.dataTransfer.files` 全部）。
- 与选择器共用同一个 `handleAttachFiles(FileList)`。

**③ 附件处理（D1/D5/D6/D7/D3）**
- `state.attachments: []`（`{ id, kind: 'image'|'text'|'path', name, size, dataUrl?, content?, path? }`）。
- 逐文件：
  - **图片**（`type.startsWith('image/')`）：先查当前模型是否支持图片（`state.status.model` 对应的 `models[]` 项 `capabilities.modalities` 含 image / 无 `capabilities` 时按支持处理）；不支持 → 降级为 `kind:'path'`（只存文件名，发送时注入路径文本）+ 提示；支持 → 检查大小 ≤4MB（超限拒绝 + `alert`），否则 `createImageBitmap`/`Image` + canvas 等比缩到长边 ≤1024 → `toDataURL('image/jpeg', 0.85)`（PNG 带透明保留 PNG）→ `kind:'image'`。
  - **文本/代码**（按扩展名白名单或 `FileReader.readAsText` 成功判为文本）：读内容，>30KB（`preloadMaxBytes` 同款 30KB）截断 + 追加截断提示 → `kind:'text'`。
  - **其它二进制**：`kind:'path'`（文件名/占位路径）。
- 附件条渲染：`#attach-list`（composer 内、输入框上方）——图片显示 `<img>` 缩略图，其余显示名称 + 大小；每条 `×` 移除；多文件平铺。

**④ 发送（D11）**
- `doSend(text, attachments)`：`sendMessage()` 收集 `state.attachments` 一并提交：
  ```js
  body: JSON.stringify({ text, attachments: state.attachments.map(a => ({
    kind: a.kind, name: a.name,
    ...(a.kind === 'image' ? { dataUrl: a.dataUrl } : {}),
    ...(a.kind === 'text' ? { content: a.content } : {}),
    ...(a.kind === 'path' ? { path: a.name } : {}),
  })) })
  ```
- 发送成功后清空 `state.attachments`。
- 仅附件无文本（text 为空但有 image/text 附件）→ 允许发送（`sendMessage` 的空判改为「text 或 attachments 任一非空」）。

**⑤ i18n**：新增中英键——`composer.attachFiles`（选择文件/图片）、`attach.remove`、`attach.imageTooLarge`（图片超过 4MB 上限）、`attach.modelNoImage`（当前模型不支持图片，已转为路径）、`attach.truncated`（已截断，可 read_file 定向读取）等。

### B. 服务端（`src/web/server.ts`）

**① `sendMessage(sid, text, attachments?)` 扩展（D11）**
- 新增可选第三参 `attachments: { kind: 'image'|'text'|'path'; name?: string; dataUrl?: string; content?: string; path?: string }[]`。
- 组装用户消息 content：
  - 无附件 → 现状 `{ role: 'user', content: prompt }`（字符串，完全向后兼容）。
  - 有附件 → **content 数组**：
    - 每张图片 → `{ type: 'image_url', image_url: { url: dataUrl } }`；
    - 每个文本 → `{ type: 'text', text: '【附件：<name>】\n<content>' }`；
    - 每个路径占位 → `{ type: 'text', text: '[附件：<name>（二进制/不支持，路径已提供，可用 read_file 读取）]' }`；
    - 末尾拼接用户输入的 `text`（若有）为 `{ type: 'text', text }`。
  - `prompt` 变量（UserPromptSubmit hook）保持对 `text` 生效；hook 改写的是文本部分，附件 part 原样保留（附件在 hook 后追加，避免 hook 处理 base64）。
- 校验：`dataUrl` 以 `data:image/` 开头且长度上限（如 ≤8MB 防超长 body）；非法附件静默丢弃。

**② 会话持久化**：content 数组经 `isPersistable`（非 string 返回 true）照常落盘，`appendSessionMessages` / `loadSession` / `persistableMessages` 无需改动。**注意**：base64 图片会显著增大 JSONL 体积（见第 5 节已知限制）。

**③ 历史恢复渲染（最小支持）**：`web/app.js` `renderSessionHistory` 与 `userBlock` 目前对数组 content 显示空——扩展：数组 content 里 image part 渲染为缩略 `<img>`（data URL）或「[图片]」占位，text part 拼回正文。这是本次的**最小渲染**（保证恢复的会话仍能看到发过的图），不做完整富文本。

### C. CLI（D9 / D10）

- **零代码改动**。终端拖入文件 = 路径文本进输入行，`preloadFiles` 已自动预载路径出现的文本/代码文件；图片接受路径局限（模型拿到路径后可自行判断，read_file 读文本类文件可用）。
- 验证项：确认拖入文本路径后 `prepareContext` 注入 `[已按任务预载` 脚手架（现状行为），在验证计划中回归确认即可。

---

## 4. 边界与兼容

- **纯文本发送完全兼容**：`{ text }` 不带 attachments 时走原字符串路径，消息格式、落盘、恢复、跨会话 `/send` 均不变。
- **多模态内容数组**：loop `messagesHaveImage` 已识别；`stripNonStandardFields` 对数组 content 原样保留；`requestMessages` 的 `estimateContextTokens` 对数组 content `JSON.stringify` 估算——无需改动。
- **图片只在 Web 端**：CLI 无 base64 多模态（D10）。
- **popover 移除影响**：工作区切换入口仍在侧栏/设置；/goal、/plan 走斜杠命令；`#add-menu` 相关 CSS/JS 清理干净（`closeAllComposerPops`、popover 互斥逻辑）。

---

## 5. 验证计划

1. `npm run typecheck`
2. 前端改动后 `node --check web/app.js`；`npm run web:sync`（内嵌 assets 同步）；`npm run probe:web` 回归（消息发送链路不变）。
3. 新探针（`scripts/probe-tmp/`）：
   - `probe-attach-api.ts`：`sendMessage` 各形态——纯文本（字符串 content）/ 图片（content 数组含 `image_url` data URL）/ 文本附件（`【附件：name】` part）/ 路径占位 / text+附件混合 / 非法 dataUrl 拒绝；落盘后 `loadSession` 能读回 content 数组；`messagesHaveImage` 判定。
   - 前端逻辑（纯函数提取：`isTextFile(name)`、`truncateText`、`compressImage` 用 node 侧 canvas 替代或断言降级分支）。
4. 手动/浏览器验证：composer 拖入图片 → 缩略图 chip → 发送 → SSE 收到 image 消息 → 模型回答；模型不支持图片 → 降级提示；>4MB 拒绝；多文件；`×` 移除；纯文本回归。
5. CLI 回归：`npm run eval:mock` + 手动确认拖入文本路径自动预载。

---

## 6. 范围外 / 已知限制 / 决策记录

- **base64 图片撑大会话 JSONL**：data URL 原样落盘（恢复/续跑需要完整图片上下文）。已知权衡；后续可改为服务端附件缓存（`.omni/attachments/<id>.png` + content 里引用相对路径），本次不做。
- **CLI 图片多模态**：不做（D10）。
- **附件条拖拽排序 / 粘贴（Ctrl+V 图片）**：本次不做（用户明确精简交互，后续重新设计时再议）。
- **popover 里的功能不迁移**：工作区/目标/计划模式走既有入口（D4）。
- **历史恢复的图片渲染为最小占位**：不做完整富文本（第 3 节 B-③）。

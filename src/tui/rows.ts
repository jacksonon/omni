/**
 * TUI 内容行构建：状态 → 全部内容行（buildBody）→ 可见窗口（computeRows）。
 *
 * 从 render.ts 拆出（业务划分）：纯函数行构建与滚动数学独立成层（不依赖
 * OpenTUI renderable），render.ts 只做挂载/重绘/事件编排。行式渲染的核心
 * 折行数学在 layout.ts，主题取色在 theme.ts。
 */
import {
  cardBottomLine,
  cardContentLine,
  cardInnerWidth,
  cardTitleLine,
  toolCardLines,
  wrapText,
  type DiffHalfKind,
  type ToolCardLine,
  type ToolCardRole,
} from '../output/format.js';
import { markdownToRows, type MdChunk } from './markdown.js';
import { CONTENT_PAD, STREAM_CURSOR, formatCompact, formatToolDur, wrapChunks, wrapRow, wrapUserLine } from './layout.js';
import { isLightTheme, themeColor, themeFor, type TuiTheme } from './theme.js';
import { SPINNER_FRAMES, type CmdPanel, type StatuslinePanel, type TuiLineKind, type TuiMenu, type TuiState, type ToolStatus } from './state.js';

/** 行样式（对应 createTextAttributes 的字段） */
export interface RowStyle {
  dim?: boolean;
  bold?: boolean;
  fg?: string;
  bg?: string;
}

/** 每种内容行的展示样式：思考浅色、警告黄、用户蓝加粗、任务青加粗、meta 浅色 */
export function rowStyle(kind: TuiLineKind): RowStyle {
  switch (kind) {
    case 'thinking':
    case 'tokens':
      return { dim: true };
    case 'warn':
      return { fg: 'yellow' };
    case 'user':
      return { fg: 'blue', bold: true };
    case 'task':
      return { fg: 'cyan', bold: true };
    case 'meta':
      return { dim: true };
    default:
      return {};
  }
}

export interface Row {
  text: string;
  style: RowStyle;
  /** 行内样式片段（answer 行走 Markdown 渲染时存在；否则用整行 style） */
  chunks?: MdChunk[];
  /** 所属工具卡片的 id（用于点击命中判定；非卡片行为 undefined） */
  cardId?: number;
  /** 所属思考行的下标（折叠态下可点击单独展开/收起；非思考行为 undefined） */
  thinkingIdx?: number;
  /** 所属 token 统计模块的行下标（tokens 行点击展开/收起；非 tokens 行为 undefined） */
  tokensIdx?: number;
  /** 审批卡片的 id（state.approval；点击「批准/拒绝」区域用） */
  approvalId?: number;
}

/**
 * 工具卡片块底色 + 文字色：按执行状态取色——成功 → 淡绿底深绿字、
 * 失败 → 淡红底深红字、执行中 → 超淡黄底深棕字（用户要求「执行成功淡绿色背景，
 * 执行异常淡红色背景」；两主题统一）。
 */
function toolCardColors(status: ToolStatus, theme: TuiTheme): { bg: string; dim: string } {
  if (status === 'ok') return { bg: theme.cardOkBg, dim: theme.cardOkDim };
  if (status === 'err') return { bg: theme.cardErrBg, dim: theme.cardErrDim };
  return { bg: theme.cardBg, dim: theme.cardDim };
}

/** 工具卡片的行样式：命令加粗深色、执行/结果/分隔/输出/提示深色；顶/底为空白留白行 */
function toolRowStyle(role: ToolCardRole, status: ToolStatus, theme: TuiTheme): RowStyle {
  const { dim } = toolCardColors(status, theme);
  switch (role) {
    case 'top':
    case 'bottom':
      // 顶/底留白行：只有底色（块式卡片的垂直边距），无文字样式
      return {};
    case 'cmd':
      // 第一行命令：加粗 + 状态色深字（淡底上默认白字/黑字都不可读，统一深色）
      return { bold: true, fg: dim };
    case 'exec':
    case 'result':
    case 'sep':
    case 'out':
    case 'hint':
      // 状态色深字：与底色（淡绿/淡红/淡黄）协调
      return { fg: dim };
    case 'diff':
      // diff 行颜色按半列/整行在 toolCardRow 里逐 chunk 指定（红=删除、绿=新增）
      return {};
    default:
      return {};
  }
}

/**
 * 工具卡片行（块式）：不再用 ╭─╮│╰╯ 边框——整行以状态底色（成功淡绿/失败淡红/
 * 执行中超淡黄）填充成色块（用户要求「代码执行使用有颜色背景区域的块，而不是用
 * 一个边框」），文字按角色着色（命令加粗、执行/结果/输出状态色深字）。每行已由
 * toolCardLines 补齐到内容宽度，背景色填满整行，多行拼成完整色块。
 *
 * **完整长方形**（用户要求「不要缺角」）：顶/底留白行也整行状态底色填满——
 * 不再是左右角透明的圆角块，四角直角、无缺口。
 *
 * diff 行（write_file 左右对比）：按 ToolCardLine.diff 的左右两半**逐 chunk 着色**
 * ——删除半列红、新增半列绿、未改动半列状态深字，中间 `│` 分隔；整行色（新增
 * 文件全文，diffRole='add'）整行绿色。
 */
function toolCardRow(line: ToolCardLine, status: ToolStatus, theme: TuiTheme): Row {
  const { bg } = toolCardColors(status, theme);
  if (line.role === 'top' || line.role === 'bottom') {
    // 完整长方形：整行状态底色填满（text 为全空格，长度 == 列数），无透明角
    const w = Math.max(3, line.text.length);
    const chunks: MdChunk[] = [{ text: ' '.repeat(w), bg }];
    return { text: line.text, style: {}, chunks };
  }
  if (line.diff) {
    // 左右对比：左半（删除红/未改动深色）+ `│` 分隔 + 右半（新增绿/未改动深色）
    const { left, lk, right, rk } = line.diff;
    const halfStyle = (k: DiffHalfKind): RowStyle =>
      k === 'rem' ? { fg: theme.diffRem } : k === 'add' ? { fg: theme.diffAdd } : { fg: theme.cardDim };
    const lc = halfStyle(lk);
    const rc = halfStyle(rk);
    const chunks: MdChunk[] = [
      { text: ` ${left}`, ...lc, bg },
      { text: '│', fg: theme.cardDim, bg },
      { text: right, ...rc, bg },
    ];
    return { text: line.text, style: {}, chunks };
  }
  if (line.diffRole) {
    // 整行 diff 色（新增文件全文：绿色）
    const fg = line.diffRole === 'add' ? theme.diffAdd : theme.diffRem;
    const chunks: MdChunk[] = [{ text: line.text, fg, bg }];
    return { text: line.text, style: {}, chunks };
  }
  const contentStyle = toolRowStyle(line.role, status, theme);
  const chunks: MdChunk[] = [{ text: line.text, ...contentStyle, bg }];
  return { text: line.text, style: {}, chunks };
}

/**
 * 命令面板的行（圆角方框，复用工具卡片边框）：
 *
 *   ╭─ 主题 ────────────╮
 *   │ › 跟随系统 ✓      │   ← 当前值 ✓，高亮项 ›
 *   │   亮色            │
 *   │   深色            │
 *   │ ↑/↓ 选择 · Enter 确认 · Esc 取消 │
 *   ╰───────────────────╯
 */
export function menuPanelRows(menu: TuiMenu, contentWidth: number): Row[] {
  const inner = cardInnerWidth(contentWidth);
  const rows: Row[] = [{ text: cardTitleLine(menu.title, '', inner), style: { fg: 'cyan' } }];
  menu.options.forEach((opt, i) => {
    const cursor = i === menu.selectedIndex ? '› ' : '  ';
    const check = opt.value === menu.currentValue ? ' ✓' : '';
    rows.push({
      text: cardContentLine(`${cursor}${opt.label}${check}`, inner),
      style: i === menu.selectedIndex ? { fg: 'cyan', bold: true } : {},
    });
  });
  rows.push({ text: cardContentLine('↑/↓ 或数字选择 · Enter 确认 · Esc 取消', inner), style: { dim: true } });
  rows.push({ text: cardBottomLine(inner), style: { dim: true } });
  return rows;
}

/**
 * 命令输出面板行（所有 / 命令的独立窗口）：圆角方框 + 标题 + 输出行 + 滚动提示。
 * 内容行按面板宽折行（每行恰好 1 个终端行，边框不被撑破），超高时垂直滚动
 * （panel.scroll 由交互层 ↑/↓ 调整，这里 clamp 到合法区间并回写）。
 */
export function cmdPanelRows(panel: CmdPanel, contentWidth: number, viewportHeight: number): Row[] {
  const inner = cardInnerWidth(contentWidth);
  // 可见主体行数：视口减标题 1 + 提示 1 + 底边 1（面板居中，上下留白）
  const maxVisible = Math.max(2, viewportHeight - 6);
  // 长行折行成多行（内容完整可滚动查看，不截断）；源行之间不插空行（保持紧凑）
  const body: string[] = [];
  for (const raw of panel.lines) {
    for (const seg of wrapText(raw, inner - 1)) body.push(seg);
  }
  const total = body.length;
  const scroll = Math.min(Math.max(0, panel.scroll), Math.max(0, total - maxVisible));
  panel.scroll = scroll;
  const visible = body.slice(scroll, scroll + maxVisible);
  const rows: Row[] = [{ text: cardTitleLine(panel.title, '', inner), style: { fg: 'cyan' } }];
  if (visible.length === 0) rows.push({ text: cardContentLine('（无输出）', inner), style: { dim: true } });
  for (const t of visible) rows.push({ text: cardContentLine(t, inner), style: {} });
  const remain = total - (scroll + maxVisible);
  rows.push({
    text: cardContentLine(remain > 0 ? `↑↓ 滚动 · Esc 关闭（还有 ${remain} 行）` : 'Esc 关闭', inner),
    style: { dim: true },
  });
  rows.push({ text: cardBottomLine(inner), style: { dim: true } });
  return rows;
}

/**
 * 工具调用审批卡片（安全护栏）：`state.approval` 非空时渲染。
 * 与工具卡片同款圆角方框：标题行 `╭─ 需要审批 ─╮` + 工具/原因 + 批准/拒绝按钮行。
 * 点击左侧区域批准、右侧区域拒绝（approvalId 标记整卡，startTui 按点击 x 列判定）；
 * 键盘：y/Enter 批准、n/Esc 拒绝（interactive.ts 在 state.approval 时拦截）。
 */
export function approvalPanelRows(
  approval: { tool: string; summary: string; reason: string },
  contentWidth: number
): Row[] {
  const inner = cardInnerWidth(contentWidth);
  const rows: Row[] = [{ text: `╭${'─'.repeat(inner)}╮`, style: { fg: 'yellow' } }];
  rows.push({ text: cardContentLine(`需要审批：${approval.tool}`, inner), style: { bold: true } });
  rows.push({ text: cardContentLine(approval.summary, inner), style: { dim: true } });
  rows.push({ text: cardContentLine(`原因：${approval.reason}`, inner), style: { dim: true } });
  rows.push({
    text: cardContentLine('[y] 批准    [n] 拒绝（Enter/Esc 同）', inner),
    style: { bold: true },
  });
  rows.push({ text: cardBottomLine(inner), style: { fg: 'yellow' } });
  return rows;
}

/**
 * 状态行设置面板（/settings statusline）：圆角方框 + 勾选列表（✓/☐）+ 排序操作提示。
 * 与菜单面板（menuPanelRows）同款边框结构，渲染在菜单浮层（menuOverlay）里——
 * 独立于会话流。高亮项 › 青色加粗；勾选 ✓ / 未勾选 ☐；←/→ 调整顺序。
 */
export function settingsPanelRows(panel: StatuslinePanel, contentWidth: number): Row[] {
  const inner = cardInnerWidth(contentWidth);
  const rows: Row[] = [{ text: cardTitleLine('设置：状态行', '', inner), style: { fg: 'cyan' } }];
  for (let i = 0; i < panel.items.length; i++) {
    const it = panel.items[i]!;
    const cursor = i === panel.selected ? '› ' : '  ';
    const check = it.enabled ? '✓' : '☐';
    rows.push({
      text: cardContentLine(`${cursor}${check} ${it.label}`, inner),
      style: i === panel.selected ? { fg: 'cyan', bold: true } : {},
    });
  }
  rows.push({
    text: cardContentLine('空格 勾选/取消 · ←/→ 排序 · Enter 保存生效 · Esc 取消', inner),
    style: { dim: true },
  });
  rows.push({ text: cardBottomLine(inner), style: { dim: true } });
  return rows;
}

/** 状态 → 全部内容行（未裁剪窗口），每行已按内容宽度折行（不截断） */
export function buildBody(state: TuiState, width: number): Row[] {
  const theme = themeFor(state);
  const body: Row[] = [];
  // 会话标题不显示在信息流里——首轮对话后由模型自动生成，改设为终端窗口/标签页标题
  // （setTerminalTitle，见 interactive.ts），保持对话流纯净。
  // 内容组间距：thinking / tool（工具卡片）/ other 三类内容组之间留空行。
  //（用户反馈「工具区域附近的思考或回答不要紧贴」）：工具卡片上方/下方与思考、回答
  // 之间都插空行；连续 thinking 段落之间不加；**每次工具执行之间也留 1 行间距**（用户
  // 反馈「每一次工具执行彼此不要合在一起」——同一轮并行调用各自成卡、不同轮多次调用
  // 的卡片不再紧贴，见下方 tool 分支的 cardId 判定）；已有空行不重复插（如 user 消息
  // 自带尾随空行）；**卡片顶/底留白行是卡片的一部分**（cardId 非空，带底色），不视为
  // 分隔空行——切出工具区域时仍要插真正的空行。
  // **所有组间切换统一留 1 行**（含 thinking ↔ 工具卡片——用户反馈「命令执行的块区域和
  // 下面的文字距离太远了」：此前 thinking↔tool 双向 2 行 + 卡片顶/底留白，卡片与下方
  // 思考/回答之间视觉间隔过大，统一收为 1 行）。
  // token 统计模块是独立组（tokens）：回答文本 → 统计模块之间插 1 行间距（用户反馈
  //「token 统计显示位置需要和回答中文本有一点间距，目前贴到一起了」）。
  let prevGroup: 'thinking' | 'tool' | 'tokens' | 'other' | null = null;
  const isRealBlank = (r: Row): boolean => r.text === '' && r.cardId === undefined;
  const pushGap = (rows: number): void => {
    for (let i = 0; i < rows; i++) body.push({ text: '', style: {} });
  };
  for (let li = 0; li < state.lines.length; li++) {
    const line = state.lines[li];
    const group: 'thinking' | 'tool' | 'tokens' | 'other' =
      line.kind === 'thinking' ? 'thinking' : line.kind === 'tool' ? 'tool' : line.kind === 'tokens' ? 'tokens' : 'other';
    if (group !== prevGroup && body.length > 0 && !isRealBlank(body[body.length - 1])) {
      pushGap(1);
    }
    prevGroup = group;
    if (line.kind === 'answer') {
      // 最终回答走行式 Markdown 渲染（加粗/行内代码/代码块/标题/引用/表格/列表/任务清单等）。
      // 传内容宽度：表格按此收缩列宽（超宽截断），每行不折行、对齐不被打断。
      // 亮色模式下把 markdown 的浅色常量（代码块/行内代码/引用/标题 cyan）映射为深色变体，
      // 否则浅底上看不清（用户报告：亮色下 AI 输出白字）。
      for (const md of markdownToRows(line.text, width)) {
        const chunks = md.chunks.map((c) => (c.fg ? { ...c, fg: themeColor(c.fg, theme) } : c));
        body.push(
          ...wrapRow(
            { text: chunks.map((c) => c.text).join(''), style: rowStyle(line.kind), chunks },
            width
          )
        );
      }
      continue;
    }
    if (line.kind === 'tool' && line.card) {
      // 每次工具执行之间留 1 行间距：连续工具卡片（同一轮并行调用各自成卡、不同轮多次
      // 调用）彼此不再紧贴——用户要求「每一次工具执行彼此不要合在一起」。判定锚点是
      // 上一行是否属于另一张卡片（工具卡片的顶/底留白行也带 cardId，天然可判）：
      // cardId 非空且与当前卡不同才插空行——并行多读合并成的同一张卡不重复插，
      // 卡片与思考/回答/用户消息之间的间距已由上方组间距逻辑处理，这里不掺和。
      const lastRow = body[body.length - 1];
      if (lastRow && lastRow.cardId !== undefined && lastRow.cardId !== line.card.id) {
        pushGap(1);
      }
      // 工具调用卡片：颜色背景块（命令/执行缩略/结果缩略），收起/展开由
      // card.expanded 决定（点击切换）。执行中（status=running）时把当前 spinner
      // 帧传进卡片——执行中行只显示动画 loading、**无「执行中…」文字**（用户要求）；
      // 帧由 TuiOutput 的 200ms 定时器推进，无动画（spinnerIndex=-1）时缺省 ⏳。
      const spinner =
        state.spinnerIndex >= 0 ? SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length] : undefined;
      const lines = toolCardLines({ ...line.card, spinner }, width);
      for (const l of lines) {
        body.push({ ...toolCardRow(l, line.card.status, theme), cardId: line.card.id });
      }
      continue;
    }
    if (line.kind === 'user') {
      // 用户消息：每行左侧带蓝色竖粗线（折行后连续，整段消息被竖线框住）
      for (const seg of line.text.split('\n')) {
        body.push(...wrapUserLine(seg, width, theme));
      }
      // 用户消息与后续内容（思考/回答/工具卡片）之间留 1 行间距，
      // 避免用户输入与 AI 思考紧贴（用户反馈距离太近）
      body.push({ text: '', style: {} });
      continue;
    }
    if (line.kind === 'tokens' && line.tokens) {
      // 当次 token 使用统计模块（**可点击展开/收起**，用户要求）：
      //   收起（默认） = 汇总一行 `⚡ N 次 LLM 请求 · 输入 X · 输出 Y · 缓存 Z`
      //   展开 = 汇总 + 每次 LLM 请求一行明细（`LLM 请求：输入 X · 输出 Y · 缓存 Z`），
      //          加起来 = 汇总（同一份 usages 数组累加）。
      // 全部行带 tokensIdx，点击任意行切换展开/收起；/tokens 关闭时不渲染（showTokens）。
      // 数值用 formatCompact（12.3K / 3M），缓存缺省按 0 显示（网关不支持时）。
      if (!state.showTokens) continue; // /tokens 关闭：该行不渲染（数据保留在 state.lines）
      const usages = line.tokens.usages;
      const sum = usages.reduce(
        (a, u) => ({
          prompt: a.prompt + u.prompt,
          completion: a.completion + u.completion,
          cached: a.cached + (u.cached ?? 0),
        }),
        { prompt: 0, completion: 0, cached: 0 }
      );
      const fmt = (n: number): string => formatCompact(n);
      body.push({
        text: `⚡ ${usages.length} 次 LLM 请求 · 输入 ${fmt(sum.prompt)} · 输出 ${fmt(sum.completion)} · 缓存 ${fmt(sum.cached)}`,
        style: { dim: true },
        tokensIdx: li,
      });
      if (line.tokens.expanded) {
        // 展开态：每次 LLM 请求一行明细（输入/输出/缓存；与汇总同源累加），
        // 用 `-` 作列表符号（用户要求「不要显示 1、2、3 这种，使用 - 即可」），
        // 每项开头标明「LLM 请求」说明这一行是什么（用户要求「在开头标明每一项是干嘛的」）
        for (let i = 0; i < usages.length; i++) {
          const u = usages[i]!;
          body.push({
            text: `  - LLM 请求：输入 ${fmt(u.prompt)} · 输出 ${fmt(u.completion)} · 缓存 ${fmt(u.cached ?? 0)}`,
            style: { dim: true },
            tokensIdx: li,
          });
        }
      }
      continue;
    }
    if (line.kind === 'thinking') {
      // 思考模块：**支持点击展开/收起**（用户要求）。每个思考段落是独立模块——
      // 展开态 = 头行（思考中 `⠋ thinking · 实时耗时` / 思考完 `- thinking · 耗时`）
      // + 完整思考内容；收起态 = 一行 `+ thinking`。全部行带 thinkingIdx，点击即切换该段。
      // 全局开关（/thinking）决定默认态：展开（默认）或折叠；两个反例集合记录用户
      // 点击——展开态点 `-`/内容 → 收起（collapsedThinking），折叠态点 `+` → 展开
      // （expandedThinking）。effective = thinkingExpanded ? !collapsed : expanded。
      const expanded = state.thinkingExpanded
        ? !state.collapsedThinking.has(li)
        : state.expandedThinking.has(li);
      if (expanded) {
        // 头行前缀：**思考中（thinkingRunning）→ loading spinner**（`⠋ thinking · 实时耗时`，
        // 用户要求「思考中显示 loading + thinking + time」）；**思考完 → `-`**（`- thinking · 耗时`）。
        // spinner 帧与工具卡片同源（state.spinnerIndex，TuiOutput 200ms 定时器推进）；无帧回退 ⏳。
        const time = line.thinkingMs != null ? ` · ${formatToolDur(line.thinkingMs)}` : '';
        const prefix = line.thinkingRunning
          ? state.spinnerIndex >= 0
            ? SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length]
            : '⏳'
          : '-';
        body.push({ text: `${prefix} thinking${time}`, style: { dim: true }, thinkingIdx: li });
        // 内容为空（onRound 预建头行、chunk 未到）：只显示头行（loading + thinking + 耗时），
        // 不渲染多余的空内容行
        if (line.text) {
          for (const seg of line.text.split('\n')) {
            body.push(...wrapRow({ text: seg, style: rowStyle(line.kind), thinkingIdx: li }, width));
          }
        }
      } else {
        body.push({ text: '+ thinking', style: { dim: true }, thinkingIdx: li });
      }
      continue;
    }
    for (const seg of line.text.split('\n')) {
      body.push(...wrapRow({ text: seg, style: rowStyle(line.kind) }, width));
    }
  }
  // 工具调用审批卡片（安全护栏）：state.approval 非空时追加在内容流末尾（独立卡片）
  if (state.approval) {
    for (const r of approvalPanelRows(state.approval, width)) {
      body.push({ ...r, approvalId: 1 });
    }
  }
  // 命令面板（/theme 等）是绝对定位浮层（menuOverlay），不占用内容流——
  // 会话内容与菜单互不干扰（用户要求 alert 形式，见 mountTree/repaintTree）。
  // 正在流式生成时，在最后一行输出末尾追加光标（代替状态栏“生成中…”文案）
  if (state.generating && body.length > 0) {
    const last = body[body.length - 1];
    if (last.cardId === undefined && last.approvalId === undefined) {
      if (last.chunks && last.chunks.length > 0) {
        // 行式 Markdown：追到最后一个片段的文本（StyledText 渲染用 chunks 而非 text）
        last.chunks[last.chunks.length - 1].text += STREAM_CURSOR;
        last.text += STREAM_CURSOR;
      } else {
        last.text += STREAM_CURSOR;
      }
    }
  }
  return body;
}

/**
 * 状态 → 可见内容行（尾部窗口 + 滚动）。状态栏、灰色块与路径/token 行是独立的
 * renderable，不在这里。
 *
 * 行数预算：根 Box paddingY(2) = 2 行固定（无边框）；
 * 交互模式再占 状态栏间距(1) + 状态栏(1) + 灰色块（输入框 inputLines + 间距 1 + 模型 1，paddingY 0）
 * + 统计行间距(1) + 统计行(1)，即内容区 = 高度 - 10 - inputLines（inputLines=1 时即高度 - 11）；
 * 单次任务模式内容区 = 高度 - 4。
 *
 * 多行输入框自动增高（Enter 发送 / Shift+Enter 换行），inputLines 由 repaintTree
 * 每次从输入框 lineCount 实时同步（蓝色细线同步增高）——输入框变高时内容区预算
 * 同步收缩，灰色块与统计行永远不会被挤出视口。
 *
 * 滚动：scrollTop = null 跟随最新；上滚时显示「内容窗 + 底部提示行」。
 * scrollIntent（按键发出的一次性指令）在此消费，滚动数学集中在这一处。
 */
export function computeRows(
  state: TuiState,
  size: { height: number; width: number },
  opts?: { withInput?: boolean }
): Row[] {
  const { height, width } = size;
  const body = buildBody(state, Math.max(1, (width ?? 80) - CONTENT_PAD));
  // footer 高度预算：输入内容行数(1-5) + 间距 1 + 模型行 1 + 统计行 1（paddingY 0，
  // 灰块低）+ 16px 圆角边框 2 行（rounded border 同色线）；极小高度时不强塞内容行（避免把灰色块挤出视口）
  const inputLines = opts?.withInput ? Math.min(5, Math.max(1, state.inputLines ?? 1)) : 0;
  // 命令联想列表是**独立浮层**（absolute 定位，见 repaintTree）——不占内容流，
  // 内容区预算不再减它的行数（对话不因联想出现而跳动）
  // 待发送消息区（输入框上方小视图）：标题 1 + 最多 4 条 + 超出时「还有 N 条」1 行（空列表 0 行）；
  // 预算同步收缩（灰色块永远完整可见）。
  const pendingCount = state.pending.length;
  const pendingRows =
    opts?.withInput && pendingCount > 0 ? 1 + Math.min(4, pendingCount) + (pendingCount > 4 ? 1 : 0) : 0;
  // 根 Box paddingY(2) 固定；交互模式再占 状态栏间距(1) + 状态栏(1) + 灰色块(inputLines+4，含圆角边框) + 统计行间距(1) + 统计行(1) + 待发送区(pendingRows)
  const cap = Math.max(0, (height ?? 24) - 2 - (opts?.withInput ? 2 + inputLines + 6 + pendingRows : 2));
  const total = body.length;

  // 消费滚动意图（按键/滚轮 → 一次性指令 → 这里换算成 scrollTop）
  if (state.scrollIntent) {
    const { action, lines = 1 } = state.scrollIntent;
    state.scrollIntent = null;
    if (total > cap && cap >= 2) {
      const contentCap = cap - 1; // 上滚模式预留 1 行给提示条
      const maxTop = Math.max(0, total - contentCap);
      const cur = state.scrollTop ?? maxTop;
      const page = Math.max(1, contentCap);
      switch (action) {
        case 'line-up':
          state.scrollTop = Math.max(0, cur - lines);
          break;
        case 'line-down':
          state.scrollTop = cur + lines >= maxTop ? null : cur + lines;
          break;
        case 'page-up':
          state.scrollTop = Math.max(0, cur - page);
          break;
        case 'page-down':
          state.scrollTop = cur + page >= maxTop ? null : cur + page;
          break;
        case 'top':
          state.scrollTop = 0;
          break;
        case 'bottom':
          state.scrollTop = null;
          break;
      }
    }
  }

  if (total <= cap) {
    state.scrollTop = null;
    return body;
  }
  if (state.scrollTop == null) {
    // 跟随最新 + 溢出：窗口顶部加一行提示（否则用户不知道上面还有内容可上滚）
    const contentCap = Math.max(1, cap - 1);
    const visible = body.slice(total - contentCap);
    visible.unshift({
      text: `↑ 上方还有 ${total - contentCap} 行 · 滚轮/PgUp 上滚`,
      style: { dim: true },
    });
    return visible;
  }

  // 上滚模式：内容窗 cap-1 行 + 底部滚动提示行
  const contentCap = Math.max(1, cap - 1);
  const top = Math.min(state.scrollTop, Math.max(0, total - contentCap));
  state.scrollTop = top;
  if (top + contentCap >= total) {
    // 已滚到内容最底（内容收缩等边界情况）→ 回到跟随模式
    state.scrollTop = null;
    return body.slice(total - cap);
  }
  const visible = body.slice(top, top + contentCap);
  visible.push({
    text: `↑ 已上滚 ${total - top - contentCap} 行 · 共 ${total} 行 · End 回到最新`,
    style: { dim: true },
  });
  return visible;
}

/**
 * 卡片屏幕区域（0-based 鼠标事件坐标）。
 *
 * 坐标语义（运行时实测）：OpenTUI 的 MouseEvent.y 是 0-based（SGR \x1b[<0;x;yM
 * 上报的 y 会减 1）。无边框布局下内容行 i 位于 1-based 屏幕行 1 + i
 * （paddingY 1），即事件坐标 y = (1 + i) - 1 = i。
 */
export interface CardRect {
  top: number;
  bottom: number;
}

/**
 * 点击命中判定（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中某张卡片的 y 区间 → 切换该卡片的展开/收起，返回是否命中。
 * y 为 0-based 鼠标事件坐标（内容行 i 位于 y = i，无边框布局）。
 */
export function hitTestCard(state: TuiState, cardRects: Map<number, CardRect>, y: number): boolean {
  for (const [id, rect] of cardRects) {
    if (y >= rect.top && y <= rect.bottom) {
      for (const line of state.lines) {
        if (line.kind === 'tool' && line.card?.id === id) {
          line.card.expanded = !line.card.expanded;
          return true;
        }
      }
      return true; // 命中区间但找不到对应行（状态已清）——仍视为消费这次点击
    }
  }
  return false;
}

/**
 * 思考模块点击命中（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中某条思考行的屏幕 y → 切换该段的展开/收起，返回是否命中。
 * y 为 0-based 鼠标事件坐标（内容行 i 位于 y = i，与卡片同一坐标系）。
 * 思考展开态（头行 + 内容）与折叠态（+ thinking）的行都带 thinkingIdx（thinkingRects
 * 恒有条目）——点击任意思考行即切换：全局展开态 → 收起（collapsedThinking）；
 * 全局折叠态 → 展开（expandedThinking）。两个集合互补，/thinking 切换时清空。
 */
export function hitTestThinking(state: TuiState, thinkingRects: Map<number, number>, y: number): boolean {
  const li = thinkingRects.get(y);
  if (li === undefined) return false;
  if (state.thinkingExpanded) {
    if (state.collapsedThinking.has(li)) state.collapsedThinking.delete(li);
    else state.collapsedThinking.add(li);
  } else {
    if (state.expandedThinking.has(li)) state.expandedThinking.delete(li);
    else state.expandedThinking.add(li);
  }
  return true;
}

/**
 * token 统计模块点击命中（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中某条 tokens 行的屏幕 y → 切换该模块展开/收起（expanded 反置），返回是否命中。
 * y 为 0-based 鼠标事件坐标（与卡片/思考同一坐标系）。收起=汇总，展开=逐次明细。
 */
export function hitTestTokens(state: TuiState, tokensRects: Map<number, number>, y: number): boolean {
  const li = tokensRects.get(y);
  if (li === undefined) return false;
  const line = state.lines[li];
  if (line && line.kind === 'tokens' && line.tokens) line.tokens.expanded = !line.tokens.expanded;
  return true;
}

/**
 * 审批卡片点击命中（纯函数，供 startTui 的鼠标 handler 与快照单测共用）：
 * 命中审批卡片区域返回 true（调用方再按点击 x 列判定 批准/拒绝——左半批准右半拒绝）。
 * y 为 0-based 鼠标事件坐标（与卡片同一坐标系）。
 */
export function hitTestApproval(
  state: TuiState,
  approvalRect: { top: number; bottom: number } | null,
  y: number
): boolean {
  if (!state.approval || !approvalRect) return false;
  return y >= approvalRect.top && y <= approvalRect.bottom;
}

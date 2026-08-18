/**
 * @ 提及文件选择：输入框内容含 @ 时列出候选文件/目录供选择（对标 IDE 的文件提及）。
 *
 * 候选规则（v2：模糊匹配 + 跨目录检索）：
 *   · **空查询**（`@` / `@src/`）：列出当前（或指定）目录顶层条目——保留逐层浏览
 *     （选目录后保留 / 继续进入下一层）；目录排在文件前，名称排序；隐藏文件默认隐藏。
 *   · **非空查询**（`@rend` / `@tuirend`）：从 cwd **递归检索整个项目**（不再一级一级
 *     选择下去）——查询对**相对路径**做大小写不敏感模糊匹配，四级评分：文件名前缀 >
 *     文件名包含 > 路径包含 > fzf 风格模糊子序列（跳过任意字符按序命中）；目录优先、
 *     路径浅优先、名称排序；结果上限 50 条。
 *   · 查询可含目录前缀（`@src/ma` → 只在 src/ 下递归检索）。
 *   · 目录以 / 结尾 —— 选中后保留 / 继续进入下一层；文件插入后加空格结束提及。
 *   · 递归跳过噪音目录（node_modules/.git/dist 等）+ 条目/深度上限，防超大仓库卡顿。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MentionSuggestion } from './state.js';

/** 递归检索时跳过的噪音目录（依赖/产物/版本库等） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'dist', 'build', '__pycache__',
  '.next', '.turbo', 'coverage', '.idea', '.cache', '.DS_Store', 'target', 'vendor',
]);
/** 递归遍历条目上限（防超大仓库每次按键扫描卡顿） */
const MAX_MENTION_WALK = 4000;
/** 候选结果上限（列表可滚动到全部；超出截断，避免渲染/滚动过载） */
const MAX_MENTION_RESULTS = 50;
/** 递归深度上限 */
const MAX_MENTION_DEPTH = 8;

/**
 * 从输入文本与光标位置检测提及。
 *
 * 规则：光标前最后一个 @ 到光标之间为查询；@ 后出现空白（如 `@foo bar`）视为
 * 提及已结束（不弹列表）。返回 @ 下标与查询；无提及返回 null。
 */
export function detectMention(
  text: string,
  cursor: number
): { atIndex: number; query: string } | null {
  if (!text.includes('@')) return null;
  // cursor ≤ 0（setText 后光标可能在 0/未初始化）→ 退化为扫描整段文本
  const end = cursor > 0 ? Math.max(0, Math.min(cursor, text.length)) : text.length;
  const atIdx = text.lastIndexOf('@', Math.max(0, end - 1));
  if (atIdx < 0) return null;
  const query = text.slice(atIdx + 1, end);
  if (/\s/.test(query)) return null; // @ 后出现空白 → 提及已结束
  return { atIndex: atIdx, query };
}

/**
 * 查询 → 模糊匹配评分（大小写不敏感；null = 不匹配）。
 * 0 文件名前缀 / 1 文件名包含 / 2 路径包含 / 3 fzf 风格模糊子序列
 *（跳过任意字符、查询字符按顺序出现即命中——`@tuirend` 命中 `src/tui/render.ts`）。
 */
function mentionScore(query: string, rel: string, name: string): number | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  const r = rel.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  if (r.includes(q)) return 2;
  let i = 0;
  for (const ch of r) {
    if (ch === q[i]) i++;
    if (i === q.length) return 3;
  }
  return null;
}

/** 列出目录顶层条目（空查询：逐层浏览用；目录以 / 结尾，隐藏文件默认隐藏） */
function listTopLevelMentions(baseDir: string, dirPart: string): string[] {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .map((d) => d.name + (d.isDirectory() ? '/' : ''));
  } catch {
    return []; // 目录不存在/无权限 → 无候选
  }
  const filtered = entries.filter((e) => !e.startsWith('.') && !(e.endsWith('/') && SKIP_DIRS.has(e.slice(0, -1))));
  filtered.sort((a, b) => {
    const ad = a.endsWith('/') ? 0 : 1;
    const bd = b.endsWith('/') ? 0 : 1;
    return ad - bd || a.localeCompare(b);
  });
  return filtered.map((e) => (dirPart ? `${dirPart}/${e}` : e));
}

/**
 * 按查询列出候选（返回带目录前缀的路径；目录以 / 结尾）。
 *
 * **空查询**：列出（dirPart 或 cwd）顶层条目——保留逐层浏览能力（选目录后保留 /
 * 继续进入下一层）。**非空查询**：从 baseDir（dirPart 或 cwd）**递归模糊检索整个项目**
 * （跨目录——不用一级一级选择下去）：对相对路径做模糊评分，目录优先 + 路径浅优先 +
 * 名称排序；跳过噪音目录、隐藏文件（查询以 . 开头才显示）、条目/深度上限。
 */
export function listMentionCandidates(cwd: string, query: string): string[] {
  const lastSlash = query.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash) : '';
  const q = query.slice(lastSlash + 1);
  const baseDir = dirPart ? path.resolve(cwd, dirPart) : cwd;
  if (!q) return listTopLevelMentions(baseDir, dirPart); // 空查询：顶层浏览
  // 非空查询：baseDir 下递归模糊搜索（跨目录）
  const showHidden = q.startsWith('.');
  const hits: { rel: string; isDir: boolean; name: string; score: number }[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_MENTION_DEPTH || hits.length >= MAX_MENTION_WALK) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(baseDir, rel) : baseDir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限 → 跳过该分支
    }
    for (const d of entries) {
      if (hits.length >= MAX_MENTION_WALK) return;
      const name = d.name;
      if (!showHidden && name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const score = mentionScore(q, childRel, name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (score !== null) hits.push({ rel: childRel, isDir: true, name, score });
        walk(childRel, depth + 1);
      } else if (d.isFile() && score !== null) {
        hits.push({ rel: childRel, isDir: false, name, score });
      }
    }
  };
  walk('', 0);
  // 评分优先（命中质量）→ 目录优先 → 路径浅优先 → 名称排序
  hits.sort(
    (a, b) =>
      a.score - b.score ||
      (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) ||
      a.rel.length - b.rel.length ||
      a.rel.localeCompare(b.rel)
  );
  return hits
    .slice(0, MAX_MENTION_RESULTS)
    .map((h) => `${dirPart ? `${dirPart}/${h.rel}` : h.rel}${h.isDir ? '/' : ''}`);
}

/**
 * 把选中项插入输入框：替换光标前 @ 后的查询段。
 *
 * 目录（以 / 结尾）：插入 `@path/` 且不加空格——重绘后按新文本继续列出该目录内容
 * （逐层导航）；文件：插入 `@path `（尾空格让提及关闭，可继续输入或 Enter 发送）。
 * 光标移到插入段末尾。读取 input.plainText 而非 state.inputText：按键处理时输入框
 * buffer 已更新（paint 的 state.inputText 可能滞后一帧）。
 */
export function insertMention(
  input: { setText(t: string): void; plainText: string; cursorOffset?: number },
  m: MentionSuggestion,
  sel = m.selected
): void {
  const item = m.items[sel] ?? m.items[0];
  if (!item) return;
  const isDir = item.endsWith('/');
  const text = input.plainText;
  const before = text.slice(0, m.atIndex + 1); // 含 @
  const after = text.slice(m.atIndex + 1 + m.query.length); // @ 后其余部分（保留）
  const sep = isDir ? '' : ' ';
  const newText = before + item + sep + after;
  input.setText(newText);
  try {
    if (typeof input.cursorOffset === 'number') {
      input.cursorOffset = m.atIndex + 1 + item.length + sep.length;
    }
  } catch {
    // 测试环境光标不可用不影响插入
  }
  m.items.length = 0; // 本次插入即消费：重绘前不再引用旧候选
  m.selected = 0;
}

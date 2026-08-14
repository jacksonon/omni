/**
 * @ 提及文件选择：输入框内容含 @ 时列出候选文件/目录供选择（对标 IDE 的文件提及）。
 *
 * 候选规则：
 *   · 只列当前工作目录下的条目（支持一层目录前缀导航：`@src/ma` → src/ 下 ma 开头）；
 *   · 目录排在文件前，名称排序；隐藏文件（. 开头）默认隐藏（查询以 . 开头才显示）；
 *   · 目录以 / 结尾 —— 选中后保留 / 继续进入下一层；文件插入后加空格结束提及。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MentionSuggestion } from './state.js';

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
 * 按查询列出候选（返回带目录前缀的路径；目录以 / 结尾）。查询可为空（列出全部）。
 * 查询含 / 时在对应子目录内过滤（`src/ma` → src/ 下 ma 前缀），返回项带目录前缀。
 */
export function listMentionCandidates(cwd: string, query: string): string[] {
  const lastSlash = query.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash) : '';
  const prefix = query.slice(lastSlash + 1);
  const dir = dirPart ? path.resolve(cwd, dirPart) : cwd;
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((d) => d.name + (d.isDirectory() ? '/' : ''));
  } catch {
    return []; // 目录不存在/无权限 → 无候选
  }
  const showHidden = prefix.startsWith('.');
  const filtered = entries.filter(
    (e) => (showHidden || !e.startsWith('.')) && (!prefix || e.toLowerCase().startsWith(prefix.toLowerCase()))
  );
  filtered.sort((a, b) => {
    const ad = a.endsWith('/') ? 0 : 1;
    const bd = b.endsWith('/') ? 0 : 1;
    return ad - bd || a.localeCompare(b);
  });
  return filtered.map((e) => (dirPart ? `${dirPart}/${e}` : e));
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

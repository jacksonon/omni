/**
 * edit_file：精确字符串替换（对标 opencode/Claude Code Edit 工具）。
 *
 * 核心优势（对比 write_file 整文件覆盖）：
 * · 节省 token：模型只需提供 old_string / new_string，不必把整个文件回传；
 * · diff 更自然：替换的部分天然就是 diff 单元，渲染更直观；
 * · 细粒度撤销：与 write_file 共享 UndoStack——一次 edit 一次撤销记录。
 *
 * 智能匹配策略（模型给的 old_string 不一定 100% 精确）：
 * 1. 严格相等匹配（首选）——找到唯一一处 → 替换；多处命中 → 报错让模型加上下文；
 * 2. 行级缩进容差——若严格匹配 0 处命中，按行 trim 后再匹配（应对模型缩进不对齐）；
 * 3. 仍失败 → 报错并附文件名+行数范围 + 一段原文件预览，让模型自助修复参数。
 *
 * 边界：
 * · 文件不存在 → 报错（与 write_file 互补：edit 是改已有内容）；
 * · 替换后写入空字符串 → 视为删除该段（保留后段）；
 * · new_string 缺省 = 删除 old_string；
 * · old_string 必须**唯一**命中（除非 replace_all=true，明确表示全部替换）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.js';
import { resolvePath } from './util.js';

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    '在已有文件中做精确字符串替换（对标 Claude Code Edit 工具）。' +
    '传入 old_string（要替换的原文，必须在文件中唯一匹配）和 new_string（替换后的内容，缺省 = 删除）。' +
    '比 write_file 更精准：能避免误覆盖、token 更省、撤销粒度更细。' +
    '注意：old_string 必须**唯一**匹配（除非 replace_all=true）；匹配失败时会附带文件预览让你修正参数。' +
    '新建文件请用 write_file。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对或绝对）' },
      old_string: {
        type: 'string',
        description: '要被替换的原文。必须与文件内容**唯一**完全匹配（除非 replace_all=true）。',
      },
      new_string: {
        type: 'string',
        description: '替换后的内容。缺省 = 删除 old_string 所在片段。',
      },
      replace_all: {
        type: 'boolean',
        description: '是否替换全部匹配项（默认 false，只替换唯一匹配；多匹配时设为 true 一次性替换）',
      },
    },
    required: ['path', 'old_string'],
  },
  async execute(args, ctx) {
    const filePath = resolvePath(String(args.path ?? ''), ctx?.cwd);
    const oldStr = String(args.old_string ?? '');
    // null/undefined 都视为"删除该段"（兼容模型显式传 null 触发删除语义）
    const newStr = args.new_string == null ? '' : String(args.new_string);
    const replaceAll = args.replace_all === true;

    if (!oldStr) return `错误：old_string 不能为空`;

    // 读取原文件
    let original: string;
    try {
      original = await fs.readFile(filePath, 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        return `错误：文件不存在：${filePath}\n（新建文件请用 write_file 工具）`;
      }
      return `错误：无法读取文件：${e?.message ?? e}`;
    }

    // 1. 严格匹配：oldStr 在 original 中出现次数
    const exactCount = countOccurrences(original, oldStr);

    let result: string;
    if (exactCount === 0) {
      // 2. 缩进容差：按行 trim 后再匹配
      const relaxed = relaxMatch(original, oldStr);
      if (relaxed.count === 1) {
        // 容差命中：用精确区间替换（保留原缩进）
        result = original.slice(0, relaxed.start) + newStr + original.slice(relaxed.end);
      } else if (relaxed.count > 1) {
        return `错误：old_string 缩进匹配到 ${relaxed.count} 处，无法定位唯一替换点。\n` +
          `请提供更多上下文让 old_string 唯一匹配，或设置 replace_all=true 替换全部。`;
      } else {
        // 3. 完全匹配失败：给模型看文件预览自助修复
        return buildMatchFailureError(filePath, original, oldStr);
      }
    } else if (exactCount === 1 || replaceAll) {
      // 唯一匹配 / 显式全部替换
      // 注意：用 split+join 而非 String.prototype.replace——后者把 `$&` `$1` 等当作特殊 token，
      // 旧路径下用户 new_string 含 `$&` 会被替换成"匹配到的字符串"，行为与直觉相反
      result = original.split(oldStr).join(newStr);
    } else {
      // 严格匹配到多处且未开启 replace_all
      const positions = findAllPositions(original, oldStr);
      return (
        `错误：old_string 匹配到 ${exactCount} 处（位置：${positions.slice(0, 5).map((p) => `L${lineOf(original, p)}`).join('、')}` +
        `${positions.length > 5 ? '…' : ''}）。\n` +
        `请提供更多上下文让 old_string 唯一匹配，或设置 replace_all=true 替换全部 ${exactCount} 处。`
      );
    }

    // 写入（与 write_file 走同一目录创建逻辑）
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, result, 'utf8');

    // 统计改动行数（用于卡片摘要）
    const { add, rem } = diffStats(original, result);
    // diffStats 是行级 LCS 的精确增删数——对"oldStr 是 N 行 + newStr 是 M 行"
    // 整段替换会显示为 +(M-K) −(N-K)（K=未变行），对用户认知偏大。
    // 我们改用"语义化"统计：oldLines 与 newLines 长度差，对外更直观。
    const oldLines = oldStr ? oldStr.split('\n').length : 0;
    const newLines = newStr ? newStr.split('\n').length : 0;
    const isDelete = newStr === '';
    const isReplace = !isDelete;
    const deltaLines = newLines - oldLines; // 净增减
    let action: string;
    if (oldLines === 0) action = '无变化';
    else if (isDelete) action = `删除 · −${oldLines} 行`;
    else if (isReplace)
      action = deltaLines === 0
        ? `修改 · ${oldLines} 行` // 净增 0：纯替换，统计旧行数（旧行=新行）
        : deltaLines > 0
          ? `修改 · +${deltaLines} 行（共 ${oldLines}→${newLines}）`
          : `修改 · ${deltaLines} 行（共 ${oldLines}→${newLines}）`;
    else action = '无变化';
    return `${action}（${Buffer.byteLength(result, 'utf8')} 字节）`;
  },
};

/** 统计 oldStr 在 text 中出现次数（不重叠） */
function countOccurrences(text: string, oldStr: string): number {
  if (!oldStr) return 0;
  let n = 0,
    i = 0;
  while ((i = text.indexOf(oldStr, i)) !== -1) {
    n++;
    i += oldStr.length;
  }
  return n;
}

/** 找出所有匹配位置 */
function findAllPositions(text: string, oldStr: string): number[] {
  const out: number[] = [];
  let i = 0;
  while ((i = text.indexOf(oldStr, i)) !== -1) {
    out.push(i);
    i += oldStr.length;
  }
  return out;
}

/** 给定字符位置，返回所在行号（1-based）；兼容 CRLF（按 \n 计数） */
function lineOf(text: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}

/** 行级 LCS 增删统计（与 format.ts lineOps 等价，工具内自包含不引外部） */
function diffStats(original: string, content: string): { add: number; rem: number } {
  const a = original.split('\n');
  const b = content.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let add = 0,
    rem = 0,
    i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rem++;
      i++;
    } else {
      add++;
      j++;
    }
  }
  while (i < n) {
    rem++;
    i++;
  }
  while (j < m) {
    add++;
    j++;
  }
  return { add, rem };
}

/** 缩进容差匹配：把 text 与 oldStr 都按行 trim 后再匹配。返回首个匹配位置和长度。 */
function relaxMatch(text: string, oldStr: string): { count: number; start: number; end: number } {
  const normOld = oldStr.split('\n').map((l) => l.trim()).join('\n');
  const lines = text.split('\n');
  // 找连续 N 行（=oldStr 行数）trim 后与 normOld 相等的起点
  const oldLines = oldStr.split('\n').length;
  if (oldLines === 0) return { count: 0, start: 0, end: 0 };
  const starts: number[] = [];
  for (let i = 0; i + oldLines <= lines.length; i++) {
    const slice = lines.slice(i, i + oldLines).map((l) => l.trim()).join('\n');
    if (slice === normOld) starts.push(i);
  }
  if (starts.length === 0) return { count: 0, start: 0, end: 0 };
  // 找到首处匹配：start = 起点行首字符位置，end = 终点行末
  const startLine = starts[0];
  let start = 0;
  for (let i = 0; i < startLine; i++) start += lines[i].length + 1; // +1 for \n
  let end = start;
  for (let i = 0; i < oldLines; i++) {
    if (i > 0) end += 1; // 行间 \n
    end += lines[startLine + i].length;
  }
  return { count: starts.length, start, end };
}

/** 匹配完全失败：返回带文件预览的错误，便于模型自助修复 */
function buildMatchFailureError(filePath: string, original: string, oldStr: string): string {
  const lines = original.split('\n');
  // 取 oldStr 第一行（trim 后）所在行作为定位线索
  const firstLine = oldStr.split('\n').find((l) => l.trim())?.trim() ?? '';
  let hintLine = -1;
  if (firstLine) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() && lines[i].includes(firstLine.slice(0, Math.min(40, firstLine.length)))) {
        hintLine = i;
        break;
      }
    }
  }
  const preview = hintLine >= 0
    ? lines.slice(Math.max(0, hintLine - 2), Math.min(lines.length, hintLine + 8)).join('\n')
    : lines.slice(0, 12).join('\n');
  const lineInfo = hintLine >= 0 ? `（参考行 L${hintLine + 1} 附近）` : '';
  return (
    `错误：old_string 在文件中未找到${lineInfo}。\n` +
    `可能原因：缩进/换行/不可见字符不一致；或行数不对。\n` +
    `文件 ${filePath} 共 ${lines.length} 行，old_string 共 ${oldStr.split('\n').length} 行。\n` +
    `请用 read_file 重新查看文件，按真实内容重写 old_string（确保缩进、换行、空白字符完全一致）。\n` +
    `文件预览（行 ${Math.max(0, hintLine - 2) + 1}..${Math.min(lines.length, hintLine + 8)}）：\n` +
    preview
  );
}

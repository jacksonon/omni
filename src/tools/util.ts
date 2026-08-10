/**
 * 工具层公共小工具。
 */
import path from 'node:path';

/** 工具结果返回给模型前的最大字符数（上下文管理第一课：截断） */
export const TOOL_OUTPUT_LIMIT = 8000;

/** 安全地把任意值转成有限数字，非法输入回退到默认值（防模型传 NaN 之类垃圾参数） */
export function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 把工具参数里的路径解析为绝对路径（基于进程 cwd） */
export function resolvePath(p: string): string {
  return path.resolve(process.cwd(), p);
}

/** 对返回给模型的内容统一截断，防止上下文被撑爆 */
export function truncate(s: string): string {
  if (s.length <= TOOL_OUTPUT_LIMIT) return s;
  return s.slice(0, TOOL_OUTPUT_LIMIT) + `\n…（已截断，共 ${s.length} 字符。需要更多请用 read_file 等工具定向获取）`;
}

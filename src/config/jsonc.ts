/**
 * 简易 JSONC 解析：去除行注释与块注释、容忍尾逗号（尽力而为）。
 * 已知限制：注释剥离是正则级的，字符串字面量里出现 "//"、",]" 之类的文本可能被误伤。
 * 注意：行注释只剥离 "//" 前是空白/行首的情况，避免误伤 https:// 这类 URL。
 */
export function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|\s)\/\/.*$/gm, '$1') // 行注释（仅当 // 前是空白或行首，避免误伤 https://）
    .replace(/,\s*([}\]])/g, '$1'); // 尾逗号
  return JSON.parse(stripped);
}

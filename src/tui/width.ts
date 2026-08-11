/**
 * 终端显示宽度工具：CJK 全角算 2 列、emoji 算 2 列、组合/零宽字符 0 列、其余 1 列。
 *
 * render.ts（行折行）与 output/format.ts（工具卡片）共用，避免两处重复实现。
 *
 * ⚠️ 判宽必须与 OpenTUI 内部渲染一致（string-width@7 + emoji-regex@10，见
 * node_modules/@opentui/core 的打包源码）。早期 charWidth 只认 CJK 区间、把 emoji
 * （如 📁）按 1 列算，但 OpenTUI 实际按 2 列渲染——卡片内容行比预算宽 1 列，
 * 右侧边框 `│` 被折行挤到下一行（用户报告的「右侧没框住」/「乱码」根因之一）。
 */

/** emoji-regex@10 在 BMP 上判为 emoji 的码点集合（含 FE0F 可选修饰的那些）。
 * 转录自 OpenTUI 打包的 emoji-regex@10.6.0 主正则；✓(U+2713)/✗(U+2717) 不在其列
 * （1 列），⏳(U+23F3)/⚡(U+26A1)/✏(U+270F)/©(U+A9) 等在其列（2 列）。 */
function isBmpEmoji(c: number): boolean {
  return (
    // 键帽组合符（1️⃣ 等）：按 2 列算，让「数字+FE0F+20E3」合计不欠计
    c === 0x20e3 ||
    c === 0xa9 || c === 0xae || c === 0x203c || c === 0x2049 || c === 0x2122 || c === 0x2139 ||
    (c >= 0x2194 && c <= 0x2199) || c === 0x21a9 || c === 0x21aa ||
    (c >= 0x231a && c <= 0x231b) || c === 0x2328 || c === 0x23cf ||
    (c >= 0x23e9 && c <= 0x23ec) || c === 0x23f0 || c === 0x23f1 || c === 0x23f2 || c === 0x23f3 ||
    (c >= 0x23ed && c <= 0x23ef) || (c >= 0x23f8 && c <= 0x23fa) ||
    c === 0x24c2 ||
    c === 0x25aa || c === 0x25ab || c === 0x25b6 || c === 0x25c0 || c === 0x25fb || c === 0x25fc || c === 0x25fd || c === 0x25fe ||
    (c >= 0x2600 && c <= 0x2604) || c === 0x260e || c === 0x2611 || c === 0x2614 || c === 0x2615 || c === 0x2618 ||
    c === 0x261d ||
    c === 0x2620 || c === 0x2622 || c === 0x2623 || c === 0x2626 || c === 0x262a || c === 0x262e || c === 0x262f ||
    (c >= 0x2638 && c <= 0x263a) || c === 0x2640 || c === 0x2642 ||
    (c >= 0x2648 && c <= 0x2653) || c === 0x265f || c === 0x2660 || c === 0x2663 || c === 0x2665 || c === 0x2666 || c === 0x2668 ||
    c === 0x267b || c === 0x267e || c === 0x267f ||
    c === 0x2692 || c === 0x2693 || (c >= 0x2694 && c <= 0x2697) || c === 0x2699 || c === 0x269b || c === 0x269c ||
    c === 0x26a0 || c === 0x26a1 || c === 0x26a7 || c === 0x26aa || c === 0x26ab || c === 0x26b0 || c === 0x26b1 ||
    c === 0x26bd || c === 0x26be || c === 0x26c4 || c === 0x26c5 || c === 0x26c8 || c === 0x26cf || c === 0x26d1 ||
    c === 0x26d3 || c === 0x26d4 || c === 0x26e9 || c === 0x26ea || // ⛓ / ⛔ / ⛩ / ⛪
    c === 0x26ce || c === 0x26f9 || // ⛎ / ⛹（emoji-regex 单独分支，裸字也 2 列）
    c === 0x2764 || // ❤（emoji-regex 的 ZWJ 分支后缀全可选，裸 ❤ 也 2 列）
    (c >= 0x26f0 && c <= 0x26f5) || c === 0x26f7 || c === 0x26f8 || c === 0x26fa || c === 0x26fd ||
    c === 0x2702 || c === 0x2705 || c === 0x2708 || c === 0x2709 || (c >= 0x270a && c <= 0x270d) || c === 0x270f ||
    c === 0x2712 || c === 0x2714 || c === 0x2716 || c === 0x271d || c === 0x2721 || c === 0x2728 ||
    c === 0x2733 || c === 0x2734 || c === 0x2744 || c === 0x2747 || c === 0x274c || c === 0x274e ||
    (c >= 0x2753 && c <= 0x2755) || c === 0x2757 || c === 0x2763 || c === 0x27a1 ||
    (c >= 0x2795 && c <= 0x2797) || c === 0x27b0 || c === 0x27bf ||
    c === 0x2934 || c === 0x2935 || (c >= 0x2b05 && c <= 0x2b07) || c === 0x2b1b || c === 0x2b1c || c === 0x2b50 || c === 0x2b55 ||
    c === 0x3030 || c === 0x303d || c === 0x3297 || c === 0x3299
  );
}

/** 零宽字符（不占列；与 string-width 的跳过集合一致） */
function isZeroWidth(c: number): boolean {
  return (
    (c >= 0x0300 && c <= 0x036f) || // 组合附加符号
    (c >= 0x1ab0 && c <= 0x1aff) || // 组合扩展
    (c >= 0x1dc0 && c <= 0x1dff) || // 组合补充
    (c >= 0x20d0 && c <= 0x20ff) || // 符号用组合符（0x20e3 键帽除外，已在 isBmpEmoji 里 2 列）
    (c >= 0xfe00 && c <= 0xfe0f) || // 变体选择符（VS16 等）
    (c >= 0xfe20 && c <= 0xfe2f) || // 组合半记号
    (c >= 0x200b && c <= 0x200f) || // ZWSP / ZWNJ / ZWJ / LRM / RLM
    c === 0x2060 || c === 0xfeff // 词连接符 / BOM
  );
}

/** 单个字符的终端显示列数（emoji/CJK 全角 2 列，组合/零宽 0 列，其余 1 列） */
export function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (isZeroWidth(c)) return 0;
  // 增补平面（emoji 如 📁💭、CJK 扩展 B 等，OpenTUI 均按 2 列）或 BMP emoji → 2 列
  if (c >= 0x1f000 || isBmpEmoji(c)) return 2;
  if (
    (c >= 0x2e80 && c <= 0x9fff) || // 部首..CJK 统一表意
    (c >= 0xac00 && c <= 0xd7a3) || // 谚文音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意
    (c >= 0xfe30 && c <= 0xfe4f) || // CJK 兼容形式
    (c >= 0xff00 && c <= 0xff60) || // 全角形式
    (c >= 0xffe0 && c <= 0xffe6) // 全角符号
  ) {
    return 2;
  }
  // 其余 1 列（含代理对单半边：wrapText 等按 UTF-16 码元迭代时每半边 1 列，
  // 成对合计恰 2 列，与按码点迭代的 visualWidth 结果一致）
  return 1;
}

/** 字符串的终端显示宽度（列数） */
export function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** mini 输入块和内联面板共用的页底区域；退出时恢复正文输出位置。 */
export function dockMiniViewport(out: NodeJS.WriteStream, height: number): number {
  const rows = Math.max(1, height);
  const top = Math.max(1, (out.rows || 24) - rows + 1);
  // 正文接近页底时先让终端分配空间，再保存滚动后的正文坐标。
  out.write('\x1b[0m' + '\n\r'.repeat(rows) + `\x1b[${rows}A`);
  out.write(`\x1b7\x1b[${top};1H`);
  return top;
}

export function restoreMiniViewport(out: NodeJS.WriteStream): void {
  out.write('\x1b8\x1b[0m\r\x1b[0J');
}

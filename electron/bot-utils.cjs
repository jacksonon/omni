'use strict';
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';
/** 只接受明确的偏好字段。 */
function normalizeSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const result = {
    shortcut: typeof v.shortcut === 'string' && v.shortcut.trim() && v.shortcut.length <= 120 ? v.shortcut.trim() : DEFAULT_SHORTCUT,
    openAtLogin: v.openAtLogin === true,
    notifications: v.notifications !== false,
  };
  for (const name of ['botBounds', 'fullBounds']) {
    const b = v[name];
    if (b && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k]))) result[name] = Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, Math.round(b[k])]));
  }
  return result;
}
/** 显示器拔插或缩放改变后仍保证窗口完整位于可用区域。compact = 只有输入框的快速窗口。 */
function fitBounds(saved, area, bot, compact = false) {
  const minWidth = compact ? 360 : bot ? 380 : 640;
  const maxWidth = compact ? Math.min(area.width, 720) : area.width;
  const defaultWidth = compact ? 640 : bot ? 720 : 1200;
  const minHeight = compact ? 150 : bot ? 340 : 480;
  const defaultHeight = compact ? 214 : bot ? 640 : 800;
  const width = Math.min(Math.max(saved?.width || defaultWidth, minWidth), maxWidth);
  // compact 是固定高度态：不能被上次展开保存的 640px 覆盖。
  const height = compact
    ? Math.min(Math.max(defaultHeight, minHeight), area.height)
    : Math.min(Math.max(saved?.height || defaultHeight, minHeight), area.height);
  const x = Math.min(Math.max(saved?.x ?? Math.round(area.x + (area.width - width) / 2), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(saved?.y ?? Math.round(area.y + (area.height - height) / 3), area.y), area.y + area.height - height);
  return { x, y, width, height };
}
function isTrustedPage(candidate, serverUrl) {
  try {
    const url = new URL(candidate), server = new URL(serverUrl);
    return url.origin === server.origin && /^\/w\/[a-zA-Z0-9_-]+\//.test(url.pathname);
  } catch { return false; }
}
function workspaceUrl(pageUrl) {
  try {
    const u = new URL(pageUrl), match = u.pathname.match(/^\/w\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    return match ? `${u.origin}/w/${match[1]}` : null;
  } catch { return null; }
}
module.exports = { DEFAULT_SHORTCUT, normalizeSettings, fitBounds, isTrustedPage, workspaceUrl };

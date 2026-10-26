'use strict';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 30 * 1024;

/** 只在明确导入时读取；图片优先，避免网页同时提供 HTML/URL 时重复附加。 */
async function readClipboardPayload(clipboard) {
  const image = await clipboard.readImage();
  if (image && !image.isEmpty()) {
    const png = image.toPNG();
    if (png.length > MAX_IMAGE_BYTES) throw new Error('剪贴板图片超过 4MB，请裁剪后重试。');
    return { kind: 'image', name: '剪贴板图片.png', size: png.length, dataUrl: 'data:image/png;base64,' + png.toString('base64') };
  }
  const text = await clipboard.readText();
  if (!text || !text.trim()) throw new Error('剪贴板中没有可导入的文字或图片。');
  return { kind: 'text', name: '剪贴板文字.txt', size: Buffer.byteLength(text), content: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS };
}

/** 一次只交给页面鼠标所在显示器；平台只返回单个授权来源时使用该来源。 */
function chooseScreenSource(sources, display) {
  const source = sources.find(s => s.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取当前显示器。请检查系统屏幕录制权限，或使用系统截图后粘贴。');
  return source;
}
function captureErrorMessage(error, permission, platform) {
  if (platform === 'darwin' && ['denied', 'restricted', 'not-determined'].includes(permission)) {
    return '尚未获得屏幕录制权限。请在 macOS「系统设置 → 隐私与安全性 → 屏幕录制」检查系统提示的应用，再重新打开 Omni。开发启动可能显示终端或宿主工具，安装版使用 Omni 自身身份；也可以使用系统截图后粘贴。';
  }
  const reason = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : '';
  return `截图失败${reason ? `：${reason}` : '，系统未返回可用的屏幕来源'}。可使用系统截图后粘贴到输入框。`;
}

/** 切工作区仅暂存在主进程内存中，不把剪贴板、截图写入磁盘或浏览器持久存储。 */
function normalizeDraft(value) {
  if (!value || typeof value.text !== 'string' || value.text.length > 100000 || !Array.isArray(value.attachments) || value.attachments.length > 20) throw new Error('草稿过大，无法切换工作区。');
  const draft = { text: value.text, attachments: [] };
  for (const a of value.attachments) {
    if (!a || typeof a.name !== 'string' || a.name.length > 500 || !['image', 'text', 'path'].includes(a.kind)) throw new Error('附件格式无效。');
    const entry = { kind: a.kind, name: a.name, size: Number.isFinite(a.size) ? a.size : 0 };
    if (a.kind === 'image') {
      if (typeof a.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a.dataUrl) || a.dataUrl.length > MAX_IMAGE_BYTES * 1.4) throw new Error('图片附件无效或超过 4MB。');
      entry.dataUrl = a.dataUrl;
    } else if (a.kind === 'text') {
      if (typeof a.content !== 'string' || a.content.length > MAX_TEXT_CHARS + 100) throw new Error('文字附件过大。');
      entry.content = a.content;
    }
    draft.attachments.push(entry);
  }
  if (Buffer.byteLength(JSON.stringify(draft)) > 16 * 1024 * 1024) throw new Error('草稿附件总大小超过 16MB，请减少附件后切换。');
  return draft;
}

module.exports = { MAX_IMAGE_BYTES, MAX_TEXT_CHARS, readClipboardPayload, chooseScreenSource, captureErrorMessage, normalizeDraft };

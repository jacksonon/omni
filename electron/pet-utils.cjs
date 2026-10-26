'use strict';
/** 独立宠物固定尺寸与屏幕边界；不使用聊天窗口的最小宽高。 */
function petBounds(saved, area) {
  const width = Math.min(240, area.width), height = Math.min(286, area.height);
  const x = Math.min(Math.max(Number.isFinite(saved?.x) ? saved.x : area.x + area.width - width - 28, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Number.isFinite(saved?.y) ? saved.y : area.y + area.height - height - 28, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}
function isPetPage(url, connection) {
  try { const value = new URL(url); return value.origin === new URL(connection.url).origin && value.pathname === new URL(connection.url).pathname + '/pet.html'; }
  catch { return false; }
}
function taskForAction(tasks, input) {
  return tasks.find(t => t.sessionId === input?.sessionId && (t.url || '') === (input?.url || ''));
}
module.exports = { petBounds, isPetPage, taskForAction };

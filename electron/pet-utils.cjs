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
/** 对话窗始终放在宠物所在屏幕，优先左侧，其次右侧；支持负坐标和上下排列。 */
function petChatBounds(pet, area, saved) {
  const gap = 12, margin = 8;
  const width = Math.min(Math.max(saved?.width || 480, 360), Math.max(1, area.width - margin * 2));
  const height = Math.min(Math.max(saved?.height || 600, 360), Math.max(1, area.height - margin * 2));
  let x = pet.x - width - gap;
  if (x < area.x + margin) x = pet.x + pet.width + gap;
  x = Math.min(Math.max(x, area.x + margin), area.x + area.width - margin - width);
  const y = Math.min(Math.max(pet.y + pet.height - height, area.y + margin), area.y + area.height - margin - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}
module.exports = { petBounds, petChatBounds, isPetPage, taskForAction };

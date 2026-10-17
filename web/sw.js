/**
 * 最小 Service Worker：只为满足「添加到主屏幕 / 独立窗口」的安装条件。
 *
 * 刻意不做缓存——Web UI 更新频繁，缓存旧 app.js 会让新功能「看不见」
 * （服务端也统一 no-cache）。网络请求原样透传，离线时由浏览器显示默认错误。
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});

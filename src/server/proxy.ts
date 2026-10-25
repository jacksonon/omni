/** 远程 Web 只保留登录/配对边界；已认证流量转发同一个本机 broker。 */
import http from 'node:http';
import type { ServerConnection } from './protocol.js';

export type SharedProxyConnection = Pick<ServerConnection, 'url' | 'serverUrl' | 'token'>;

export function proxySharedRequest(req: http.IncomingMessage, res: http.ServerResponse, connection: SharedProxyConnection): void {
  const incoming = new URL(req.url ?? '/', 'http://omni.invalid');
  const root = new URL(connection.serverUrl);
  const scoped = /^\/w\/[a-f0-9]{24}(?:\/|$)/.test(incoming.pathname);
  const target = new URL(scoped ? incoming.pathname : new URL(connection.url).pathname + incoming.pathname, root);
  target.search = incoming.search;
  target.searchParams.delete('token');
  // 禁止利用路径规范化跨出工作区，远程认证不能升级为 broker 管理权限。
  if (!/^\/w\/[a-f0-9]{24}(?:\/|$)/.test(target.pathname)) {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '工作区路径无效' })); return;
  }
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: root.host, authorization: `Bearer ${connection.token}` };
  delete headers.cookie;
  // 外部 Origin 已在认证边界校验，内部请求使用 broker 自己的来源。
  if (headers.origin) headers.origin = root.origin;
  const upstream = http.request(target, { method: req.method, headers }, (response) => {
    const forwarded = { ...response.headers }; delete forwarded['set-cookie'];
    // 保存认证层刚设置的登录 cookie；broker cookie 永远不会泄漏给远端。
    res.writeHead(response.statusCode ?? 502, forwarded); response.pipe(res);
  });
  upstream.once('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '共享服务连接中断，请检查 omni server status' }));
  });
  res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

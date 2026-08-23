/**
 * 沙箱网络白名单代理（1.0 P0-4 沙箱 2.0）：本地回环上的最小转发代理。
 *
 * 工作方式：
 * · 沙箱内的命令经 `http_proxy/https_proxy` 环境变量把出站流量交给本代理
 *   （curl/npm/pip/git 等主流工具都尊重这些变量；TLS 端到端加密**不解密**，
 *   代理只在 CONNECT 阶段看到目标 hostname）；
 * · CONNECT（HTTPS 流量）：按 hostname 白名单判定——命中即开隧道，否则 403；
 * · 绝对形式 HTTP 请求：按 Host 头同样过滤后转发；
 * · 白名单条目语义：`example.com` = example.com 及其任意子域；`*.a.com` 同义；
 *   IP 字面量精确匹配。
 *
 * 这是**纵深防御的一层**而非硬边界：macOS Seatbelt 同时把「允许网络」收紧为
 * 「仅允许连本代理端口」（内核层强制）；Linux bwrap/firejail 无等价单命令能力时
 * 依赖代理环境变量（尽力而为，结果附说明）。
 */
import * as net from 'node:net';
import * as http from 'node:http';

/** 白名单匹配：host 命中任一条目（精确 / 后缀域 / 通配子域 / IP 精确） */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const rawEntry of allow) {
    let e = rawEntry.toLowerCase().trim();
    if (!e) continue;
    if (e === '*') return true;
    // 条目可带协议或端口前缀——剥掉只留 hostname
    e = e.replace(/^https?:\/\//, '').split('/')[0]!.split(':')[0]!;
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // '.example.com'
      if (h.endsWith(suffix)) return true;
      continue;
    }
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** 从 CONNECT 目标 `host:port` 取 hostname */
function splitHostPort(authority: string): { host: string; port: number } | null {
  const idx = authority.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = authority.slice(0, idx);
  const port = Number(authority.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

export interface AllowlistProxy {
  port: number;
  close(): Promise<void>;
}

/** 启动白名单代理（监听 127.0.0.1 随机空闲端口）；listen 失败抛错由调用方降级 */
export function startAllowlistProxy(allow: string[]): Promise<AllowlistProxy> {
  const server = http.createServer((req, res) => {
    // 绝对形式 HTTP 请求（http_proxy 场景）
    const hostHeader = (req.headers.host ?? '').split(':')[0] ?? '';
    if (!hostAllowed(hostHeader, allow)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`omni 沙箱：目标 ${hostHeader} 不在网络白名单内（config sandboxNetworkAllow）`);
      return;
    }
    try {
      const upstream = http.request(
        req.url!,
        { method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        }
      );
      upstream.on('error', () => {
        try { res.destroy(); } catch { /* ignore */ }
      });
      req.pipe(upstream);
    } catch {
      try { res.destroy(); } catch { /* ignore */ }
    }
  });

  // CONNECT（https_proxy 场景）：按 SNI 目标 hostname 过滤后开裸隧道（不解密）
  server.on('connect', (req, clientSocket, head) => {
    const target = splitHostPort(req.url ?? '');
    const ok = target && hostAllowed(target.host, allow);
    if (!ok) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const { host, port } = target!;
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // 强制断开存量连接（close 只等新连接排空）
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

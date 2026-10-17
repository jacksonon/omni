/**
 * Cloudflare 快速隧道（`cloudflared tunnel --url`）：把本机 web 服务临时暴露到
 * https://<随机>.trycloudflare.com。免费、无需 Cloudflare 账号，适合手机/PWA 远程访问。
 *
 * 注意：
 *   · 公网地址是**临时**的（每次启动变化，进程退出即失效）；固定域名请自建 named tunnel；
 *   · 服务端必须启用账号密码（--tunnel 时 fail-closed），否则等于把可执行命令的 Agent 裸奔公网；
 *   · 依赖本机安装 cloudflared（brew install cloudflared / winget install Cloudflare.cloudflared）。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface QuickTunnel {
  /** 公网 https 地址 */
  url: string;
  /** 关闭隧道（终止 cloudflared 子进程） */
  close: () => void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function startQuickTunnel(port: number, host = '127.0.0.1', timeoutMs = 40_000): Promise<QuickTunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('cloudflared', ['tunnel', '--url', `http://${host}:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    let output = '';
    const close = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      close();
      reject(
        new Error(
          'cloudflared 在 40 秒内未返回公网地址（检查网络/代理；或手动运行 cloudflared tunnel --url http://' +
            host +
            ':' +
            port +
            ' 排查）'
        )
      );
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString();
      // cloudflared 的地址打印在 banner 里，可能被分块——累积匹配
      const m = URL_RE.exec(output);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], close });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            '未找到 cloudflared：请先安装（macOS: brew install cloudflared · Windows: winget install Cloudflare.cloudflared · Linux: 见 Cloudflare 文档）'
          )
        );
      } else {
        reject(err);
      }
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared 提前退出（code ${code ?? 'null'}）`));
    });
  });
}

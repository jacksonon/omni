/**
 * MCP OAuth 登录（RFC 8414 + 授权码 + PKCE）：streamable HTTP 服务器的身份认证。
 *
 * 流程：
 *   1. 从服务器端点发现 OAuth 元数据（`/.well-known/oauth-authorization-server` 或端点自身元数据）；
 *   2. 生成本地临时回调端口 + PKCE code_verifier/code_challenge；
 *   3. 打开浏览器访问 authorization_endpoint（用户登录授权）；
 *   4. 回调收到 code → 用 token_endpoint 换 access/refresh token；
 *   5. token 持久化到 ~/.config/omni/mcp-oauth.json（按 server URL 索引）。
 *
 * 无第三方依赖：本地临时 http 服务器接收回调（Node 内置 http 模块）。
 */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** OAuth 令牌存储（按 server URL 索引，多服务器各一份） */
export interface McpOAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number; // epoch ms；未知 = 永不过期
  scope?: string;
}

/** OAuth 服务器元数据（RFC 8414 discovery 结果） */
interface OAuthMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

function oauthFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'omni', 'mcp-oauth.json');
}

/** 读取某 server URL 的已存 token（无则 null） */
export async function loadMcpToken(url: string): Promise<McpOAuthToken | null> {
  try {
    const file = oauthFilePath();
    if (!existsSync(file)) return null;
    const all = JSON.parse(await readFile(file, 'utf8')) as Record<string, McpOAuthToken>;
    const tok = all[url];
    if (!tok) return null;
    // 过期检查：expiresAt 存在且已过 → 视为无 token（触发重新登录）
    if (tok.expiresAt && Date.now() >= tok.expiresAt) return null;
    return tok;
  } catch {
    return null;
  }
}

/** 保存 token（按 server URL 索引，保留其它服务器条目） */
export async function saveMcpToken(url: string, token: McpOAuthToken): Promise<void> {
  const file = oauthFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  let all: Record<string, McpOAuthToken> = {};
  try {
    if (existsSync(file)) all = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    all = {};
  }
  all[url] = token;
  await writeFile(file, JSON.stringify(all, null, 2) + '\n', 'utf8');
}

/** 清除某 server URL 的 token（登录失败/用户手动登出） */
export async function clearMcpToken(url: string): Promise<void> {
  const file = oauthFilePath();
  try {
    if (!existsSync(file)) return;
    const all = JSON.parse(await readFile(file, 'utf8')) as Record<string, McpOAuthToken>;
    if (url in all) {
      delete all[url];
      await writeFile(file, JSON.stringify(all, null, 2) + '\n', 'utf8');
    }
  } catch {
    // 静默
  }
}

/** 从服务器发现 OAuth 元数据（RFC 8414 discovery：/.well-known/oauth-authorization-server） */
export async function discoverOAuthMetadata(baseUrl: string): Promise<OAuthMetadata | null> {
  const candidates = [
    // RFC 8414：https://<host>/.well-known/oauth-authorization-server
    baseUrl.replace(/\/+$/, '') + '/.well-known/oauth-authorization-server',
    // 兜底：端点自身（部分服务器把元数据放在同一路径）
    baseUrl.replace(/\/+$/, ''),
  ];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (resp.ok) {
        const data = (await resp.json()) as OAuthMetadata;
        if (data.authorization_endpoint || data.token_endpoint) return data;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

/**
 * 执行 OAuth 授权码 + PKCE 流程：
 * 打开浏览器 → 用户授权 → 本地回调接收 code → 换 token → 持久化返回。
 * 返回新 token；流程失败（取消/无端点）返回 null。
 */
export async function oauthLogin(baseUrl: string, scope = 'mcp'): Promise<McpOAuthToken | null> {
  const meta = await discoverOAuthMetadata(baseUrl);
  if (!meta?.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`服务器 ${baseUrl} 未提供 OAuth 元数据（authorization_endpoint / token_endpoint 缺失）`);
  }
  const { verifier, challenge } = pkce();
  const code = randomBytes(8).toString('hex');
  const redirectPort = 47_000 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'omni');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', code);
  if (scope) authUrl.searchParams.set('scope', scope);

  // 打开默认浏览器
  const open = (await import('node:child_process')).spawn;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', authUrl.toString()] : [authUrl.toString()];
  const child = open(opener, args, { stdio: 'ignore', detached: true });
  child.unref();

  // 本地回调服务器：接收 code 后关闭
  const received = await new Promise<URLSearchParams | null>((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname === '/callback') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Omni 已收到授权，可关闭此页面</h2></body></html>');
        server.close();
        resolve(u.searchParams);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(redirectPort, '127.0.0.1', () => {});
    // 超时兜底：60s 未回调 → 取消
    setTimeout(() => {
      server.close();
      resolve(null);
    }, 60_000);
  });

  if (!received) return null;
  const authCode = received.get('code');
  const state = received.get('state');
  if (state !== code) throw new Error('OAuth state 校验失败（CSRF 防护）');
  if (!authCode) throw new Error('OAuth 授权被拒绝（无 code）');

  // 换 token
  const tokenResp = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirectUri,
      client_id: 'omni',
      code_verifier: verifier,
    }),
  });
  if (!tokenResp.ok) {
    throw new Error(`OAuth token 交换失败：HTTP ${tokenResp.status}`);
  }
  const data = (await tokenResp.json()) as Record<string, unknown>;
  const token: McpOAuthToken = {
    accessToken: String(data.access_token ?? ''),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    tokenType: String(data.token_type ?? 'Bearer'),
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
  };
  if (!token.accessToken) throw new Error('OAuth token 交换响应缺少 access_token');
  await saveMcpToken(baseUrl, token);
  return token;
}

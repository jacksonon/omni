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
  /**
   * 换 token 时用的 client_id（codex 83b56bc：配置的保密客户端 id 与存量
   * 凭证不一致时要求重新登录；client_secret 永不进持久化记录）。
   */
  clientId?: string;
}

/** OAuth 服务器元数据（RFC 8414 discovery 结果） */
interface OAuthMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
  /** RFC 7591 动态客户端注册端点（2026-09 补课；有则登录时自动注册 client_id） */
  registration_endpoint?: string;
  /** CIMD（Client ID Metadata Document）支持标记（client_id 为 HTTPS 元数据文档 URL） */
  client_id_metadata_document_supported?: boolean;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

/** OAuth 客户端注册策略（codex mcp add --oauth-client-registration 对等） */
export type OAuthClientRegistration = 'auto' | 'cimd' | 'dcr';

/** OAuth 客户端选项：clientId 传 HTTPS URL 即 CIMD 模式；缺省尝试 DCR → 回退 'omni' */
export interface OAuthClientOptions {
  clientId?: string;
  /**
   * 预注册保密客户端密钥（codex mcp add --oauth-client-secret 对等）：
   * 与 clientId 成对配置，换 token 时以 client_secret(_post) 发送；
   * DCR 下发的临密钥仍走旧路径；本字段来自配置文件，不打 debug 日志。
   */
  clientSecret?: string;
  clientName?: string;
  /**
   * RFC 8707 resource 指示（codex mcp add --oauth-resource 对等）：部分网关要求
   * 授权与换 token 时携带目标资源；缺省不发（保持旧行为）。
   */
  resource?: string;
  /**
   * 注册策略覆盖（codex --oauth-client-registration 对等）：
   * cimd = 必须显式 clientId（HTTPS URL），否则抛错；dcr = 强制动态注册，
   * 无 registration_endpoint 时抛错而不静默回退；auto/缺省 = 旧行为。
   */
  clientRegistration?: OAuthClientRegistration;
  /**
   * 请求的 OAuth scope（codex mcp login --scopes 对等）：逗号/空格分隔，
   * 归一为空格连接后发 scope 参数；缺省用位置 scope（内部默认 'mcp'）。
   */
  scopes?: string;
  /**
   * 无浏览器模式（codex mcp login --no-browser 对等）：打印授权地址，
   * 由 promptCallback/标准输入粘贴回调地址完成；不拉本地回调服务器。
   * 交互会话内 stdin 被主 readline 独占——调用方负责改走顶层命令。
   */
  noBrowser?: boolean;
  /**
   * no-browser 回调地址提供器（缺省 stdin readline 问一句；单测注入桩）。
   * 入参带本次 state（桩按 state 组回调地址）；返回 null/空 = 用户取消。
   */
  promptCallback?: (info: { authUrl: string; state: string; redirectUri: string }) => Promise<string | null>;
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
 * 解析 OAuth client_id（2026-09 补课）：
 *  1. 显式 clientId（HTTPS URL = CIMD 元数据文档；普通字符串 = 预注册 client_id）；
 *  2. 服务器声明 registration_endpoint → RFC 7591 动态注册（PKCE public client）；
 *  3. 回退旧行为 'omni'。
 * 策略覆盖：cimd 要求显式 clientId（缺失/非 HTTPS URL 直接抛错，不猜）；
 * dcr 跳过显式直用、强制走 registration_endpoint（缺失/失败抛错，不静默回退）。
 */
export async function resolveOAuthClientId(
  meta: OAuthMetadata,
  redirectUri: string,
  opts?: OAuthClientOptions
): Promise<{ clientId: string; clientSecret?: string }> {
  const strategy = opts?.clientRegistration ?? 'auto';
  if (strategy === 'cimd') {
    if (!opts?.clientId || !opts.clientId.startsWith('https://')) {
      throw new Error('CIMD 注册策略要求显式 --oauth-client-id（HTTPS URL 元数据文档）');
    }
    // CIMD 下配置的 secret 同行（显式 id 的一部分，不丢）
    return { clientId: opts.clientId, ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}) };
  }
  // 预注册保密客户端（仅 auto 策略）：显式 id + secret 直接用，不走 DCR 注册；
  // 显式 dcr 要求全新注册，配置密钥让路（flag 优先）
  if (strategy !== 'dcr' && opts?.clientId && opts?.clientSecret) {
    return { clientId: opts.clientId, clientSecret: opts.clientSecret };
  }
  if (strategy !== 'dcr' && opts?.clientId) return { clientId: opts.clientId };
  if (strategy === 'dcr' && !meta.registration_endpoint) {
    throw new Error('DCR 注册策略要求服务器提供 registration_endpoint（元数据缺失）');
  }
  if (meta.registration_endpoint) {
    try {
      const resp = await fetch(meta.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_name: opts?.clientName ?? 'omni',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        if (typeof data.client_id === 'string' && data.client_id) {
          return {
            clientId: data.client_id,
            ...(typeof data.client_secret === 'string' && data.client_secret ? { clientSecret: data.client_secret } : {}),
          };
        }
      }
    } catch (err) {
      // 注册失败 → auto 回退预注册 'omni'；dcr 显式策略不吞错
      if (strategy === 'dcr') {
        throw new Error(`动态客户端注册失败：${(err as Error)?.message ?? err}`);
      }
    }
  }
  if (strategy === 'dcr') {
    throw new Error('动态客户端注册失败（服务器未返回可用 client_id）');
  }
  return { clientId: 'omni' };
}

/**
 * scope 归一（codex --scopes 逗号形态兼容）：逗号/空白切分去空 → 空格连接；
 * 空输入回 undefined（调用方用默认 scope）。
 */
/**
 * 存量 token 是否因配置变更失效（codex 83b56bc：配置的保密客户端 id 与
 * 存量凭证不一致 → 丢弃缓存连接，要求重新登录；无配置 id 或无记录时不判）。
 */
export function isStaleOAuthToken(configuredClientId: string | undefined, token: McpOAuthToken | null): boolean {
  if (!configuredClientId || !token?.clientId) return false;
  return token.clientId !== configuredClientId;
}

export function normalizeScopes(input?: string): string | undefined {
  const parts = `${input ?? ''}`.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** 拼授权地址（纯函数：PKCE/state/scope/resource 组装可单测） */
export function buildAuthorizeUrl(
  authorizationEndpoint: string,
  parts: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    state: string;
    scope?: string;
    resource?: string;
  }
): string {
  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', parts.clientId);
  authUrl.searchParams.set('redirect_uri', parts.redirectUri);
  authUrl.searchParams.set('code_challenge', parts.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', parts.state);
  if (parts.scope) authUrl.searchParams.set('scope', parts.scope);
  if (parts.resource) authUrl.searchParams.set('resource', parts.resource);
  return authUrl.toString();
}

/** 解析回调参数（纯函数）：state 校验 + 取 code，失败抛错（CSRF/拒绝） */
export function parseCallbackParams(params: URLSearchParams, expectedState: string): string {
  const state = params.get('state');
  if (state !== expectedState) throw new Error('OAuth state 校验失败（CSRF 防护）');
  const authCode = params.get('code');
  if (!authCode) throw new Error('OAuth 授权被拒绝（无 code）');
  return authCode;
}

/** 缺省回调地址提问（顶层命令独占 stdin 时用；交互会话内禁用见 noBrowser 注释） */
async function askCallbackUrl(): Promise<string | null> {
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ans = await rl.question('粘贴授权后跳回的完整地址（空回车取消）：');
    return ans.trim() || null;
  } finally {
    rl.close();
  }
}

/**
 * 执行 OAuth 授权码 + PKCE 流程：
 * 打开浏览器 → 用户授权 → 本地回调接收 code → 换 token → 持久化返回。
 * 返回新 token；流程失败（取消/无端点）返回 null。
 */
export async function oauthLogin(baseUrl: string, scope = 'mcp', opts?: OAuthClientOptions): Promise<McpOAuthToken | null> {
  const meta = await discoverOAuthMetadata(baseUrl);
  if (!meta?.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`服务器 ${baseUrl} 未提供 OAuth 元数据（authorization_endpoint / token_endpoint 缺失）`);
  }
  const { verifier, challenge } = pkce();
  const code = randomBytes(8).toString('hex');
  const redirectPort = 47_000 + Math.floor(Math.random() * 1000);
  const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;
  // client_id：显式（CIMD URL）→ DCR 动态注册 → 'omni' 回退
  const { clientId, clientSecret } = await resolveOAuthClientId(meta, redirectUri, opts);

  const scopeText = normalizeScopes(opts?.scopes) ?? scope;
  const authUrlText = buildAuthorizeUrl(meta.authorization_endpoint, {
    clientId,
    redirectUri,
    challenge,
    state: code,
    ...(scopeText ? { scope: scopeText } : {}),
    ...(opts?.resource ? { resource: opts.resource } : {}),
  });

  let authCode: string;
  if (opts?.noBrowser) {
    // 无浏览器模式（codex --no-browser 对等）：打印地址 + 粘贴回调地址
    console.log(`在浏览器打开以下地址完成授权，再把跳回的完整地址粘贴回来：\n${authUrlText}`);
    const pasted = await (opts.promptCallback ?? (() => askCallbackUrl()))({ authUrl: authUrlText, state: code, redirectUri });
    if (!pasted) return null;
    let cb: URL;
    try {
      cb = new URL(pasted.trim());
    } catch {
      throw new Error('回调地址非法（需要完整 URL）');
    }
    authCode = parseCallbackParams(cb.searchParams, code);
  } else {
    // 打开默认浏览器
    const open = (await import('node:child_process')).spawn;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', authUrlText] : [authUrlText];
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
    authCode = parseCallbackParams(received, code);
  }

  // 换 token
  const tokenBody: Record<string, string> = {
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  };
  if (clientSecret) tokenBody.client_secret = clientSecret;
  if (opts?.resource) tokenBody.resource = opts.resource;
  const tokenResp = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenBody),
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
    clientId,
  };
  if (!token.accessToken) throw new Error('OAuth token 交换响应缺少 access_token');
  await saveMcpToken(baseUrl, token);
  return token;
}

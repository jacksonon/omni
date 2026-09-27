/**
 * `omni mcp list/get`：MCP 服务器只读查看（codex mcp list/get 对等）。
 * 只读配置文件（不连接服务器，零副作用；连接状态/工具清单看交互 /mcp 或 TUI）。
 * 密钥类字段经 redactDeep 脱敏后输出（与全局 redactSecrets 开关一致，默认开）。
 * add/remove/login/logout 需要交互流程：显式指路 TUI/配置文件，不静默。
 */
import type { ConfigOverrides } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { redactDeep } from '../agent/redact.js';
import type { McpServerConfig } from '../tools/mcp.js';

function describeTransport(c: McpServerConfig): string {
  if (c.command) return `stdio: ${c.command}${c.args?.length ? ` ${c.args.join(' ')}` : ''}`;
  if (c.url) return `http: ${c.url}`;
  return '（未配置传输）';
}

function describeFilters(c: McpServerConfig): string {
  const parts: string[] = [];
  if (c.enabledTools?.length) parts.push(`白名单 ${c.enabledTools.length} 工具`);
  if (c.disabledTools?.length) parts.push(`黑名单 ${c.disabledTools.length} 工具`);
  if (c.defaultToolsApprovalMode) parts.push(`审批 ${c.defaultToolsApprovalMode}`);
  return parts.length > 0 ? `（${parts.join('，')}）` : '';
}

/** `omni mcp ...` 入口：返回进程退出码（0 成功 / 1 用法或目标错误） */
export async function runMcpCommand(
  args: string[],
  overrides: ConfigOverrides = {},
  opts: { fromInteractive?: boolean } = {}
): Promise<number> {
  const [sub, ...rest] = args;
  const cfg = loadConfig(overrides);
  const servers = (cfg.mcpServers ?? {}) as Record<string, McpServerConfig>;
  const names = Object.keys(servers);
  if (!sub || sub === 'list' || sub === 'ls') {
    if (names.length === 0) {
      console.log('没有已配置 MCP 服务器（配置文件 mcpServers 字段；连接状态看交互 /mcp 或 TUI）');
      return 0;
    }
    console.log(`MCP 服务器（${names.length} 个，来自配置文件；连接状态看交互 /mcp 或 TUI）：`);
    for (const n of names) {
      const c = servers[n]!;
      console.log(`· ${n} — ${describeTransport(c)}${describeFilters(c) ? ` ${describeFilters(c)}` : ''}`);
    }
    return 0;
  }
  if (sub === 'get') {
    const name = rest[0] ?? '';
    if (!name) {
      console.error('缺少服务器名：omni mcp get <名称>（omni mcp list 查看）');
      return 1;
    }
    const hit = servers[name];
    if (!hit) {
      console.error(`MCP 服务器「${name}」不存在${names.length > 0 ? `（已有：${names.join('、')}）` : ''}`);
      return 1;
    }
    console.log(JSON.stringify(redactDeep(hit), null, 2));
    return 0;
  }
  // 登录态管理（codex mcp login/logout 对等）：token 按 server URL 存 XDG 下 mcp-oauth.json，
  // 与客户端读取路径一致（loadMcpToken）。login 走浏览器 + 本地回调（60s 超时）。
  if (sub === 'login' || sub === 'logout') {
    // login 附加旗（codex mcp login 对等）：--no-browser/--scopes/--oauth-client-registration
    //（logout 不吃 flag，走原 rest[0] 取名）
    let noBrowser = false;
    let scopes: string | undefined;
    let loginReg: string | undefined;
    let name: string;
    if (sub === 'login') {
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--no-browser') noBrowser = true;
        else if (a === '--scopes') scopes = rest[++i];
        else if (a === '--oauth-client-registration') loginReg = rest[++i];
        else if (a.startsWith('-')) {
          console.error(`未知参数：${a}（可用：--no-browser/--scopes/--oauth-client-registration）`);
          return 1;
        } else positional.push(a);
      }
      if (loginReg !== undefined && loginReg !== 'auto' && loginReg !== 'cimd' && loginReg !== 'dcr') {
        console.error(`--oauth-client-registration 非法（auto|cimd|dcr）：${loginReg}`);
        return 1;
      }
      if (!positional[0] || positional.length > 1) {
        console.error(`用法：omni mcp login <名称> [--no-browser] [--scopes a,b] [--oauth-client-registration auto|cimd|dcr]`);
        return 1;
      }
      name = positional[0];
    } else {
      name = rest[0] ?? '';
      if (!name) {
        console.error(`缺少服务器名：omni mcp logout <名称>（omni mcp list 查看）`);
        return 1;
      }
    }
    const hit = servers[name];
    if (!hit) {
      console.error(`MCP 服务器「${name}」不存在${names.length > 0 ? `（已有：${names.join('、')}）` : ''}`);
      return 1;
    }
    if (!hit.url) {
      console.error(`服务器「${name}」是 stdio 本地命令，无需 OAuth 登录`);
      return 1;
    }
    if (sub === 'logout') {
      const { clearMcpToken, loadMcpToken } = await import('../tools/mcp-oauth.js');
      const had = await loadMcpToken(hit.url);
      await clearMcpToken(hit.url);
      console.log(had ? `已清除「${name}」的登录态` : `「${name}」本来就没有登录态`);
      return 0;
    }
    if (noBrowser && opts.fromInteractive) {
      // 交互会话内 stdin 被主 readline 独占：第二 readline 会饿死（实锤教训），指路顶层命令
      console.error('交互会话内 --no-browser 需要独占 stdin：请在新终端运行 omni mcp login ' + name + ' --no-browser');
      return 1;
    }
    const reg = loginReg !== undefined && loginReg !== 'auto' ? loginReg as 'cimd' | 'dcr' : hit.oauthClientRegistration;
    console.log(
      noBrowser
        ? `正在为「${name}」无浏览器登录（打印授权地址，粘贴回调完成；60 秒内有效）…`
        : `正在为「${name}」打开浏览器登录（60 秒内完成授权；远程终端用 omni mcp login ${name} --no-browser）…`
    );
    try {
      const { oauthLogin } = await import('../tools/mcp-oauth.js');
      const tok = await oauthLogin(hit.url, 'mcp', {
        ...(hit.clientId ? { clientId: hit.clientId } : {}),
        ...(hit.oauthResource ? { resource: hit.oauthResource } : {}),
        ...(reg ? { clientRegistration: reg } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(noBrowser ? { noBrowser: true as const } : {}),
        clientName: `omni (${name})`,
      });
      if (!tok) {
        console.error('登录未完成（授权超时或被拒绝）');
        return 1;
      }
      console.log(`「${name}」登录成功（token 已存，仅本机可用）`);
      return 0;
    } catch (err) {
      console.error(`登录失败：${(err as Error)?.message ?? err}`);
      return 1;
    }
  }
  // 新增 / 删除（codex mcp add/remove 对等）：落盘口径与 /mcp remove、/model add 一致
  //（loadConfigObject 决定的最高优先级文件；JSONC 带注释拒改并指路手动）。
  if (sub === 'add' || sub === 'remove') {
    const { addMcpServerToConfig, removeMcpServerFromConfig } = await import('../config/write.js');
    if (sub === 'remove') {
      const name = rest[0] ?? '';
      if (!name) {
        console.error('缺少服务器名：omni mcp remove <名称>');
        return 1;
      }
      const r = removeMcpServerFromConfig(name, cfg);
      if (!r.ok) {
        console.error(r.message);
        return 1;
      }
      console.log(r.message);
      return 0;
    }
    // add <name> --url <url> [--oauth-client-id X] | add <name> -- <cmd> [...] [--env K=V ...]
    const { name, entry, error } = parseMcpAddArgs(rest);
    if (error || !name || !entry) {
      console.error(error ?? '用法：omni mcp add <名称> --url <地址> [--oauth-client-id X] [--oauth-client-registration auto|cimd|dcr] [--oauth-resource R] | omni mcp add <名称> -- <命令> [参数...] [--env K=V ...]');
      return 1;
    }
    if (servers[name]) {
      console.error(`MCP 服务器「${name}」已存在（先 omni mcp remove 删除再重加）`);
      return 1;
    }
    const r = addMcpServerToConfig(name, entry, cfg);
    if (!r.ok) {
      console.error(r.message);
      return 1;
    }
    console.log(`${r.message}（重启会话生效）`);
    return 0;
  }
  console.error(
    `未知子命令 omni mcp ${sub}（可用：list/get/login/logout/add/remove）`
  );
  return 1;
}

/** `mcp add` 参数解析（codex mcp add 对等子集；返回 entry 或错误） */
export function parseMcpAddArgs(rest: string[]): {
  name?: string;
  entry?: import('../tools/mcp.js').McpServerConfig;
  error?: string;
} {
  const dash = rest.indexOf('--');
  const pre = dash < 0 ? rest : rest.slice(0, dash);
  const cmd = dash < 0 ? [] : rest.slice(dash + 1);
  let url: string | undefined;
  let clientId: string | undefined;
  let oauthResource: string | undefined;
  let oauthReg: string | undefined;
  let bearerEnv: string | undefined;
  const env: Record<string, string> = {};
  let name: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < pre.length; i++) {
    const a = pre[i]!;
    if (a === '--url') url = pre[++i];
    else if (a === '--oauth-client-id') clientId = pre[++i];
    else if (a === '--oauth-resource') oauthResource = pre[++i];
    else if (a === '--oauth-client-registration') oauthReg = pre[++i];
    else if (a === '--bearer-token-env-var') bearerEnv = pre[++i];
    else if (a === '--env') {
      const kv = pre[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq <= 0) return { error: `--env 须为 K=V 形态（收到「${kv}」）` };
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('-')) {
      return { error: `未知参数：${a}（可用：--url/--bearer-token-env-var/--oauth-client-id/--oauth-resource/--oauth-client-registration/--env，或 -- <命令>）` };
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) return { error: '缺少服务器名：omni mcp add <名称> --url <地址> | omni mcp add <名称> -- <命令>' };
  if (positional.length > 1) return { error: `名称只能一个（多余：${positional.slice(1).join(' ')}）` };
  name = positional[0]!;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { error: `服务器名非法（限字母数字/_/-）：${name}` };
  const envKeys = Object.keys(env);
  if (url !== undefined && cmd.length > 0) return { error: '--url 与 -- <命令> 互斥（二选一）' };
  if (bearerEnv !== undefined && cmd.length > 0) {
    return { error: '--bearer-token-env-var 仅 streamable HTTP 服务器可用（stdio 用 --env 传参）' };
  }
  if (oauthResource !== undefined && url === undefined && cmd.length > 0) {
    return { error: '--oauth-resource 仅 streamable HTTP 服务器可用' };
  }
  if (oauthReg !== undefined && url === undefined && cmd.length > 0) {
    return { error: '--oauth-client-registration 仅 streamable HTTP 服务器可用' };
  }
  if (oauthReg !== undefined && oauthReg !== 'auto' && oauthReg !== 'cimd' && oauthReg !== 'dcr') {
    return { error: `--oauth-client-registration 非法（auto|cimd|dcr）：${oauthReg}` };
  }
  const oauthFields = {
    ...(oauthResource !== undefined ? { oauthResource } : {}),
    ...(oauthReg !== undefined && oauthReg !== 'auto' ? { oauthClientRegistration: oauthReg as 'cimd' | 'dcr' } : {}),
  };
  if (url !== undefined) {
    if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) return { error: `--url 非法（须为 http(s) 地址）：${url}` };
    if (envKeys.length > 0) return { error: '--env 仅 stdio 服务器可用（http 服务器用 --oauth-client-id 登录或配 headers）' };
    let bearerHeaders: Record<string, string> | undefined;
    if (bearerEnv !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerEnv)) return { error: `--bearer-token-env-var 非法（环境变量名）：${bearerEnv}` };
      // token 不落盘：运行时由 {env:} 解析（与 apiKey 同机制；缺失时该 header 被移除）
      bearerHeaders = { Authorization: `Bearer {env:${bearerEnv}}` };
    }
    return { name, entry: { url, ...(clientId ? { clientId } : {}), ...oauthFields, ...(bearerHeaders ? { headers: bearerHeaders } : {}) } };
  }
  if (cmd.length === 0) return { error: '缺少传输（二选一）：--url <地址> 或 -- <命令> [参数...]' };
  return { name, entry: { command: cmd[0]!, args: cmd.slice(1), ...(envKeys.length > 0 ? { env } : {}), ...(clientId ? { clientId } : {}) } };
}

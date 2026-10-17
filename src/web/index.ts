/**
 * omni web 子命令入口：`omni web [--port <n>] [--host <h>] [--no-open]`
 *
 * 复用现有配置体系（-m/--config/OMNI_* 环境变量等全局 overrides 照常生效），
 * 解析 web 专属参数后启动本地后端服务（REST + SSE）并托管 Web UI。
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { attachRuntime, prepareRun } from '../main.js';
import { isTrustedWorkspace } from '../safety/trust.js';
import { routingOutput, startWebService } from './server.js';
import type { ConfigOverrides } from '../config/index.js';
import { persistWebAuthToConfig, readPersistedWebWorkspace } from '../config/write.js';
import { loadConfig } from '../config/index.js';
import { generatePairCode, generateSecret, hashPassword, normalizePairCode } from './auth.js';
import { startQuickTunnel, type QuickTunnel } from './tunnel.js';
import qrTerminal from 'qrcode-terminal';

export interface WebArgs {
  port: number;
  host: string;
  open: boolean;
  help: boolean;
  /** 远程接入令牌（--token / OMNI_WEB_TOKEN）：非回环地址必填，API 需 Bearer/查询参数 */
  token?: string;
  /** 强制要求登录（即使监听回环；账号密码或 token 至少一个） */
  requireAuth?: boolean;
  /** Cloudflare 快速隧道：把本机服务临时暴露到公网 https 地址 */
  tunnel?: boolean;
  /** 配对模式（omni pair）：打印链接 + 二维码，一次性配对码免密登录 */
  pair?: boolean;
  /** 自定义配对码（测试/自动化；缺省随机生成） */
  code?: string;
}

/** 解析 `omni web` 子命令参数 */
export function parseWebArgs(args: string[]): WebArgs {
  const out: WebArgs = { port: 3080, host: '127.0.0.1', open: true, help: false };
  let hostExplicit = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const val = (): string => inline ?? args[++i] ?? '';
    switch (name) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--port':
      case '-p': {
        const n = Number(val());
        if (Number.isInteger(n) && n > 0 && n < 65536) out.port = n;
        break;
      }
      case '--host':
        out.host = val() || '127.0.0.1';
        hostExplicit = true;
        break;
      case '--token':
        out.token = val() || undefined;
        break;
      case '--no-open':
        out.open = false;
        break;
      case '--auth':
        out.requireAuth = true;
        break;
      case '--tunnel':
        out.tunnel = true;
        break;
      case '--pair':
        out.pair = true;
        break;
      case '--code':
        out.code = val();
        break;
      default:
        // 未知参数忽略（不阻塞启动）
        break;
    }
  }
  if (!out.token && process.env.OMNI_WEB_TOKEN) out.token = process.env.OMNI_WEB_TOKEN.trim() || undefined;
  // 配对模式：默认不自动开浏览器；局域网配对监听 0.0.0.0，隧道模式只监听回环
  // （cloudflared 只连本机，没有必要同时暴露局域网）。显式 --host 时尊重用户选择。
  if (out.pair) {
    out.open = false;
    if (!hostExplicit) out.host = out.tunnel ? '127.0.0.1' : '0.0.0.0';
  }
  return out;
}

export function printWebHelp(): void {
  console.log(`用法：
  omni web                     启动本地后端服务 + Web 界面（默认 http://127.0.0.1:3080）
  omni web --host 0.0.0.0      局域网直连（需先 omni web auth set 设置账号密码）
  omni web --tunnel            Cloudflare 快速隧道（公网 https，需先设置账号密码）
  omni pair                    局域网配对：打印链接 + 二维码（同 Wi-Fi 手机扫码）

Web 服务参数：
  -p, --port <端口>   服务端口（默认 3080）
      --host <地址>   监听地址（默认 127.0.0.1；0.0.0.0 = 局域网可访问）
      --token <令牌>  旧版接入令牌（或环境变量 OMNI_WEB_TOKEN）：
                      访问 http://host:port/?token=<令牌> 一次即可（写入 Cookie），
                      API 请求带 Authorization: Bearer <令牌> 或 ?token=；未授权返回 401
      --auth          强制要求登录（回环地址也生效；便于本地验证登录流程）
      --tunnel        启动 cloudflared 快速隧道，打印临时公网 https 地址（需安装 cloudflared）
      --no-open       不自动打开浏览器

账号密码（局域网 / 隧道 / 小程序）：
  omni web auth set [--user <用户名>] [--days <有效天数>]   设置或修改（密码交互输入）
  omni web auth show                                        查看当前账号（不显示密码）
  omni web auth clear                                       清除账号（回到免登录/令牌模式）
  非交互环境用环境变量提供密码：OMNI_WEB_PASSWORD=... omni web auth set --user omni

说明：
  · 复用现有配置（模型 / API Key / 权限 / MCP / hooks 等与 omni 一致）；
  · Web UI 支持：多会话 / 流式回复 / 思考与工具调用实时展示 / 审批与提问卡片 /
    模型与权限设置 / 会话标题自动生成；
  · 同一后端服务可供多个浏览器标签页 / 前端访问（REST + SSE 协议）；
  · 手机可在浏览器中「添加到主屏幕」（PWA）；HTTPS 隧道下支持独立窗口运行。`);
}

/** 局域网 IPv4 地址（0.0.0.0 监听时打印，方便手机直接输入） */
function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      // 过滤链路本地与 VPN/基准测试网段（Clash TUN 常用 198.18.0.0/15），避免误导
      if (i.address.startsWith('169.254.') || i.address.startsWith('198.18.') || i.address.startsWith('198.19.')) continue;
      out.push(`http://${i.address}:${port}`);
    }
  }
  return out;
}


/** 终端二维码（qrcode-terminal，小尺寸块字符） */
function printQr(text: string): void {
  try {
    qrTerminal.generate(text, { small: true }, (qr) => console.log(qr));
  } catch {
    console.log('  （二维码生成失败，请直接复制上面的链接）');
  }
}

/** 交互式隐藏输入（密码）；非 TTY 由调用方改用环境变量 */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error('非交互终端：请用 OMNI_WEB_PASSWORD 环境变量提供密码'));
      return;
    }
    stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pw = '';
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(pw);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (pw) {
            pw = pw.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          pw += ch;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** `omni web auth set|show|clear` */
export async function runWebAuth(args: string[]): Promise<void> {
  const sub = args[0] ?? 'show';
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(`用法：
  omni web auth set [--user <用户名>] [--days <有效天数>]   设置账号密码（写入全局配置）
  omni web auth show                                        查看当前账号
  omni web auth clear                                       清除账号

密码输入：TTY 下交互隐藏输入；脚本/CI 用 OMNI_WEB_PASSWORD 环境变量。
`);
    return;
  }

  if (sub === 'set') {
    let userFlag = '';
    let days = 30;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      const val = (): string => args[++i] ?? '';
      if (a === '--user' || a === '-u') userFlag = val().trim();
      else if (a === '--days') {
        const n = Number(val());
        if (Number.isInteger(n) && n >= 1 && n <= 365) days = n;
      }
    }
    let username = userFlag;
    if (!username && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      username = (await rl.question('用户名 [omni]: ')).trim();
      rl.close();
    }
    username = username || process.env.OMNI_WEB_USER?.trim() || 'omni';

    const envPw = process.env.OMNI_WEB_PASSWORD;
    let password = envPw ?? '';
    if (!password) {
      if (!process.stdin.isTTY) {
        console.error('✗ 非交互终端：请设置 OMNI_WEB_PASSWORD 环境变量');
        process.exitCode = 1;
        return;
      }
      const first = await promptHidden('密码（至少 8 位）: ');
      if (first.length < 8) {
        console.error('✗ 密码至少 8 位');
        process.exitCode = 1;
        return;
      }
      const second = await promptHidden('再输一次: ');
      if (first !== second) {
        console.error('✗ 两次输入不一致');
        process.exitCode = 1;
        return;
      }
      password = first;
    }
    if (password.length < 8) {
      console.error('✗ 密码至少 8 位');
      process.exitCode = 1;
      return;
    }

    const auth = {
      username,
      passwordHash: hashPassword(password),
      secret: generateSecret(),
      sessionDays: days,
    };
    const res = persistWebAuthToConfig(auth);
    if (!res.ok) {
      console.error(`✗ ${res.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ 已设置 Web 登录账号「${username}」（会话有效期 ${days} 天）`);
    console.log(`  → ${res.file}`);
    console.log('  重启 omni web 后生效；旧登录会话已全部失效。');
    return;
  }

  if (sub === 'clear') {
    const res = persistWebAuthToConfig(null);
    if (!res.ok) {
      console.error(`✗ ${res.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ 已清除 Web 登录账号（${res.file}）`);
    return;
  }

  if (sub === 'show') {
    const cfg = loadConfig();
    if (!cfg.webAuth) {
      console.log('未设置账号密码（omni web auth set 设置）');
      return;
    }
    console.log(`用户名：${cfg.webAuth.username}`);
    console.log(`会话有效期：${cfg.webAuth.sessionDays ?? 30} 天`);
    console.log(`配置文件：${cfg.sources.join(' · ')}`);
    return;
  }

  console.error(`未知子命令：${sub}（支持 set / show / clear）`);
  process.exitCode = 1;
}

/**
 * 启动 web 服务。
 * routingOutput 已从 server.ts 导出（attachRuntime 的审批/提问路由到当前运行会话）。
 */
export async function runWeb(args: string[], overrides: ConfigOverrides): Promise<void> {
  // 子命令：omni web auth set|show|clear
  if (args[0] === 'auth') {
    await runWebAuth(args.slice(1));
    return;
  }
  const parsed = parseWebArgs(args);
  if (parsed.help || args.includes('--help') || args.includes('-h')) {
    printWebHelp();
    return;
  }

  // 工作目录（优先级高→低）：OMNI_WEB_WORKSPACE 环境变量 > 持久化的 webWorkspace
  // （上次在界面里切换的）> 启动 cwd；cwd 为 "/"（Finder/Dock 启动）回退 home。
  // chdir 后再 prepareRun——配置发现/记忆/系统提示全部跟随新工作区，与运行时切换语义一致。
  const envWs = process.env.OMNI_WEB_WORKSPACE?.trim();
  const target = envWs ?? readPersistedWebWorkspace();
  if (target && existsSync(target) && statSync(target).isDirectory()) {
    try {
      process.chdir(target);
    } catch {
      // chdir 失败保持原目录
    }
  } else if (process.cwd() === '/') {
    try {
      process.chdir(os.homedir());
    } catch {
      // 同上
    }
  }

  // prepareRun：无 API Key 时降级启动（allowMissingKey 占位）——桌面应用首次安装
  // 没有任何配置，若这里抛错整个后端起不来，用户永远到不了设置面板填 Key。
  // 占位 Key 只在真正发请求时才失败（聊天里会看到鉴权错误），填好 Key 即恢复。
  let ctx: ReturnType<typeof prepareRun>;
  let missingKey = false;
  try {
    ctx = prepareRun(overrides);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('未找到 API Key'))) throw err;
    ctx = prepareRun(overrides, { allowMissingKey: true });
    missingKey = true;
  }
  // 认证前置检查（fail-closed）：局域网监听 / --auth / --tunnel 至少要有一种凭据，
  // 否则直接给可执行的指引，而不是让 Agent 裸奔在网络上。
  const loopbackHost = parsed.host === '127.0.0.1' || parsed.host === 'localhost' || parsed.host === '::1';
  // 配对码依赖账号体系（token-only 无法签发会话）
  if (parsed.pair && !ctx.cfg.webAuth) {
    console.error('✗ 配对模式需要先设置账号密码：omni web auth set');
    process.exitCode = 1;
    return;
  }
  if ((!loopbackHost || parsed.requireAuth || parsed.tunnel || parsed.pair) && !parsed.token && !ctx.cfg.webAuth) {
    console.error('✗ 当前启动方式要求认证：');
    console.error('    设置账号密码：omni web auth set');
    console.error('    或使用令牌：  omni web --token <令牌>（或 OMNI_WEB_TOKEN）');
    process.exitCode = 1;
    return;
  }

  // attachRuntime：安全护栏 + 动态工具链 + 上下文选项；审批/提问经 routingOutput
  // 路由到当前运行会话的 WebOutput；hook 输出/子代理事件转发到 SSE
  // 工作区信任：web 不弹审批（SSE 时序依赖浏览器连接），直接按信任清单判定——未信任只读
  const trusted = isTrustedWorkspace(process.cwd());
  await attachRuntime(ctx, routingOutput as unknown as import('../output/types.js').Output, { trust: trusted });
  if (!trusted) {
    console.log(`  ⚠️ 当前工作目录未受信任——以只读模式运行（/mcp 等写操作被拒绝；信任目录：omni 交互模式 / CLI 首次进入时批准）`);
  }
  if (missingKey) {
    // 注意措辞：Ollama / LM Studio 等本地网关不校验 Key（占位 Key 直接可用），
    // 不能吓唬用户「会失败」——只有云端网关才真的需要填
    console.log(`  ⚠️ 未配置 API Key：云端网关请在页面「设置」→「模型配置」填写后对话；`);
    console.log(`     Ollama / LM Studio 等本地服务无需 Key，可直接使用。`);
  }

  // 一次性配对码（5 分钟、单次使用）；--code 供自动化/测试指定
  let pairInfo: { code: string; expiresAt: number } | undefined;
  if (parsed.pair) {
    const custom = parsed.code ? normalizePairCode(parsed.code) : '';
    if (parsed.code && custom.length !== 8) {
      console.error('✗ 配对码需要 8 位字母/数字（例如 ABCD-EFGH）');
      process.exitCode = 1;
      return;
    }
    pairInfo = {
      code: custom || generatePairCode(),
      expiresAt: Date.now() + 5 * 60_000,
    };
  }

  const server = await startWebService({
    ctx,
    host: parsed.host,
    port: parsed.port,
    overrides,
    token: parsed.token,
    auth: ctx.cfg.webAuth,
    requireAuth: parsed.requireAuth || parsed.tunnel || parsed.pair,
    pair: pairInfo,
  });
  // 0.0.0.0 监听时浏览器/手机用具体地址；本机自动打开始终走回环
  const localUrl = `http://127.0.0.1:${parsed.port}`;
  const tunnelTarget =
    parsed.host === '0.0.0.0' || parsed.host === '::' || parsed.host === '::1' ? '127.0.0.1' : parsed.host;
  const url = `${localUrl}${parsed.token ? `/?token=${encodeURIComponent(parsed.token)}` : ''}`;
  const showUrl = parsed.host === '0.0.0.0' || parsed.host === '::' ? localUrl : `http://${parsed.host}:${parsed.port}`;
  console.log(`omni v${(await import('../version.js')).VERSION}`);
  console.log('');
  console.log(`  ◉ omni web 已启动：${showUrl}`);
  if (!loopbackHost) {
    const lan = lanUrls(parsed.port);
    if (lan.length > 0) {
      console.log('    局域网地址（同 Wi-Fi 的手机/电脑直接打开）：');
      for (const u of lan) console.log(`      ${u}`);
    }
  }
  if (ctx.cfg.webAuth) {
    console.log(`    登录账号：${ctx.cfg.webAuth.username}（账号密码认证已启用）`);
  }
  if (parsed.token) {
    console.log(`    接入令牌：已启用（浏览器打开 ${showUrl}/?token=<token> 完成授权）`);
  }
  console.log(`    工作目录：${process.cwd()}`);
  console.log(`    模型：${ctx.runOpts.modelRuntime?.model ?? ctx.cfg.model} · 权限：${ctx.runOpts.permission ?? 'safe'}`);

  // Cloudflare 快速隧道（公网 https）：仅在本机监听回环时默认，cloudflared 连本机端口
  let tunnel: QuickTunnel | null = null;
  if (parsed.tunnel) {
    console.log('');
    console.log('  … 正在建立 Cloudflare 快速隧道（首次可能需要几秒）');
    try {
      tunnel = await startQuickTunnel(parsed.port, tunnelTarget);
      process.once('exit', () => tunnel?.close());
      console.log(`  🌐 公网地址：${tunnel.url}`);
      console.log('     手机可直接打开（需登录）；此地址为临时地址，重启后变化。');
    } catch (err) {
      console.error(`  ⚠️ 隧道启动失败：${(err as Error)?.message ?? err}`);
      console.error('     本机服务仍在运行，可继续用局域网地址访问。');
    }
  }
  if (pairInfo) {
    const displayCode = `${pairInfo.code.slice(0, 4)}-${pairInfo.code.slice(4)}`;
    const lanBase = loopbackHost ? null : lanUrls(parsed.port)[0];
    const base = tunnel?.url ?? lanBase ?? showUrl;
    const link = `${base}/?pair=${encodeURIComponent(displayCode)}`;
    console.log('');
    console.log('  ┌─ 配对 ─────────────────────────────────');
    console.log(`  │ 链接：${link}`);
    console.log(`  │ 配对码：${displayCode}（5 分钟内有效，仅一次）`);
    console.log('  └────────────────────────────────────────');
    printQr(link);
    console.log('  手机与电脑连同一 Wi-Fi 后扫码；也可复制链接到浏览器。');
  }
  console.log('');
  console.log('  Ctrl+C 停止服务。');

  // 自动打开浏览器（可 --no-open 关闭；仅 macOS/Linux，Windows 用 start）
  if (parsed.open) {
    openBrowser(url);
  }

  // 等待关闭信号（SIGINT/SIGTERM 由 server.ts 处理；server 关闭后进程随事件循环退出）
  await new Promise<void>((resolve) => {
    server.on('close', () => {
      tunnel?.close();
      resolve();
    });
  });
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // 打不开浏览器不阻塞服务
  }
}
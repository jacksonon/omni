/**
 * WebFetch 内置工具（P1，Claude Code/Gemini/Qwen 标配）：
 * URL 抓取 → 转 markdown/纯文本 → 截断回传（omni 此前只能 curl 兜底）。
 *
 * · 用 Node 内置 fetch（无新依赖）
 * · HTML → 纯文本：剥 script/style/标签，保留代码块（<pre>）与链接
 * · 截断到 WEB_FETCH_MAX（30KB 字节）
 * · 域名允许列表可配（config webFetchDomains；缺省 = 全部）
 */
import type { Tool } from './types.js';

/** WebFetch 单次抓取字节上限 */
export const WEB_FETCH_MAX = 30 * 1024;

/** 去 HTML 标签转纯文本（尽力而为：剥脚本/样式/标签、解码常见实体、保留 pre 换行） */
export function htmlToText(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<pre[^>]*>/gi, '\n```\n') // 代码块围栏
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>/gi, '\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2（$1）')
    .replace(/<[^>]+>/g, '') // 剩余标签
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ldquo;|&rdquo;/g, '"');
  // 折叠多余空行
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/** 校验域名允许列表（webFetchDomains；空 = 全部允许） */
export function urlAllowed(url: string, allowed?: string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  try {
    const host = new URL(url).hostname;
    return allowed.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** 抓取 URL → 纯文本（截断）；失败抛错由 execute 转结果 */
async function fetchUrl(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'user-agent': 'omni-web-fetch/0.1', accept: 'text/html,text/plain,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = await resp.text();
  const text = htmlToText(raw);
  if (Buffer.byteLength(text, 'utf8') <= WEB_FETCH_MAX) return text;
  let cut = text.length;
  while (cut > 0 && Buffer.byteLength(text.slice(0, cut), 'utf8') > WEB_FETCH_MAX) cut--;
  return `${text.slice(0, cut)}\n\n…[内容过长已截断]`;
}

/** 创建 WebFetch 工具（域名允许列表可配） */
export function createWebFetchTool(allowedDomains?: string[]): Tool {
  return {
    name: 'web_fetch',
    description:
      '抓取一个 URL 的内容并转成纯文本返回（用于查询网页、文档、README 等）。' +
      '比 run_command curl 更直接：自动转文本、截断到安全大小。适合需要最新信息/文档时的外部查询。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 URL（http/https）' },
      },
      required: ['url'],
    },
    async execute(args) {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) return '错误：缺少 URL';
      if (!/^https?:\/\//i.test(url)) return `错误：仅支持 http/https URL（收到 ${url}）`;
      if (!urlAllowed(url, allowedDomains)) {
        return `错误：域名不在允许列表（webFetchDomains 配置，当前允许：${allowedDomains?.join(', ') ?? '（全部）'}）`;
      }
      try {
        const text = await fetchUrl(url);
        return `### ${url}\n\n${text.slice(0, 4000)}`;
      } catch (err) {
        return `抓取失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

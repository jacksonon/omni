/**
 * WebSearch 内置工具（P1，Claude Code/Codex CLI 标配）：
 * 输入关键词 → 返回搜索结果（标题 + URL + 摘要 snippet）。
 *
 * 方案 C「编程优先路由」：
 * 1. 先判断 query 是「查什么」——npm 包 / GitHub 仓库 / 通用网页；
 * 2. 查 npm/GitHub → 打官方免费 API（npm registry / api.github.com，免 key、结构化 JSON、稳定）；
 * 3. 通用网页 → 优先 Brave API（配了 webSearchApiKey 时），否则 DuckDuckGo HTML 端点兜底（免 key）。
 *
 * 对齐 web_fetch 的既有模式：Node 内置 fetch（无新依赖）、失败转文本结果不抛错、结果字节截断。
 */
import type { Tool } from './types.js';
import { truncateUtf8ByBytes } from './util.js';

/** 单次搜索返回结果条数默认值 */
export const WEB_SEARCH_DEFAULT_COUNT = 5;
/** 结果条数上限（防上下文被撑爆） */
export const WEB_SEARCH_MAX_COUNT = 10;
/** 单次搜索打包文本字节上限 */
export const WEB_SEARCH_MAX = 24 * 1024;
/** 单个来源搜索用 timeouter（秒） */
const SEARCH_TIMEOUT_MS = 15_000;
/** GitHub 未认证 API 限 10 次/分钟——query 一律走 search 端点、per_page 压到 count */
const GITHUB_PER_PAGE_MIN = 5;

/** 编程优先路由的判定结果 */
export type SearchRoute = 'npm' | 'github' | 'web';

/**
 * 判定搜索路由：
 * · site 明确带 npmjs/registry → npm
 * · site 明确带 github → github
 * · query 是「单一包名 token」或带 install/usage/package 等查包意图 → npm
 * · query 含 github/repo/仓库 意图 → github
 * · 其余 → 通用 web
 */
export function classifySearch(query: string, site: string): SearchRoute {
  const q = query.trim().toLowerCase();
  const s = site.trim().toLowerCase();
  if (s.includes('npmjs') || s.includes('registry.npmjs')) return 'npm';
  if (s.includes('github')) return 'github';
  // 查包意图：单 token（zod/vitest/next.js 这类）或裸@scope/name + 意图词
  const pkgIdea = /(^| )(install|usage|usage?|documentation|docs|npm|package|library|plugin|cli|sdk|wrapper|how to|example|api|version)( |$)/;
  const singleToken = /^[a-z0-9@][a-z0-9@._\-/]{1,63}$/.test(q.trim());
  if (singleToken && /^@?[a-z0-9_\-]+(\/[a-z0-9_\-]+)*$/.test(q.trim())) return 'npm';
  if (pkgIdea.test(` ${q} `)) return 'npm';
  // GitHub / 仓库意图
  if (/github|repo|repository|source\s+code|\.git\b|\brepo\b/.test(q)) return 'github';
  return 'web';
}

/* ── npm registry search（免 key，官方） ───────────────────────────── */

interface NpmSearchHit {
  package?: {
    name?: string;
    version?: string;
    description?: string;
    links?: { npm?: string; repository?: string };
    date?: string;
  };
}

async function searchNpm(query: string, count: number): Promise<string> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${Math.min(count, 20)}`;
  const resp = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'omni-web-search/0.1' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`npm registry HTTP ${resp.status}`);
  const data = (await resp.json()) as { objects?: NpmSearchHit[] };
  const hits = data.objects ?? [];
  if (hits.length === 0) return `npm 上没有找到与「${query}」相关的包。`;
  return hits
    .map((h, i) => {
      const p = h.package ?? {};
      const name = p.name ?? '(未知)';
      const repo = p.links?.repository ? ` · GitHub: ${p.links.repository}` : '';
      return `${i + 1}. ${name} v${p.version ?? '?'}\n   ${p.links?.npm ?? `https://www.npmjs.com/package/${name}`}\n   ${(p.description ?? '(无描述)').trim()}${repo}`;
    })
    .join('\n\n');
}

/* ── GitHub search API（免 key，未认证限 10 次/分钟） ─────────────── */

interface GhRepoItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
}

async function searchGithub(query: string, count: number): Promise<string> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.max(GITHUB_PER_PAGE_MIN, count)}`;
  const resp = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'omni-web-search/0.1' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    if (resp.status === 403) return 'GitHub API 限流（未认证 10 次/分钟）。稍后再试，或该需求请用通用搜索。';
    throw new Error(`GitHub API HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { items?: GhRepoItem[] };
  const items = data.items ?? [];
  if (items.length === 0) return `GitHub 上没有找到与「${query}」相关的仓库。`;
  return items
    .map((it, i) => {
      const lang = it.language ? ` · ${it.language}` : '';
      const stars = typeof it.stargazers_count === 'number' ? ` ⭐${it.stargazers_count}` : '';
      return `${i + 1}. ${it.full_name ?? '(未知)'}${lang}${stars}\n   ${it.html_url ?? ''}\n   ${(it.description ?? '(无描述)').trim()}`;
    })
    .join('\n\n');
}

/* ── 通用 web：Brave（配 key）→ DuckDuckGo HTML（免 key 兜底） ─────── */

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

async function searchBrave(query: string, count: number, apiKey: string): Promise<string | null> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const resp = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-subscription-token': apiKey,
      'user-agent': 'omni-web-search/0.1',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { web?: { results?: BraveWebResult[] } };
  const results = data?.web?.results ?? [];
  if (results.length === 0) return null;
  return results
    .map((r, i) => {
      const t = r.title?.trim() || '(无标题)';
      const u = r.url ?? '';
      const d = r.description?.trim() || '(无摘要)';
      return `${i + 1}. ${t}\n   ${u}\n   ${d}`;
    })
    .join('\n\n');
}

/** 解码常见 HTML 实体（DDG 摘要里会残留 &#x27; &amp; 等） */
function decodeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 从 DuckDuckGo HTML 端点抽取结果（标题 + URL + snippet；优先 result__a / result__snippet） */
export function parseDdgHtml(html: string): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = [];
  // 每个 result: <a class="result__a" href="//duckduckgo.com/l/?uddg=<enc>">Title</a> ... snippet
  const blockRe = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && out.length < 20) {
    const block = m[1];
    const aRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)<\/a>/i;
    const a = aRe.exec(block);
    if (!a) continue;
    let url = a[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '');
    // href 里 & 以 HTML 实体 &amp; 出现（含 DDG 追加的 &amp;rut= 追踪参数）——先转真实 & 再剥
    url = url.replace(/&amp;/g, '&');
    try {
      url = decodeURIComponent(url);
    } catch {
      /* 原样保留 */
    }
    // 剥掉 DDG 追加的追踪参数 &rut=...（非原 URL 一部分）
    url = url.split('&rut=')[0];
    // 过滤 DDG 广告跳转（y.js?ad_domain=...）与无协议垃圾
    if (/duckduckgo\.com\/y\.js|ad_domain=/i.test(url)) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeHtml(a[2].replace(/<[^>]+>/g, ''));
    const sRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
    const sm = sRe.exec(block);
    const snippet = decodeHtml(sm ? sm[1] : '').replace(/<[^>]+>/g, '');
    out.push({ title, url, snippet });
  }
  return out;
}

async function searchDdg(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  const html = await resp.text();
  const results = parseDdgHtml(html);
  if (results.length === 0) return `DuckDuckGo 上没有找到与「${query}」相关的结果。`;
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.snippet || '(无摘要)')}`)
    .join('\n\n');
}

/* ── 组装工具 ────────────────────────────────────────────────────── */

/** 创建 WebSearch 工具（方案 C：npm → GitHub → 通用（Brave/DuckDuckGo）） */
export function createWebSearchTool(apiKey?: string, opts?: { preferDdg?: boolean }): Tool {
  // Brave key 只用于通用网页搜索这层
  const braveKey = (opts?.preferDdg ? undefined : apiKey) ?? process.env.BRAVE_API_KEY;

  async function runWeb(query: string, count: number): Promise<string> {
    if (braveKey) {
      try {
        const r = await searchBrave(query, count, braveKey);
        if (r) return r;
      } catch {
        /* 落到 DuckDuckGo 兜底 */
      }
    }
    return searchDdg(query);
  }

  return {
    name: 'web_search',
    description:
      '搜索标题/URL/摘要。编程优先路由：查 npm 包→npm registry、GitHub 仓库→GitHub API（均免 key），' +
      '通用网页→DuckDuckGo（或已配的 Brave key）。适用于查最新信息、文档、包、仓库、报错等。' +
      '返回的每条含 URL，需完整内容再用 web_fetch 抓取。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（查包用包名，如 "lodash"；查仓库用仓库名/意图）' },
        count: { type: 'number', description: `返回结果条数（默认 ${WEB_SEARCH_DEFAULT_COUNT}，最大 ${WEB_SEARCH_MAX_COUNT}）` },
        site: { type: 'string', description: '限定站点/源：填 "github" 强制走 GitHub、"npmjs" 或 "npm" 强制走 npm；否则自动路由' },
      },
      required: ['query'],
    },
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return '错误：缺少搜索关键词 query';
      const count = Math.min(
        WEB_SEARCH_MAX_COUNT,
        Math.max(1, Math.floor(Number(args.count) || WEB_SEARCH_DEFAULT_COUNT))
      );
      const site = typeof args.site === 'string' ? args.site.trim() : '';
      let route = classifySearch(query, site);
      // site= npm/github 强制路由
      if (site === 'npm' || site === 'npmjs') route = 'npm';
      if (site === 'github') route = 'github';
      try {
        let result: string;
        if (route === 'npm') result = await searchNpm(query, count);
        else if (route === 'github') result = await searchGithub(query, count);
        else result = await runWeb(query, count);
        const joined = `搜索「${query}」结果${route === 'npm' ? '（npm）' : route === 'github' ? '（GitHub）' : '（网页）'}：\n\n${result}`;
        if (Buffer.byteLength(joined, 'utf8') <= WEB_SEARCH_MAX) return joined;
        return `${truncateUtf8ByBytes(joined, WEB_SEARCH_MAX)}\n\n…[结果过多已截断]`;
      } catch (err) {
        return `搜索失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
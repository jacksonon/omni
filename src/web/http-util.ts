/**
 * omni web 本地后端的静态资源与 HTTP 小工具（从 server.ts 抽出）：
 * 页面/图标读取（开发目录优先、内嵌 assets 回退）、MIME 表、JSON 响应与请求体读取。
 */
import type http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_ASSETS } from './assets.js';

/* ---------------- 静态资源 ---------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_WEB_DIR = path.resolve(__dirname, '..', '..', 'web');
const CWD_WEB_DIR = path.resolve(process.cwd(), 'web');

/** 读取页面资源：开发模式优先 web/ 目录（热更新），否则用内嵌 assets.ts */
export function getAsset(name: string): string | null {
  const candidates = process.env.OMNI_WEB_DIR ? [process.env.OMNI_WEB_DIR] : [SRC_WEB_DIR, CWD_WEB_DIR];
  for (const dir of candidates) {
    try {
      const f = path.join(dir, name);
      if (existsSync(f)) return readFileSync(f, 'utf8');
    } catch {
      // 继续尝试下一个候选
    }
  }
  return WEB_ASSETS[name] ?? null;
}

/** 读取应用图标 PNG：开发模式优先 web/icon.png，bundle 回退内嵌 base64 */
export function getIconPng(): Buffer | null {
  const candidates = process.env.OMNI_WEB_DIR ? [process.env.OMNI_WEB_DIR] : [SRC_WEB_DIR, CWD_WEB_DIR];
  for (const dir of candidates) {
    try {
      const f = path.join(dir, 'icon.png');
      if (existsSync(f)) return readFileSync(f);
    } catch {
      // 继续尝试下一个候选
    }
  }
  const embedded = WEB_ASSETS['icon.png'];
  if (embedded && embedded.startsWith('data:image/png;base64,')) {
    return Buffer.from(embedded.slice('data:image/png;base64,'.length), 'base64');
  }
  return null;
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/* ---------------- 工具函数 ---------------- */
export function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

export function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
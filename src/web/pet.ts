/** 宠物偏好和主动导入的图像；所有路径与文件名由服务端生成。 */
import type http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { json } from './http-util.js';
import { petState, emitEvent } from './state.js';

const MAX_BYTES = 20 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
interface PetAsset { id: string; name: string; rows: number; mime: string; url: string }
export interface PetSettings { enabled: boolean; selected: string }
function root(): string { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omni', 'pets'); }
async function atomic(file: string, content: string | Buffer): Promise<void> {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, content, { mode: 0o600 }); await rename(tmp, file); }
  finally { await unlink(tmp).catch(() => {}); }
}
export async function petSettings(): Promise<PetSettings> {
  try {
    const v = JSON.parse(await readFile(path.join(root(), 'settings.json'), 'utf8'));
    return { enabled: v.enabled !== false, selected: v.selected === 'omni' || ID.test(v.selected) ? v.selected : 'omni' };
  } catch { return { enabled: true, selected: 'omni' }; }
}
export async function petCatalog(): Promise<PetAsset[]> {
  const result: PetAsset[] = [{ id: 'omni', name: 'Omni 小猫', rows: 0, mime: 'image/svg+xml', url: '' }];
  const files = await readdir(root()).catch(() => [] as string[]);
  for (const file of files.filter(f => /^[a-f0-9]{32}\.json$/.test(f)).slice(0, 100)) {
    try {
      const p = JSON.parse(await readFile(path.join(root(), file), 'utf8'));
      if (ID.test(p.id) && file === `${p.id}.json` && [9, 11].includes(p.rows) && ['image/png', 'image/webp'].includes(p.mime)) {
        result.push({ id: p.id, name: String(p.name || '自定义宠物').slice(0, 80), rows: p.rows, mime: p.mime, url: `/api/pet/assets/${p.id}` });
      }
    } catch { /* 损坏的清单不会阻止内置宠物使用。 */ }
  }
  return result;
}
export async function petSnapshot(): Promise<Record<string, unknown>> {
  const [settings, pets] = await Promise.all([petSettings(), petCatalog()]);
  if (!pets.some(p => p.id === settings.selected)) settings.selected = 'omni';
  return { version: 1, cwd: process.cwd(), settings, pets, tasks: petState.snapshot().map(t => ({ ...t, cwd: process.cwd(), source: 'shared' })) };
}
export function spriteGeometry(buf: Buffer): { rows: number; mime: string } {
  if (buf.length > MAX_BYTES) throw new Error('宠物图像不能超过 20 MiB');
  let width = 0, height = 0, mime = '';
  if (buf.length >= 45 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buf.toString('ascii', 12, 16) === 'IHDR' && buf.toString('ascii', buf.length - 8, buf.length - 4) === 'IEND') {
    width = buf.readUInt32BE(16); height = buf.readUInt32BE(20); mime = 'image/png';
  } else if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.readUInt32LE(4) === buf.length - 8) {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + buf.readUIntLE(24, 3); height = 1 + buf.readUIntLE(27, 3); }
    else if (kind === 'VP8L' && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ' && buf[23] === 0x9d && buf[24] === 1 && buf[25] === 0x2a) {
      width = buf.readUInt16LE(26) & 0x3fff; height = buf.readUInt16LE(28) & 0x3fff;
    }
    mime = 'image/webp';
  }
  if (width !== 1536 || ![1872, 2288].includes(height)) throw new Error('需要透明 PNG/WebP 精灵图：1536×1872（v1）或 1536×2288（v2）');
  return { rows: height / 208, mime };
}
async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BYTES * 4 / 3 + 4096) throw new Error('宠物图像不能超过 20 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export async function handlePetRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/api/pet' && !pathname.startsWith('/api/pet/')) return false;
  try {
    if (pathname === '/api/pet' && req.method === 'GET') { json(res, 200, await petSnapshot()); return true; }
    if (pathname === '/api/pet/settings' && req.method === 'POST') {
      const input = await body(req), value = await petSettings();
      if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') throw new Error('显示开关无效'); value.enabled = input.enabled; }
      if (input.selected !== undefined) {
        if (!(await petCatalog()).some(p => p.id === input.selected)) throw new Error('宠物形象不存在');
        value.selected = String(input.selected);
      }
      await atomic(path.join(root(), 'settings.json'), JSON.stringify(value));
      emitEvent('pet.changed', {}); json(res, 200, await petSnapshot()); return true;
    }
    if (pathname === '/api/pet/read' && req.method === 'POST') {
      const input = await body(req);
      const revision = Number(input.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('读取水位无效');
      if (petState.read(String(input.sessionId), revision)) emitEvent('pet.changed', {});
      json(res, 200, { ok: true }); return true;
    }
    if (pathname === '/api/pet/import' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.dataUrl !== 'string' || !/^data:image\/(?:png|webp);base64,[A-Za-z0-9+/=]+$/.test(input.dataUrl)) throw new Error('仅接受 PNG/WebP 图像');
      if ((await petCatalog()).length > 100) throw new Error('宠物数量已达上限，请先删除不用的形象');
      const buf = Buffer.from(input.dataUrl.slice(input.dataUrl.indexOf(',') + 1), 'base64');
      const geometry = spriteGeometry(buf), id = createHash('sha256').update(buf).digest('hex').slice(0, 32);
      const manifest = { id, name: String(input.name || '自定义宠物').slice(0, 80), ...geometry };
      await atomic(path.join(root(), `${id}.image`), buf);
      await atomic(path.join(root(), `${id}.json`), JSON.stringify(manifest));
      emitEvent('pet.changed', {}); json(res, 201, { ...manifest, url: `/api/pet/assets/${id}` }); return true;
    }
    const id = pathname.slice('/api/pet/assets/'.length);
    if (pathname.startsWith('/api/pet/assets/') && ID.test(id)) {
      const asset = (await petCatalog()).find(p => p.id === id);
      if (!asset) { json(res, 404, { error: '宠物形象不存在' }); return true; }
      if (req.method === 'GET') {
        const buf = await readFile(path.join(root(), `${id}.image`));
        res.writeHead(200, { 'content-type': asset.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }); res.end(buf); return true;
      }
      if (req.method === 'DELETE') {
        await unlink(path.join(root(), `${id}.json`)); await unlink(path.join(root(), `${id}.image`)).catch(() => {});
        const settings = await petSettings();
        if (settings.selected === id) await atomic(path.join(root(), 'settings.json'), JSON.stringify({ ...settings, selected: 'omni' }));
        emitEvent('pet.changed', {}); json(res, 200, { ok: true }); return true;
      }
    }
    json(res, 404, { error: '宠物接口不存在' });
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '宠物操作失败' }); }
  return true;
}

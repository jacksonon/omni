/** 从终端同源点阵生成 PNG / ICO / ICNS，无额外图像依赖。bun run scripts/generate-brand-icons.ts */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { omniMarkFrame } from '../src/tui/omni-mark.js';

const dots: Array<[number, number]> = [];
const cells = [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8], [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]];
omniMarkFrame().forEach((row, y) => [...row].forEach((char, x) => {
  const bits = char === ' ' ? 0 : char.charCodeAt(0) - 0x2800;
  for (const [dx, dy, bit] of cells) if (bits & bit!) dots.push([x * 2 + dx!, y * 4 + dy!]);
}));
function uint32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  return Buffer.concat([uint32(data.length), body, uint32(crc32(body))]);
}
function png(size: number): Buffer {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const spacing = size * 0.022;
  const radius = spacing * 0.37;
  // 深色圆角底板，留足系统图标安全区；小尺寸适当加粗。
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const dx = Math.max(Math.abs(x + 0.5 - size / 2) - size * 0.29, 0);
    const dy = Math.max(Math.abs(y + 0.5 - size / 2) - size * 0.29, 0);
    const alpha = Math.max(0, Math.min(1, size * 0.17 - Math.hypot(dx, dy) + 0.5));
    rows.set([18, 24, 32, Math.round(255 * alpha)], offset);
  }
  for (const [dx, dy] of dots) {
    const cx = size / 2 + (dx - 18.5) * spacing;
    const cy = size / 2 + (dy - 17.5) * spacing;
    const r = Math.max(radius, size <= 32 ? 0.62 : radius);
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y < Math.min(size, cy + r + 1); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 1)); x < Math.min(size, cx + r + 1); x++) {
        const a = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
        const offset = y * (size * 4 + 1) + 1 + x * 4;
        for (let c = 0; c < 3; c++) rows[offset + c] = Math.round(rows[offset + c]! * (1 - a) + [161, 199, 220][c]! * a);
      }
    }
  }
  const ihdr = Buffer.concat([uint32(size), uint32(size), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 32, 64, 128, 256, 512, 1024];
const images = new Map(sizes.map(size => [size, png(size)]));
writeFileSync('web/icon.png', images.get(512)!);
writeFileSync('electron/icon.png', images.get(1024)!);
const icnsTypes = ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10'];
const icns = Buffer.concat(sizes.map((size, i) => Buffer.concat([Buffer.from(icnsTypes[i]!), uint32(images.get(size)!.length + 8), images.get(size)!])));
writeFileSync('electron/icon.icns', Buffer.concat([Buffer.from('icns'), uint32(icns.length + 8), icns]));
const icoSizes = [16, 32, 48, 256];
const icoImages = icoSizes.map(size => images.get(size) ?? png(size));
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const entries = icoSizes.map((size, i) => {
  const entry = Buffer.alloc(16);
  entry[0] = entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(icoImages[i]!.length, 8); entry.writeUInt32LE(offset, 12);
  offset += icoImages[i]!.length;
  return entry;
});
writeFileSync('electron/icon.ico', Buffer.concat([header, ...entries, ...icoImages]));
console.log('Omni 编织 O → Web PNG / Electron PNG, ICO, ICNS');

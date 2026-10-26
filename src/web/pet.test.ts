import test from 'node:test';
import assert from 'node:assert/strict';
import { spriteGeometry } from './pet.js';
test('精灵图真实格式、网格与大小限定，支持 WebP 两种无损头和 PNG', () => {
  const png = Buffer.alloc(45); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.write('IHDR',12); png.writeUInt32BE(1536,16); png.writeUInt32BE(1872,20); png.write('IEND',37);
  assert.deepEqual(spriteGeometry(png),{rows:9,mime:'image/png'});
  png.writeUInt32BE(2288,20); assert.equal(spriteGeometry(png).rows,11);
  png.writeUInt32BE(999999,16); assert.throws(()=>spriteGeometry(png),/1536/);
  const webp=Buffer.alloc(30);webp.write('RIFF');webp.writeUInt32LE(22,4);webp.write('WEBP',8);webp.write('VP8X',12);webp.writeUIntLE(1535,24,3);webp.writeUIntLE(1871,27,3);
  assert.deepEqual(spriteGeometry(webp),{rows:9,mime:'image/webp'});
  webp.write('VP8L',12);webp[20]=0x2f;webp.writeUInt32LE(1535|(2287<<14),21);assert.equal(spriteGeometry(webp).rows,11);
  assert.throws(()=>spriteGeometry(Buffer.from('<svg><script/></svg>')),/PNG/);
  assert.throws(()=>spriteGeometry(Buffer.alloc(20*1024*1024+1)),/20 MiB/);
});

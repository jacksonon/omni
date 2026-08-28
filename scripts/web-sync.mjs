/**
 * 同步 web/ 下的静态资源到 src/web/assets.ts（内嵌副本，供 bundle 单文件发布）。
 *
 * 用法：npm run web:sync（build/bundle 前自动执行；开发热更新不需要——server
 * 优先从 web/ 目录读取，assets.ts 只是发布兜底）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const names = ['index.html', 'app.js', 'style.css', 'vendor.js', 'markdown-renderer.js'];

const entries = [];
for (const n of names) {
  const text = await readFile(path.join(webDir, n), 'utf8');
  // 内联的 JS 里有反引号/模板串——用 JSON.stringify 完全转义，保证 TS 字符串字面量安全
  entries.push(`  ${JSON.stringify(n)}: ${JSON.stringify(text)},`);
}

// 应用图标（二进制）：以 data URL 形式内嵌，服务端 /icon.png 回退时解码返回
const iconBuf = await readFile(path.join(webDir, 'icon.png'));
entries.push(`  ${JSON.stringify('icon.png')}: ${JSON.stringify('data:image/png;base64,' + iconBuf.toString('base64'))},`);

const ts = `/**
 * Web UI 静态资源（web/ 目录的嵌入副本，bundle 单文件发布时无需外部文件）。
 *
 * ⚠️ 自动生成——修改请编辑 web/ 下的源文件后运行 \`npm run web:sync\`。
 * 服务端运行时优先读 web/ 目录（开发热更新），缺失时才回退到这里。
 */
export const WEB_ASSETS: Record<string, string> = {
${entries.join('\n')}
};
`;

const outFile = path.join(root, 'src', 'web', 'assets.ts');
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, ts, 'utf8');
console.log(`web:sync ✓ ${names.join(', ')} → ${path.relative(root, outFile)} (${ts.length} 字节)`);
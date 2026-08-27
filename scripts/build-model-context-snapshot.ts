/**
 * 模型能力快照生成器（npm run models:snapshot）——TS 版，复用
 * src/config/model-context-builder.ts 的纯逻辑（拉取/归一化/建表/序列化），
 * 开发者用它在在线拉取 models.dev 后重建**仓库内置快照**并提交进 repo。
 *
 * 注意：这是「开发者维护内置快照」的入口；普通用户更新用运行时命令
 * `/models refresh`（CLI / TUI / Web 三端都有），写用户数据目录不污染仓库。
 *
 * 用法：npm run models:snapshot [-- <输出路径>]
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildSnapshotTable,
  fetchModelsDevData,
  MODELS_DEV_URL,
  serializeSnapshotTs,
} from '../src/config/model-context-builder.js';

const OUT_FILE = path.resolve(process.argv[2] ?? 'src/config/model-context-snapshot.ts');

async function main(): Promise<void> {
  console.log(`⏳ 拉取 ${MODELS_DEV_URL} …`);
  const api = await fetchModelsDevData();
  const generatedAt = new Date().toISOString();
  const table = buildSnapshotTable(api);
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, serializeSnapshotTs(table, { sourceUrl: MODELS_DEV_URL, generatedAt }), 'utf8');
  const sizeKB = Math.round(statSync(OUT_FILE).size / 1024);
  console.log(`✅ 已写出 ${path.relative(process.cwd(), OUT_FILE)}：${table.size} 个模型 · ${sizeKB} KB · 生成时间 ${generatedAt}`);
  console.log('   白名单更新：src/config/model-context-builder.ts 顶部 PROVIDERS 数组加一行；提交后全用户受益。');
}

main().catch((err) => {
  console.error(`❌ 快照生成失败：${err instanceof Error ? err.message : err}`);
  console.error('   提示：网络不可用时保留仓库内既有快照（快照进 repo，离线可用）。');
  process.exit(1);
});

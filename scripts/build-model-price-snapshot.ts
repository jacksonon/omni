/**
 * 模型单价快照生成器（npm run prices:snapshot）——复用
 * src/config/model-price-builder.ts 的纯逻辑（拉取/归一化/建表/序列化），
 * 开发者用它在在线拉取 OpenRouter 公开模型表后重建**仓库内置快照**并提交进 repo。
 *
 * 数据源：GET https://openrouter.ai/api/v1/models（免费 no-key，{data:[…]}）。
 * 归一化：{ p: 输入 $/1M, o: 输出 $/1M, c: context, m: max_output, intel: 智能指数 }
 * （pricing 字符串 $/token × 1e6；缺失字段缺省不写；键为原始 qualified id 小写）。
 *
 * 用法：npm run prices:snapshot [-- <输出路径>]
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildPriceTable,
  fetchOpenRouterData,
  OPENROUTER_MODELS_URL,
  serializePriceTs,
} from '../src/config/model-price-builder.js';

const OUT_FILE = path.resolve(process.argv[2] ?? 'src/config/model-price-snapshot.ts');

async function main(): Promise<void> {
  console.log(`⏳ 拉取 ${OPENROUTER_MODELS_URL} …`);
  const api = await fetchOpenRouterData();
  const generatedAt = new Date().toISOString();
  const table = buildPriceTable(api);
  // 关键字断言：规模兜底（全量表应远超 300）+ 锚点模型单价（gpt-4o 输入 ≈ $2.5/1M；
  // OpenRouter 调价时放宽到 ±0.5，超出即失败提醒人工确认而非静默写脏快照）
  if (table.size <= 300) {
    throw new Error(`条目过少（${table.size} ≤ 300），疑似拉取不完整，拒绝写快照`);
  }
  const anchor = table.get('openai/gpt-4o')?.p;
  if (anchor === undefined || Math.abs(anchor - 2.5) > 0.5) {
    throw new Error(`锚点 openai/gpt-4o 输入单价异常（p=${anchor}，期望 ≈2.5），拒绝写快照`);
  }
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, serializePriceTs(table, { sourceUrl: OPENROUTER_MODELS_URL, generatedAt }), 'utf8');
  const sizeKB = Math.round(statSync(OUT_FILE).size / 1024);
  console.log(`✅ 已写出 ${path.relative(process.cwd(), OUT_FILE)}：${table.size} 个模型 · ${sizeKB} KB · 生成时间 ${generatedAt}`);
  console.log(`   锚点校验：openai/gpt-4o p=${anchor} $/1M · 条目 ${table.size}（>300 通过）`);
}

main().catch((err) => {
  console.error(`❌ 单价快照生成失败：${err instanceof Error ? err.message : err}`);
  console.error('   提示：网络不可用时保留仓库内既有快照（快照进 repo，离线可用）。');
  process.exit(1);
});

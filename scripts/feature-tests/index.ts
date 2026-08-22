/**
 * 功能回归测试运行器：汇总执行各功能模块，输出量化报告。
 *
 * 用法：npm run test:features
 * 报告：feature-report.json（每模块通过/失败 + 断言数 + 完成率）
 *
 * 设计目标：每个用例有明确量化断言（通过/失败 + 断言计数），
 * 后续根据报告即可确定功能是否正常。
 */
import { TestSuite, type TestResult, writeReport } from './framework.js';
import { memorySuite } from './memory.js';
import { safetySuite } from './safety.js';
import { mcpSuite } from './mcp.js';
import { skillsSuite } from './skills.js';
import { configSuite } from './config.js';
import { coreSuite } from './core.js';
import { sessionSuite } from './session.js';
import { memoryEnhanceSuite } from './memory-enhance.js';
import { rewindSuite } from './rewind.js';

console.log('🧪 Omni 功能回归测试');
console.log('═══════════════════════════════════════════');

async function main(): Promise<void> {
  const suites: TestSuite[] = [
    configSuite(),
    sessionSuite(),
    memorySuite(),
    memoryEnhanceSuite(),
    safetySuite(),
    mcpSuite(),
    skillsSuite(),
    rewindSuite(),
    coreSuite(),
  ];

  const started = Date.now();
  const moduleResults: { name: string; total: number; passed: number; ms: number }[] = [];
  const details: { module: string; case: string; ok: boolean; ms: number; asserts: number; failed: number; error?: string }[] = [];

  let totalPassed = 0;
  let totalCases = 0;

  for (const suite of suites) {
    const moduleStart = Date.now();
    const results: TestResult[] = await suite.run();
    const ms = Date.now() - moduleStart;
    const passed = results.filter((r) => r.ok).length;
    totalPassed += passed;
    totalCases += results.length;
    moduleResults.push({ name: suite.name, total: results.length, passed, ms });
    for (const r of results) {
      details.push({ module: suite.name, case: r.name, ok: r.ok, ms: r.ms, asserts: r.asserts, failed: r.failed, error: r.error });
    }
  }

  const ms = Date.now() - started;
  console.log('\n═══════════════════════════════════════════');
  console.log('📊 汇总');
  for (const m of moduleResults) {
    const rate = m.total ? ((m.passed / m.total) * 100).toFixed(0) : '0';
    console.log(`  ${m.passed === m.total ? '✅' : '❌'} ${m.name}: ${m.passed}/${m.total}（${rate}%）· ${m.ms}ms`);
  }
  const rate = totalCases ? ((totalPassed / totalCases) * 100).toFixed(0) : '0';
  writeReport(
    {
      runAt: new Date().toISOString(),
      modules: moduleResults,
      total: totalCases,
      passed: totalPassed,
      ms,
      details,
    },
    totalPassed === totalCases ? 0 : 1
  );
}

main().catch((err) => {
  console.error('功能测试崩溃：', err instanceof Error ? err.message : err);
  process.exit(1);
});
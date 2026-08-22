/**
 * 功能测试框架：轻量 describe/it/assert 测试基础设施。
 * 每个功能模块导出 TestSuite，runner 汇总执行 + 输出量化报告。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TestCase {
  name: string;
  fn: () => Promise<void> | void;
}

export interface TestResult {
  name: string;
  ok: boolean;
  ms: number;
  asserts: number;
  failed: number;
  error?: string;
}

export class TestSuite {
  public name: string;
  private cases: TestCase[] = [];
  private currentAsserts = 0;
  private currentFailed = 0;

  constructor(name: string) {
    this.name = name;
  }

  /** 注册一条测试用例 */
  test(name: string, fn: () => Promise<void> | void): void {
    this.cases.push({ name, fn });
  }

  /** 断言（量化计数） */
  assert(cond: boolean, msg: string, detail?: unknown): void {
    this.currentAsserts++;
    if (!cond) {
      this.currentFailed++;
      const d = detail !== undefined ? `: ${JSON.stringify(detail)}` : '';
      console.error(`    ✗ ${msg}${d}`);
    } else {
      console.log(`    ✓ ${msg}`);
    }
  }

  /** 运行所有测试用例，返回汇总结果 */
  async run(): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const total = this.cases.length;
    let passed = 0;
    console.log(`\n  📦 ${this.name}（${total} 用例）`);
    for (const tc of this.cases) {
      this.currentAsserts = 0;
      this.currentFailed = 0;
      const start = Date.now();
      try {
        await tc.fn();
        const ms = Date.now() - start;
        const ok = this.currentFailed === 0;
        if (ok) passed++;
        console.log(`    ${ok ? '✅' : '❌'} ${tc.name}（${ms}ms · ${this.currentAsserts} 断言${this.currentFailed ? ` · ${this.currentFailed} 失败` : ''}）`);
        results.push({ name: tc.name, ok, ms, asserts: this.currentAsserts, failed: this.currentFailed });
      } catch (err) {
        const ms = Date.now() - start;
        const error = err instanceof Error ? err.message : String(err);
        console.error(`    ❌ ${tc.name}（${ms}ms · ${this.currentAsserts} 断言）\n      ✗ 异常: ${error}`);
        results.push({ name: tc.name, ok: false, ms, asserts: this.currentAsserts, failed: this.currentFailed + 1, error });
      }
    }
    return results;
  }
}

/** 汇总报告 */
export interface FeatureReport {
  runAt: string;
  modules: { name: string; total: number; passed: number; ms: number }[];
  total: number;
  passed: number;
  ms: number;
  details: { module: string; case: string; ok: boolean; ms: number; asserts: number; failed: number; error?: string }[];
}

/** 写入报告 + 退出 */
export function writeReport(report: FeatureReport, exitCode: number): void {
  const file = path.join(process.cwd(), 'feature-report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n📊 ${report.passed}/${report.total} 用例通过（${(report.passed / report.total * 100).toFixed(0)}%）`);
  console.log(`报告已写入 ${file}`);
  process.exit(exitCode);
}
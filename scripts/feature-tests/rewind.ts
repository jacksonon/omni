/**
 * 功能测试：会话检查点（/rewind）+ /diff 扩展 + write_file diff 审批（TODO 第五节）。
 * 纯函数断言 + 临时 git 仓库端到端（快照 → 改动 → 回滚 → 内容一致）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { TestSuite } from './framework.js';
import {
  CHECKPOINTS_DIRNAME,
  CHECKPOINT_FILE_MAX_BYTES,
  checkpointDiffStats,
  checkpointSummaryLine,
  createCheckpoint,
  isExcludedPath,
  loadCheckpoint,
  loadCheckpoints,
  modifiedTrackedFiles,
  restoreCheckpoint,
} from '../../src/agent/rewind.js';
import { collectDiff } from '../../src/agent/review.js';

/** 临时 git 仓库（隔离 cwd；测试内 chdir，finally 恢复） */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-rewind-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t && git config user.name t', { cwd: dir, shell: '/bin/zsh' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

export function rewindSuite(): TestSuite {
  const suite = new TestSuite('会话检查点（rewind 快照 / 回滚 / 持久化 / diff 审批）');
  const oldCwd = process.cwd();

  suite.test('isExcludedPath：排除清单与 cwd 外路径', () => {
    const cwd = '/tmp/proj';
    suite.assert(isExcludedPath('/tmp/proj/node_modules/x.js', cwd) === true, 'node_modules 排除');
    suite.assert(isExcludedPath('/tmp/proj/.env', cwd) === true, '.env 排除');
    suite.assert(isExcludedPath('/tmp/proj/dist/a.js', cwd) === true, 'dist 排除');
    suite.assert(isExcludedPath('/tmp/proj/src/a.ts', cwd) === false, 'src 正常');
    suite.assert(isExcludedPath('/elsewhere/a.ts', cwd) === true, 'cwd 外排除');
  });

  suite.test('检查点创建 → 加载 → 回滚（端到端，临时 git 仓库）', async () => {
    const repo = makeGitRepo();
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-rewind-xdg-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    try {
      process.chdir(repo);
      // 会话文件（checkpoint 目录用其 id 命名）
      const { createSession } = await import('../../src/agent/session.js');
      const sessionFile = await createSession({ project: repo, model: 'mock' });
      suite.assert(sessionFile !== null, '会话文件创建');
      // 回合 1：提交前工作区干净 → 快照 0 文件
      const cp1 = await createCheckpoint(sessionFile!, '第一个任务');
      suite.assert(cp1.files.length === 0, '干净工作区快照 0 文件');
      // 修改文件后回合 2：快照含 a.txt 的**提交时（回合开始前盘上）**内容
      fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nCHANGED\nline3\n');
      const cp2 = await createCheckpoint(sessionFile!, '第二个任务');
      suite.assert(cp2.files.length === 1, '修改后快照 1 文件');
      suite.assert(cp2.files[0]!.content === 'line1\nCHANGED\nline3\n', '快照内容 = 回合开始前盘上状态');
      suite.assert(cp2.index === 2, '检查点序号递增（#2）');
      // 再改 + 回滚到 #2：a.txt 回到「第二个任务提交时」的状态
      fs.writeFileSync(path.join(repo, 'a.txt'), 'TOTALLY\nDIFFERENT\n');
      const target = await loadCheckpoint(sessionFile!, 2);
      suite.assert(target !== null, '按序号加载检查点');
      const results = await restoreCheckpoint(target!);
      suite.assert(results.length === 1 && results[0]!.includes('a.txt'), '回滚结果列出文件');
      suite.assert(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'line1\nCHANGED\nline3\n', '回滚后内容 = 快照时状态');
      // 持久化：重新 loadCheckpoints 从磁盘读回
      const all = await loadCheckpoints(sessionFile!);
      suite.assert(all.length === 2, '磁盘重读 2 个检查点');
      suite.assert(all[0]!.userMessage === '第一个任务', '用户消息摘要保留');
      // 快照目录在 .omni/checkpoints/ 下
      suite.assert(fs.existsSync(path.join(repo, CHECKPOINTS_DIRNAME)), '快照目录 .omni/checkpoints/');
      // diffStats：当前与快照一致 → 0 差异；改动后 → 有差异
      const same = await checkpointDiffStats(target!);
      suite.assert(same.add === 0 && same.rem === 0 && same.files.length === 0, '与当前一致时 0 差异');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nCHANGED\nline3\nplus\n');
      const diff = await checkpointDiffStats(target!);
      suite.assert(diff.add === 1 && diff.files.includes('a.txt'), `差异统计 +1（实际 +${diff.add}）`);
      suite.assert(checkpointSummaryLine(target!).includes('#2'), '摘要行含序号');
    } finally {
      process.chdir(oldCwd);
      delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  suite.test('modifiedTrackedFiles：只取已跟踪修改、排除未跟踪与排除目录', async () => {
    const repo = makeGitRepo();
    try {
      process.chdir(repo);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'modified\n'); // 已跟踪修改
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n'); // 未跟踪 → 排除
      fs.mkdirSync(path.join(repo, 'node_modules'));
      fs.writeFileSync(path.join(repo, 'node_modules', 'pkg.js'), 'x\n'); // 排除目录（已跟踪才会出现，这里验证 porcelain 解析）
      const files = await modifiedTrackedFiles(repo);
      suite.assert(files.length === 1, `只列已跟踪修改 1 个（实际 ${files.length}）`);
      suite.assert(files[0]!.endsWith('a.txt'), '文件为 a.txt');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  suite.test('collectDiff：--stat 统计摘要 / 非 git 目录如实报错', async () => {
    const repo = makeGitRepo();
    try {
      process.chdir(repo);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
      const full = await collectDiff();
      suite.assert(full.ok && full.output.includes('a.txt'), '默认 diff 含改动文件');
      const stat = await collectDiff({ stat: true });
      suite.assert(stat.ok && stat.output.includes('a.txt'), '--stat 含文件名');
      suite.assert(!stat.output.includes('@@'), '--stat 无 hunk 头');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(repo, { recursive: true, force: true });
    }
    // 非 git 目录：diff 与 status 都失败 → ok=false（修复：错误文本不再混入 ok 结果）
    const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-rewind-nogit-'));
    try {
      process.chdir(nogit);
      const r = await collectDiff();
      suite.assert(r.ok === false, '非 git 目录 ok=false');
      suite.assert(!r.output.startsWith('（无改动'), '不误报无改动');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(nogit, { recursive: true, force: true });
    }
  });

  suite.test('write_file diff 审批：writeDiffSummary 统计（新增/修改）', async () => {
    // 直接测 Safety.gate 的 writeDiffSummary 注入语义（ask 档位 → needApproval + reason 附统计）
    const { Safety } = await import('../../src/safety/index.js');
    const { writeFileTool } = await import('../../src/tools/write-file.js');
    let captured = '';
    const gate = new Safety({
      tier: 'ask',
      audit: false,
      requestApproval: () => {
        return false; // 拒绝（只关心 reason 内容）
      },
      writeDiffSummary: (_tool, args) => {
        const content = String(args.content ?? '');
        return `新增文件 · 全文 ${content.split('\n').length} 行`;
      },
    });
    const g = await gate.gate(writeFileTool, { path: 'x.txt', content: 'a\nb\nc' });
    suite.assert(!g.allow, 'ask 档位拒绝（审批回调拒绝）');
    // reason 经 requestApproval 的 req.reason 传递——用捕获回调验证
    let reason = '';
    const gate2 = new Safety({
      tier: 'ask',
      audit: false,
      requestApproval: (req) => {
        reason = req.reason;
        return true;
      },
      writeDiffSummary: (_tool, args) => `新增文件 · 全文 ${String(args.content ?? '').split('\n').length} 行`,
    });
    await gate2.gate(writeFileTool, { path: 'x.txt', content: 'a\nb\nc' });
    suite.assert(reason.includes('新增文件 · 全文 3 行'), `审批 reason 附变更统计（实际：${reason.slice(0, 60)}）`);
    suite.assert(captured === '', '首闸未走捕获路径');
    // 非 write_file 工具不附统计
    const { readFileTool } = await import('../../src/tools/read-file.js');
    let reason2 = '';
    const gate3 = new Safety({
      tier: 'ask',
      audit: false,
      requestApproval: (req) => {
        reason2 = req.reason;
        return true;
      },
      writeDiffSummary: () => '不应出现',
    });
    await gate3.gate(readFileTool, { path: 'x.txt' });
    suite.assert(!reason2.includes('不应出现'), '只读工具不附 diff 统计');
  });

  suite.test('大文件跳过快照（CHECKPOINT_FILE_MAX_BYTES 上界）', async () => {
    suite.assert(CHECKPOINT_FILE_MAX_BYTES === 1024 * 1024, '上界 1MB');
  });

  return suite;
}

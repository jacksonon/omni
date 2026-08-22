/**
 * 功能测试：记忆与上下文增强（第三节）。
 * 覆盖：override/fallback 发现、合计上限、TTL、渐进披露工具、项目记忆待提交、repo map、新工具。
 * 纯函数 + mock server 端到端。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestSuite } from './framework.js';
import {
  findAgentsFiles,
  loadProjectMemory,
  applyMemoryTTL,
  appendGlobalMemory,
  globalMemoryPath,
  PROJECT_MEMORY_TOTAL_MAX_BYTES,
} from '../../src/agent/memory.js';
import { searchMemory } from '../../src/tools/memory-tools.js';
import { buildRepoMap, extractSymbol } from '../../src/agent/repomap.js';
import { htmlToText, urlAllowed } from '../../src/tools/web-fetch.js';
import { detectCheckCommand } from '../../src/tools/diagnose.js';
import { createTodoWriteTool } from '../../src/tools/todo.js';

export function memoryEnhanceSuite(): TestSuite {
  const suite = new TestSuite('记忆与上下文增强（override/合计/TTL/渐进披露/repo map/工具）');

  suite.test('override + fallback 文件名发现', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ovr-'));
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    try {
      // fallback：无 AGENTS.md → 用 TEAM_GUIDE.md
      fs.writeFileSync(path.join(root, 'TEAM_GUIDE.md'), '# Team Guide\n- 团队规范\n');
      const files1 = findAgentsFiles(root);
      suite.assert(files1.length === 1 && files1[0].endsWith('TEAM_GUIDE.md'), 'fallback TEAM_GUIDE.md 被发现');
      const mem1 = await loadProjectMemory(root);
      suite.assert(mem1.length === 1 && mem1[0].content.includes('团队规范'), 'fallback 内容加载');
      // override：AGENTS.override.md 替代 AGENTS.md
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# AGENTS\n- 常规\n');
      fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '# Override\n- 个人分支\n');
      const files2 = findAgentsFiles(root);
      suite.assert(files2.length === 1 && files2[0].endsWith('AGENTS.override.md'), 'override 优先于 AGENTS.md');
      const mem2 = await loadProjectMemory(root);
      suite.assert(mem2[0].content.includes('个人分支') && !mem2[0].content.includes('常规'), 'override 内容替代');
      // 子目录普通 AGENTS.md（嵌套：override 外层 + AGENTS 内层并存）
      fs.writeFileSync(path.join(root, 'sub', 'AGENTS.md'), '# 子目录\n- 局部\n');
      const files3 = findAgentsFiles(path.join(root, 'sub'));
      suite.assert(files3.length === 2, 'override 与子目录 AGENTS 并存（2 层）');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  suite.test('嵌套合计上限：超 32KB 从外层裁', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-total-'));
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    try {
      // 外层大文件（30KB）+ 内层大文件（30KB）→ 合计 60KB > 32KB，外层被裁
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '长'.repeat(10_000)); // ~30KB
      fs.writeFileSync(path.join(root, 'sub', 'AGENTS.md'), '内'.repeat(10_000)); // ~30KB
      const mems = await loadProjectMemory(path.join(root, 'sub'));
      suite.assert(mems.length >= 1, '至少保留一层');
      // 内层（sub）权重高应保留
      suite.assert(mems[0].path.includes('sub'), '内层保留');
      const total = mems.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
      suite.assert(total <= PROJECT_MEMORY_TOTAL_MAX_BYTES + 500, `合计在预算内（${total} ≤ ${PROJECT_MEMORY_TOTAL_MAX_BYTES}）`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  suite.test('记忆 TTL：超期段落移入归档', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ttl-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    try {
      const gpath = globalMemoryPath();
      fs.mkdirSync(path.dirname(gpath), { recursive: true });
      const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 200 天前
      const recent = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(gpath, `# 手写头部\n- 固定偏好\n\n## 会话记忆（${oldDate}）\n\n- 旧偏好 A\n\n## 会话记忆（${recent}）\n\n- 新偏好 B\n`);
      // 触发一次追加（模拟会话结束），触发 TTL 归档
      const ok = await appendGlobalMemory('- 本次新偏好');
      suite.assert(ok === true, '追加成功');
      const raw = fs.readFileSync(gpath, 'utf8');
      suite.assert(raw.includes('旧偏好 A'), '旧条目仍保留（TTL 只归档段落不删条目——去重防重复学习）');
      suite.assert(raw.includes('新偏好 B'), '近期段落保留');
      suite.assert(raw.includes('本次新偏好'), '新条目追加');
      // applyMemoryTTL 纯函数：过期段落分离
      const secOld = `## 会话记忆（${oldDate}）\n\n- x\n`;
      const secNew = `## 会话记忆（${recent}）\n\n- y\n`;
      const { kept, expired } = applyMemoryTTL([secOld, secNew]);
      suite.assert(kept.length === 1 && expired.length === 1, 'TTL 纯函数分离过期/保留');
    } finally {
      process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  suite.test('渐进披露：memory_search 关键词检索（含排序）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ms-'));
    fs.mkdirSync(path.join(root, '.git'));
    try {
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 项目\n- 构建命令：npm run dev\n- 测试命令：npm test\n- 架构约定：src/agent 放核心\n');
      // 从临时目录搜索（discover 以 cwd 为准，用显式路径）
      const hits = await searchMemory('npm run dev', root);
      suite.assert(hits.length === 1, '精确命中 1 处');
      suite.assert(hits[0].text.includes('npm run dev'), '命中内容');
      // 多关键词 AND：同时命中"npm 和 dev"
      const hits2 = await searchMemory('npm dev', root);
      suite.assert(hits2.length >= 1, '多关键词 AND 命中');
      // 无命中
      const hits3 = await searchMemory('不存在的词xyz', root);
      suite.assert(hits3.length === 0, '无命中返回空');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  suite.test('项目级会话自动写入：pending 片段 + memory-apply 应用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-pm-'));
    fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
    const { projectMemoryPendingPath, applyProjectMemoryPending } = await import('../../src/agent/memory.js');
    try {
      const pending = projectMemoryPendingPath(root);
      fs.writeFileSync(pending, '- 构建命令：npm run build\n- 架构：src/main 为入口\n');
      // 无 AGENTS.md 时应用 → 新建
      const res = await applyProjectMemoryPending(root);
      suite.assert(res.ok === true, '应用成功');
      const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
      suite.assert(agents.includes('npm run build'), '内容已写入 AGENTS.md');
      suite.assert(!fs.existsSync(pending), 'pending 片段已清除');
      // 再应用无 pending → 报错
      const res2 = await applyProjectMemoryPending(root);
      suite.assert(res2.ok === false, '无 pending 时应用失败提示');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  suite.test('repo map：符号提取 + 地图生成', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-rm-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function greet(name: string) {\n  return `hi ${name}`;\n}\nconst VERSION = "1.0";\n');
      fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export class Helper {\n  run() {}\n}\n');
      // 符号提取
      suite.assert(extractSymbol('export function greet(name)') === 'greet', '函数符号提取');
      suite.assert(extractSymbol('export class Helper {') === 'Helper', '类符号提取');
      suite.assert(extractSymbol('export const VERSION = "1"') === 'VERSION', '常量符号提取');
      suite.assert(extractSymbol('const x = 1 + 2;') === 'x', '赋值符号提取');
      suite.assert(extractSymbol('return result;') === null, '普通行不提取');
      // 地图生成（相对路径 + 符号）
      const map = await buildRepoMap(root, { maxSymbols: 20 });
      suite.assert(map.includes('src/a.ts'), '地图含文件 a');
      suite.assert(map.includes('greet'), '地图含符号 greet');
      suite.assert(map.includes('Helper'), '地图含类 Helper');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  suite.test('WebFetch 工具：HTML 转文本 + 域名过滤', async () => {
    const html = '<html><head><style>a{}</style></head><body><h1>标题</h1><p>正文内容</p><a href="https://x.com">链接</a><script>bad()</script></body></html>';
    const text = htmlToText(html);
    suite.assert(text.includes('标题'), '标题保留');
    suite.assert(text.includes('正文内容'), '正文保留');
    suite.assert(text.includes('链接（https://x.com）'), '链接转文本');
    suite.assert(!text.includes('bad()'), 'script 内容剥除');
    suite.assert(!text.includes('<p>'), '标签剥除');
    // 域名过滤
    suite.assert(urlAllowed('https://example.com/page', undefined) === true, '无白名单全部允许');
    suite.assert(urlAllowed('https://example.com/page', ['example.com']) === true, '域名命中');
    suite.assert(urlAllowed('https://sub.example.com/page', ['example.com']) === true, '子域名命中');
    suite.assert(urlAllowed('https://evil.com/x', ['example.com']) === false, '域名不匹配拒绝');
    suite.assert(urlAllowed('not a url', ['example.com']) === false, '非法 URL 拒绝');
  });

  suite.test('TodoWrite 工具：状态维护', async () => {
    const runOpts: { todoList?: unknown[] } = {};
    const tool = createTodoWriteTool(runOpts as never);
    const res = await tool.execute({
      todos: [
        { content: '写测试', status: 'in_progress' },
        { content: '跑测试', status: 'pending' },
      ],
    });
    suite.assert(res.includes('共 2 项'), '返回汇总');
    suite.assert(res.includes('写测试'), '含任务内容');
    suite.assert(Array.isArray(runOpts.todoList) && runOpts.todoList.length === 2, '状态已写入');
    suite.assert(runOpts.todoList![0].status === 'in_progress', '状态正确');
    // 更新为完成
    await tool.execute({ todos: [{ content: '写测试', status: 'completed' }] });
    suite.assert(runOpts.todoList!.length === 1 && runOpts.todoList![0].status === 'completed', '更新为完成');
  });

  suite.test('diagnose 工具：探测检查命令', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-dia-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest' } }));
      const cmd = detectCheckCommand(root);
      suite.assert(cmd !== null && cmd.name === 'typecheck', '优先 typecheck');
      // 无 typecheck → 降级 lint/test
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      const cmd2 = detectCheckCommand(root);
      suite.assert(cmd2 !== null && cmd2.name === 'test', '降级 test');
      // 无脚本 → null
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      suite.assert(detectCheckCommand(root) === null, '无脚本返回 null');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  return suite;
}
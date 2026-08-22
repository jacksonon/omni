/**
 * 功能测试：记忆系统（嵌套 AGENTS.md + 全局记忆 + autoMemory 去重合并）。
 * 纯函数断言（import 源文件），无需网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestSuite } from './framework.js';
import {
  findAgentsFiles,
  loadProjectMemory,
  memoryMessage,
  MEMORY_PREFIX,
  globalMemoryDir,
  globalMemoryPath,
  normalizeMemoryItem,
  topicKey,
  dedupMemoryItems,
  extractMemoryItems,
} from '../../src/agent/memory.js';
import { prepareContext } from '../../src/agent/context.js';

export function memorySuite(): TestSuite {
  const suite = new TestSuite('记忆系统（嵌套 AGENTS.md / 全局 / 去重合并）');

  suite.test('嵌套 AGENTS.md：多层级发现 + 加载 + 注入顺序', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-memory-'));
    fs.mkdirSync(path.join(root, 'repo', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'repo', '.git'));
    fs.writeFileSync(path.join(root, 'repo', 'AGENTS.md'), '# 外层\n- 整体约定\n');
    fs.writeFileSync(path.join(root, 'repo', 'src', 'AGENTS.md'), '# 内层\n- 子目录约定\n');

    // 发现：从内到外两个层级
    const files = findAgentsFiles(path.join(root, 'repo', 'src'));
    suite.assert(files.length === 2, '发现两个层级');
    suite.assert(files[0].endsWith(path.join('src', 'AGENTS.md')), '内层在前');
    suite.assert(files[1].endsWith(path.join('repo', 'AGENTS.md')), '外层在后');

    // 加载
    const mems = await loadProjectMemory(path.join(root, 'repo', 'src'));
    suite.assert(mems.length === 2, '加载两个层级');
    suite.assert(mems[0].content.includes('子目录约定'), '内层内容');

    // 注入顺序：外层靠 system、内层贴近 user
    const msgs = [{ role: 'user' as const, content: '你好' }];
    const oldCwd = process.cwd();
    process.chdir(path.join(root, 'repo', 'src'));
    await prepareContext({} as never, 'mock', msgs, {
      agentsFile: true, globalAgentsFile: false, preloadFiles: false, summarizeAt: 0,
    });
    process.chdir(oldCwd);
    const memMsgs = msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith(MEMORY_PREFIX));
    suite.assert(memMsgs.length === 2, '注入两条记忆');
    suite.assert(String(memMsgs[0].content).includes('整体约定'), '外层在前（靠 system）');
    suite.assert(String(memMsgs[1].content).includes('子目录约定'), '内层在后（贴近 user）');

    // 幂等：再次 prepareContext 不重复注入
    await prepareContext({} as never, 'mock', msgs, {
      agentsFile: true, globalAgentsFile: false, preloadFiles: false, summarizeAt: 0,
    });
    suite.assert(msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith(MEMORY_PREFIX)).length === 2, '幂等不重复注入');
    fs.rmSync(root, { recursive: true, force: true });
  });

  suite.test('嵌套 AGENTS.md：单层（无子目录）回归 + git 根边界', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-memory2-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 项目\n- 整体\n');
    // 子目录无 AGENTS.md → 只发现一层
    fs.mkdirSync(path.join(root, 'src'));
    const files = findAgentsFiles(path.join(root, 'src'));
    suite.assert(files.length === 1, '无子目录时只发现一层');
    const mems = await loadProjectMemory(path.join(root, 'src'));
    suite.assert(mems.length === 1 && mems[0].content.includes('整体'), '加载一层');
    // git 根边界：不向上越过 .git
    fs.rmSync(root, { recursive: true, force: true });
  });

  suite.test('记忆截断：超长文件按字节截断 + read_file 提示', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-memory3-'));
    fs.mkdirSync(path.join(root, '.git'));
    // 3 万汉字 ≈ 90KB > 40KB 上限（用中文确保按字节计算生效）
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '长'.repeat(30_000));
    const mems = await loadProjectMemory(root);
    suite.assert(mems.length === 1, '加载超长文件');
    suite.assert(Buffer.byteLength(mems[0].content, 'utf8') <= 40 * 1024 + 500, '按字节截断（40KB 内）');
    suite.assert(mems[0].content.includes('记忆文件过长已截断'), '截断提示');
    fs.rmSync(root, { recursive: true, force: true });
  });

  suite.test('全局记忆：XDG 路径 + 级联顺序（全局在前、项目在后）', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-global-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    const dir = globalMemoryDir();
    const file = globalMemoryPath();
    suite.assert(dir === path.join(fakeXdg, 'omni'), '全局目录 XDG 感知');
    suite.assert(file.endsWith(path.join('omni', 'AGENTS.md')), '全局文件路径');
    process.env.XDG_CONFIG_HOME = oldXdg;
    fs.rmSync(fakeXdg, { recursive: true, force: true });
  });

  suite.test('偏好去重/矛盾合并：extract + dedup 纯函数', () => {
    const items = extractMemoryItems('- 回复语言：中文\n- 代码注释用中文\n普通段落');
    suite.assert(items.length === 2, '提取 Markdown 条目');
    suite.assert(normalizeMemoryItem('- 回复语言：中文。') === '回复语言中文', '规范化去标点折叠空白');
    suite.assert(topicKey('- 回复语言：中文') === '回复语言', '主题关键词取分隔符前短语');
    const known = new Map<string, string>();
    known.set(normalizeMemoryItem('- 回复语言：中文'), '- 回复语言：中文');
    // 重复 → 跳过
    const r1 = dedupMemoryItems(known, ['- 回复语言：中文']);
    suite.assert(r1.fresh.length === 0 && r1.replaced.size === 0, '完全相同 → 去重');
    // 矛盾（同主题不同内容）→ 替换
    const r2 = dedupMemoryItems(known, ['- 回复语言：English']);
    suite.assert(r2.fresh.length === 0 && r2.replaced.size === 1, '同主题不同内容 → 矛盾替换');
    const [old, neu] = [...r2.replaced.entries()][0];
    suite.assert(old.includes('中文') && neu.includes('English'), '替换为新条目');
    // 新条目 → 追加
    const r3 = dedupMemoryItems(known, ['- 工具偏好：npm']);
    suite.assert(r3.fresh.length === 1, '新主题 → 追加');
  });

  suite.test('memoryMessage 格式：system + 前缀 + 路径标注', () => {
    const msg = memoryMessage({ path: '/tmp/repo/AGENTS.md', content: '# 内容' });
    suite.assert(msg.role === 'system', 'system 角色');
    suite.assert(String(msg.content).startsWith('[项目记忆 AGENTS.md：/tmp/repo/AGENTS.md]'), '前缀含路径');
    suite.assert(String(msg.content).includes('# 内容'), '含记忆内容');
  });

  return suite;
}
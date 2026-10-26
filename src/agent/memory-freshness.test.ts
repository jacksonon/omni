import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryUpdateTool, memoryReadTool, memorySearchTool, searchMemory } from '../tools/memory-tools.js';
import { listTopics, memoryIndexFile, memoryTopicsDir, parseTopicFile, topicsMatchingTask, writeTopicEntry } from './memory-topics.js';
import { appendGlobalMemory, loadGlobalMemory } from './memory.js';
import { checkMemoryFreshness } from './memory-freshness.js';
import { gateTool } from '../safety/policy.js';
import { prepareContext } from './context.js';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

test('memory freshness: source, dependency drift, same-session refresh, explicit revalidation and legacy compatibility', async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'omni-memory-freshness-'));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const originalCwd = process.cwd();
  const cwd = path.join(sandbox, 'project');
  await mkdir(cwd);
  await mkdir(path.join(cwd, 'src'));
  await mkdir(path.join(cwd, '.git'));
  await writeFile(path.join(cwd, 'src/foo.ts'), 'export const version = 1;\n');
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^4.0.0' } }));
  await writeFile(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  process.env.XDG_CONFIG_HOME = path.join(sandbox, 'config');
  process.chdir(cwd);
  try {
    let file = '';
    await t.test('save natural-language tool path creates source and associated baseline', async () => {
      const result = await memoryUpdateTool.execute({
        action: 'save', topic: 'SDK 调用经验', content: '- SDK 调用兼容参数需要保留。', globs: 'src/**',
        files: ['src/foo.ts'], dependencies: [{ name: 'openai' }],
      }, { cwd, sessionPath: '/sessions/example.jsonl' });
      assert.match(result, /已保存记忆主题/);
      const topic = (await listTopics())[0]!;
      file = topic.file;
      assert.equal(topic.globs, 'src/**');
      assert.equal(topic.freshness?.source, '/sessions/example.jsonl');
      assert(topic.freshness?.files.some((f) => f.path === 'package-lock.json'));
      assert.equal((await checkMemoryFreshness(topic.freshness, cwd)).status, 'unchanged');
      assert.match(await memoryReadTool.execute({ path: file }, { cwd }), /来源：\/sessions\/example.jsonl/);
      assert.match((await loadGlobalMemory(cwd))!.content, /基线未变化/);
      assert.equal((await searchMemory('sha256', cwd)).length, 0);
    });

    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '查看 src/foo.ts' }];
    const options = { agentsFile: false, skills: false, repoMap: false, preloadFiles: false, summarizeAt: 0 };
    await prepareContext({} as OpenAI, 'mock', messages, options);
    await t.test('file edit refreshes index and already-injected topics in same conversation', async () => {
      await writeFile(path.join(cwd, 'src/foo.ts'), 'export const version = 2;\n');
      messages.push({ role: 'assistant', content: '继续检查' }, { role: 'user', content: '查看 src/foo.ts' });
      await prepareContext({} as OpenAI, 'mock', messages, options);
      const injected = messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('[全局记忆主题'));
      assert.equal(injected.length, 1);
      assert.match(String(injected[0]!.content), /待复核/);
      assert.match(String(injected[0]!.content), /不可作为当前已验证事实/);
      assert.match((await loadGlobalMemory(cwd))!.content, /待复核/);
      assert.match(await memoryReadTool.execute({ path: memoryIndexFile() }, { cwd }), /待复核/);
      assert.match(await memorySearchTool.execute({ query: 'SDK 调用' }, { cwd }), /关联文件已变化/);
      assert.match((await topicsMatchingTask('src/foo.ts'))[0]!.content, /待复核/);
    });

    await t.test('confirmation requires explicit flag and evidence; baseline updates after confirmation', async () => {
      assert.match(await memoryUpdateTool.execute({ action: 'confirm', path: file }, { cwd }), /confirm=true/);
      assert.match(await memoryUpdateTool.execute({ action: 'confirm', path: file, confirm: true }, { cwd }), /verification/);
      assert.match(await memoryUpdateTool.execute({ action: 'save', path: file, content: '- 修订后的 SDK 调用经验。' }, { cwd }), /待复核/);
      const result = await memoryUpdateTool.execute({ action: 'confirm', path: file, confirm: true, verification: '已检查当前源码参数与类型定义，用户确认继续适用' }, { cwd });
      assert.match(result, /已记录复核并更新基线/);
      assert.match(result, /基线未变化/);
      assert.doesNotMatch(result, /待复核/);
    });

    await t.test('dependency declaration changes and lockfile-only changes require review', async () => {
      await writeFile(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/openai":{"version":"4.1.0"}}}');
      assert.match(await memoryReadTool.execute({ path: file }, { cwd }), /待复核.*package-lock.json/);
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { openai: '^5.0.0' } }));
      assert.match(await memoryReadTool.execute({ path: file }, { cwd }), /\^4.0.0 → \^5.0.0/);
      await rm(path.join(cwd, 'src/foo.ts'));
      assert.match(await memoryReadTool.execute({ path: file }, { cwd }), /已删除/);
    });

    await t.test('other workspaces, traversal and escaping symlinks cannot borrow or create a baseline', async () => {
      const other = path.join(sandbox, 'other');
      await mkdir(other);
      assert.match(await memoryReadTool.execute({ path: file }, { cwd: other }), /其他工作区/);
      await writeFile(path.join(sandbox, 'outside.txt'), 'private');
      const escape = await memoryUpdateTool.execute({ action: 'save', topic: 'escape', content: 'bad', files: ['../outside.txt'] }, { cwd });
      assert.match(escape, /工作区内/);
      await symlink(path.join(sandbox, 'outside.txt'), path.join(cwd, 'linked.txt'));
      assert.match(await memoryUpdateTool.execute({ action: 'save', topic: 'linked', content: 'bad', files: ['linked.txt'] }, { cwd }), /工作区外/);
      assert.match(await memoryUpdateTool.execute({ action: 'save', path: '../outside.txt', content: 'bad' }, { cwd }), /不能写任意文件/);
      assert.equal((gateTool('read', memoryUpdateTool, {}) as { allow: boolean }).allow, false);
      assert.deepEqual(gateTool('read', memoryReadTool, {}), { allow: true });
    });

    await t.test('legacy topic works without metadata; autoMemory retains session source without limiting global preferences', async () => {
      await writeTopicEntry('Legacy', '用户偏好简洁回复', 'src/**');
      const legacy = (await listTopics()).find((x) => x.topic === 'Legacy')!;
      assert.equal((await checkMemoryFreshness(legacy.freshness, cwd)).status, 'untracked');
      const wrote = await appendGlobalMemory('- 用户希望始终用中文回复', { cwd, sessionPath: '/sessions/language.jsonl' });
      assert(wrote);
      const preference = (await listTopics()).find((x) => x.content.includes('始终用中文'))!;
      assert.equal(preference.freshness?.source, '/sessions/language.jsonl');
      assert.equal((await checkMemoryFreshness(preference.freshness, path.join(sandbox, 'other'))).status, 'untracked');
      assert.match(await memoryReadTool.execute({ path: preference.file }, { cwd: path.join(sandbox, 'other') }), /来源：\/sessions\/language.jsonl/);
      const raw = await readFile(legacy.file, 'utf8');
      await writeFile(legacy.file, raw.replace('date:', 'freshness: invalid\ndate:'));
      assert((await parseTopicFile(legacy.file))!.freshnessInvalid);
      assert.match(await memoryReadTool.execute({ path: legacy.file }, { cwd }), /元数据损坏/);
      assert.equal((await listTopics()).length, 3);
      assert.equal(path.dirname(file), memoryTopicsDir());
    });
  } finally {
    process.chdir(originalCwd);
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    await rm(sandbox, { recursive: true, force: true });
  }
});

/**
 * 功能测试：配置分层 / JSONC 解析 / 字段解析。
 * 纯函数断言（import 源文件），无需网络。
 */
import { TestSuite } from './framework.js';
import { parseJsonc } from '../../src/config/jsonc.js';
import { loadConfig } from '../../src/config/index.js';
import { findProjectConfig } from '../../src/config/discover.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configSuite(): TestSuite {
  const suite = new TestSuite('配置系统（分层 / JSONC / 字段解析）');

  suite.test('JSONC 解析：注释 + 尾逗号', () => {
    const obj = parseJsonc(`{
      // 注释
      "model": "gpt-4o",
      "maxSteps": 50,  // 尾逗号
    }`);
    suite.assert(obj?.model === 'gpt-4o', '解析字符串字段');
    suite.assert(obj?.maxSteps === 50, '解析数字字段');
    // 非法输入抛异常（parseJsonc 无兜底，调用方 try/catch）
    let threw = false;
    try {
      parseJsonc('{');
    } catch {
      threw = true;
    }
    suite.assert(threw === true, '非法 JSON 抛异常');
  });

  suite.test('配置默认值（隔离：空 cwd + 空 XDG + 无环境变量）', () => {
    const saved: [string, string | undefined][] = [];
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-xdg-'));
    for (const k of ['OMNI_MODEL', 'OMNI_BASE_URL', 'OMNI_API_KEY', 'OMNI_PERMISSION', 'OMNI_MAX_STEPS', 'OMNI_SHOW_THINKING']) {
      saved.push([k, process.env[k]]);
      delete process.env[k];
    }
    saved.push(['XDG_CONFIG_HOME', process.env.XDG_CONFIG_HOME]);
    process.env.XDG_CONFIG_HOME = tmpXdg; // 隔离全局配置（避免读到真实 ~/.config/omni）
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgdefault-'));
    const oldCwd = process.cwd();
    process.chdir(tmp); // 空目录：无项目配置 → 纯默认值
    try {
      const cfg = loadConfig();
      suite.assert(cfg.model === 'gpt-4o-mini', '默认模型 gpt-4o-mini');
      suite.assert(cfg.maxSteps === 50, '默认 maxSteps 50');
      suite.assert(cfg.permission === 'safe', '默认权限 safe');
      suite.assert(cfg.auditLog === true, '默认审计日志开启');
      suite.assert(cfg.sandbox === 'off', '默认沙箱 off');
      suite.assert(cfg.language === 'zh', '默认语言 zh');
    } finally {
      process.chdir(oldCwd);
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('CLI 参数覆盖模型（overrides 优先级最高）', () => {
    const saved = process.env.OMNI_MODEL;
    delete process.env.OMNI_MODEL;
    try {
      const cfg = loadConfig({ model: 'test-model' });
      suite.assert(cfg.model === 'test-model', 'CLI 参数覆盖默认模型');
    } finally {
      if (saved !== undefined) process.env.OMNI_MODEL = saved;
    }
  });

  suite.test('配置发现：向上查找 + git 根边界', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ft-cfg-'));
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'omni.json'), '{"model":"test"}');
    const found = findProjectConfig(path.join(root, 'sub'));
    suite.assert(found !== null && found.endsWith('omni.json'), '向上找到项目配置');
    rmSync(root, { recursive: true, force: true });
  });

  return suite;
}
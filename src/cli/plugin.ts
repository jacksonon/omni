/**
 * `omni plugin` CLI（2026-09 PLG）：插件安装/卸载/启用清单管理的命令行入口。
 *
 * 用法：
 *   omni plugin list
 *   omni plugin install <本地路径|git URL> [--force] [--yes]
 *   omni plugin remove <名称> [--yes]
 *   omni plugin enable|disable <名称>
 *
 * 安装只复制文件、不执行；启用会加载 hooks/MCP（执行命令）——安装时展示清单并要求确认
 *（非交互加 --yes 跳过）。
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  describePlugin,
  enabledPluginNames,
  installPlugin,
  listInstalledPlugins,
  pluginsRootDir,
  readPlugin,
  removePlugin,
  setEnabledPlugins,
} from '../agent/plugins.js';
import { persistPluginListToGlobal } from '../config/write.js';

function usage(): void {
  console.log(`用法：
  omni plugin list                               列出已安装插件（★ = 已启用）
  omni plugin install <本地路径|git URL> [选项]   安装插件（复制到 ${pluginsRootDir()}/）
      --force   覆盖同名已安装插件
      --yes     跳过确认（非交互环境用）
  omni plugin remove <名称> [--yes]               删除插件并从启用清单移除
  omni plugin enable <名称>                       启用插件（写入全局配置 plugins）
  omni plugin disable <名称>                      停用（从清单移除，保留文件）

说明：插件 = plugin.json（name/版本/描述 + skills/agents/hooks/mcpServers）。
安装后新会话生效；hooks/MCP 会执行命令，请只安装可信来源。`);
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

export async function runPluginCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? '';
  const rest = args.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const positional = rest.filter((a) => !a.startsWith('--'));

  if (!sub || sub === 'list' || sub === 'ls') {
    const installed = listInstalledPlugins();
    if (installed.length === 0) {
      console.log(`没有已安装插件（omni plugin install <路径|git URL>；目录：${pluginsRootDir()}）`);
      return 0;
    }
    const enabled = new Set(enabledPluginNames());
    console.log(`已安装 ${installed.length} 个插件（目录：${pluginsRootDir()}）：`);
    for (const p of installed) {
      console.log(`  ${enabled.has(p.manifest.name) ? '★' : '·'} ${describePlugin(p)}`);
    }
    console.log('启用/停用：omni plugin enable|disable <名称>（全局配置 plugins 字段）');
    return 0;
  }

  if (sub === 'install') {
    const src = positional[0] ?? '';
    if (!src) {
      console.error('缺少安装源：omni plugin install <本地路径|git URL>');
      return 1;
    }
    // 预览源清单（本地目录可直接读；git 源克隆后才知道——安装函数内部校验）
    const localSrc = path.resolve(src);
    const preview = existsSync(localSrc) ? readPlugin(localSrc) : null;
    if (preview && !flags.has('--yes')) {
      console.log(`将安装：${describePlugin(preview)}`);
      if (!(await confirm('确认安装并启用？'))) {
        console.log('已取消');
        return 1;
      }
    }
    const r = installPlugin(src, { force: flags.has('--force') });
    console.log(r.ok ? r.message : `✗ ${r.message}`);
    if (!r.ok) return 1;
    if (r.name) {
      const names = enabledPluginNames();
      if (!names.includes(r.name)) names.push(r.name);
      const pr = persistPluginListToGlobal(names);
      setEnabledPlugins(names);
      console.log(pr.message.startsWith('已保存') ? `✓ 已启用（${pr.message}）` : `⚠ ${pr.message}`);
    }
    console.log('重启会话后技能/子代理/hooks/MCP 生效。');
    return 0;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
    const name = positional[0] ?? '';
    if (!name) {
      console.error('用法：omni plugin remove <名称> [--yes]');
      return 1;
    }
    if (!flags.has('--yes') && !(await confirm(`删除插件「${name}」（目录 + 启用清单）？`))) {
      console.log('已取消');
      return 1;
    }
    const r = removePlugin(name);
    console.log(r.ok ? r.message : `✗ ${r.message}`);
    if (!r.ok) return 1;
    const names = enabledPluginNames().filter((n) => n !== name);
    const pr = persistPluginListToGlobal(names);
    setEnabledPlugins(names);
    console.log(pr.message.startsWith('已保存') ? `✓ 已从启用清单移除` : `⚠ ${pr.message}`);
    return 0;
  }

  if (sub === 'enable' || sub === 'disable') {
    const name = positional[0] ?? '';
    if (!name) {
      console.error(`用法：omni plugin ${sub} <名称>`);
      return 1;
    }
    const installed = listInstalledPlugins();
    if (!installed.some((p) => p.manifest.name === name)) {
      console.error(`插件未安装：${name}（omni plugin list 查看）`);
      return 1;
    }
    const names = enabledPluginNames();
    const next = sub === 'enable' ? [...new Set([...names, name])] : names.filter((n) => n !== name);
    const pr = persistPluginListToGlobal(next);
    setEnabledPlugins(next);
    console.log(pr.message.startsWith('已保存') ? `✓ 已${sub === 'enable' ? '启用' : '停用'}插件「${name}」` : `⚠ ${pr.message}`);
    return pr.ok ? 0 : 1;
  }

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    usage();
    return 0;
  }

  console.error(`未知子命令：plugin ${sub}`);
  usage();
  return 1;
}

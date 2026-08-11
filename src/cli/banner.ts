/**
 * 启动 banner：展示版本、模型、API 地址、工具列表、权限级别与配置来源。
 */
import type { OmniConfig } from '../config/index.js';
import { bold, cyan, dim } from '../ui.js';
import { VERSION } from '../version.js';

const PERMISSION_LABEL: Record<string, string> = {
  full: '直通',
  safe: '危险命令询问',
  ask: '全部询问',
  read: '只读',
};

export function printBanner(cfg: OmniConfig, toolNames?: string[]): void {
  const names = toolNames && toolNames.length > 0 ? toolNames : ['read_file', 'write_file', 'list_directory', 'search_code', 'run_command'];
  console.log(`${bold(cyan('Omni'))} v${VERSION} ${dim('— Agent 工程')}`);
  console.log(`${dim('模型:')} ${bold(cfg.model)}${cfg.baseURL ? ` ${dim('· API:')} ${cfg.baseURL}` : ''} ${dim('· 步数上限:')} ${cfg.maxSteps}`);
  console.log(`${dim('工具:')} ${names.map((n) => cyan(n)).join(', ')}`);
  console.log(`${dim('权限:')} ${cyan(cfg.permission)}（${PERMISSION_LABEL[cfg.permission] ?? ''}）`);
  console.log(`${dim('配置来源:')} ${cfg.sources.length ? cfg.sources.join(' → ') : '默认值'}\n`);
}

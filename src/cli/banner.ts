/**
 * 启动 banner：展示版本、模型、API 地址、工具列表与配置来源。
 */
import type { OmniConfig } from '../config/index.js';
import { tools } from '../tools/index.js';
import { bold, cyan, dim } from '../ui.js';
import { VERSION } from '../version.js';

export function printBanner(cfg: OmniConfig): void {
  console.log(`${bold(cyan('Omni'))} v${VERSION} ${dim('— Agent 工程')}`);
  console.log(`${dim('模型:')} ${bold(cfg.model)}${cfg.baseURL ? ` ${dim('· API:')} ${cfg.baseURL}` : ''} ${dim('· 步数上限:')} ${cfg.maxSteps}`);
  console.log(`${dim('工具:')} ${tools.map((t) => cyan(t.name)).join(', ')}`);
  console.log(`${dim('配置来源:')} ${cfg.sources.length ? cfg.sources.join(' → ') : '默认值'}\n`);
}

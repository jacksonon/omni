/**
 * 能力一键预设（1.0 P1-6）：`omni preset browser` 把浏览器自动化双雄写入全局
 * MCP 配置——**不自研浏览器栈**（TODO-1.0 明确不做清单）：
 * · playwright  → @playwright/mcp（自动化：开页面/填表/点击/截图/抓数据）
 * · devtools    → chrome-devtools-mcp（调试/性能分析）
 * 写入全局配置 ~/.config/omni/omni.json 的 mcpServers 字段；下次会话自动连接。
 */
import { persistMcpServerToGlobal } from '../config/write.js';
import type { McpServerConfig } from '../tools/mcp.js';

export const PRESETS: Record<string, { description: string; servers: Record<string, McpServerConfig> }> = {
  browser: {
    description: '浏览器自动化双雄：Playwright MCP（自动化操作）+ Chrome DevTools MCP（调试/性能）',
    servers: {
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    },
  },
};

/** 应用预设：写入全局配置，返回逐项结果行 */
export async function runPreset(name: string): Promise<{ ok: boolean; lines: string[] }> {
  const key = name.trim().toLowerCase();
  const preset = PRESETS[key];
  if (!preset) {
    return { ok: false, lines: [`未知预设「${name}」。可用：${Object.keys(PRESETS).join('、')}`] };
  }
  const lines: string[] = [`应用预设 ${key}——${preset.description}`];
  let allOk = true;
  for (const [serverName, cfg] of Object.entries(preset.servers)) {
    const res = persistMcpServerToGlobal(serverName, cfg);
    lines.push(`${res.ok ? '✓' : '✗'} ${serverName}: ${res.message}`);
    if (!res.ok) allOk = false;
  }
  lines.push('重启会话或 /mcp reconnect 后生效。');
  return { ok: allOk, lines };
}

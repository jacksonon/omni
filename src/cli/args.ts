/**
 * CLI 参数解析与帮助文本。
 */
import type { ConfigOverrides } from '../config/index.js';

export interface ParsedArgs {
  taskArgs: string[];
  overrides: ConfigOverrides;
  flags: { noTui: boolean };
  help: boolean;
  version: boolean;
}

/** 解析参数：支持 --flag value 与 --flag=value 两种写法 */
export function parseArgs(args: string[]): ParsedArgs {
  const taskArgs: string[] = [];
  const overrides: ConfigOverrides = {};
  const flags = { noTui: false };
  let help = false;
  let version = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inlineValue = eq >= 0 ? a.slice(eq + 1) : undefined;
    const takeValue = (): string | undefined => inlineValue ?? args[++i];

    switch (name) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
        version = true;
        break;
      case '--model':
      case '-m':
        overrides.model = takeValue();
        break;
      case '--config':
      case '-c':
        overrides.configPath = takeValue();
        break;
      case '--no-tui':
        flags.noTui = true;
        break;
      default:
        taskArgs.push(a);
    }
  }
  return { taskArgs, overrides, flags, help, version };
}

export function printHelp(): void {
  console.log(`用法：
  omni "<任务描述>"    单次执行一个任务
  omni                进入交互模式（输入 /exit 退出，/help 查看帮助）

参数：
  -m, --model <名称>    指定模型（覆盖配置文件）
  -c, --config <路径>   指定配置文件（覆盖自动发现）
      --no-tui          禁用全屏 TUI（默认：bun + 终端时自动启用）
  -h, --help            显示帮助
  -v, --version         显示版本

配置文件（JSON / JSONC，优先级从低到高）：
  1. 全局配置   ~/.config/omni/omni.json
  2. 项目配置   omni.json / omni.jsonc（从当前目录向上找）
  3. 自定义配置 OMNI_CONFIG 环境变量 或 --config <路径>
  4. 环境变量   OMNI_API_KEY / OMNI_BASE_URL / OMNI_MODEL / OMNI_MAX_STEPS / OMNI_SHOW_THINKING
  5. CLI 参数   --model

配置字段：
  { "model": "deepseek-chat", "baseURL": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx", "maxSteps": 20,
    "showThinking": true }    // 默认展示思考过程；false 关闭（仍落盘 .omni/last-thinking.md）

示例：cp omni.example.jsonc omni.json 后按需修改。`);
}

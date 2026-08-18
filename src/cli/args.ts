/**
 * CLI 参数解析与帮助文本。
 */
import type { ConfigOverrides } from '../config/index.js';

export interface ParsedArgs {
  taskArgs: string[];
  overrides: ConfigOverrides;
  flags: { noTui: boolean; listSessions: boolean; continueSession: boolean };
  /** --resume/-r <id>：要恢复的会话 id（null = 未指定） */
  resumeId: string | null;
  help: boolean;
  version: boolean;
}

/** 解析参数：支持 --flag value 与 --flag=value 两种写法 */
export function parseArgs(args: string[]): ParsedArgs {
  const taskArgs: string[] = [];
  const overrides: ConfigOverrides = {};
  const flags = { noTui: false, listSessions: false, continueSession: false };
  let resumeId: string | null = null;
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
      case '--continue':
        // 恢复当前项目最近一次会话（-c 已被 --config 占用，故只用长选项）
        flags.continueSession = true;
        break;
      case '--resume':
      case '-r':
        resumeId = takeValue() ?? null;
        break;
      case '--list-sessions':
      case '-l':
        flags.listSessions = true;
        break;
      default:
        taskArgs.push(a);
    }
  }
  return { taskArgs, overrides, flags, resumeId, help, version };
}

export function printHelp(): void {
  console.log(`用法：
  omni "<任务描述>"    单次执行一个任务
  omni                进入交互模式（/exit 退出；/init [--global] 生成记忆；/undo 撤销；/redo 重做；/model 切换/添加模型（/model <名称> 切换 · /model add <名称> [--base-url] [--api-key] 添加并持久化）；/variants 思考级别；/permission 权限；/plan 计划模式；/agents 子代理配置（模型路由/嵌套深度/已定义子代理）；/orchestrate 并行编排（fan-out+汇总+对抗审查）；/loop [--goal] 循环任务；/compact 压缩上下文；/status 状态；/context 上下文用量；/session 会话管理（列出/继续当前目录历史会话）；/resume 恢复会话；/export 导出；/diff 查看改动；/review 审查；/mcp MCP 管理；/skill 技能；/doctor 诊断；/help 帮助）

Headless（把 omni 变成可组合 Unix 命令，对标 codex exec / claude -p）：
  omni exec "<任务>"                非交互执行：stdout 只输出最终结果，进度走 stderr
  omni exec -                      任务从 stdin 读取（echo "任务" | omni exec -）
  echo "<上下文>" | omni exec "<任务>"   stdin 注入为上下文
  omni exec "<任务>" --output-format json       单对象 { result, cost_usd, duration_ms, num_turns, session_id, exit_code }
  omni exec "<任务>" --output-format stream-json 每行一个轨迹事件 {"t":"ev",...}，末行 {"t":"result",...}
  omni exec "<任务>" --max-turns 20 --allowed-tools read_file,run_command
  omni exec "<任务>" --output-schema '{"type":"object","required":["verdict"]}'   # 最终回答须符合 JSON Schema（不符 → 非零退出）
  omni exec resume <会话id> "<继续任务>"   恢复 headless 会话继续（json 输出带 session_id）
  omni mcp-server                作为 MCP server（stdio JSON-RPC：omni_exec / omni_reply 工具）
  headless exit code：0 = 完成；1 = 请求失败 / 触达步数上限 / schema 不符（可 &&/|| 分支）

会话持久化（跨进程恢复对话）：
  omni --continue "继续任务"      恢复当前项目最近一次会话并继续（交互模式自动创建会话文件）
  omni -r <会话id> "继续任务"      恢复指定会话（id 见 --list-sessions 输出）
  omni -l / --list-sessions       列出已保存的会话

参数：
  -m, --model <名称>    指定模型（覆盖配置文件）
  -c, --config <路径>   指定配置文件（覆盖自动发现；-c 已被占用，会话恢复用 --continue）
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
    "showThinking": true,       // 默认展示思考过程；false 关闭（仍落盘 .omni/last-thinking.md）
    "reasoningEffort": "medium", // 思考级别（/variants 切换；不配置则不传 reasoning_effort）
    "models": {                  // 多模型端点（/model 切换；缺省字段回退顶层 baseURL/apiKey；
      "glm-4-flash": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "sk-glm" } //   /model add 命令可运行时添加并持久化）
    } }

示例：cp omni.example.jsonc omni.json 后按需修改。`);
}

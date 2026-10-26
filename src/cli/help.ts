/**
 * CLI 帮助：默认只显示导航，完整用法按主题展开；不加载配置或启动 Agent。
 */
import type { ParsedArgs } from './args.js';

export type HelpTopic = 'commands' | 'exec' | 'mini' | 'web' | 'sessions' | 'interactive' | 'options' | 'config' | 'all';

const HELP_DETAILS = {
  en: {
    commands: `Extensions and utilities:
  omni update [--check]          Update Omni to the latest stable version; --check only checks
  omni plugin                    Plugin manager (install/list/enable/disable/remove; plugin.json bundles skills/agents/hooks/MCP)
  omni import                    Migrate config from Claude Code (CLAUDE.md → AGENTS.md · .claude/skills → .agents/skills · .claude/agents → .agents/subagents; additive only)
  omni watch                     Watch AI!/AI? comment markers; Ctrl+C to quit
  omni doctor                    Diagnose installation, config, auth, and runtime health
  omni review ["<focus>"] [--base <branch> | --commit <SHA>] [--title <title>]   Non-interactive code review
  omni completion <bash|zsh|fish|powershell>   Print shell completion script (eval "$(omni completion bash)")
  omni acp                       ACP endpoint (Agent Client Protocol, stdio JSON-RPC; Zed editor integration)
  omni mcp list|get <name>|login|logout   MCP servers: list/get, browser login/logout
  omni mcp-server                Run as MCP server (stdio JSON-RPC: omni_exec / omni_reply tools)
  omni preset browser            Set up browser automation MCP servers`,
    exec: `Usage: omni exec "<task>" [options]
  omni exec "<task>" (alias e)         Non-interactive run: stdout = final result only, progress goes to stderr
  omni exec -                      Read task from stdin (echo "task" | omni exec -)
  echo "<context>" | omni exec "<task>"   stdin is injected as context
  omni exec "<task>" --output-format json       Single object { result, cost_usd, duration_ms, num_turns, session_id, exit_code }
  omni exec "<task>" --output-format stream-json One trace event per line {"t":"ev",...}, last line {"t":"result",...}
  omni exec "<task>" --json        Alias for --output-format stream-json
  omni exec "<task>" -o <file>     Write the final answer to a file (--output-last-message)
  omni exec "<task>" --max-turns 20 --allowed-tools read_file,run_command
  omni exec "<task>" --output-schema '{"type":"object","required":["verdict"]}'   # final answer must match JSON Schema (mismatch → non-zero exit)
  omni exec "<task>" --quiet                 Suppress progress on stderr (stdout result only)
  omni exec "<task>" --approve-for-me        AI auto-approval: review approval requests with the model (never widens sandbox/permissions)
  omni exec resume <session-id> "<follow-up>"   Resume a headless session (session_id from json output)
  omni exec resume --last "<follow-up>"   Resume the most recent session in cwd
  omni exec fork <session-id> "<follow-up>"   Fork into a new session, then continue (no prompt = fork only, prints new id)
  omni exec review ["<focus>"] [--title <title>]   Non-interactive code review (typecheck + git diff, like codex exec review)
  omni exec -i img.png "<task>"      Attach image(s), repeatable
  omni exec "<task>" -m <model>      Model override (same as global -m)
  omni exec "<task>" --color never   Plain output without ANSI colors
  omni exec --ephemeral "<task>"       Run without persisting session files
  omni exec "<task>" --add-dir <dir>   Extra writable sandbox directory; repeatable
  omni exec review --base <branch>    Review changes relative to a branch
  omni exec review --commit <SHA>     Review a commit (--uncommitted for local changes)
  headless exit code: 0 = done; 1 = request failed / max steps reached / schema mismatch (use &&/|| to branch)`,
    mini: `Terminal mode:
  omni mini                      Start a terminal session; Ctrl+T expands/collapses tool output
  omni mini "<task>"             One-shot task rendered in the same terminal style
  omni mini "<task>" --approve-for-me  One-shot with AI auto-review of approvals
  omni mini "<task>" -o <file>      One-shot task + write final answer to a file
  omni mini -i img.png "<task>"      One-shot with image attachment(s), repeatable
  omni mini -c                   Continue the latest session
  omni mini -s <session-id>       Resume a specific session`,
    web: `Web and remote access:
  omni web                       Start backend service (REST + SSE) and serve Web UI (default http://127.0.0.1:3080)
  omni web --host 0.0.0.0 --token <t>   Remote access with a token instead of username/password
  omni web auth set              Set username/password for LAN/tunnel access (password hashed in global config)
  omni web --host 0.0.0.0        LAN access (same Wi-Fi; requires auth set or --token)
  omni web --tunnel              Cloudflare quick tunnel: temporary public https URL (requires auth set)
  omni pair                      LAN pairing: prints URL + terminal QR (one-time 5-min code, same Wi-Fi)
  omni service install --tunnel omni   Install local web + Cloudflare tunnel as a login service (macOS)
  omni service enable|disable|start|stop|status|uninstall   Manage the service lifecycle
  omni web --port 4000           Custom port
  omni web --no-open             Do not open browser automatically
  · Web UI supports multi-session / streaming replies / thinking & tool cards / approval & question cards / model & permission settings`,
    sessions: `Sessions:
  omni -c "follow-up"           Resume the latest session in current project and continue (interactive mode auto-creates session files)
  omni -s <session-id> "follow-up"    Resume a specific session (id from -l output; -r is an alias)
  omni resume [id|--last] [--all] ["<follow-up>"]   Resume a session into interactive mode (picker by default, like codex resume)
  omni fork [id|--last] [--all] ["<follow-up>"]      Fork a session into a new one, then continue interactively
  omni archive/unarchive/delete <id> [--yes]   Archive management, delete is permanent (like codex; non-interactive delete needs --yes)
  omni -l                       List saved sessions in current directory (cwd only)
  omni -l -f / --list-sessions --full   List all saved sessions across directories`,
    interactive: `Conversation:
  /exit or /quit to quit
  /stop stop the running turn
  /btw side question (read-only tools; --keep keeps the answer in context)
  /vim Vim keybindings
  /copy copy last assistant reply to clipboard

Sessions:
  /new new session (old file kept)
  /session session management (list/continue history in cwd; archived lists archives)
  /pin pin session
  /fork fork session
  /rename rename session
  /send message another session
  /archive archive session
  /unarchive unarchive session
  /delete delete a session (permanent)
  /resume resume session
  /export export
  /rollout print session file path

Code and planning:
  /undo undo
  /redo redo
  /rewind session checkpoints (three modes: /rewind <N> preview · /rewind <N> --code|--chat|--both [--yes])
  /plan plan mode
  /diff view changes (--stat summary only · --full untruncated)
  /review review
  /spec spec workflow

Context and workspace:
  /recap summarize the conversation (read-only)
  /compact compact context
  /clear clear context
  /status status
  /trace full trace ledger (incl. context usage)
  /context set context window (256/400/512/750/1000K · default)
  /cd change working directory
  /pwd print working directory
  /warnings retained session warnings

Models and settings:
  /init [--global] generate memory
  /import import config from Claude Code
  /model switch/add models (/model <name> switch · /model add <name> [--base-url] [--api-key] add & persist)
  /variants reasoning effort
  /permission permission
  /memory-apply apply pending memory config (model routing/nesting depth/defined subagents)
  /auto AI auto-approval
  /doctor diagnose
  /settings settings (help · models snapshot)

Agents and extensions:
  /agents subagent
  /orchestrate parallel pipeline or dynamic workflow (--pipeline forces fixed)
  /goal goal mechanism (alias /loop) (derive criteria and loop until met, /goal <goal> [--accept criteria] [--max N])
  /team shared task board
  /tasks subagent task center (/tasks · show <id> · resume <id> <msg> · stop <id|seq>)
  /mcp MCP management (/mcp verbose per-server status)
  /plugin (/plugins) plugins
  /hooks lifecycle hooks (view effective hooks)
  /preset browser automation preset
  /skill (/skills) skills`,
    options: `Options:
  -m, --model <name>    Select model (overrides config file)
  -i, --image <file>    Attach image(s), repeatable
      --approve-for-me  AI auto-approval for all modes
  -a, --ask-for-approval <policy>   Approval policy override: never (=full) | on-request (=safe) | full | safe | ask | read
  -c, --continue        Resume the latest session in current project (-c no longer means --config; use -C for config)
  -C, --config <path>   Use a specific config file (overrides auto-discovery)
      --cd <dir>        Run with the directory as working root
  -p, --profile <name>    Apply a config profile (config "profiles" field, e.g. work/personal/offline snapshots)
      --sandbox <mode>    OS sandbox override: off | read-only | workspace-write | danger-full-access
      --strict-config         Error on unrecognized config file fields
      --ignore-user-config    Skip the user-level config file
      --add-dir <dir>     Extra writable dir for the sandbox, repeatable
      --local             Run in-process without the shared server (debug/isolation)
      --server <url>      Connect to an explicit shared server (HTTPS; token via OMNI_SERVER_TOKEN)
  -s, -r, --resume <session-id>   Resume a specific session
  -l, --list-sessions   List saved sessions (cwd only by default; add -f/--full/--all for all)
  -f, --full, --all     With -l: list all sessions (default lists cwd only)
      --lang <zh|en>    Help language (default en; --lang zh for Chinese help)
      --no-tui          Disable fullscreen TUI (default: auto-enable on bun + TTY)
  -h, --help            Show help (default English; add --lang zh for Chinese)
  -v, -V, --version     Show version
  OMNI_LOCAL=1          Same as --local (--server takes precedence)`,
    config: `Config files (JSON / JSONC, ascending priority):
  1. Global   ~/.config/omni/omni.json
  2. Project  omni.json / omni.jsonc (search upward from cwd)
  3. Custom   OMNI_CONFIG env var or --config <path>
  4. Env vars OMNI_API_KEY / OMNI_BASE_URL / OMNI_MODEL / OMNI_MAX_STEPS / OMNI_SHOW_THINKING
  5. CLI args --model

Config fields:
  { "model": "deepseek-chat", "maxSteps": 50,
    "showThinking": true,       // show thinking by default; false hides it (still saved to .omni/last-thinking.md)
    "reasoningEffort": "medium", // reasoning level (switch via /variants; omit to skip reasoning_effort)
    "providers": {              // multi-model endpoints (/model switch) — the only place for baseURL/apiKey:
      "bigmodel": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "sk-glm",
        "models": { "glm-4-flash": {} } } // /model add adds & persists at runtime (single-model group)
    } }

Example: cp omni.example.jsonc omni.json then edit as needed.`,
  },
  zh: {
    commands: `扩展与实用命令：
  omni update [--check]          更新 Omni 到最新稳定版；--check 只检查版本
  omni plugin                    插件管理（install/list/enable/disable/remove；plugin.json 打包 skills/子代理/hooks/MCP）
  omni import                    从 Claude Code 迁移配置（CLAUDE.md → AGENTS.md · .claude/skills → .agents/skills · .claude/agents → .agents/subagents；只增不改）
  omni watch                     监听 AI!/AI? 注释标记并执行任务；Ctrl+C 退出
  omni doctor                    环境诊断（安装/配置/鉴权/运行时健康，对标 codex doctor）
  omni review ["<侧重>"] [--base <分支> | --commit <SHA>] [--title <标题>]   非交互代码审查
  omni completion <bash|zsh|fish|powershell>   打印 shell 补全脚本（eval "$(omni completion bash)"）
  omni acp                       ACP 端点（Agent Client Protocol，stdio JSON-RPC；Zed 等编辑器生态集成）
  omni mcp list|get <名称>|login|logout   MCP 服务器：查看/浏览器登录登出
  omni mcp-server                作为 MCP server（stdio JSON-RPC：omni_exec / omni_reply 工具）
  omni preset browser            配置浏览器自动化 MCP 预设`,
    exec: `用法：omni exec "<任务>" [参数]
  omni exec "<任务>"（别名 e）      非交互执行：stdout 只输出最终结果，进度走 stderr
  omni exec -                      任务从 stdin 读取（echo "任务" | omni exec -）
  echo "<上下文>" | omni exec "<任务>"   stdin 注入为上下文
  omni exec "<任务>" --output-format json       单对象 { result, cost_usd, duration_ms, num_turns, session_id, exit_code }
  omni exec "<任务>" --output-format stream-json 每行一个轨迹事件 {"t":"ev",...}，末行 {"t":"result",...}
  omni exec "<任务>" --json        等同于 --output-format stream-json
  omni exec "<任务>" -o <文件>     最终回答落盘（--output-last-message）
  omni exec "<任务>" --max-turns 20 --allowed-tools read_file,run_command
  omni exec "<任务>" --output-schema '{"type":"object","required":["verdict"]}'   # 最终回答须符合 JSON Schema（不符 → 非零退出）
  omni exec "<任务>" --quiet                 静默进度（stderr 不输出思考/工具进度，只留 stdout 结果）
  omni exec "<任务>" --approve-for-me       AI 自动审批：需要审批的操作先经模型审阅（不改变沙箱/权限边界）
  omni exec resume <会话id> "<继续任务>"   恢复 headless 会话继续（json 输出带 session_id）
  omni exec resume --last "<继续任务>"   恢复当前目录最近一次会话
  omni exec fork <会话id> "<继续任务>"   分叉出新会话再跑（无后续任务 = 仅分叉，输出新 id）
  omni exec review ["<侧重>"] [--title <标题>]   非交互代码审查（typecheck + git diff，对标 codex exec review）
  omni exec -i 图.png "<任务>"      图片附件，可重复
  omni exec "<任务>" -m <模型>      模型覆盖（与全局 -m 同效）
  omni exec "<任务>" --color never   纯文本输出（无 ANSI 颜色，对标 codex exec --color）
  omni exec --ephemeral "<任务>"       不落盘会话文件
  omni exec "<任务>" --add-dir <目录>   沙箱额外可写目录，可重复
  omni exec review --base <分支>      相对指定分支审查改动
  omni exec review --commit <SHA>     审查指定提交（--uncommitted 审查未提交改动）
  headless exit code：0 = 完成；1 = 请求失败 / 触达步数上限 / schema 不符（可 &&/|| 分支）`,
    mini: `纯终端模式：
  omni mini                      进入终端会话；Ctrl+T 展开/收起工具输出
  omni mini "<任务>"             单次任务（同一终端形态）
  omni mini "<任务>" --approve-for-me  单次任务 + AI 自动审批
  omni mini "<任务>" -o <文件>      单次任务 + 最终回答落盘
  omni mini -i 图.png "<任务>"      单次任务 + 图片附件，可重复
  omni mini -c                   继续最近一次会话
  omni mini -s <会话id>           恢复指定会话`,
    web: `Web 与远程接入：
  omni web                       启动后端服务（REST + SSE）并托管 Web UI（默认 http://127.0.0.1:3080）
  omni web --host 0.0.0.0 --token <令牌>   使用令牌代替账号密码进行远程接入
  omni web auth set              设置账号密码（局域网/隧道登录；口令只存哈希到全局配置）
  omni web --host 0.0.0.0        局域网直连（同 Wi-Fi；需先设置账号密码或 --token）
  omni web --tunnel              Cloudflare 快速隧道（临时公网 https 地址；需先设置账号密码）
  omni pair                      局域网配对：打印链接 + 终端二维码（5 分钟一次性配对码，需同 Wi-Fi）
  omni service install --tunnel omni   安装本地 Web + Cloudflare 隧道为登录服务（macOS）
  omni service enable|disable|start|stop|status|uninstall   管理服务启停与自启
  omni web --port 4000           指定端口
  omni web --no-open             不自动打开浏览器
  · Web UI 支持多会话 / 流式回复 / 思考与工具卡片 / 审批与提问卡片 / 模型与权限设置`,
    sessions: `会话管理：
  omni -c "继续任务"           恢复当前项目最近一次会话并继续（交互模式自动创建会话文件）
  omni -s <会话id> "继续任务"    恢复指定会话（id 见 -l 输出；-r 为同义别名）
  omni resume [会话id|--last] [--all] ["<继续任务>"]   恢复会话进交互模式（缺省 picker，对标 codex resume）
  omni fork [会话id|--last] [--all] ["<继续任务>"]      分叉出新会话后进交互模式继续
  omni archive/unarchive/delete <会话id> [--yes]   会话归档管理，delete 永久删除
  omni -l                      列出当前目录已保存的会话（仅当前文件夹）
  omni -l -f / --list-sessions --full   列出全部已保存的会话（跨目录）`,
    interactive: `对话：
  /exit 或 /quit 退出
  /stop 停止当前任务
  /btw 旁问（只读工具查证；--keep 将答案留在上下文）
  /vim Vim 键位
  /copy 复制上一条回复到剪贴板

会话：
  /new 新建会话（旧文件保留）
  /session 会话管理（列出/继续当前目录历史会话；archived 查看归档）
  /pin 置顶会话
  /fork 分叉会话
  /rename 重命名会话
  /send 给其它会话发消息
  /archive 归档会话
  /unarchive 取消归档
  /delete 删除会话（永久）
  /resume 恢复会话
  /export 导出
  /rollout 打印会话文件路径

代码与计划：
  /undo 撤销
  /redo 重做
  /rewind 会话检查点（三模式：/rewind <N> 预览 · /rewind <N> --code|--chat|--both [--yes]）
  /plan 计划模式
  /diff 查看改动（--stat 只看统计 · --full 不截断）
  /review 审查
  /spec 规格工作流

上下文与工作目录：
  /recap 总结当前对话（只读）
  /compact 压缩上下文
  /clear 清空上下文
  /status 状态
  /trace 完整轨迹账本（含上下文用量）
  /context 调整上下文窗口（256/400/512/750/1000K · 默认）
  /cd 切换工作目录
  /pwd 显示工作目录
  /warnings 查看会话 retained 警告

模型与设置：
  /init [--global] 生成记忆
  /import 从 Claude Code 迁移配置
  /model 切换/添加模型（/model <名称> 切换 · /model add <名称> [--base-url] [--api-key] 添加并持久化）
  /variants 思考级别
  /permission 权限
  /memory-apply 应用待定记忆配置（模型路由/嵌套深度/已定义子代理）
  /auto AI 自动审批
  /doctor 诊断
  /settings 设置（help 帮助 · models 模型能力快照）

子代理与扩展：
  /agents 子代理
  /orchestrate 并行编排或动态工作流（--pipeline 强制固定管线）
  /goal 目标机制（别名 /loop）（自动推导验收标准并循环直至达标，/goal <目标> [--accept 标准] [--max N]）
  /team 共享任务看板
  /tasks 子代理任务中心（无参列表 · show <id> 查看 · resume <id> <追问> 续跑 · stop <id|seq> 停止）
  /mcp MCP 管理（/mcp verbose 逐服务器状态）
  /plugin（/plugins）插件管理
  /hooks 查看生效中的 hooks
  /preset 浏览器自动化预设
  /skill（/skills）技能`,
    options: `参数：
  -m, --model <名称>    指定模型（覆盖配置文件）
  -i, --image <文件>    图片附件，可重复
      --approve-for-me  AI 自动审批
  -a, --ask-for-approval <策略>   审批策略覆盖：never（=full）| on-request（=safe）| full | safe | ask | read
  -c, --continue        恢复当前项目最近一次会话（-c 已从 --config 让位；config 用 -C）
  -C, --config <路径>   指定配置文件（覆盖自动发现）
      --cd <目录>       以指定目录为工作根运行
  -p, --profile <名>    套用配置档案（config profiles 字段；如工作/个人/离线多套快照）
      --sandbox <档位>    OS 沙箱覆盖：off | read-only | workspace-write | danger-full-access
      --strict-config         严格配置校验：未知顶层字段报错
      --ignore-user-config    跳过用户级配置文件
      --add-dir <目录>    沙箱额外可写目录，可重复
      --local             不连接共享 server，进程内独立运行（调试/隔离）
      --server <地址>     连接指定共享 server（HTTPS；令牌用 OMNI_SERVER_TOKEN）
  -s, -r, --resume <会话id>   恢复指定会话
  -l, --list-sessions   列出会话（默认仅当前目录；加 -f/--full/--all 查看全部）
  -f, --full, --all     配合 -l：查看全部会话（默认仅当前目录）
      --lang <zh|en>    帮助语言（默认英文；--lang zh 显示中文）
      --no-tui          禁用全屏 TUI（默认：bun + 终端时自动启用）
  -h, --help            显示帮助（默认英文；加 --lang zh 显示中文）
  -v, -V, --version     显示版本
  OMNI_LOCAL=1          等价 --local（--server 优先）`,
    config: `配置文件（JSON / JSONC，优先级从低到高）：
  1. 全局配置   ~/.config/omni/omni.json
  2. 项目配置   omni.json / omni.jsonc（从当前目录向上找）
  3. 自定义配置 OMNI_CONFIG 环境变量 或 --config <路径>
  4. 环境变量   OMNI_API_KEY / OMNI_BASE_URL / OMNI_MODEL / OMNI_MAX_STEPS / OMNI_SHOW_THINKING
  5. CLI 参数   --model

配置字段：
  { "model": "deepseek-chat", "maxSteps": 50,
    "showThinking": true,       // 默认展示思考过程；false 关闭（仍写入 .omni/last-thinking.md）
    "reasoningEffort": "medium", // 思考级别（/variants 切换；不配置则不传 reasoning_effort）
    "providers": {              // 多模型端点（/model 切换）——端点/密钥的唯一格式：
      "bigmodel": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "sk-glm",
        "models": { "glm-4-flash": {} } } //  /model add 命令可运行时添加并持久化（单模型分组）
    } }

示例：cp omni.example.jsonc omni.json 后按需修改。`,
  },
} as const;

function overview(lang: 'zh' | 'en'): string {
  if (lang === 'zh') return `Omni · AI 编程助手

用法：omni [命令] [参数] ["任务"]

开始使用：
  omni                    进入交互模式
  omni "任务"             执行一个任务
  omni mini               使用纯终端界面
  omni web                打开 Web 界面
  omni bot                启动菜单栏/托盘助手（需安装桌面应用）
  omni exec "任务"        非交互执行，适合脚本和管道
  omni review             审查未提交的代码改动
  omni update             更新 Omni（--check 只检查版本）

远程与配对：
  omni web auth set       设置远程登录账号密码
  omni pair               手机扫码配对（同一 Wi-Fi）
  omni web --tunnel       开启临时公网 HTTPS 接入
  omni service            管理常驻服务与登录自启
  omni server             查看共享 server（start / status / stop）

会话：
  omni -c                 继续当前项目最近一次会话
  omni resume             选择历史会话
  omni -l                 列出当前项目会话

常用参数：
  -m, --model <名称>      指定模型
  -i, --image <文件>      添加图片，可重复
  -C, --config <路径>     指定配置文件
      --cd <目录>        指定工作目录
  -h, --help              显示帮助
  -v, --version           显示版本

详细帮助：omni help <主题>
  exec / mini             任务执行与纯终端模式
  web / remote / pair     网页、远程接入与扫码配对
  bot / server            托盘助手与共享服务
  sessions                恢复、分叉、归档与删除会话
  commands                插件、MCP、诊断与其他命令
  interactive             按类别查看交互斜杠命令
  options / config        完整参数与配置说明
  all                     查看全部帮助

交互中输入 /settings help 查看命令；--lang en 切换英文帮助。`;
  return `Omni · AI coding assistant

Usage: omni [command] [options] ["task"]

Get started:
  omni                    Interactive mode
  omni "task"             Run a single task
  omni mini               Use the terminal interface
  omni web                Open the Web UI
  omni bot                Start the menu-bar/tray assistant (desktop app required)
  omni exec "task"        Run non-interactively for scripts and pipes
  omni review             Review uncommitted code changes
  omni update             Update Omni (--check only checks for updates)

Remote access and pairing:
  omni web auth set       Set a remote login username and password
  omni pair               Pair a phone via QR code on the same Wi-Fi
  omni web --tunnel       Start temporary public HTTPS access
  omni service            Manage background service and login startup
  omni server             Shared server lifecycle (start / status / stop)

Sessions:
  omni -c                 Continue the latest session in this project
  omni resume             Choose a previous session
  omni -l                 List sessions in this project

Common options:
  -m, --model <name>      Select a model
  -i, --image <file>      Attach an image; repeatable
  -C, --config <path>     Use a config file
      --cd <dir>         Set the working directory
  -h, --help              Show help
  -v, --version           Show version

More help: omni help <topic>
  exec / mini             Task execution and terminal mode
  web / remote / pair     Web UI, remote access, and QR pairing
  bot / server            Tray assistant and shared server
  sessions                Resume, fork, archive, and delete sessions
  commands                Plugins, MCP, diagnostics, and other commands
  interactive             Interactive slash commands by category
  options / config        All options and configuration
  all                     Show all help

In a session, use /settings help; add --lang zh for Chinese help.`;
}

export function helpText(lang: 'zh' | 'en' = 'en', topic?: HelpTopic): string {
  const details = HELP_DETAILS[lang];
  return topic === 'all'
    ? [overview(lang), ...Object.values(details)].join('\n\n')
    : topic ? details[topic] : overview(lang);
}

export function printHelp(lang: 'zh' | 'en' = 'en', topic?: HelpTopic): void {
  console.log(helpText(lang, topic));
}

/** 双入口共用的帮助分发；必须先于配置、信任询问与 TUI 初始化。 */
export async function handleHelp(args: ParsedArgs): Promise<boolean> {
  const explicit = args.taskArgs[0] === 'help';
  if (!explicit && !args.help) return false;
  const lang = args.lang ?? 'en';
  const topic = explicit ? args.taskArgs[1] : args.taskArgs[0];
  if (explicit && args.taskArgs.length > 2) {
    console.error(lang === 'zh' ? '用法：omni help [主题]' : 'Usage: omni help [topic]');
    process.exitCode = 1;
    return true;
  }
  // 复用已有子命令帮助，避免 --help 被全局首页吞掉。
  if (topic === 'exec' || topic === 'e' || topic === 'review') {
    printHelp(lang, !explicit && args.taskArgs.includes('--') ? undefined : 'exec');
  } else if (topic === 'update') {
    const { updateHelp } = await import('./update.js');
    console.log(updateHelp(lang));
  } else if (topic === 'mcp') {
    const { runMcpCommand } = await import('./mcp.js');
    process.exitCode = await runMcpCommand(['--help'], args.overrides);
  } else if (topic === 'plugin') {
    const { runPluginCommand } = await import('./plugin.js');
    process.exitCode = await runPluginCommand(['--help']);
  } else if (topic === 'service') {
    const { runServiceCommand } = await import('./service.js');
    process.exitCode = await runServiceCommand(['--help']);
  } else if (topic === 'bot') {
    const { runBotCommand } = await import('./bot.js');
    process.exitCode = await runBotCommand(['--help']);
  } else if (topic === 'pet') {
    const { runPetCommand } = await import('./pet.js');
    process.exitCode = await runPetCommand(['--help']);
  } else if (topic === 'server') {
    const { runServerCommand } = await import('../server/command.js');
    process.exitCode = await runServerCommand(['--help']);
  } else if (topic === 'resume' || topic === 'fork' || topic === 'archive' || topic === 'unarchive' || topic === 'delete') {
    printHelp(lang, 'sessions');
  } else if (topic === 'pair' || topic === 'remote') {
    printHelp(lang, 'web');
  } else if (topic && Object.hasOwn(HELP_DETAILS.en, topic)) {
    printHelp(lang, topic as Exclude<HelpTopic, 'all'>);
  } else if (topic === 'all') {
    printHelp(lang, 'all');
  } else if (explicit && topic) {
    console.error(lang === 'zh' ? `未知帮助主题：${topic}。运行 omni help 查看主题。` : `Unknown help topic: ${topic}. Run omni help to list topics.`);
    process.exitCode = 1;
  } else {
    printHelp(lang);
  }
  return true;
}

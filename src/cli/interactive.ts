/**
 * 交互模式：readline 循环，消息跨轮次保留（上下文连续）。
 * 支持 /exit、/clear、/help 命令。
 */
import { existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import { parseModelAddArgs, persistModelDefaultToConfig, persistModelToConfig, persistReasoningEffortToConfig } from '../config/write.js';
import { stdin as input, stdout as output } from 'node:process';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { prepareContext } from '../agent/context.js';
import {
  generateAgentsFile,
  generateGlobalAgentsFile,
  findProjectRoot,
  writeAgentsFile,
  writeGlobalAgentsFile,
} from '../agent/init.js';
import { runAgent } from '../agent/loop.js';
import { maybeWriteGlobalMemory } from '../agent/memory.js';
import { appendSessionMessages, finalizeSession, persistableMessages } from '../agent/session.js';
import type { PermissionTier } from '../safety/policy.js';
import { applyUndo } from '../tools/undo.js';
import {
  discoverSkills,
  loadSkillContent,
  parseSkillFindResults,
  runSkillsCli,
} from '../agent/skill.js';
import { summarizeContext } from '../agent/context.js';
import { EventRecorder } from '../agent/events.js';
import { buildTraceTextLines } from '../agent/trace.js';
import { captureCommand, collectDiff, detectCheckCommand, reviewCode } from '../agent/review.js';
import {
  configReport,
  contextReport,
  detectScaffolds,
  doctorReport,
  exportSession,
  openInEditor,
  statusReport,
} from '../agent/report.js';
import { findSessionCandidates, listSessions, loadSession, removeEmptySession, sessionIdFromPath, updateSessionTitle } from '../agent/session.js';
import { closeMcpClients, discoverMcpTools } from '../tools/mcp.js';
import { createClient } from '../client.js';
import type { RunOptions } from '../agent/types.js';
import type { Output } from '../output/types.js';
import { cyan, dim, green, red, setTerminalTitle, yellow } from '../ui.js';
import { printHelp } from './args.js';

export async function runInteractive(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  runOpts: RunOptions,
  out: Output
): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: cyan('omni> ') });
  // stdin 流结束（EOF）时接口会自动关闭，之后不能再调 prompt，这里做安全守卫
  const safePrompt = () => {
    try {
      rl.prompt();
    } catch {
      /* 接口已关闭，忽略 */
    }
  };
  // 计划模式（/plan 切换，会话级）：每轮同步进 runOpts.planMode（loop 只暴露只读工具 + 系统提示）
  let planMode = false;
  // 安全权限档位（/permission 切换，会话级）：低=read / 中=safe / 高=ask / 全量=full。
  // 初始取入口配置（runOpts.permission = cfg.permission）；每轮同步 runOpts + 共用闸门 setTier
  let permission: PermissionTier = runOpts.permission ?? 'safe';
  // 当前模型运行时（/model 切换，会话级）：切换时重建 client 并更新共享引用（子代理同步）
  let currentClient: OpenAI = client;
  let currentModel = runOpts.modelRuntime?.model ?? model;
  const switchModel = (name: string): string | null => {
    // 从 runOpts.models 找目标端点（baseURL/apiKey/userAgent 已按配置展开），重建 client
    // 并更新 runOpts.modelRuntime——主循环与 delegate 子代理（闭包持有引用）同步生效
    const endpoint = (runOpts.models ?? []).find((m) => m.name === name);
    if (!endpoint) return `未知模型「${name}」——可用：${(runOpts.models ?? []).map((m) => m.name).join(' / ')}`;
    if (name === currentModel) return null; // 已是当前模型，无需切换
    currentClient = createClient(endpoint, endpoint.apiKey ?? '');
    currentModel = name;
    if (runOpts.modelRuntime) {
      runOpts.modelRuntime.client = currentClient;
      runOpts.modelRuntime.model = name;
    }
    return null;
  };
  // 会话持久化：增量追加每轮新增消息。
  // savedCount 统计**可落盘**消息数（脚手架 system 消息不落盘，见 persistableMessages）：
  // · --continue/-r 恢复时历史已在文件里 → 从可落盘数起步，避免整段重复追加（review 抓到的 bug）；
  // · prepareContext 每轮可能 unshift 全局/项目记忆/预载 system 消息（不落盘）——按可落盘数
  //   切片不受下标偏移影响（否则恢复会话会把上轮回答重复写盘，实测抓到）
  // 会话文件路径取 runOpts.sessionPath（可变）：/resume、/session 恢复后会替换它，
  // 之后的持久化必须落到**新**文件（否则继续的对话会写进旧的空占位会话，e2e 抓到）
  let savedCount = persistableMessages(messages).length;
  const persistTurn = async (): Promise<void> => {
    if (!runOpts.sessionPath) return;
    const persistable = persistableMessages(messages);
    if (savedCount > persistable.length) savedCount = 0; // /clear 后上下文重置
    if (persistable.length <= savedCount) return;
    await appendSessionMessages(runOpts.sessionPath, persistable.slice(savedCount)).catch(() => {});
    savedCount = persistable.length;
    // 轨迹事件批量落盘（`{"t":"ev"}` 行与消息共存；失败静默不打扰对话）
    await runOpts.events?.flush().catch(() => {});
  };
  console.log('输入任务开始；/exit 退出，/help 查看帮助。');
  safePrompt();
  for await (const line of rl) {
    const cmd = line.trim();
    if (cmd === '/exit') {
      // 会话结束：把本轮新表达的偏好自动追加进全局记忆（autoMemory 开关；静默失败）
      if (runOpts.context?.autoMemory !== false && messages.some((m) => m.role === 'user')) {
        await maybeWriteGlobalMemory(currentClient, currentModel, messages).catch(() => {});
      }
      // 轨迹事件最终落盘（persistTurn 已逐轮 flush，这里兜底退出边界）
      await runOpts.events?.flush().catch(() => {});
      if (runOpts.sessionPath) {
        await finalizeSession(runOpts.sessionPath).catch(() => {}); // 刷新会话更新时间
        // 仅命令（无真实对话）的会话文件是空占位 → 退出时删除，避免污染会话列表
        await removeEmptySession(runOpts.sessionPath).catch(() => {});
      }
      break;
    }
    if (cmd === '/clear') {
      messages.length = 0;
      savedCount = 0;
      runOpts.hooks?.resetSessionStart(); // 新一轮会话：SessionStart hook 重新触发
      console.log(dim('（已清空上下文，开始新一轮对话）'));
      safePrompt();
      continue;
    }
    if (cmd === '/plan') {
      // 计划模式开关：只读调研（read_file/list_directory/search_code），不修改文件
      planMode = !planMode;
      runOpts.planMode = planMode;
      console.log(
        planMode
          ? dim('已进入计划模式（只读调研，不会修改文件；/plan 退出）')
          : dim('已退出计划模式（可正常修改文件/执行命令）')
      );
      safePrompt();
      continue;
    }
    if (cmd === '/permission' || cmd.startsWith('/permission ')) {
      // /permission：显示当前档位；/permission 低|中|高|全量（或 read|safe|ask|full）切换
      const want = cmd.slice('/permission'.length).trim();
      const PERMS: Record<string, PermissionTier> = {
        低: 'read', 中: 'safe', 高: 'ask', 全量: 'full',
        read: 'read', safe: 'safe', ask: 'ask', full: 'full',
      };
      const PERM_LABEL: Record<PermissionTier, string> = {
        read: '低（只读）', safe: '中（标准）', ask: '高（谨慎）', full: '全量（直通）',
      };
      if (!want) {
        console.log(dim(`当前安全权限：${PERM_LABEL[permission]}（/permission 低|中|高|全量 切换）`));
      } else {
        const next = PERMS[want];
        if (!next) {
          console.log(red(`未知权限「${want}」——可选：低=只读 / 中=标准 / 高=谨慎 / 全量=直通`));
        } else {
          permission = next;
          runOpts.permission = next;
          runOpts.safetyGate?.setTier(next); // 共用闸门（子代理）同步
          console.log(green(`已切换安全权限 → ${PERM_LABEL[next]}`));
        }
      }
      safePrompt();
      continue;
    }
    if (cmd === '/undo' || cmd.startsWith('/undo ')) {
      // /undo：撤销最近一次 write_file 修改（/undo all = 全部撤销，回到会话前状态）
      const stack = runOpts.undoStack;
      if (!stack || stack.size === 0) {
        console.log(dim('没有可撤销的写操作（本次会话尚未修改文件）'));
        safePrompt();
        continue;
      }
      const all = /(?:^|\s)all(?=\s|$)/.test(cmd.slice(5));
      if (all) {
        // popAllForUndo：逆序 pop（新→旧）并逐个捕获 redo 候选（/redo all 可恢复）
        const entries = await stack.popAllForUndo();
        const results: string[] = [];
        for (const e of entries) results.push(await applyUndo(e).catch(() => `撤销失败：${e.path}`));
        console.log(green(`已撤销全部 ${results.length} 个写操作`));
        for (const r of results) console.log(dim(`· ${r}`));
        messages.push({ role: 'system', content: `[已执行 /undo all] 本次会话 ${results.length} 个文件修改已全部回滚，请勿再基于旧结果操作。` });
      } else {
        // popForUndo：pop 时捕获「撤销前」状态进 redo 栈（/redo 恢复）
        const entry = await stack.popForUndo();
        if (!entry) continue;
        const msg = await applyUndo(entry).catch(() => `撤销失败：${entry.path}`);
        console.log(green(stack.size > 0 ? `${msg}（还有 ${stack.size} 个可撤销，/undo all 全部撤销）` : `${msg}（无更多可撤销）`));
        messages.push({ role: 'system', content: `[已执行 /undo] ${msg}。该文件的写操作已回滚，请勿再基于旧内容操作。` });
      }
      safePrompt();
      continue;
    }
    if (cmd === '/skill' || cmd.startsWith('/skill ')) {
      // /skill：列出已发现技能（SKILL.md）；find <词> 网络检索；add 安装；show 查看内容
      const args = cmd.slice('/skill'.length).trim();
      if (!args) {
        const skills = await discoverSkills();
        if (skills.length === 0) {
          console.log(dim('未发现技能（.opencode/.claude/.agents/skills 下无 SKILL.md）。用 /skill find <关键词> 网络检索，或 /skill add <owner/repo> --skill <名称> 安装。'));
        } else {
          console.log(dim(`已发现 ${skills.length} 个技能（模型可用 skill 工具按 name 加载；/skill find 网络检索更多）：`));
          for (const s of skills) console.log(dim(`· ${s.name} — ${s.description}${s.global ? '（全局）' : ''}`));
        }
        safePrompt();
        continue;
      }
      const findM = args.match(/^find\s+(.+)$/);
      if (findM) {
        const query = findM[1].trim();
        console.log(dim(`正在网络检索技能（npx skills find ${query}）…`));
        const { ok, output } = await runSkillsCli(['find', query]);
        if (!ok) {
          console.log(red(`检索失败：${output.slice(0, 300) || 'npx skills 不可用'}`));
        } else {
          const results = parseSkillFindResults(output);
          if (results.length === 0) {
            console.log(red(`没有匹配「${query}」的技能。`));
          } else {
            console.log(dim(`找到 ${results.length} 个技能（安装：/skill add <owner/repo> --skill <技能名>）：`));
            for (const r of results.slice(0, 20)) console.log(dim(`· ${r}`));
            if (results.length > 20) console.log(dim(`… 还有 ${results.length - 20} 个（npx skills find ${query} 查看全部）`));
          }
        }
        safePrompt();
        continue;
      }
      const addM = args.match(/^add\s+(\S+)(?:\s+--skill\s+(.+))?$/);
      if (addM) {
        const source = addM[1];
        const skillName = addM[2]?.trim();
        console.log(dim(`正在安装 ${source}${skillName ? ` 的 ${skillName}` : '（仓库全部技能）'}…（npx skills add，可能需要下载）`));
        const { ok, output } = await runSkillsCli(['add', source, ...(skillName ? ['--skill', skillName] : []), '-y'], 180_000);
        if (ok) {
          console.log(green('安装完成（已装入 .agents/skills 等目录，下次会话自动发现；本会话可用 /skill 查看已发现列表）'));
        } else {
          console.log(red(`安装失败：${output.slice(0, 300) || 'npx skills 不可用'}`));
          for (const line of output.split('\n').slice(0, 10)) {
            if (line.trim()) console.log(dim(`· ${line}`));
          }
        }
        safePrompt();
        continue;
      }
      const showM = args.match(/^show\s+(\S+)$/);
      if (showM) {
        const content = await loadSkillContent(showM[1]);
        if (!content) {
          console.log(red(`未找到技能「${showM[1]}」（/skill 查看已发现列表）`));
        } else {
          console.log(dim(`技能「${showM[1]}」内容：`));
          console.log(content);
        }
        safePrompt();
        continue;
      }
      console.log(red('用法：/skill（列出已发现）· /skill find <关键词>（网络检索）· /skill add <owner/repo> [--skill <名称>]（安装）· /skill show <名称>（查看内容）'));
      safePrompt();
      continue;
    }
    if (cmd === '/compact') {
      // /compact：手动触发长对话摘要压缩（与自动压缩同一实现）
      const before = messages.length;
      await summarizeContext(currentClient, currentModel, messages, { summarizeAt: 1, summarizeWindow: 8 }, runOpts.events);
      const after = messages.length;
      if (after >= before) {
        console.log(dim('上下文还很短或无可压缩内容（/compact 在长对话中才有明显效果）'));
      } else {
        console.log(green(`已压缩 ${before - after} 条旧消息为摘要（保留最近 8 条原文）`));
      }
      safePrompt();
      continue;
    }
    if (cmd === '/agents') {
      // /agents：展示子代理（delegate）配置（只读查看）
      const tools = runOpts.tools ?? [];
      const hasDelegate = tools.some((t) => t.name === 'delegate');
      const subTools = tools.filter((t) => t.name !== 'delegate');
      console.log(dim(`子代理配置（delegate）：${hasDelegate ? '已启用' : '未启用（allowSubagents=false）'}`));
      console.log(dim(`· 模型：${currentModel}`));
      console.log(dim(`· 最大循环步数：${runOpts.maxSubagentSteps ?? '（默认 10）'}`));
      console.log(dim(`· 子代理可用工具（${subTools.length}）：${subTools.map((t) => t.name).join('、')}`));
      console.log(dim('说明：模型在任务中可用 delegate 工具把独立子任务委托给子代理（隔离上下文）；子代理共用安全闸门，权限与主代理一致。'));
      safePrompt();
      continue;
    }
    if (cmd === '/review') {
      // /review：typecheck + git diff → LLM 审查（独立请求，不进历史）
      console.log(dim('正在收集改动并运行 typecheck…'));
      const checkCmd = detectCheckCommand();
      const check: { command: string | null; output: string } = checkCmd
        ? { command: checkCmd, output: (await captureCommand(checkCmd, 120_000)).output }
        : { command: null, output: '（无脚本）' };
      const diff = await collectDiff();
      if (!diff.ok) {
        console.log(red(`无法获取 git diff：${diff.output.slice(0, 200)}`));
      } else if (diff.output === '（无改动）') {
        console.log(red('工作区没有改动可审查（git diff 为空）'));
      } else {
        console.log(dim(`typecheck：${check.output === '（无输出）' ? '通过（无输出）' : check.output.split('\n').slice(0, 3).join(' · ')}`));
        const review = await reviewCode(currentClient, currentModel, diff.output, { command: check.command, output: check.output });
        if (!review) {
          console.log(red('审查失败（网络 / API 问题），请重试'));
        } else {
          console.log(green(`审查结果（${diff.output.length} 字符改动）：`));
          console.log(review);
        }
      }
      safePrompt();
      continue;
    }
    if (cmd === '/variants' || cmd.startsWith('/variants ')) {
      // /variants：显示当前思考级别；/variants low|medium|high（或配置的选项）直接切换
      const opts = runOpts.reasoningEffortOptions ?? ['low', 'medium', 'high'];
      const want = cmd.slice('/variants'.length).trim();
      if (!want) {
        console.log(dim(`当前思考级别：${runOpts.reasoningEffort ?? '（未设置，用模型默认）'}（/variants ${opts.join('|')} 切换）`));
      } else if (!opts.includes(want)) {
        console.log(red(`未知思考级别「${want}」——可选：${opts.join(' / ')}`));
      } else {
        runOpts.reasoningEffort = want;
        console.log(green(`已切换思考级别 → ${want}`));
        // 持久化：切换后下次启动仍是新思考级别（纯 JSON 配置文件自动改写；JSONC 提示手动）
        const cfg = runOpts.cfg;
        if (cfg) {
          const res = persistReasoningEffortToConfig(want, cfg);
          console.log(res.ok ? dim(res.message) : yellow(res.message));
        }
      }
      safePrompt();
      continue;
    }
    if (cmd === '/settings' || cmd.startsWith('/settings ')) {
      // /settings：TUI 专属设置（底部状态行 statusline 的可视化配置面板只在 TUI 有——
      // CLI 模式无该界面）。配置文件 statusline 字段对所有模式生效（TUI 渲染时读取）。
      console.log(dim('/settings 是 TUI（全屏）模式命令：/settings statusline 用面板配置底部状态行（空格勾选 · ←/→ 排序 · Enter 保存生效）· /settings language 切换界面语言 · /settings theme 切换主题 · /settings tokens 显示/隐藏当次 token 统计 · /settings doctor 环境诊断。'));
      console.log(dim('CLI 模式可直接编辑配置文件 statusline 字段（段：rounds/llm/speed/cache/tokens，空数组 = 不显示），TUI 渲染时读取。'));
      safePrompt();
      continue;
    }
    if (cmd === '/model' || cmd.startsWith('/model ')) {
      // /model：显示当前模型 + 可用列表；/model <名称> 切换；/model add <名称> [--base-url] [--api-key] [--user-agent] 添加并持久化
      const want = cmd.slice('/model'.length).trim();
      const models = runOpts.models ?? [];
      if (!want) {
        console.log(dim(`当前模型：${currentModel}（可用：${models.length > 0 ? models.map((m) => m.name).join(' / ') : currentModel}；/model <名称> 切换 · /model add <名称> [--base-url] [--api-key] 添加 · config models 可配多端点）`));
      } else if (want.startsWith('add')) {
        // /model add <名称> [--base-url <url>] [--api-key <key>] [--user-agent <ua>]：
        // 解析 → 运行时注册（缺省字段回退顶层配置）→ 切换 → 持久化到配置文件
        const parsed = parseModelAddArgs(want.slice(3));
        if (!parsed.ok) {
          console.log(red(parsed.error));
          safePrompt();
          continue;
        }
        const cfg = runOpts.cfg;
        const endpoint = {
          name: parsed.name,
          baseURL: parsed.baseURL ?? cfg?.baseURL,
          apiKey: parsed.apiKey ?? cfg?.apiKey,
          userAgent: parsed.userAgent ?? cfg?.userAgent,
        };
        // 注册进运行时模型表（同名覆盖）：子代理/主循环经 modelRuntime 用新端点
        const existing = models.find((m) => m.name === parsed.name);
        if (existing) Object.assign(existing, endpoint);
        else runOpts.models = [...models, endpoint];
        switchModel(parsed.name); // 重建 client + 更新 modelRuntime（子代理同步）
        console.log(green(`已添加并切换模型 → ${parsed.name}${endpoint.baseURL ? `（${endpoint.baseURL}）` : ''}`));
        // 持久化：只写用户**显式给出**的字段（缺省字段运行时回退顶层即可，
        // 不要烘焙进配置文件——否则顶层改 UA 后模型条目还留着旧值）；
        // 纯 JSON 配置文件自动追加；JSONC 提示手动添加（不破坏注释）
        if (cfg) {
          const res = persistModelToConfig(
            parsed.name,
            { baseURL: parsed.baseURL, apiKey: parsed.apiKey, userAgent: parsed.userAgent },
            cfg
          );
          console.log(res.ok ? dim(res.message) : yellow(res.message));
        }
      } else {
        const ep = models.find((m) => m.name === want);
        if (!ep) {
          console.log(red(`未知模型「${want}」——可用：${models.map((m) => m.name).join(' / ')}（/model add <名称> [--base-url] [--api-key] 添加，config models 可配不同端点）`));
        } else if (want === currentModel) {
          console.log(dim(`已是当前模型 ${want}`));
        } else {
          switchModel(want); // 重建 client + 更新 modelRuntime（子代理同步）
          console.log(green(`已切换模型 → ${want}${ep.baseURL ? `（${ep.baseURL}）` : ''}`));
          // 持久化：切换后下次启动默认就是新模型（纯 JSON 配置文件自动改写；JSONC 提示手动）
          const cfg = runOpts.cfg;
          if (cfg) {
            const res = persistModelDefaultToConfig(want, cfg);
            console.log(res.ok ? dim(res.message) : yellow(res.message));
          }
        }
      }
      safePrompt();
      continue;
    }
    if (cmd === '/status') {
      // /status：会话状态汇总（模型/权限/计划模式/思考级别/token/会话文件/脚手架）
      const cfg = runOpts.cfg;
      for (const line of statusReport({
        model: currentModel,
        permission: runOpts.permission ?? permission,
        planMode: runOpts.planMode ?? false,
        reasoningEffort: runOpts.reasoningEffort,
        sessionPath: runOpts.sessionPath,
        scaffolds: detectScaffolds(messages),
      })) console.log(dim(line));
      safePrompt();
      continue;
    }
    if (cmd === '/context') {
      // /context：上下文用量（消息数/token 估算/脚手架/压缩建议）
      for (const line of contextReport(messages, runOpts.cfg?.summarizeAt ?? 40)) console.log(dim(line));
      safePrompt();
      continue;
    }
    if (cmd === '/export') {
      // /export：会话导出为 Markdown（.omni/ 目录）
      const file = exportSession(messages, process.cwd());
      console.log(file ? green(`已导出会话 → ${file}（${messages.length} 条消息）`) : red('导出失败（无法写入 .omni/ 目录）'));
      safePrompt();
      continue;
    }
    if (cmd === '/config') {
      // /config：列出配置文件 + 用 $EDITOR 打开（console 可 spawn 编辑器）
      if (!runOpts.cfg) {
        console.log(red('配置信息不可用'));
      } else {
        for (const line of configReport(runOpts.cfg)) console.log(dim(line));
        // 优先打开项目配置，其次全局配置
        const project = ['omni.json', 'omni.jsonc']
          .map((f) => `${process.cwd()}/${f}`)
          .find((f) => existsSync(f));
        const target = project || `${process.env.HOME || '~'}/.config/omni/omni.json`;
        // 仅真实 TTY 才 spawn 编辑器（管道/非交互环境 spawn 会阻塞）；非 TTY 只给路径
        if (process.stdout.isTTY && process.stdin.isTTY) {
          console.log(dim(`用 $EDITOR 打开 ${target}…（编辑后重启生效）`));
          openInEditor(target);
        } else {
          console.log(dim(`编辑配置：${target}（非交互环境不自动打开编辑器）`));
        }
      }
      safePrompt();
      continue;
    }
    if (cmd === '/mcp' || cmd.startsWith('/mcp ')) {
      // /mcp：列出 MCP 服务器/工具；reconnect 重连（改完配置后生效）
      const servers = runOpts.mcpServers ?? {};
      const names = Object.keys(servers);
      if (names.length === 0) {
        console.log(red('未配置 MCP 服务器（配置文件 mcpServers 字段）'));
        safePrompt();
        continue;
      }
      const mcpToolNames = (runOpts.tools ?? []).filter((t) =>
        names.some((n) => t.name.startsWith(n.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '_'))
      );
      console.log(dim(`已配置 ${names.length} 个 MCP 服务器：${names.join('、')}`));
      console.log(dim(mcpToolNames.length > 0 ? `已发现工具（${mcpToolNames.length}）：${mcpToolNames.map((t) => t.name).join('、')}` : '（尚未发现工具——服务器连接失败或未提供工具）'));
      if (/(?:^|\s)reconnect(?=\s|$)/.test(cmd)) {
        console.log(dim('正在重连 MCP 服务器…'));
        closeMcpClients();
        const mcp = await discoverMcpTools(runOpts.mcpServers);
        runOpts.tools = [...(runOpts.baseTools ?? []), ...mcp];
        console.log(green(`已重连（工具链已更新，当前 ${runOpts.tools.length} 个工具）`));
      } else {
        console.log(dim('用 /mcp reconnect 重连（改完配置文件后生效）'));
      }
      safePrompt();
      continue;
    }
    if (cmd === '/diff') {
      // /diff：查看未提交改动（git diff）
      console.log(dim('正在收集 git diff…'));
      const d = await collectDiff();
      if (!d.ok) {
        console.log(red(`无法获取 git diff：${d.output.slice(0, 200)}`));
      } else if (d.output === '（无改动）') {
        console.log(dim('工作区没有未提交的改动'));
      } else {
        const lines = d.output.split('\n');
        console.log(dim(`git diff（${lines.length} 行，前 60 行）：`));
        for (const l of lines.slice(0, 60)) console.log(l);
        if (lines.length > 60) console.log(dim(`… 还有 ${lines.length - 60} 行（git diff 查看全部）`));
      }
      safePrompt();
      continue;
    }
    if (cmd === '/rename' || cmd.startsWith('/rename ')) {
      // /rename <标题>：改会话标题（终端窗口标题 + 会话 meta 落盘）
      const title = cmd.slice('/rename'.length).trim();
      if (!title) {
        console.log(dim('用法：/rename <标题>（当前：会话标题未设置）'));
      } else {
        setTerminalTitle(title);
        if (runOpts.sessionPath) await updateSessionTitle(runOpts.sessionPath, title);
        console.log(green(`会话标题已改为「${title}」（终端窗口标题）`));
      }
      safePrompt();
      continue;
    }
    if (cmd === '/resume' || cmd.startsWith('/resume ')) {
      // /resume：无参列出会话；/resume <id> 恢复（替换当前上下文）
      const id = cmd.slice('/resume'.length).trim();
      if (!id) {
        const list = await listSessions();
        if (list.length === 0) {
          console.log(dim('没有已保存的会话（交互模式退出时自动落盘；/resume <id> 恢复）'));
        } else {
          console.log(dim(`已保存 ${list.length} 个会话（/resume <id> 恢复）：`));
          for (const s of list.slice(0, 15)) console.log(dim(`· ${s.id} — ${s.title || '（无标题）'}（${s.messages} 条消息 · ${s.model}）`));
          if (list.length > 15) console.log(dim(`… 还有 ${list.length - 15} 个`));
        }
        safePrompt();
        continue;
      }
      // 支持 id 前缀匹配；多个命中时列出候选不静默选（避免继续到错误的会话）；
      // 排除当前正在进行的会话（它的占位文件会污染前缀匹配，e2e 抓到）
      const currentResumeId = runOpts.sessionPath ? sessionIdFromPath(runOpts.sessionPath) : '';
      const cands = (await findSessionCandidates(id)).filter((c) => c.id !== currentResumeId);
      if (cands.length === 0) {
        console.log(red(`会话「${id}」不存在（/resume 查看列表）`));
        safePrompt();
        continue;
      }
      if (cands.length > 1) {
        console.log(red(`「${id}」匹配 ${cands.length} 个会话，请用完整 id 恢复：`));
        for (const c of cands.slice(0, 9)) console.log(dim(`· ${c.id} — ${c.title || '（无标题）'}（${c.messages} 条消息 · ${c.model}）`));
        safePrompt();
        continue;
      }
      const file = cands[0].path;
      const loaded = await loadSession(file);
      if (!loaded) {
        console.log(red(`会话「${id}」加载失败`));
        safePrompt();
        continue;
      }
      const prevResumePath = runOpts.sessionPath;
      messages.length = 0;
      messages.push(...loaded.messages);
      runOpts.sessionPath = file; // 继续追加到同一会话文件
      savedCount = persistableMessages(messages).length;
      // 轨迹记录器同步重开到新会话文件（读回其历史事件续 seq/turn；失败保留原内存事件）
      const oldEvents = runOpts.events;
      runOpts.events = await EventRecorder.open(file).catch(() => oldEvents);
      // 被替换的是本次交互刚创建的空占位会话（0 条消息）→ 删除，避免残留孤儿会话
      if (prevResumePath && prevResumePath !== file) await removeEmptySession(prevResumePath).catch(() => {});
      console.log(green(`已恢复会话 ${loaded.meta.id}（${loaded.messages.length} 条消息 · 模型 ${loaded.meta.model}${loaded.meta.title ? ` · 标题「${loaded.meta.title}」` : ''}）`));
      if (loaded.meta.title) setTerminalTitle(loaded.meta.title);
      safePrompt();
      continue;
    }
    if (cmd === '/session' || cmd.startsWith('/session ')) {
      // /session：会话管理——无参列出当前目录（同目录）的历史会话；
      // /session all|list 列出全部；/session <id> 加载历史会话并继续（支持 id 前缀匹配）
      const arg = cmd.slice('/session'.length).trim();
      const isAll = arg === 'all' || arg === 'list';
      if (!arg || isAll) {
        // 历史会话列表排除当前正在进行的会话（它的历史就是当前对话，继续它无意义）
        const currentId = runOpts.sessionPath ? sessionIdFromPath(runOpts.sessionPath) : '';
        const list = (await listSessions(isAll ? undefined : process.cwd())).filter((s) => s.id !== currentId);
        if (list.length === 0) {
          console.log(dim(isAll ? '没有已保存的会话（交互模式退出时自动落盘；/session 查看当前目录）' : '当前目录没有历史会话（交互模式退出时自动落盘；/session all 查看全部）'));
        } else {
          console.log(dim(isAll ? `已保存 ${list.length} 个会话（/session <id> 继续）：` : `当前目录 ${list.length} 个历史会话（/session <id> 继续 · /session all 查看全部）：`));
          for (const s of list.slice(0, 15)) console.log(dim(`· ${s.id} — ${s.title || '（无标题）'}（${s.messages} 条消息 · ${s.model}）`));
          if (list.length > 15) console.log(dim(`… 还有 ${list.length - 15} 个`));
        }
        safePrompt();
        continue;
      }
      // 支持 id 前缀匹配；多个命中时列出候选不静默选（避免继续到错误的会话）；
      // 排除当前正在进行的会话（它的占位文件会污染前缀匹配，e2e 抓到）
      const currentSessionId = runOpts.sessionPath ? sessionIdFromPath(runOpts.sessionPath) : '';
      const cands = (await findSessionCandidates(arg)).filter((c) => c.id !== currentSessionId);
      if (cands.length === 0) {
        console.log(red(`会话「${arg}」不存在（/session 查看当前目录的历史会话）`));
        safePrompt();
        continue;
      }
      if (cands.length > 1) {
        console.log(red(`「${arg}」匹配 ${cands.length} 个会话，请用完整 id 继续：`));
        for (const c of cands.slice(0, 9)) console.log(dim(`· ${c.id} — ${c.title || '（无标题）'}（${c.messages} 条消息 · ${c.model}）`));
        safePrompt();
        continue;
      }
      const file = cands[0].path;
      const loaded = await loadSession(file);
      if (!loaded) {
        console.log(red(`会话「${arg}」加载失败`));
        safePrompt();
        continue;
      }
      const prevSessionPath = runOpts.sessionPath;
      messages.length = 0;
      messages.push(...loaded.messages);
      runOpts.sessionPath = file; // 继续追加到同一会话文件
      savedCount = persistableMessages(messages).length;
      // 轨迹记录器同步重开到新会话文件（读回其历史事件续 seq/turn；失败保留原内存事件）
      const oldEvents = runOpts.events;
      runOpts.events = await EventRecorder.open(file).catch(() => oldEvents);
      // 被替换的是本次交互刚创建的空占位会话（0 条消息）→ 删除，避免残留孤儿会话
      if (prevSessionPath && prevSessionPath !== file) await removeEmptySession(prevSessionPath).catch(() => {});
      console.log(green(`已继续会话 ${loaded.meta.id}（${loaded.messages.length} 条消息 · 模型 ${loaded.meta.model}${loaded.meta.title ? ` · 标题「${loaded.meta.title}」` : ''}）`));
      if (loaded.meta.title) setTerminalTitle(loaded.meta.title);
      safePrompt();
      continue;
    }
    if (cmd === '/redo' || cmd.startsWith('/redo ')) {
      // /redo：重做上次撤销（all = 全部重做）
      const stack = runOpts.undoStack;
      if (!stack || stack.redoSize === 0) {
        console.log(dim('没有可重做的操作（/undo 撤销后才有；新写入会清空 redo 历史）'));
        safePrompt();
        continue;
      }
      const all = /(?:^|\s)all(?=\s|$)/.test(cmd.slice(5));
      if (all) {
        const entries = stack.redoAll();
        const results: string[] = [];
        for (const e of entries) results.push(await applyUndo(e).catch(() => `重做失败：${e.path}`));
        console.log(green(`已重做全部 ${results.length} 个操作`));
        for (const r of results) console.log(dim(`· ${r}`));
        messages.push({ role: 'system', content: `[已执行 /redo all] 已恢复 ${results.length} 个被撤销的写操作。` });
      } else {
        const entry = stack.redo();
        if (!entry) continue;
        const msg = await applyUndo(entry).catch(() => `重做失败：${entry.path}`);
        console.log(green(stack.redoSize > 0 ? `${msg}（还有 ${stack.redoSize} 个可重做，/redo all 全部重做）` : `${msg}（无更多可重做）`));
        messages.push({ role: 'system', content: `[已执行 /redo] ${msg}。` });
      }
      safePrompt();
      continue;
    }
    if (cmd === '/doctor') {
      // /doctor：环境诊断（Node/Bun/API 连通性/配置健康检查）
      if (!runOpts.cfg) {
        console.log(red('配置信息不可用'));
      } else {
        console.log(dim('正在诊断环境…'));
        for (const line of await doctorReport(runOpts.cfg)) console.log(dim(line));
      }
      safePrompt();
      continue;
    }
    if (cmd === '/trace') {
      // /trace：本次会话的轨迹账本（每轮请求/工具/消息/压缩的事件序列折叠投影）。
      // 数据源 = 事件记录器内存全量事件；console 端文本账本，TUI 端右侧面板。
      const events = runOpts.events?.events ?? [];
      if (events.length === 0) {
        console.log(dim('暂无轨迹——开始对话后这里会记录每一轮请求/工具/消息'));
      } else {
        console.log(dim(`轨迹账本（${events.length} 条事件 · 当前会话，含恢复的历史）：`));
        for (const line of buildTraceTextLines(events, { full: true })) console.log(dim(line));
      }
      safePrompt();
      continue;
    }
    if (cmd === '/help') {
      printHelp();
      safePrompt();
      continue;
    }
    if (cmd === '/init' || cmd.startsWith('/init ')) {
      // /init：扫描项目结构 → LLM 生成 AGENTS.md（项目记忆；已存在不覆盖）
      // /init --global：生成 ~/.config/omni/AGENTS.md（跨项目用户偏好）
      const isGlobal = /(?:^|\s)--global(?=\s|$)/.test(cmd);
      if (isGlobal) {
        console.log(dim('正在扫描用户环境并生成全局记忆 AGENTS.md…'));
        const content = await generateGlobalAgentsFile(currentClient, currentModel);
        if (!content) {
          console.log(red('全局记忆生成失败（网络 / API 问题），请重试'));
        } else {
          const res = await writeGlobalAgentsFile(content);
          console.log(
            res.ok
              ? green(`已生成全局记忆 ${res.path}（所有项目会话自动加载）`)
              : red(`已存在 ${res.path}，/init --global 不覆盖（如需重新生成请先删除或重命名）`)
          );
        }
      } else {
        const root = findProjectRoot(process.cwd());
        console.log(dim(`正在扫描项目并生成 AGENTS.md（项目根：${root}）…`));
        const content = await generateAgentsFile(currentClient, currentModel, root);
        if (!content) {
          console.log(red('AGENTS.md 生成失败（网络 / API 问题），请重试'));
        } else {
          const res = await writeAgentsFile(root, content);
          console.log(
            res.ok
              ? green(`已生成 ${res.path}（下次会话自动加载为项目记忆）`)
              : red(`已存在 ${res.path}，/init 不覆盖（如需重新生成请先删除或重命名）`)
          );
        }
      }
      safePrompt();
      continue;
    }
    if (!cmd) {
      safePrompt();
      continue;
    }
    // Hooks：UserPromptSubmit——hook 返回 updatedPrompt 可改写 prompt（补上下文/策略）
    let userText = cmd;
    if (runOpts.hooks?.has('UserPromptSubmit')) {
      userText = (await runOpts.hooks.userPromptSubmit(cmd)).prompt;
    }
    messages.push({ role: 'user', content: userText });
    out.onUserMessage(cmd); // 回显用户原文（改写不替换 UI 回显，hook 输出已回显）
    runOpts.events?.user(userText); // 轨迹：用户消息（记录模型实际看到的 prompt，source=user）
    // 上下文管理：首轮预载相关文件 + 长对话摘要压缩（选项由入口注入 runOpts.context；
    // recorder 传下去——压缩成功时记 compact 轨迹事件）
    await prepareContext(currentClient, currentModel, messages, runOpts.context ?? {}, runOpts.events);
    runOpts.planMode = planMode; // 每轮同步计划模式（/plan 切换即时生效）
    runOpts.permission = permission; // 每轮同步权限档位（/permission 切换即时生效）
    runOpts.safetyGate?.setTier(permission); // 共用闸门（子代理）同步，与 TUI 路径一致
    // 请求失败（网络/401/端点错误）时 runAgent 已提示并正常返回；这里再兜底捕获意外异常，
    // 只在控制台提示、不把交互循环打崩
    try {
      await runAgent(currentClient, currentModel, messages, runOpts, out);
    } catch (err) {
      console.log(red(`运行出错：${(err as Error)?.message ?? String(err)}（可修正配置后重发）`));
    }
    await persistTurn(); // 本轮消息（用户 + 助手 + 工具结果）追加进会话文件
    out.onTurnEnd();
    safePrompt();
  }
  rl.close();
}

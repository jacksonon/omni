/**
 * 交互模式：readline 循环，消息跨轮次保留（上下文连续）。
 * 支持 /exit、/clear、/help 命令。
 */
import readline from 'node:readline/promises';
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
import type { RunOptions } from '../agent/types.js';
import type { Output } from '../output/types.js';
import { cyan, dim, green, red } from '../ui.js';
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
  // 会话持久化：增量追加每轮新增消息。
  // savedCount 统计**可落盘**消息数（脚手架 system 消息不落盘，见 persistableMessages）：
  // · --continue/-r 恢复时历史已在文件里 → 从可落盘数起步，避免整段重复追加（review 抓到的 bug）；
  // · prepareContext 每轮可能 unshift 全局/项目记忆/预载 system 消息（不落盘）——按可落盘数
  //   切片不受下标偏移影响（否则恢复会话会把上轮回答重复写盘，实测抓到）
  const sessionPath = runOpts.sessionPath;
  let savedCount = persistableMessages(messages).length;
  const persistTurn = async (): Promise<void> => {
    if (!sessionPath) return;
    const persistable = persistableMessages(messages);
    if (savedCount > persistable.length) savedCount = 0; // /clear 后上下文重置
    if (persistable.length <= savedCount) return;
    await appendSessionMessages(sessionPath, persistable.slice(savedCount)).catch(() => {});
    savedCount = persistable.length;
  };
  console.log('输入任务开始；/exit 退出，/help 查看帮助。');
  safePrompt();
  for await (const line of rl) {
    const cmd = line.trim();
    if (cmd === '/exit') {
      // 会话结束：把本轮新表达的偏好自动追加进全局记忆（autoMemory 开关；静默失败）
      if (runOpts.context?.autoMemory !== false && messages.some((m) => m.role === 'user')) {
        await maybeWriteGlobalMemory(client, model, messages).catch(() => {});
      }
      if (sessionPath) await finalizeSession(sessionPath).catch(() => {}); // 刷新会话更新时间
      break;
    }
    if (cmd === '/clear') {
      messages.length = 0;
      savedCount = 0;
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
        const entries = stack.popAll();
        const results: string[] = [];
        for (const e of entries) results.push(await applyUndo(e).catch(() => `撤销失败：${e.path}`));
        console.log(green(`已撤销全部 ${results.length} 个写操作`));
        for (const r of results) console.log(dim(`· ${r}`));
        messages.push({ role: 'system', content: `[已执行 /undo all] 本次会话 ${results.length} 个文件修改已全部回滚，请勿再基于旧结果操作。` });
      } else {
        const entry = stack.pop();
        if (!entry) continue;
        const msg = await applyUndo(entry).catch(() => `撤销失败：${entry.path}`);
        console.log(green(stack.size > 0 ? `${msg}（还有 ${stack.size} 个可撤销，/undo all 全部撤销）` : `${msg}（无更多可撤销）`));
        messages.push({ role: 'system', content: `[已执行 /undo] ${msg}。该文件的写操作已回滚，请勿再基于旧内容操作。` });
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
        const content = await generateGlobalAgentsFile(client, model);
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
        const content = await generateAgentsFile(client, model, root);
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
    messages.push({ role: 'user', content: cmd });
    out.onUserMessage(cmd);
    // 上下文管理：首轮预载相关文件 + 长对话摘要压缩（选项由入口注入 runOpts.context）
    await prepareContext(client, model, messages, runOpts.context ?? {});
    runOpts.planMode = planMode; // 每轮同步计划模式（/plan 切换即时生效）
    runOpts.permission = permission; // 每轮同步权限档位（/permission 切换即时生效）
    runOpts.safetyGate?.setTier(permission); // 共用闸门（子代理）同步，与 TUI 路径一致
    await runAgent(client, model, messages, runOpts, out);
    await persistTurn(); // 本轮消息（用户 + 助手 + 工具结果）追加进会话文件
    out.onTurnEnd();
    safePrompt();
  }
  rl.close();
}

/**
 * 会话 fork（/fork）：从历史某点复制独立新会话，原会话不丢。
 * 跨会话消息（/send）：向指定会话发消息，接收结果。
 *
 * · fork 只复制指定条数内的消息（脚手架 system 消息被过滤），
 *   新会话独立 id/时间戳，project 与当前一致。
 * · send 串行执行：保存当前上下文 → 载入目标会话 →
 *   追加用户消息 → 跑一轮 runAgent → 结果落盘 → 恢复当前上下文。
 */
import { appendFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { sessionsDir, newSessionId, isPersistable, loadSession, finalizeSession } from './session.js';
import type { RunOptions } from './types.js';
import type { Output } from '../output/types.js';
import { prepareContext } from './context.js';
import { runAgent } from './loop.js';

/**
 * 从已有会话 fork 新会话：复制前 splitIndex 条消息（1-based，含该索引）到新文件。
 * 脚手架 system 消息被过滤。返回新文件路径；失败返回 null。
 */
export async function forkSession(
  sourceFile: string,
  splitIndex: number,
  project: string,
  model: string
): Promise<string | null> {
  try {
    const loaded = await loadSession(sourceFile);
    if (!loaded) return null;
    const msgs = loaded.messages.filter(isPersistable);
    if (splitIndex < 1 || splitIndex > msgs.length) return null;
    const forkMsgs = msgs.slice(0, splitIndex);
    if (forkMsgs.length === 0) return null;

    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    const id = newSessionId(project);
    const now = Date.now();
    const file = path.join(dir, `${id}.jsonl`);
    const meta = { id, project, model, created: now, updated: now, title: loaded.meta.title };
    const lines = [JSON.stringify({ t: 'meta', ...meta })];
    for (const m of forkMsgs) lines.push(JSON.stringify({ t: 'm', m }));
    await writeFile(file, lines.join('\n') + '\n', 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * 向目标会话发送消息并等待结果（串行跨会话）：
 * 1. 保存当前 messages 快照
 * 2. 加载目标会话 messages
 * 3. 追加用户消息 → prepareContext → runAgent
 * 4. 结果落盘到目标会话文件
 * 5. 恢复当前 messages
 * 返回结果文本（失败返回 null）。
 */
export async function sendSessionMessage(
  sessionId: string,
  text: string,
  client: OpenAI,
  model: string,
  runOpts: RunOptions,
  output: Output,
  // 当前会话的消息（保存/恢复用）
  currentMessages: ChatCompletionMessageParam[]
): Promise<string | null> {
  try {
    // 查找目标会话
    const { findSessionById } = await import('./session.js');
    const targetFile = await findSessionById(sessionId);
    if (!targetFile) return null;
    const loaded = await loadSession(targetFile);
    if (!loaded) return null;

    // 保存当前消息快照
    const savedMessages = [...currentMessages];
    // 当前消息数量（用于恢复后截取差值）
    const savedLen = currentMessages.length;

    // 替换为目标会话的上下文
    currentMessages.length = 0;
    currentMessages.push(...loaded.messages);
    // 追加用户消息
    currentMessages.push({ role: 'user', content: text });

    // 准备上下文 + 跑一轮 Agent（记录本轮新增消息的起点）
    await prepareContext(client, model, currentMessages, runOpts.context ?? {}, runOpts.events);
    const beforeLen = currentMessages.length;
    output.onUserMessage(text);
    await runAgent(client, model, currentMessages, runOpts, output);

    // 提取新增的助手消息作为结果（本轮起点之后的消息，精确——不受 prepareContext 注入影响）
    const newMsgs = currentMessages.slice(beforeLen);
    const resultParts: string[] = [];
    for (const m of newMsgs) {
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        resultParts.push(m.content.trim());
      }
    }
    const result = resultParts.join('\n') || null;

    // 落盘目标会话（本轮新增消息）
    const { appendSessionMessages } = await import('./session.js');
    await appendSessionMessages(targetFile, newMsgs);
    await finalizeSession(targetFile);

    // 恢复当前会话消息（只保留原始消息，不保留目标会话的历史）
    currentMessages.length = 0;
    currentMessages.push(...savedMessages);

    return result;
  } catch {
    return null;
  }
}
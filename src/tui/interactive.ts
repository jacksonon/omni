/**
 * TUI 交互模式：底部输入框 + 消息滚动区，多轮对话全部在 TUI 内完成。
 *
 * 流程：等待输入框 Enter 提交 → 回显用户消息 → 跑一轮 Agent → 等待下一轮。
 * 支持 /exit、/clear、/help 命令。Ctrl+C 由渲染器的 exitOnCtrlC 处理（直接退出进程）。
 *
 * 按键刷新：输入框内部编辑会自行 requestRender，但这里再订阅一次 keypress
 * 显式重绘，兜底保证键入字符实时上屏（与 30ms 节流无关，代价很小）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { InputRenderable } from '@opentui/core';
import { runAgent } from '../agent/loop.js';
import type { RunOptions } from '../agent/types.js';
import type { TuiOutput } from './output.js';
import type { TuiSession, TuiKey } from './render.js';
import type { ScrollAction, TuiState } from './state.js';

/**
 * 等待输入框下一次 Enter 提交，resolve 出输入内容。
 *
 * InputRenderable 重写了 submit()：Enter 时 emit 'enter' 事件（携带当前值），
 * 不调用父类的 onSubmit 回调，所以这里监听 'enter' 事件而非设置 onSubmit。
 */
function waitForSubmit(input: InputRenderable): Promise<string> {
  return new Promise((resolve) => {
    const handler = (value: string) => {
      input.off('enter', handler); // 一次性：本次提交消费后移除，避免重复触发
      resolve(value);
    };
    input.on('enter', handler);
  });
}

/**
 * 按键 → 滚动动作（返回 null 表示交给输入框处理）。
 *
 * 冲突规则：输入框（Textarea）占用了 ↑/↓/Home/End（光标移动），
 * 所以只有当输入框为空时这些键才用于滚动；PgUp/PgDn/Ctrl+↑/↓/Ctrl+Home/End
 * 输入框未绑定，始终可滚动。
 */
function resolveScrollAction(key: TuiKey, input: InputRenderable): ScrollAction | null {
  const empty = input.value === '';
  switch (key.name) {
    case 'pageup':
      return 'page-up';
    case 'pagedown':
      return 'page-down';
    case 'up':
      return key.ctrl || empty ? 'line-up' : null;
    case 'down':
      return key.ctrl || empty ? 'line-down' : null;
    case 'home':
      return key.ctrl || key.meta || empty ? 'top' : null;
    case 'end':
      return key.ctrl || key.meta || empty ? 'bottom' : null;
    default:
      return null;
  }
}

export async function runTuiInteractive(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  runOpts: RunOptions,
  out: TuiOutput,
  session: TuiSession,
  state: TuiState
): Promise<void> {
  const input = session.input;
  if (!input) return;

  const unsubKey = session.onKeyPress((key) => {
    // 滚动键：发出一次性意图（computeRows 消费），preventDefault 阻止输入框处理该键
    const action = resolveScrollAction(key, input);
    if (action) {
      state.scrollIntent = { action };
      key.preventDefault();
    }
    // 输入框自行 requestRender，这里兜底重绘（无状态变更时 repaint 是幂等的）
    void session.paint().catch(() => {});
  });

  try {
    input.focus();
    for (;;) {
      out.onWaitForInput();
      await session.paint();
      const text = await waitForSubmit(input);
      const cmd = text.trim();
      // 提交后回到最新：新消息和后续回答应立即可见
      state.scrollTop = null;
      state.scrollIntent = null;
      input.value = '';
      await session.paint(); // 立即清掉输入框，避免残留文本影响阅读

      if (!cmd) continue;
      if (cmd === '/exit') break;
      if (cmd === '/clear') {
        messages.length = 0;
        out.clearScrollback();
        continue;
      }
      if (cmd === '/help') {
        out.showHelp();
        continue;
      }

      messages.push({ role: 'user', content: cmd });
      out.onUserMessage(cmd);
      // Agent 运行期间 blur 输入框：防止运行中键入的内容混入下一轮输入
      input.blur();
      await runAgent(client, model, messages, runOpts, out);
      out.onTurnEnd();
      input.focus();
    }
  } finally {
    unsubKey();
  }
}

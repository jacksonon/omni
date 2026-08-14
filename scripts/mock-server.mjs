/**
 * 本地 mock OpenAI API 服务器。
 *
 * 用途：没有真实 API Key 也能端到端验证 Agent 循环——
 * 第一轮返回一个 run_command 工具调用，模型执行工具后，
 * 第二轮（历史中已有 role=tool 消息）返回最终回答。
 *
 * 用法：npm run mock（默认端口 8787，可用 PORT 环境变量覆盖）
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
// MOCK_STREAM=1 时逐字分块 + 延迟发送（模拟真实模型几百次流式重绘，用于高重绘压力测试）
const STREAM_MODE = process.env.MOCK_STREAM === '1';
// MOCK_WRITE=1 时第一轮改发 write_file 调用（/undo 撤销 e2e 验证：写入 undo-test.txt）
const MOCK_WRITE = process.env.MOCK_WRITE === '1';
// MOCK_DANGEROUS=1 时第一轮发危险命令 run_command（full 直通 / safe 审批 e2e 验证）
const MOCK_DANGEROUS = process.env.MOCK_DANGEROUS === '1';
// 思考内容可配置：MOCK_REASONING=long 时输出一长段无换行文本（模拟 grok 等模型把
// reasoning 一次性塞进一个 delta、且不带换行的真实场景，用于验证流式显示）
const LONG_REASONING = '我需要仔细分析这个任务的要求和当前环境。首先确认用户想要什么，然后规划出最合理的执行步骤，确保每一步都有明确的验证方式。这个思考过程可能很长而且没有换行，正好用来验证终端上的流式输出是否逐字显示。';
const REASONING_1 = process.env.MOCK_REASONING === 'long' ? LONG_REASONING : '我需要分析这个任务。\n看起来应该先验证一下运行环境。';
// MOCK_MARKDOWN=1 时最终回答包含 Markdown（加粗/表格/代码块/列表/任务清单/标题），用于验证 TUI 行式渲染
const MARKDOWN_BASE =
  process.env.MOCK_MARKDOWN === '1'
    ? '任务完成 ✅ **mock 端到端验证通过**。\n\n## 验证点\n- 工具调用成功\n- 流式输出正常\n\n| 项目 | 状态 | 说明 |\n| --- | :---: | --- |\n| 工具调用 | ✅ | 执行成功 |\n| 流式输出 | ✅ | 逐字渲染 |\n| ~~废弃项~~ | ❌ | 已移除 |\n\n- [x] 已完成事项\n- [ ] 待办事项\n\n示例代码：\n```js\nconst result = await runCommand("echo mock-ok");\nconsole.log(result);\n```\n\n行内代码 `mock-ok` 与 **加粗** 均应正确渲染。'
    : '任务完成 ✅ mock 端到端验证通过。';
// MOCK_LONGLINE=1 时追加一长段无换行的散文（验证长消息自动折行而非截断）
const LONG_LINE =
  process.env.MOCK_LONGLINE === '1'
    ? '\n\n这是一段特意构造的非常长的无换行文本，用来验证终端里的消息在超过屏幕宽度时会自动折行而不是被截断，长度一路延伸下去直到超过一行所能容纳的列数，从而确认每一段内容都完整可见。LONGLINE-END。'
    : '';
const MARKDOWN_ANSWER = MARKDOWN_BASE + LONG_LINE;

const server = http.createServer((req, res) => {
  // 兼容 baseURL 带 /v1 与不带 /v1 两种情况
  const isChat = req.url?.endsWith('/chat/completions') ?? false;
  if (req.method !== 'POST' || !isChat) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const messages = parsed.messages ?? [];
    // 请求里的模型名（/model 切换 e2e：非默认 mock 时在回答里带 [模型 X] 标记）
    const modelName = typeof parsed.model === 'string' ? parsed.model : 'mock';
    const wantUsage = parsed.stream_options?.include_usage === true;
    // 上下文管理：长对话摘要压缩是独立请求（system 提示词以「把以下 Agent 对话压缩」开头）
    const wantSummary =
      typeof messages[0]?.content === 'string' && messages[0].content.startsWith('把以下 Agent 对话压缩成要点摘要');
    // 会话标题生成是独立轻量请求：max_tokens 很小（≤60）→ 返回固定标题
    const wantTitle = parsed.max_tokens != null && parsed.max_tokens <= 60;
    // /init 生成 AGENTS.md 是独立请求（system 提示词以「你是项目文档工程师」开头）
    const wantInit =
      typeof messages[0]?.content === 'string' && messages[0].content.startsWith('你是项目文档工程师');
    // /init --global 生成全局记忆（system 提示词以「你是用户偏好整理员」开头）
    const wantInitGlobal =
      typeof messages[0]?.content === 'string' && messages[0].content.startsWith('你是用户偏好整理员');
    // 会话结束自动写入全局记忆（system 提示词以「你是记忆整理员」开头）
    const wantMemoryExtract =
      typeof messages[0]?.content === 'string' && messages[0].content.startsWith('你是记忆整理员');
    // /review 代码审查（system 提示词以「你是资深代码审查员」开头）
    const wantReview =
      typeof messages[0]?.content === 'string' && messages[0].content.startsWith('你是资深代码审查员');
    const last = messages[messages.length - 1];
    const hasToolResult = last?.role === 'tool';
    // 第一轮的工具调用：默认 run_command；MOCK_WRITE=1 时改发 write_file（/undo e2e）；
    // MOCK_DANGEROUS=1 时发危险命令（full 直通 / safe 审批 e2e）。
    // 注意用 JSON.stringify 生成 arguments——单引号字符串里的 \n 是真实换行，会让 JSON 非法
    const firstToolCall = MOCK_WRITE
      ? { name: 'write_file', arguments: JSON.stringify({ path: 'undo-test.txt', content: 'mock-write-content\n' }) }
      : MOCK_DANGEROUS
        ? { name: 'run_command', arguments: '{"command":"git push origin main"}' }
        : { name: 'run_command', arguments: '{"command":"echo mock-ok"}' };
    // 计划模式（/plan）：loop 按 planMode 过滤后请求的 tools 里没有 run_command →
    // 直接返回一份「实施计划」回答（不发起工具调用），验证只读工具链 e2e
    const planMode =
      Array.isArray(parsed.tools) &&
      !parsed.tools.some((t) => t.function?.name === 'run_command');

    // omni 始终以流式请求，这里统一返回 SSE
    res.writeHead(200, { 'content-type': 'text/event-stream' });

    const sendChunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // stream_options.include_usage 时末 chunk 携带 usage（TUI footer 展示 token 用量）
    const usageChunk = (id) => ({
      id,
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(wantUsage ? { usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } } : {}),
    });

    if (wantSummary) {
      // 摘要压缩请求：返回固定摘要（长对话压缩 e2e 验证）
      sendChunk({
        id: 'mock-summary',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: '（摘要）用户要求验证 mock 端到端链路，已执行命令并确认结果正常。' }, finish_reason: null }],
      });
      sendChunk(usageChunk('mock-summary-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (wantTitle) {
      // 标题请求：直接返回固定标题（首轮对话后 TUI 顶部显示「— mock 端到端验证 —」）
      sendChunk({
        id: 'mock-title',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'mock 端到端验证' }, finish_reason: null }],
      });
      sendChunk(usageChunk('mock-title-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (wantInitGlobal) {
      // /init --global 请求：返回固定全局记忆（全局记忆 e2e 验证）
      sendChunk({
        id: 'mock-init-global',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                '# 全局偏好\n\n## 通用\n- 优先使用中文回复\n- 代码注释使用中文\n\n## 工具\n- 常用 npm 管理依赖\n\n## 工作方式\n- 小步快跑，先验证再继续',
            },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-init-global-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (wantReview) {
      // /review 请求：返回固定审查意见（review e2e 验证）
      sendChunk({
        id: 'mock-review',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                '## 审查结果（mock）\n\n- ✅ typecheck 通过\n- ✅ 改动范围清晰，无明显的 bug 或安全问题\n- 💡 建议：补充注释说明新逻辑的边界情况',
            },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-review-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (wantMemoryExtract) {
      // 会话结束自动写入：返回固定偏好条目（autoMemory e2e 验证——追加进全局记忆文件）
      sendChunk({
        id: 'mock-memory-extract',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '- 用户偏好使用中文回复\n- 用户喜欢简洁的步骤说明' },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-memory-extract-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (planMode && !hasToolResult) {
      // 计划模式请求：返回实施计划（不调用任何工具；若历史已有 tool 结果则正常回答）
      sendChunk({
        id: 'mock-plan',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                '## 实施计划（计划模式 · 只读调研）\n\n1. 用 list_directory 查看项目根目录结构；\n2. 用 read_file 阅读 package.json 确认脚本；\n3. 确认后退出计划模式再执行修改。',
            },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-plan-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (wantInit) {
      // /init 请求：返回固定 AGENTS.md（/init e2e 验证——生成文件内容 + 不覆盖已存在）
      sendChunk({
        id: 'mock-init',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                '# Mock 项目\n\n## 项目是什么\nmock 端到端验证用项目。\n\n## 常用命令\n- `npm run dev` 开发运行\n\n## 对 AI Agent 的协作规范\n- 改代码前先读相关文件。',
            },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-init-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // MOCK_STREAM=1：把 reasoning/content 拆成小块、间隔 20ms 逐字发送，
    // 制造与真实模型一致的成百上千次流式重绘。
    // MOCK_SLOW_FIRST=1：首 chunk 前延迟 2s（模拟慢思考/首 token 长延迟——取消在
    // create 挂起阶段必须立即生效，不能等首 chunk）；MOCK_SLOW_GAP=1：reasoning
    // 中段插入 2s 停顿（模拟思考中长间隔——取消不能等下一个 chunk）
    if (STREAM_MODE) {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const SLOW_FIRST = process.env.MOCK_SLOW_FIRST === '1';
      const SLOW_GAP = process.env.MOCK_SLOW_GAP === '1';
      const streamDelta = async (pieces, makeDelta) => {
        for (let i = 0; i < pieces.length; i++) {
          if (SLOW_FIRST && i === 0) await delay(2000);
          if (SLOW_GAP && i === Math.floor(pieces.length / 2)) await delay(2000);
          await delay(20);
          sendChunk({
            id: 'mock-stream',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'mock',
            choices: [{ index: 0, delta: makeDelta(pieces[i]), finish_reason: null }],
          });
        }
      };
      const chars = (text) => Array.from(text);
      (async () => {
        if (!hasToolResult) {
          await streamDelta(chars(REASONING_1), (p) => ({ role: 'assistant', reasoning_content: p }));
          sendChunk({
            id: 'mock-tool',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'mock',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_mock',
                      type: 'function',
                      function: firstToolCall,
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        } else {
          await streamDelta(chars('工具执行成功了，现在总结结果并回复用户。'), (p) => ({
            role: 'assistant',
            reasoning_content: p,
          }));
          await streamDelta(chars(MARKDOWN_ANSWER + (modelName !== 'mock' ? `\n\n[模型 ${modelName}]` : '')), (p) => ({ role: 'assistant', content: p }));
        }
        sendChunk(usageChunk('mock-done'));
        res.write('data: [DONE]\n\n');
        res.end();
      })().catch((e) => {
        res.write(`data: {"error": ${JSON.stringify(String(e))}}\n\n`);
        res.end();
      });
      return;
    }

    if (!hasToolResult) {
      // 第一轮：先输出思考过程，再要求调用 run_command 执行 echo
      sendChunk({
        id: 'mock-0',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: REASONING_1 },
            finish_reason: null,
          },
        ],
      });
      sendChunk({
        id: 'mock-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,              delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_mock',
                  type: 'function',
                  function: firstToolCall,
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    } else {
      // 第二轮：先输出思考过程，再返回最终回答
      sendChunk({
        id: 'mock-1.5',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: '工具执行成功了，现在总结结果并回复用户。' },
            finish_reason: null,
          },
        ],
      });
      sendChunk({
        id: 'mock-2',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: MARKDOWN_ANSWER + (modelName !== 'mock' ? `\n\n[模型 ${modelName}]` : '') },
            finish_reason: null,
          },
        ],
      });
    }

    sendChunk(usageChunk('mock-3'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, () => {
  console.log(`mock API 服务器已启动: http://127.0.0.1:${PORT}/v1/chat/completions`);
});

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
// MOCK_ASK=1 时第一轮发 ask_user 调用（用户提问面板 e2e 验证：选项/自定义/取消）
const MOCK_ASK = process.env.MOCK_ASK === '1';
// MOCK_MULTIREAD=1 时第一轮**并行发 3 个 read_file 调用**（TUI 多读合并展示 e2e 验证：
// `→ Read 3 files` 一张卡、点击展开逐条 ⤷）
const MOCK_MULTIREAD = process.env.MOCK_MULTIREAD === '1';
// MOCK_SUBAGENT=1 时第一轮发 delegate 调用（子代理委托 e2e 验证：嵌套/进度事件/结果回传）
const MOCK_SUBAGENT = process.env.MOCK_SUBAGENT === '1';
// 运行时可变副本（POST /__mock/config 切换；默认跟随环境变量）
let curWrite = MOCK_WRITE;
let curDangerous = MOCK_DANGEROUS;
let curAsk = MOCK_ASK;
let curMultiread = MOCK_MULTIREAD;
let curSubagent = MOCK_SUBAGENT;
// curSlow：第一轮工具调用 chunk 前延迟 2s（web 服务取消运行 e2e 用——让 run 停在流中可被 abort）
let curSlow = process.env.MOCK_SLOW_TOOL === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
// MOCK_JSON=1 时最终回答改为单个 JSON 对象（headless `omni exec --output-schema` e2e：
// schema 通过 → exit 0；json/stream-json 输出里 result 字段即为该 JSON 文本）
const MOCK_JSON = process.env.MOCK_JSON === '1';
const JSON_ANSWER = '{"verdict":"safe","summary":"任务完成 ✅ mock 端到端验证通过。"}';
const FINAL_ANSWER = MOCK_JSON ? JSON_ANSWER : MARKDOWN_ANSWER;

const server = http.createServer((req, res) => {
  // 运行时调整 mock 行为（e2e 探针用）：POST /__mock/config { write|dangerous|ask|multiread|subagent: bool }
  // 让同一个 mock 进程可以连续跑多个场景（默认行为 / 审批 / 提问），无需重启
  if (req.method === 'POST' && req.url?.endsWith('/__mock/config')) {
    let cb = '';
    req.on('data', (c) => (cb += c));
    req.on('end', () => {
      try {
        const cfg = JSON.parse(cb || '{}');
        if (typeof cfg.write === 'boolean') curWrite = cfg.write;
        if (typeof cfg.dangerous === 'boolean') curDangerous = cfg.dangerous;
        if (typeof cfg.ask === 'boolean') curAsk = cfg.ask;
        if (typeof cfg.multiread === 'boolean') curMultiread = cfg.multiread;
        if (typeof cfg.subagent === 'boolean') curSubagent = cfg.subagent;
        if (typeof cfg.slow === 'boolean') curSlow = cfg.slow;
      } catch {
        /* ignore malformed config */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 兼容 baseURL 带 /v1 与不带 /v1 两种情况
  const isChat = req.url?.endsWith('/chat/completions') ?? false;
  if (req.method !== 'POST' || !isChat) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
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
    // 子代理请求识别：首条用户消息以子代理提示词开头（runSubagent 的 messages[0] 是 user 角色
    // ——系统提示拼在 prompt 里）——MOCK_SUBAGENT 的 delegate 只发给主代理，子代理内部
    // 走普通 run_command 流程（否则每层 mock 都返回 delegate → 无限嵌套）
    const isSubagentReq =
      typeof messages[0]?.content === 'string' &&
      messages[0].content.startsWith('你是 Omni 的子代理，负责独立完成一项被委托的子任务');
    // 第一轮的工具调用：默认 run_command；MOCK_WRITE=1 时改发 write_file（/undo e2e）；
    // MOCK_DANGEROUS=1 时发危险命令（full 直通 / safe 审批 e2e）。
    // 注意用 JSON.stringify 生成 arguments——单引号字符串里的 \n 是真实换行，会让 JSON 非法
    const firstToolCall = curWrite
      ? { name: 'write_file', arguments: JSON.stringify({ path: 'undo-test.txt', content: 'mock-write-content\n' }) }
      : curDangerous
        ? { name: 'run_command', arguments: '{"command":"git push origin main"}' }
        : curAsk
          ? {
              name: 'ask_user',
              arguments: JSON.stringify({ question: '接下来怎么做？', options: ['继续执行', '先总结', '换个方案'] }),
            }
          : curSubagent && !isSubagentReq
            ? { name: 'delegate', arguments: JSON.stringify({ task: '检查项目根目录并总结发现', agent: '' }) }
            : { name: 'run_command', arguments: '{"command":"echo mock-ok"}' };
    // 第一轮的完整 tool_calls 数组：MOCK_MULTIREAD=1 时并行 3 个 read_file（其余单调用）
    const firstToolCalls = curMultiread
      ? [
          { index: 0, id: 'call_mock_0', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'AGENTS.md' }) } },
          { index: 1, id: 'call_mock_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } },
          { index: 2, id: 'call_mock_2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) } },
        ]
      : [{ index: 0, id: 'call_mock', type: 'function', function: firstToolCall }];
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

    // 编排流水线固定角色（/orchestrate /goal 离线 e2e）：worker / 汇总器 / 对抗审查员 /
    // 目标拆解器 / 验收判定器——按 system 提示词前缀识别，返回固定输出（worker 直接答、不调工具）
    const sys0 = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    if (sys0.startsWith('你是 Omni 编排流水线的一个子代理')) {
      // worker：直接返回固定结果（e2e 确定性；真实场景 worker 会正常调工具）
      sendChunk({
        id: 'mock-worker',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '（worker 结果）已从分配角度完成检查：mock 项目结构清晰，无阻塞问题。' },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-worker-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (sys0.startsWith('把以下多个子代理的独立结果汇总')) {
      // 汇总器：返回固定综合结论
      sendChunk({
        id: 'mock-combine',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '（综合结论）各 worker 结论一致：mock 项目可以继续推进，无需额外处理。' },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-combine-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (sys0.startsWith('你是 Omni 编排的对抗审查员')) {
      // 对抗审查员：返回固定审查意见
      sendChunk({
        id: 'mock-review',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '（审查）未发现明显问题；建议补充验收测试。\n总体结论：可采纳' },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-review-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (sys0.startsWith('你是 Omni 目标拆解器')) {
      // 目标拆解器（/goal 缺省自动推导验收标准）：返回固定验收条款
      sendChunk({
        id: 'mock-accept',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '1) 功能完整可运行 2) 关键路径验证通过 3) 无明显缺陷' },
            finish_reason: null,
          },
        ],
      });
      sendChunk(usageChunk('mock-accept-done'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (sys0.startsWith('你是 Omni 验收判定器')) {
      // 验收判定器：第一次「不满足」（验证 /goal 继续迭代）、第二次起「满足」（验证提前结束）
      let goalChecks = Number(process.env.MOCK_GOAL_CHECKS ?? '0');
      goalChecks += 1;
      process.env.MOCK_GOAL_CHECKS = String(goalChecks);
      const verdict = goalChecks === 1 ? '不满足：结果尚未完整' : '满足：验收标准已达成';
      sendChunk({
        id: 'mock-goal',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', content: verdict }, finish_reason: null }],
      });
      sendChunk(usageChunk('mock-goal-done'));
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
                  tool_calls: firstToolCalls,
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
          await streamDelta(chars(FINAL_ANSWER + (!MOCK_JSON && modelName !== 'mock' ? `\n\n[模型 ${modelName}]` : '')), (p) => ({ role: 'assistant', content: p }));
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
      // 第一轮：先输出思考过程，再要求调用工具（curSlow 时工具调用前停顿 2s——web 取消 e2e）
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
      if (curSlow) {
        await sleep(2000);
      }
      sendChunk({
        id: 'mock-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: firstToolCalls,
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
            delta: { role: 'assistant', content: FINAL_ANSWER + (!MOCK_JSON && modelName !== 'mock' ? `\n\n[模型 ${modelName}]` : '') },
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

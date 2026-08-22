/**
 * Web 服务事件协议（SSE 事件名统一在这层声明，server / output 共用）。
 *
 * 客户端（web/app.js）按这些事件名渲染消息流：
 *   ready            —— SSE 刚连上时的初始快照
 *   status           —— 服务器状态快照（模型/权限/运行中…）
 *   session.created  —— 会话创建（{ id, title }）
 *   user.message     —— 用户消息（{ sessionId, text }）
 *   thinking.start   —— 思考块开始（预建，等待 reasoning chunk）
 *   thinking.chunk   —— 思考增量（{ sessionId, text }）
 *   thinking.end     —— 思考结束（{ sessionId }）
 *   tool.start       —— 工具调用开始（{ sessionId, step, name, argsPreview, args }）
 *   tool.result      —— 工具调用完成（{ sessionId, ok, chars, preview, detail }）
 *   answer.chunk     —— 最终回答增量（{ sessionId, text }）
 *   answer.end       —— 最终回答结束
 *   turn.step        —— 本轮第 N 步（{ sessionId, step, maxSteps }）
 *   lap              —— LLM 请求墙钟 / 首 token（{ sessionId, llmMs, firstTokenMs }）
 *   toolsLap         —— 该轮工具执行墙钟（{ sessionId, toolsMs }）
 *   usage            —— token 用量（{ sessionId, prompt, completion, total, cached }）
 *   subagent         —— 子代理进度事件（{ sessionId, ev: SubagentEvent }）
 *   hook.output      —— Hooks 输出回显（{ sessionId, event, lines }）
 *   error            —— 请求失败（{ sessionId, message }）
 *   run.end          —— 一轮运行结束（{ sessionId, reason }）
 *   meta.add         —— 附加元信息行（{ sessionId, text }）
 *   approval.request —— 需要审批（{ sessionId, approvalId, tool, summary, reason }）
 *   approval.resolved—— 审批已处理（{ sessionId, approvalId, allow }）
 *   ask.request      —— 向用户提问（{ sessionId, askId, question, options, multiple }）
 *   ask.resolved     —— 提问已处理（{ sessionId, askId, choices | null }）
 *   title            —— 会话标题已生成（{ sessionId, title }）
 *   clear            —— 清空当前会话视图（{ sessionId }）
 *   workspace.changed—— 工作目录已切换（{ cwd }）
 */
export type WebEventName =
  | 'ready'
  | 'status'
  | 'session.created'
  | 'user.message'
  | 'thinking.start'
  | 'thinking.chunk'
  | 'thinking.end'
  | 'tool.start'
  | 'tool.result'
  | 'answer.chunk'
  | 'answer.end'
  | 'turn.step'
  | 'lap'
  | 'toolsLap'
  | 'usage'
  | 'subagent'
  | 'hook.output'
  | 'error'
  | 'run.end'
  | 'meta.add'
  | 'approval.request'
  | 'approval.resolved'
  | 'ask.request'
  | 'ask.resolved'
  | 'title'
  | 'clear'
  | 'workspace.changed'
  | 'workspace.changed';

/** 广播函数：把（事件名, 数据）发给所有已连接客户端 */
export type WebBroadcast = (type: WebEventName, data: Record<string, unknown>) => void;
/**
 * Agent 主循环的运行态小工具（从 loop.ts 抽出）：
 * 多模态前置校验、错误可重试/取消判定、可被 abort 中断的等待与 sleep。
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** 消息里是否含图片输入（多模态前置校验用：content 为分段数组且带 image 类型） */
export function messagesHaveImage(messages: ChatCompletionMessageParam[]): boolean {
  return messages.some((m) => {
    const c: unknown = (m as { content?: unknown }).content;
    return (
      Array.isArray(c) &&
      c.some((p) => {
        const t = (p as { type?: string })?.type;
        return t === 'image_url' || t === 'input_image' || t === 'image';
      })
    );
  });
}

/** 可被 abort 中断的 sleep（fallback 端点间间隔等待用） */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 请求错误是否值得 fallback 回退（P0）：429 限流 / 408·5xx 网关 / 超时 / 网络层
 * （fetch failed / ECONNRESET 等）→ 可重试；401 鉴权、400 参数、404 模型不存在
 * → 配置问题，换端点同样失败，不浪费回退。
 */
export function isRetryableRequestError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string; name?: string };
  if (typeof e?.status === 'number') {
    return e.status === 408 || e.status === 429 || (e.status >= 500 && e.status <= 599);
  }
  const msg = `${e?.message ?? ''} ${e?.code ?? ''}`.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  );
}

/**
 * 判定一个错误是否为「取消/打断」类：原生 AbortError 之外，OpenAI SDK 在
 * signal 触发时会抛 `APIUserAbortError`（Node25 undici 下 in-flight fetch 真被中断）。
 * 若只认 AbortError，SDK 的 rejection 会逃逸成 unhandledRejection——Node ≥15 默认
 * 直接杀死进程（web 服务整台挂掉）。所有取消判定点统一走这里。
 */
export function isAbortLike(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'AbortError' || e?.name === 'APIUserAbortError' || /was aborted|aborted/i.test(e?.message ?? '');
}

/** 构造 AbortError（bun/Node 通用；流式逐 chunk 检查与工具等待共用） */
export const abortError = (): Error => {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
};

/**
 * 等待可被 abort 中断：信号触发时立即 reject AbortError（不等 p 完成）。
 * 用于工具执行阶段（execute 无 signal 不可中断，但取消/打断不必等它跑完——
 * 用户反馈「esc 取消后再次发消息会先排队」）与 create/流式迭代（bun 的 fetch 不响应
 * in-flight abort，只靠逐 chunk 检查会让取消延迟一个 chunk 间隔——真实模型思考中
 * chunk 间隔可能数秒）。onAbort 可选：信号触发时同步执行（流式迭代用它 iter.return()
 * 让 SDK 迭代器收尾断连）。结果与错误都正常透传；监听器用后即清。
 */
export async function waitAbort<T>(p: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal?.aborted) {
    onAbort?.();
    throw abortError();
  }
  return new Promise<T>((resolve, reject) => {
    const handler = (): void => {
      onAbort?.();
      reject(abortError());
    };
    signal?.addEventListener('abort', handler, { once: true });
    p.then(
      (v) => {
        signal?.removeEventListener('abort', handler);
        resolve(v);
      },
      (e) => {
        signal?.removeEventListener('abort', handler);
        reject(e);
      }
    );
  });
}
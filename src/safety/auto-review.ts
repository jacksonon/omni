/**
 * AI 自动审批（2026-09 补课，对标 Codex `--approve-for-me`）。
 *
 * 需要人工审批的操作先经一次**轻量模型审阅**：把工具名/参数摘要/审批原因/权限档位/
 * 沙箱档位喂给当前模型，返回 `{decision, reason}`。approve 直接放行、deny 回传模型；
 * 审阅失败（超时/解析失败/网关不支持）返回 null → 回退人工审批。
 *
 * 安全边界：审阅器**不能扩大权限与沙箱边界**——它只决定「是否需要打扰用户」，
 * 真正的闸门判定（read 档拒绝、需要审批的原因）在 Safety.gate 里已经完成。
 */
import type OpenAI from 'openai';
import type { ApprovalRequest } from './index.js';

export interface AutoReviewVerdict {
  approve: boolean;
  reason: string;
}

/** 审阅请求超时（ms）：模型慢/网关卡住时不能拖死 Agent 主循环 */
const REVIEW_TIMEOUT_MS = 15_000;

/**
 * 解析模型审阅输出（纯函数，可单测）：
 * 接受 `{decision:"approve"|"deny",reason}` / `{approve:true|false,reason}`，
 * 允许围栏与前后散文（提取第一个 JSON 对象）。
 */
export function parseAutoReviewVerdict(text: string): AutoReviewVerdict | null {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    let approve: boolean | null = null;
    if (typeof obj.approve === 'boolean') approve = obj.approve;
    else if (typeof obj.decision === 'string') {
      const d = obj.decision.toLowerCase();
      if (['approve', 'allow', 'allowed', 'yes', 'ok'].includes(d)) approve = true;
      else if (['deny', 'reject', 'rejected', 'no', 'block'].includes(d)) approve = false;
    }
    if (approve === null) return null;
    const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 300) : '';
    return { approve, reason };
  } catch {
    return null;
  }
}

export interface AutoReviewerOptions {
  client: OpenAI;
  model: string;
  /** 审阅上下文（每次调用实时取：cwd/权限档位/沙箱档位） */
  describeContext: () => { cwd: string; tier: string; sandbox?: string };
  /** 审阅完成回调（UI 展示「自动审阅：批准/拒绝（理由）」） */
  onVerdict?: (req: ApprovalRequest, verdict: AutoReviewVerdict) => void;
}

/**
 * 创建审阅器。返回的函数语义：
 *   verdict    —— 审阅完成（approve/deny，reason 非空可展示）
 *   null       —— 审阅不可用/失败 → 调用方回退人工审批
 */
export function createAutoReviewer(
  opts: AutoReviewerOptions
): (req: ApprovalRequest) => Promise<AutoReviewVerdict | null> {
  return async (req: ApprovalRequest): Promise<AutoReviewVerdict | null> => {
    const { cwd, tier, sandbox } = opts.describeContext();
    const system =
      '你是代码 Agent 的审批审阅器：判断一个即将执行的工具调用是否可以无需用户确认地放行。\n' +
      '原则：只读操作、常规项目内文件修改、常规构建/测试命令 → approve；\n' +
      '删除数据、修改项目外文件、访问凭据/密钥、网络上传、危险或不可逆操作 → deny。\n' +
      '你不改变权限与沙箱判定，只决定是否打扰用户。仅输出 JSON：{"decision":"approve"|"deny","reason":"一句话理由"}';
    const user =
      `工具：${req.tool}\n` +
      `操作：${req.summary}\n` +
      `需要审批的原因：${req.reason}\n` +
      `工作目录：${cwd}\n` +
      `权限档位：${tier}\n` +
      `沙箱：${sandbox || 'off'}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REVIEW_TIMEOUT_MS);
    try {
      const resp = await opts.client.chat.completions.create(
        {
          model: opts.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          max_tokens: 160,
          stream: false,
        },
        { signal: ctrl.signal }
      );
      const raw = resp.choices?.[0]?.message?.content;
      const verdict = parseAutoReviewVerdict(typeof raw === 'string' ? raw : '');
      if (verdict) opts.onVerdict?.(req, verdict);
      return verdict;
    } catch {
      return null; // 超时/网络/解析失败 → 回退人工审批
    } finally {
      clearTimeout(timer);
    }
  };
}

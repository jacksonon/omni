/** 跨前端统一速率口径：OpenCode 口径：输出（含思考）token / 请求开始至流结束耗时，排除工具执行。 */
export const MIN_RATE_SAMPLE_MS = 300;
export interface GenerationUsage { tokens: number; ms: number; basis?: 'request' }
export function validRateSample(tokens: number, ms: number): boolean {
  return Number.isFinite(tokens) && Number.isFinite(ms) && tokens > 0 && ms > 0;
}
export function tokenRate(tokens: number, ms: number): number {
  return validRateSample(tokens, ms) ? Math.round(tokens * 10000 / ms) / 10 : 0;
}
export function sumGeneration(usages: Array<{ generation?: GenerationUsage }>, tokens: number, ms: number): GenerationUsage {
  if (!usages.some(u => u.generation?.basis === 'request')) return { tokens, ms };
  return usages.reduce((sum, u) => {
    if (u.generation?.basis === 'request' && validRateSample(u.generation.tokens, u.generation.ms)) {
      sum.tokens += u.generation.tokens; sum.ms += u.generation.ms;
    }
    return sum;
  }, { tokens: 0, ms: 0 });
}

/** 旧历史没有请求口径标记时，按该步完整请求耗时重建，不能复用旧的纯生成分母。 */
export function requestGeneration(usage: { completion: number; generation?: GenerationUsage }, elapsedMs: number): GenerationUsage {
  return usage.generation?.basis === 'request' ? usage.generation : { tokens: usage.completion, ms: elapsedMs, basis: 'request' };
}

/** 流中仅作估算，分母与完成后相同：从请求开始计时，包含首 token 等待。 */
export class StreamingRate {
  private units = 0;
  private startedAt: number | undefined;
  constructor(startedAt?: number) { this.startedAt = startedAt; }
  add(text: string, now: number): { tokens: number; tps: number } {
    this.startedAt ??= now;
    for (const ch of text) this.units += /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/u.test(ch) ? 1 : 0.25;
    const ms = now - this.startedAt;
    return { tokens: Math.ceil(this.units), tps: ms >= MIN_RATE_SAMPLE_MS ? this.units * 1000 / ms : 0 };
  }
}

/** 跨前端统一速率口径：只对成对的生成 token / 耗时计速，短突发不报峰值。 */
export const MIN_RATE_SAMPLE_MS = 300;
export interface GenerationUsage { tokens: number; ms: number }
export function validRateSample(tokens: number, ms: number): boolean {
  return Number.isFinite(tokens) && Number.isFinite(ms) && tokens > 0 && ms >= MIN_RATE_SAMPLE_MS;
}
export function tokenRate(tokens: number, ms: number): number {
  return validRateSample(tokens, ms) ? Math.round(tokens * 1000 / ms) : 0;
}
export function sumGeneration(usages: Array<{ generation?: GenerationUsage }>, tokens: number, ms: number): GenerationUsage {
  if (!usages.some(u => u.generation !== undefined)) return { tokens, ms };
  return usages.reduce((sum, u) => {
    if (u.generation && validRateSample(u.generation.tokens, u.generation.ms)) {
      sum.tokens += u.generation.tokens; sum.ms += u.generation.ms;
    }
    return sum;
  }, { tokens: 0, ms: 0 });
}

/** 流中仅作估算：累计字符权重，不对每个网络 chunk 各自取整。 */
export class StreamingRate {
  private units = 0;
  private samples: Array<{ at: number; units: number }> = [];
  add(text: string, now: number): { tokens: number; tps: number } {
    for (const ch of text) this.units += /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/u.test(ch) ? 1 : 0.25;
    if (this.samples[this.samples.length - 1]?.at === now) this.samples[this.samples.length - 1]!.units = this.units;
    else this.samples.push({ at: now, units: this.units });
    // 保留最近 1 秒及边界前一采样，按时间窗口计算，避免 1ms 小包放大 EMA。
    while (this.samples.length > 2 && this.samples[1]!.at <= now - 1000) this.samples.shift();
    const first = this.samples[0]!;
    const ms = now - first.at;
    return { tokens: Math.ceil(this.units), tps: ms >= MIN_RATE_SAMPLE_MS ? (this.units - first.units) * 1000 / ms : 0 };
  }
}

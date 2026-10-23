/** 等宽 Braille 点阵：Omni 编织 O，由两条斜向回环交织，中央留出菱形负空间；坐标在采样前旋转。 */
export const OMNI_MARK_ROWS = 9;
export const OMNI_MARK_COLS = 19;
export const OMNI_MARK_SPIN_MS = 1200;

export const OMNI_MARK_AXES = ['center', 'reverse', 'x', 'y', 'diagonal', 'tumble', 'corkscrew'] as const;
export type OmniMarkAxis = typeof OMNI_MARK_AXES[number];

/** 从其余动作中等概率抽取，避免连续重复；首次点击可抽到任意动作。 */
export function randomOmniMarkAxis(previous: OmniMarkAxis | null, random = Math.random): OmniMarkAxis {
  const choices = OMNI_MARK_AXES.filter(axis => axis !== previous);
  return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))]!;
}

export function omniMarkFrame(progress = 0, axis: OmniMarkAxis = 'center'): string[] {
  const angle = progress * Math.PI * 2;
  const flips = axis === 'x' || axis === 'y' || axis === 'diagonal' || axis === 'tumble' || axis === 'corkscrew';
  const roll = axis === 'reverse' ? -angle : axis === 'tumble' ? angle : axis === 'corkscrew' ? angle * 2 : flips ? 0 : angle;
  const cos = Math.cos(roll), sin = Math.sin(roll);
  const tiltAxis = axis === 'y' || axis === 'corkscrew' ? Math.PI / 2 : axis === 'diagonal' ? Math.PI / 4 : axis === 'tumble' ? angle / 2 : 0;
  const ax = Math.cos(tiltAxis), ay = Math.sin(tiltAxis);
  const tilt = flips ? Math.cos(angle) : 1;
  // 保留侧面薄边，避免投影退化时除零或整幅消失。
  const scale = Math.abs(tilt) < 0.06 ? (tilt < 0 ? -0.06 : 0.06) : tilt;
  const dots = [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8], [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]];
  return Array.from({ length: OMNI_MARK_ROWS }, (_, row) =>
    Array.from({ length: OMNI_MARK_COLS }, (_, col) => {
      let bits = 0;
      for (const [dx, dy, bit] of dots) {
        const px = (col * 2 + dx! - 18.5) / 17;
        const py = (row * 4 + dy! - 17.5) / 17;
        // 逆向采样：先还原平面转动，再还原绕指定轴的正交投影。
        const rx = px * cos + py * sin, ry = -px * sin + py * cos;
        const along = rx * ax + ry * ay;
        const across = (-rx * ay + ry * ax) / scale;
        const x = along * ax - across * ay;
        const y = along * ay + across * ax;
        // 两条 ±45° 的椭圆丝带：外轮廓读作 O，交织结构呼应无限循环。
        const u = (x + y) / Math.SQRT2;
        const v = (y - x) / Math.SQRT2;
        const first = Math.abs(Math.hypot(u / 0.94, v / 0.46) - 1) < 0.12;
        const second = Math.abs(Math.hypot(v / 0.94, u / 0.46) - 1) < 0.12;
        // 交叉处错开上下关系，留出一格气口，让丝带具有编织感。
        const firstGap = Math.abs(u) < 0.16 && v > 0;
        const secondGap = Math.abs(v) < 0.16 && u < 0;
        if ((first && !firstGap) || (second && !secondGap)) bits |= bit!;
      }
      return bits ? String.fromCharCode(0x2800 + bits) : ' ';
    }).join('')
  );
}

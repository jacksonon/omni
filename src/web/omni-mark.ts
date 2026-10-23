/** Web / Electron 与 TUI 共享点阵形状及随机动作。构建为独立浏览器脚本。 */
import { omniMarkFrame, randomOmniMarkAxis, OMNI_MARK_SPIN_MS, type OmniMarkAxis } from '../tui/omni-mark.js';

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-omni-mark]')) {
  const mark = button.querySelector<HTMLElement>('.omni-mark-dots');
  if (!mark) continue;
  // SVG 使用等距点坐标，避免浏览器字体的字宽 / 行高压扁 Braille 标识。
  const render = (progress = 0, axis: OmniMarkAxis = 'center') => {
    const dots = [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8], [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]];
    const circles: string[] = [];
    omniMarkFrame(progress, axis).forEach((row, y) => [...row].forEach((char, x) => {
      const bits = char === ' ' ? 0 : char.charCodeAt(0) - 0x2800;
      for (const [dx, dy, bit] of dots) {
        if (bits & bit!) circles.push(`<circle cx="${x * 2 + dx! + 0.5}" cy="${y * 4 + dy! + 1.5}" r=".34"/>`);
      }
    }));
    mark.innerHTML = `<svg viewBox="0 0 38 38" aria-hidden="true" fill="currentColor">${circles.join('')}</svg>`;
  };
  render();
  let previous: OmniMarkAxis | null = null;
  let animation = 0;
  const reset = () => render();
  button.addEventListener('click', () => {
    cancelAnimationFrame(animation);
    previous = randomOmniMarkAxis(previous);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      reset();
      return;
    }
    const axis = previous;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / OMNI_MARK_SPIN_MS);
      if (t >= 1 || !button.isConnected) { reset(); return; }
      render(1 - Math.pow(1 - t, 3), axis);
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  });
}

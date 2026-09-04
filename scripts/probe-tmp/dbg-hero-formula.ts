import { createTestRenderer } from '@opentui/core/testing';
import { createTuiState } from '../../src/tui/state.js';
import { mountTree, repaintTree } from '../../src/tui/render.js';

const HERO_LINES = 4; // OMNI_BANNER.length（render.ts 未导出，这里硬编码同值）

// 公式候选（修正版）：
// status 隐藏（visible=false）后空文本高度 0，但 marginTop:1 仍占 1 行；
// yoga 居中偏移 = round(剩余空间/2)（半行向上取整）；
// metaRow（空内容 BoxRenderable）仍占 1 行 + marginTop 1。
// groupH = status(1) + banner(HERO_LINES) + bannerMargin(1) + pending + ask + gray(inputLines+4) + meta(2)
// grayTopCentered = 1 + round(((height-2) - groupH) / 2) + 1 + HERO_LINES + 1
function predict(height: number, inputLines: number, pendingRows: number, askRows: number): number {
  const groupH = 1 + HERO_LINES + 1 + pendingRows + askRows + (inputLines + 4) + 2;
  const groupTop = 1 + Math.round(((height - 2) - groupH) / 2);
  return groupTop + 1 + HERO_LINES + 1;
}

const ask = false; // ask 面板暂不扫（hero 下 ask 会退出 hero）
let fail = 0;
for (const width of [50, 64, 65, 80]) {
  for (const height of [20, 24, 25, 30]) {
    for (const inputLines of [1, 2, 3]) {
      const s = createTuiState(); s.version = '0.1.0'; s.model = 'mock';
      const t = await createTestRenderer({ width, height });
      const tree = mountTree(t.renderer, s, { withInput: true });
      await t.renderOnce();
      const text = inputLines === 1 ? '/m' : Array.from({ length: inputLines }, (_, i) => `/m line${i}`).join('\n');
      tree.input?.setText(text);
      repaintTree(t.renderer, tree, s, { withInput: true });
      await t.renderOnce();
      const fb = tree.footerBox!;
      const actual = { x: fb.screenX, y: fb.screenY, w: fb.width, h: fb.height };
      const py = predict(height, inputLines, 0, 0);
      const okY = actual.y === py;
      // 水平：hero footerBox 宽 = max(32, round((width-2)*0.75))
      const fw = Math.max(32, Math.round((width - 2) * 0.75));
      const px = 1 + Math.round(((width - 2) - fw) / 2);
      const okX = actual.x === px && actual.w === fw;
      if (!okY || !okX) fail++;
      console.log(
        `${okY && okX ? 'ok  ' : 'FAIL'} w=${width} h=${height} il=${inputLines}` +
        ` actual(x=${actual.x},y=${actual.y},w=${actual.w},h=${actual.h})` +
        ` pred(x=${px},y=${py},w=${fw})`,
      );
      // 输入行数真的生效了吗（setText 换行 → inputLines）？
      if (inputLines === 2 && actual.h !== inputLines + 4) {
        console.log(`     note: footer h=${actual.h} ≠ inputLines(${inputLines})+4 —— setText 折行未按预期生效`);
      }
    }
  }
}
console.log(fail === 0 ? '\n全部吻合' : `\n${fail} 例不吻合`);

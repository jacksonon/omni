/**
 * @ 提及模糊匹配 + 跨目录检索探针：非空查询从 cwd 递归整个项目模糊匹配（文件名前缀 >
 * 文件名包含 > 路径包含 > fzf 模糊子序列），不再一级一级选择；空查询保留顶层浏览；
 * 目录带 / 结尾、跳过 node_modules、隐藏文件规则、dirPart 限定目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { insertMention, listMentionCandidates } from '../../src/tui/mention.js';
import { createTuiState } from '../../src/tui/state.js';

let ok = true;
const check = (cond: boolean, msg: string): void => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ok = false;
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mention2-'));
  fs.mkdirSync(path.join(tmp, 'src', 'tui'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src', 'util'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'main.ts'), '');
  fs.writeFileSync(path.join(tmp, 'src', 'tui', 'render.ts'), '');
  fs.writeFileSync(path.join(tmp, 'src', 'util', 'helper.ts'), '');
  fs.writeFileSync(path.join(tmp, 'README.md'), '');
  fs.writeFileSync(path.join(tmp, 'package.json'), '');
  fs.writeFileSync(path.join(tmp, 'node_modules', 'junk.js'), '');
  fs.writeFileSync(path.join(tmp, '.secret.txt'), '');

  // 1. 空查询：顶层浏览（目录优先 + 名称排序 + 隐藏过滤）——逐层导航保留
  check(
    JSON.stringify(listMentionCandidates(tmp, '')) === JSON.stringify(['src/', 'package.json', 'README.md']),
    `空查询 = 顶层条目（目录优先）: ${JSON.stringify(listMentionCandidates(tmp, ''))}`
  );
  check(
    JSON.stringify(listMentionCandidates(tmp, 'src/')) === JSON.stringify(['src/tui/', 'src/util/', 'src/main.ts']),
    `@src/ 空查询 = src 顶层（目录优先）: ${JSON.stringify(listMentionCandidates(tmp, 'src/'))}`
  );

  // 2. 跨目录检索：非空查询递归整个项目（不再一级一级选）
  check(
    JSON.stringify(listMentionCandidates(tmp, 'render')) === JSON.stringify(['src/tui/render.ts']),
    `跨目录：@render 直接命中 src/tui/render.ts: ${JSON.stringify(listMentionCandidates(tmp, 'render'))}`
  );
  check(
    JSON.stringify(listMentionCandidates(tmp, 'helper')) === JSON.stringify(['src/util/helper.ts']),
    `跨目录：@helper 命中 src/util/helper.ts: ${JSON.stringify(listMentionCandidates(tmp, 'helper'))}`
  );

  // 3. 模糊子序列（fzf 风格）：跳过字符按序命中
  check(
    JSON.stringify(listMentionCandidates(tmp, 'tuirender')) === JSON.stringify(['src/tui/render.ts']),
    `模糊子序列：@tuirender 命中 src/tui/render.ts: ${JSON.stringify(listMentionCandidates(tmp, 'tuirender'))}`
  );
  check(
    JSON.stringify(listMentionCandidates(tmp, 'mt')) === JSON.stringify(['src/main.ts']),
    `模糊子序列：@mt 命中 src/main.ts: ${JSON.stringify(listMentionCandidates(tmp, 'mt'))}`
  );

  // 4. 评分排序：文件名前缀 > 文件名包含 > 路径包含 > 子序列；同级路径浅优先
  //    @ts → main.ts / render.ts / helper.ts 的 basename 都含 'ts'（score 1），按路径浅优先
  const ts = listMentionCandidates(tmp, 'ts');
  check(
    JSON.stringify(ts) === JSON.stringify(['src/main.ts', 'src/tui/render.ts', 'src/util/helper.ts']),
    `文件名包含评分 + 路径浅优先: @ts → ${JSON.stringify(ts)}`
  );
  //    @readme（小写）：README.md basename 前缀（score 0）优先于路径含 'readme' 的其它
  check(
    JSON.stringify(listMentionCandidates(tmp, 'readme')) === JSON.stringify(['README.md']),
    `文件名前缀优先: @readme → ${JSON.stringify(listMentionCandidates(tmp, 'readme'))}`
  );
  //    目录也参与：@src → src/（basename 前缀 score 0）在 src/main.ts 之前
  const src = listMentionCandidates(tmp, 'src');
  check(src[0] === 'src/' && src.includes('src/main.ts'), `目录参与匹配且在前: @src → ${JSON.stringify(src)}`);

  // 5. 跳过噪音目录
  check(listMentionCandidates(tmp, 'junk').length === 0, 'node_modules 被跳过（@junk 无结果）');

  // 6. 隐藏文件规则：默认隐藏；查询以 . 开头才显示
  check(listMentionCandidates(tmp, 'sec').length === 0, '隐藏文件默认不匹配（@sec 无结果）');
  check(
    JSON.stringify(listMentionCandidates(tmp, '.sec')) === JSON.stringify(['.secret.txt']),
    `查询以 . 开头显示隐藏文件: @.sec → ${JSON.stringify(listMentionCandidates(tmp, '.sec'))}`
  );

  // 7. dirPart 限定目录：@src/ma 只在 src/ 下检索
  check(
    JSON.stringify(listMentionCandidates(tmp, 'src/ma')) === JSON.stringify(['src/main.ts']),
    `dirPart 限定目录: @src/ma → ${JSON.stringify(listMentionCandidates(tmp, 'src/ma'))}`
  );
  check(
    JSON.stringify(listMentionCandidates(tmp, 'src/render')) === JSON.stringify(['src/tui/render.ts']),
    `dirPart 限定目录内仍跨子目录递归: @src/render → ${JSON.stringify(listMentionCandidates(tmp, 'src/render'))}`
  );

  // 8. 端到端：repaintTree 驱动 + insertMention 插入完整路径（跨目录直接选中）
  const s = createTuiState();
  s.cwd = tmp;
  const t = await createTestRenderer({ width: 64, height: 20 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  tree.input?.setText('看看 @rend');
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const m = s.mention;
  check(!!m && m.items[0] === 'src/tui/render.ts', `repaintTree 驱动提及候选: ${JSON.stringify(m?.items)}`);
  insertMention(tree.input!, m!, 0);
  check(tree.input?.plainText === '看看 @src/tui/render.ts ', `跨目录直接插入完整路径: ${JSON.stringify(tree.input?.plainText)}`);
  // 目录项插入保留 / 继续浏览
  tree.input?.setText('看看 @src');
  repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const m2 = s.mention;
  check(!!m2 && m2.items[0] === 'src/', `目录项在结果最前: ${JSON.stringify(m2?.items.slice(0, 3))}`);
  insertMention(tree.input!, m2!, 0);
  check(tree.input?.plainText === '看看 @src/', '目录插入保留 / 继续进入下一层浏览');

  fs.rmSync(tmp, { recursive: true, force: true });
  if (!ok) {
    console.log('✗ 存在失败断言');
    process.exit(1);
  }
  console.log('✓ @ 提及模糊匹配 + 跨目录检索探针全部通过');
  process.exit(0);
}
void main();

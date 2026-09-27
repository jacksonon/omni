/**
 * 外部编辑器组稿（codex Ctrl+G 对等：TUI `open_external_editor` 默认绑定）。
 * 行式终端版：当前 `› ` 行内容做种子写入临时 .md → `$VISUAL`/`$EDITOR`
 * 同步接管终端（stdio inherit）→ 保存后读回填进行缓冲（回车才提交）。
 * 非 TTY 下调用方不装快捷键；编辑器缺失/失败返回错误而非静默。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 编辑器命令解析（`$VISUAL` 优先于 `$EDITOR`；含参数形态按空白拆分） */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = (env.VISUAL ?? env.EDITOR ?? '').trim();
  if (!raw) return null;
  return raw.split(/\s+/);
}

export type ComposeResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * 同步组稿：种子写临时文件 → 编辑器接管 → 读回（去尾部空白，回车才提交，
 * 行缓冲里的换行会立即提交，必须剥掉）。调用方负责 TTY/空闲门控与行回填；
 * 临时文件必删（读失败也删）。
 */
export function composeInEditor(
  initial: string,
  command: string[] = resolveEditorCommand() ?? ['vi']
): ComposeResult {
  const [cmd, ...args] = command;
  if (!cmd) return { ok: false, error: '未配置外部编辑器' };
  const dir = mkdtempSync(join(tmpdir(), 'omni-edit-'));
  const file = join(dir, 'prompt.md');
  try {
    writeFileSync(file, initial);
    const r = spawnSync(cmd, [...args, file], { stdio: 'inherit' });
    if (r.error) return { ok: false, error: `启动编辑器失败：${(r.error as Error).message}` };
    if (r.status !== 0) return { ok: false, error: `编辑器异常退出（${r.status ?? '信号'}），组稿已丢弃` };
    return { ok: true, text: readFileSync(file, 'utf8').trimEnd() };
  } catch (err) {
    return { ok: false, error: `组稿失败：${(err as Error)?.message ?? err}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

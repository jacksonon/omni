/** 记忆适用性：只读比较已记录的文件/依赖基线，不执行历史命令，也不把“未变化”当成正确性证明。 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface MemoryDependency {
  manifest: string;
  name: string;
  version: string;
}

export interface MemoryFreshness {
  version: 1;
  workspace: string;
  recordedAt: string;
  source?: string;
  verification?: string;
  files: { path: string; sha256: string }[];
  dependencies: MemoryDependency[];
}

export interface MemoryFreshnessResult {
  status: 'untracked' | 'unchanged' | 'review';
  reasons: string[];
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ASSOCIATIONS = 24;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 只接受工作区内的普通文件；realpath 阻止符号链接跨出边界。 */
async function readWorkspaceFile(workspace: string, relative: string): Promise<Buffer> {
  if (!relative || path.isAbsolute(relative) || !inside(workspace, path.resolve(workspace, relative))) {
    throw new Error('关联路径必须位于当前工作区内');
  }
  const file = await realpath(path.resolve(workspace, relative));
  if (!inside(workspace, file)) throw new Error('关联文件链接指向工作区外');
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('关联文件必须是 1 MiB 以内的普通文件');
  return readFile(file);
}

async function dependencyVersion(workspace: string, manifest: string, name: string): Promise<string> {
  if (!name || name.length > 200) throw new Error('依赖名称无效');
  const data = JSON.parse((await readWorkspaceFile(workspace, manifest)).toString('utf8')) as Record<string, unknown>;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const group = data[section];
    if (group && typeof group === 'object') {
      const version = (group as Record<string, unknown>)[name];
      if (typeof version === 'string') return version;
    }
  }
  throw new Error(`依赖 ${name} 不在 ${manifest} 的依赖声明中`);
}

/** frontmatter 来自磁盘，严格校验后才允许用于路径读取。 */
export function parseMemoryFreshness(raw: string): MemoryFreshness | undefined {
  try {
    const value = JSON.parse(raw) as MemoryFreshness;
    if (value.version !== 1 || typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace) ||
        typeof value.recordedAt !== 'string' || !Array.isArray(value.files) || !Array.isArray(value.dependencies) ||
        value.files.length + value.dependencies.length > MAX_ASSOCIATIONS ||
        (value.source !== undefined && typeof value.source !== 'string') ||
        (value.verification !== undefined && typeof value.verification !== 'string')) return undefined;
    if (!value.files.every((f) => f && typeof f.path === 'string' && typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/.test(f.sha256))) return undefined;
    if (!value.dependencies.every((d) => d && typeof d.manifest === 'string' && typeof d.name === 'string' && typeof d.version === 'string')) return undefined;
    return value;
  } catch { return undefined; }
}

export async function captureMemoryBaseline(
  cwd: string,
  files: string[],
  dependencies: { manifest: string; name: string }[],
  source?: string,
  verification?: string
): Promise<MemoryFreshness> {
  if (files.length + dependencies.length > MAX_ASSOCIATIONS) throw new Error('每个主题最多关联 24 个文件/依赖');
  const workspace = await realpath(cwd);
  const baseline: MemoryFreshness = {
    version: 1, workspace, recordedAt: new Date().toISOString(),
    ...(source ? { source: source.slice(0, 1000) } : {}),
    ...(verification ? { verification: verification.slice(0, 2000) } : {}),
    files: [], dependencies: [],
  };
  // npm/pnpm/yarn/bun 的解析版本可能只变化锁文件；连同清单旁的现存锁文件保守跟踪。
  const associatedFiles = new Set(files);
  for (const dependency of dependencies) {
    for (const lock of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
      const relative = path.join(path.dirname(dependency.manifest), lock);
      if (existsSync(path.resolve(workspace, relative))) associatedFiles.add(relative);
    }
  }
  if (associatedFiles.size + dependencies.length > MAX_ASSOCIATIONS) throw new Error('关联文件与自动关联锁文件合计超过 24 项');
  for (const file of associatedFiles) {
    const bytes = await readWorkspaceFile(workspace, file);
    baseline.files.push({ path: path.normalize(file), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const dependency of dependencies) {
    baseline.dependencies.push({ ...dependency, version: await dependencyVersion(workspace, dependency.manifest, dependency.name) });
  }
  return baseline;
}

export async function checkMemoryFreshness(
  baseline: MemoryFreshness | undefined,
  cwd = process.cwd(),
  invalid = false
): Promise<MemoryFreshnessResult> {
  if (invalid) return { status: 'review', reasons: ['适用性元数据损坏，请重新关联并复核'] };
  if (!baseline) return { status: 'untracked', reasons: [] };
  if (!baseline.files.length && !baseline.dependencies.length) return { status: 'untracked', reasons: [] };
  let workspace: string;
  try { workspace = await realpath(cwd); }
  catch { return { status: 'review', reasons: ['当前工作区不可读'] }; }
  // 全局记忆不能跨工作区借用“已确认”的状态；也不读取另一个项目的文件。
  if (workspace !== baseline.workspace) return { status: 'review', reasons: ['记录来自其他工作区，需在当前项目重新确认适用性'] };
  const reasons: string[] = [];
  for (const file of baseline.files) {
    try {
      const bytes = await readWorkspaceFile(workspace, file.path);
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) reasons.push(`关联文件已变化：${file.path}`);
    } catch { reasons.push(`关联文件不可读、已删除或超出边界：${file.path}`); }
  }
  for (const dependency of baseline.dependencies) {
    try {
      const current = await dependencyVersion(workspace, dependency.manifest, dependency.name);
      if (current !== dependency.version) reasons.push(`依赖声明已变化：${dependency.name} ${dependency.version} → ${current}（${dependency.manifest}）`);
    } catch { reasons.push(`依赖声明不可读或已移除：${dependency.name}（${dependency.manifest}）`); }
  }
  return { status: reasons.length ? 'review' : 'unchanged', reasons };
}

export function memoryFreshnessNotice(result: MemoryFreshnessResult, baseline?: MemoryFreshness): string {
  const status = result.status === 'untracked' ? '[未关联基线；历史记忆，使用前按任务核实]' : result.status === 'review'
    ? `[待复核：${result.reasons.join('；')}。以下仅是历史线索，不可作为当前已验证事实]`
    : '[关联基线未变化；这不代表内容已通过当前任务验证]';
  const details = baseline
    ? `\n来源：${baseline.source || '未注明'}\n来源工作区（有文件/依赖关联时限定适用范围）：${baseline.workspace}\n基线记录时间：${baseline.recordedAt}` +
      `\n关联文件：${baseline.files.map((f) => f.path).join('、') || '无'}` +
      `\n依赖声明：${baseline.dependencies.map((d) => `${d.manifest} / ${d.name} = ${d.version}`).join('、') || '无'}` +
      (baseline.verification ? `\n复核说明：${baseline.verification}` : '')
    : '';
  return status + details;
}

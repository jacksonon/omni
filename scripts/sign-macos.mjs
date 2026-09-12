/**
 * macOS：对 bun compile 产物做 ad-hoc 重新签名。
 *
 * 背景：`bun build --compile` 产出的是 linker-signed（adhoc）Mach-O，但 bun 在
 * 链接后又写入了运行时载荷，导致签名失效（`codesign` 报
 * "invalid signature (code or signature have been modified)"）。
 * 旧版 macOS 运行时容忍该状态，macOS 26+/27 强校验直接 SIGKILL（exit 137），
 * 表现为 `omni` 无任何输出。编译后 `codesign --force --sign -` 即可修复
 * （仍为 adhoc 签名，npm 安装不带 quarantine，运行时校验可过）。
 *
 * 用法：npm run compile 自动调用；非 macOS 平台静默跳过。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bin = path.join(root, 'release', 'omni');
  if (existsSync(bin)) {
    execFileSync('codesign', ['--force', '--sign', '-', bin], { stdio: 'inherit' });
    console.log('✓ macOS 重签名完成（release/omni，adhoc）');
  }
}

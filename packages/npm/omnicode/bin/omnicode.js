#!/usr/bin/env node
// omnicode npm 启动器：定位当前平台的原生二进制并执行（完整 TUI）
// 对标 esbuild 的跨平台分发模式：主包 bin 是 JS，平台二进制在各平台子包里
'use strict';
const { spawnSync } = require('child_process');
const { platform, arch } = process;

const pkgName = `omnicode-${platform}-${arch}`;
const binName = platform === 'win32' ? 'omnicode.exe' : 'omnicode';

let binPath;
try {
  binPath = require.resolve(`${pkgName}/bin/${binName}`);
} catch {
  console.error(
    `omnicode: 当前平台 ${platform}-${arch} 不受支持，或平台包未安装（${pkgName}）。` +
      '支持的平台：darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / win32-x64'
  );
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error(`omnicode: 启动失败（${result.error.message}）`);
  process.exit(1);
}
process.exit(result.status ?? (result.signal ? 1 : 0));

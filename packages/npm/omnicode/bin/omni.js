#!/usr/bin/env node
// @right-ai/omni 启动器：定位当前平台的原生二进制并执行（完整 TUI）
// 对标 esbuild 的跨平台分发模式：主包 bin 是 JS，平台二进制在各平台子包里
// （平台子包名为 omnicode-<平台>-<架构>，属内部实现细节；用户侧只认 omni / @right-ai/omni）
'use strict';
const { spawnSync } = require('child_process');
const { platform, arch } = process;

const pkgName =
  platform === 'win32' ? '@right-ai/win32-x64' : `omnicode-${platform}-${arch}`;
const binName = platform === 'win32' ? 'omnicode.exe' : 'omnicode';
const ourPkg = require('../package.json');
// 与 README/主包 optionalDependencies 保持一致的受支持平台清单
const supported = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];

let binPath;
try {
  binPath = require.resolve(`${pkgName}/bin/${binName}`);
} catch {
  const cur = `${platform}-${arch}`;
  if (!supported.includes(cur)) {
    console.error(`omni: 当前平台 ${cur} 不受支持。`);
    console.error(`  支持的平台：${supported.join(' / ')}`);
  } else {
    // 平台受支持但二进制缺失：平台组件（可选依赖）没装上
    //（常见诱因：安装被中断/换了镜像源后重跑/缓存异常）。
    // 给出可执行的补救命令，而不是只报"不受支持"让用户无从下手。
    // 注意：用户装的是 @right-ai/omni，omnicode-* 只是其内部平台子包名，此处仅作技术细节括号注明。
    console.error(`omni: 平台组件缺失（内部包 ${pkgName}@${ourPkg.version} 未安装）。`);
    console.error(`  你的平台 ${cur} 受支持，重新安装即可修复：`);
    console.error(`    npm install -g ${ourPkg.name}@${ourPkg.version}`);
  }
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error(`omni: 启动失败（${result.error.message}）`);
  process.exit(1);
}
process.exit(result.status ?? (result.signal ? 1 : 0));
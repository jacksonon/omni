#!/usr/bin/env node
/**
 * 生成 Winget 安装清单（Windows 分发，发布工程）。
 * 用法：OMNI_VERSION=0.6.7 node scripts/make-winget-manifests.mjs
 * 输出：packaging/winget/Omni.Omni/<版本>/{installer,loc}.yaml
 * 注意：Winget 安装器需为 MSI/EXE 安装器（GitHub Release 的 omni-win32-x64.exe
 * 是 NSIS 安装器，可直接引用）。发布前把 installerSha256 填为实际 exe 的 SHA256。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const version = process.env.OMNI_VERSION || '0.6.7';
const url = `https://github.com/omni/omni/releases/download/v${version}/omni-win32-x64.exe`;
const outDir = path.join(process.cwd(), 'packaging', 'winget', 'Omni.Omni', version);
mkdirSync(outDir, { recursive: true });

const installer = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.4.0.schema.json
PackageIdentifier: Omni.Omni
PackageVersion: ${version}
InstallerType: exe
InstallerSwitches:
  Silent: /S
  SilentWithProgress: /S
Installers:
  - Architecture: x64
    InstallerUrl: ${url}
    InstallerSha256: REPLACE_WITH_EXE_SHA256
Scope: user
ManifestType: installer
ManifestVersion: 1.4.0
`;

const loc = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.locale.1.4.0.schema.json
PackageIdentifier: Omni.Omni
PackageVersion: ${version}
PackageLocale: zh-CN
Publisher: Omni
PackageName: Omni
ShortDescription: 终端 AI 编程助手（全屏 TUI / headless exec / web 后端）
ManifestType: locale
ManifestVersion: 1.4.0
`;

const def = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.4.0.schema.json
PackageIdentifier: Omni.Omni
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Omni
Author: Omni
PackageName: Omni
PackageUrl: https://github.com/omni/omni
License: MIT
ShortDescription: Omni — a terminal AI coding assistant (full-screen TUI / headless exec / web backend)
Moniker: omni
ManifestType: defaultLocale
ManifestVersion: 1.4.0
`;

const v = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.4.0.schema.json
PackageIdentifier: Omni.Omni
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.4.0
`;

writeFileSync(path.join(outDir, 'installer.yaml'), installer);
writeFileSync(path.join(outDir, 'locale.zh-CN.yaml'), loc);
writeFileSync(path.join(outDir, 'defaultLocale.yaml'), def);
writeFileSync(path.join(outDir, 'version.yaml'), v);
console.log(`✓ 已生成 Winget 清单 → ${outDir}（发布前把 installerSha256 填为 exe 实际 SHA256）`);

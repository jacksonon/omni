# 构建与发布完整指南

> 2026-08-26 从 `AGENTS.md` 迁移。三种产物 + GitHub Actions 自动发布 + npm 发布 + 关键坑。

## 构建与发布（三种产物）

| 产物 | 命令 | 说明 |
|---|---|---|
| `dist/omni.cjs`（~730K） | `npm run bundle` | **单文件 JS 包**（内联 openai SDK），需 Node ≥18；npm 安装即用此文件 |
| `release/omni`（~57M） | `npm run compile` | **原生二进制**（bun compile，含运行时，零依赖、无需 Node），平台相关（arm64/x64），适合直接分发 |
| `omni-<版本>.tgz` | `npm pack` | **npm 安装包**（自动 prepack 构建），`npm install -g omni-0.1.0.tgz` 全局安装后可直接用 `omni` 命令 |

打包注意：
- 原生二进制输出到 `release/`（已 gitignore），**不进 npm 包**（平台相关）；
- npm 包只发布 `dist/`（`files` 字段），体积约 150K；
- 全局安装测试：`npm install -g ./omni-0.1.0.tgz --prefix <前缀>`。

**GitHub Actions 自动发布**（`.github/workflows/release.yml`）：推送任意 `v*` tag → **三平台矩阵构建**（ubuntu-latest linux-x64 / ubuntu-24.04-arm linux-arm64 / macos-15 darwin-arm64 / macos-15-intel darwin-x64 / windows-latest win32-x64）→ 每平台 `npm run compile` 出原生二进制 → linux-x64 顺带 `npm run build` + `npm pack`（tgz）→ upload-artifact 汇总 → **Electron 桌面应用 job 并行打包（linux-x64 AppImage / darwin-arm64 zip / darwin-x64 zip / win32-x64 exe；走 ELECTRON_MIRROR 镜像防下载超时）** → release job 创建 GitHub Release 附上 **10 个产物**：`omni-<版本>.tgz` + `omni-linux-x64` + `omni-linux-arm64` + `omni-darwin-arm64` + `omni-darwin-x64` + `omni-win32-x64.exe` + 4 个 Electron 应用（omni-electron-*）。**npm 自动发布**（需仓库 Secrets 配置 `NPM_TOKEN`，npmjs.com 生成 Automation 类型 token）：build job 编译后把二进制装入 `packages/npm/omnicode-<platform>-<arch>/bin/`（版本与根 package.json 同步）→ `npm publish` 各平台子包（linux/darwin 子包名 `omnicode-<platform>-<arch>`，win32 因 npm 反垃圾检测误判改 **scoped `@right-ai/win32-x64`**）；release job 最后同步 `packages/npm/omnicode` 主包（**scoped `@right-ai/omni`**）版本 + optionalDependencies 并发布——主包 bin 是 JS 启动器（`require.resolve('omnicode-<platform>-<arch>/bin/omnicode'` / win32 `'@right-ai/win32-x64/bin/omnicode.exe'`) + spawnSync 透传 stdio/退出码，对标 esbuild 分发模式），npm 自动按 os/cpu 选平台子包。手动发布备用：`scripts/publish-npm.sh [tag]`（本机编译当前平台 + gh release download 其余平台 → npm pack 验证 → 依序 publish 5 子包 + 主包；发布必须 `--registry=https://registry.npmjs.org`，本机 registry 是腾讯镜像）。**关键坑**：bun 静态解析 `@opentui/core` 的 chunk-bun 按 libc 分支的 import，linux 下需同时提供 gnu+musl 原生包，否则 `npm run compile` 报 `Could not resolve @opentui/core-linux-x64-musl`——workflow 在 compile 前用 `npm i --force --no-save @opentui/core-linux-x64-musl@<版本>`（x64）/`@opentui/core-linux-arm64-musl@<版本>`（arm64）补装（npm 默认拒绝跨 libc 安装，需 `--force` 绕过；`--no-save` 不污染 package.json/lock）。**注意**：Windows 上 bun compile 产物自动带 `.exe` 后缀（`release/omni.exe`）；macOS arm64 runner 用显式 `macos-15`（`macos-latest` 2026-06 起已切 macOS 26 新镜像，bun 1.3.5 兼容性风险大）；x64 macOS 用 `macos-15-intel`（2027-08 前可用）。**npm 发布幂等**（v0.7.3 修复）：build job 的子包发布与 release job 的主包发布都先 `npm view <name>@<ver> version` 探测——版本已存在（重复发布/重跑/先手动发过）直接跳过不失败，否则 npm 403 硬失败会阻断后续「Create GitHub Release」步骤，导致 Release 停在 Draft 态（v0.7.3 曾因此卡住，需手动 `gh release edit v0.7.3 --draft=false` 补发）。**烟测与 registry 同步竞态**（v0.7.13 修复）：平台包 publish 后的「Smoke test」步骤若立即安装，registry CDN 未同步会 404 → 秒败并阻断 npm pack / release job（平台包其实已发布成功）；烟测安装失败时按同步延迟轮询重试（15s × 16 ≈ 4 分钟），安装成功但 bin 缺失/不可执行则判定真打包缺陷立即失败并打印包目录。重跑注意：`gh run rerun --failed` 按**原 commit 的 workflow 文件**执行——workflow 修复需先合入 main，对旧 run 重跑只适用于「registry 已同步、逻辑无需改」的场景。


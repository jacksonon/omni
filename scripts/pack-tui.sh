#!/usr/bin/env bash
# ============================================================
# pack-tui.sh — 一键打包 TUI 版（omni-tui npm 包 + 可选原生二进制）
#
# 用法：
#   ./scripts/pack-tui.sh              # 只打 omni-tui-<版本>.tgz（npm 包）
#   ./scripts/pack-tui.sh --compile    # 额外产出原生二进制 release/omni
#
# 流程：版本同步（packages/omni-tui 跟随根 package.json）→ 清理旧产物
#   → bun build（--external @opentui/core-* 平台原生库外置）
#   → npm pack（按 optionalDependencies 声明原生库，安装时自动按平台装）
#   →（可选）bun compile 原生二进制
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ 未找到 bun（TUI 打包依赖 bun，安装：curl -fsSL https://bun.sh/install | bash）" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
PKG_DIR="packages/omni-tui"
PKG_JSON="$PKG_DIR/package.json"
TGZ="$PKG_DIR/omni-tui-$VERSION.tgz"

# 1) 版本同步：packages/omni-tui/package.json 与根版本必须一致（防漂移）
CUR="$(node -p "require('./$PKG_JSON').version")"
if [ "$CUR" != "$VERSION" ]; then
  echo "↻ 版本同步 ${PKG_JSON}：${CUR} → ${VERSION}"
  node -e "
    const fs = require('fs');
    const p = '$PKG_JSON';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = '$VERSION';
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  "
fi

# 2) 清理旧产物：dist 里旧版本 @opentui 的 wasm/scm 哈希文件会残留，先清干净
rm -rf "$PKG_DIR/dist" "$TGZ"

# 3) bun bundle：TUI 入口（bun target），@opentui/core-* 原生库外置为动态 import
echo "▸ bun build → ${PKG_DIR}/dist/"
npm run bundle:tui

# 4) npm pack：产出 omni-tui-<版本>.tgz
echo "▸ npm pack → ${TGZ}"
(cd "$PKG_DIR" && npm pack --silent)

# 5)（可选）原生二进制（零依赖，需 bun compile 支持当前平台）
if [ "${1:-}" = "--compile" ]; then
  echo "▸ bun compile → release/omni"
  npm run compile
fi

echo
echo "✅ TUI 打包完成"
echo "   npm 包：${TGZ}（$(du -h "$TGZ" | cut -f1)）"
echo "   安装：npm install -g ./${TGZ}（需 bun ≥ 1.3；与 npm 版 omni bin 同名，先 npm uninstall -g omni）"
if [ "${1:-}" = "--compile" ]; then
  echo "   原生二进制：release/omni（$(du -h release/omni | cut -f1)，零依赖直接运行）"
fi

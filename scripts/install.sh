#!/usr/bin/env sh
# Omni 一键安装：从 GitHub Release 下载原生二进制（零依赖，含全屏 TUI）。
#   curl -fsSL https://raw.githubusercontent.com/<owner>/omni/main/scripts/install.sh | sh
# 安装到 $HOME/.local/bin（可被 OMNI_INSTALL_DIR 覆盖）；Homebrew: brew install omni
set -e

INSTALL_DIR="${OMNI_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${OMNI_VERSION:-latest}"
OWNER="${OMNI_OWNER:-$(git config user.name 2>/dev/null || echo omni)}"
REPO="${OMNI_REPO:-omni}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  ASSET="omni-darwin-arm64" ;;
  Darwin-x86_64) ASSET="omni-darwin-x64" ;;
  Linux-x86_64)  ASSET="omni-linux-x64" ;;
  Linux-aarch64) ASSET="omni-linux-arm64" ;;
  *) echo "✗ 不支持的平台: $(uname -s)-$(uname -m)（请用 npm/Homebrew 安装，或从 Release 手动下载）"; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp)"
echo "↓ 下载 $URL"
if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$TMP" "$URL"
elif command -v wget >/dev/null 2>&1; then wget -q -O "$TMP" "$URL"
else echo "✗ 需要 curl 或 wget"; exit 1; fi
chmod +x "$TMP"
mv "$TMP" "$INSTALL_DIR/omni"
echo "✓ 已安装 omni → $INSTALL_DIR/omni"
echo "  把 $INSTALL_DIR 加入 PATH：export PATH=\"$INSTALL_DIR:\$PATH\""
echo "  运行 omni 进入全屏 TUI；omni \"任务\" 单次执行；omni web 网页界面"
"$INSTALL_DIR/omni" --version

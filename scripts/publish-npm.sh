#!/bin/bash
# 一键发布 omnicode 到公共 npm 源（omnicode 主包 + 5 平台子包）
# 前置：已 `npm login`（npmjs.org）；本机有 bun（编译本机平台二进制）
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="${1:-v${VERSION}}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PKG_ROOT="packages/npm"
echo "==> 版本 ${VERSION}，Release tag ${TAG}，registry ${NPM_REGISTRY}"

# 1. 各平台二进制 → 对应子包 bin/
# 本机平台用 bun 现编（保证与源码一致），其余平台从 GitHub Release 下载
LOCAL_BIN="release/omni"
HOST_PLATFORM=$(node -p "'\${process.platform}-\${process.arch}'")
case "${HOST_PLATFORM}" in
  darwin-arm64) LOCAL_PKG="omnicode-darwin-arm64"; LOCAL_NAME="omnicode" ;;
  darwin-x64)   LOCAL_PKG="omnicode-darwin-x64";   LOCAL_NAME="omnicode" ;;
  linux-x64)    LOCAL_PKG="omnicode-linux-x64";    LOCAL_NAME="omnicode" ;;
  linux-arm64)  LOCAL_PKG="omnicode-linux-arm64";  LOCAL_NAME="omnicode" ;;
  win32-x64)    LOCAL_PKG="omnicode-win32-x64";    LOCAL_NAME="omnicode.exe" ;;
  *) echo "!! 本机平台 ${HOST_PLATFORM} 无子包，全部走 GitHub Release 下载"; LOCAL_PKG="" ;;
esac

declare -A BIN_MAP=(
  [omnicode-darwin-arm64]="omni-darwin-arm64:omnicode"
  [omnicode-darwin-x64]="omni-darwin-x64:omnicode"
  [omnicode-linux-x64]="omni-linux-x64:omnicode"
  [omnicode-linux-arm64]="omni-linux-arm64:omnicode"
  [omnicode-win32-x64]="omni-win32-x64.exe:omnicode.exe"
)

TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

for PKG in "${!BIN_MAP[@]}"; do
  REMOTE_NAME="${BIN_MAP[$PKG]%%:*}"; BIN_NAME="${BIN_MAP[$PKG]##*:}"
  DEST="${PKG_ROOT}/${PKG}/bin/${BIN_NAME}"
  if [[ "${PKG}" == "${LOCAL_PKG}" ]]; then
    echo "==> [本机] bun compile ${HOST_PLATFORM}"
    npm run compile
    cp "${LOCAL_BIN}" "${DEST}"
  else
    if [[ ! -s "${DEST}" ]]; then
      echo "==> [下载] GitHub Release ${TAG} 的 ${REMOTE_NAME}"
      gh release download "${TAG}" -p "${REMOTE_NAME}" -D "${TMP}" --clobber
      cp "${TMP}/${REMOTE_NAME}" "${DEST}"
    else
      echo "==> [复用] ${DEST} 已存在"
    fi
  fi
  chmod +x "${DEST}" 2>/dev/null || true
  test -s "${DEST}" && echo "     OK ($(wc -c < "${DEST}") bytes)"
done

# 2. 打包验证（先 npm pack 确认结构）
echo "==> npm pack 验证"
mkdir -p "${TMP}/packs"
for PKG in omnicode omnicode-darwin-arm64 omnicode-darwin-x64 omnicode-linux-x64 omnicode-linux-arm64 omnicode-win32-x64; do
  (cd "${PKG_ROOT}/${PKG}" && npm pack --pack-destination "${TMP}/packs" --silent)
done
ls -lh "${TMP}/packs"

# 3. 发布（子包先发，主包最后）
echo "==> npm publish → ${NPM_REGISTRY}"
for PKG in omnicode-darwin-arm64 omnicode-darwin-x64 omnicode-linux-x64 omnicode-linux-arm64 omnicode-win32-x64 omnicode; do
  echo "    publishing ${PKG}@${VERSION} ..."
  (cd "${PKG_ROOT}/${PKG}" && npm publish --registry "${NPM_REGISTRY}" --access public)
done

echo "==> 全部发布完成：npm install -g omnicode"

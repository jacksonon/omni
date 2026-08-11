#!/bin/bash
# 稀疏克隆 opencode 的 TUI 源码（只取需要的目录）
cd /tmp || exit 1
rm -rf opencode-src
git clone --depth 1 --filter=blob:none --sparse https://github.com/sst/opencode opencode-src 2>&1 | tail -2
cd opencode-src || exit 1
git sparse-checkout set packages/opencode/src 2>&1 | tail -1
echo '=== 找 TUI 相关目录 ==='
find packages/opencode/src -type d -name '*tui*' -o -type d -name '*ui*' 2>/dev/null | head -10
echo '=== 找滚动相关组件 ==='
grep -rln 'onWheel\|scrollTop\|scrollToBottom\|useScrollable' packages/opencode/src --include='*.tsx' --include='*.ts' 2>/dev/null | head -15

#!/bin/bash
cd /Users/os/Downloads/questions/talk-20260810/omni/node_modules/@opentui/core || exit 1
echo '=== ctrl+u 绑定 ==='
grep -o '"ctrl+u"[^,]*' chunk-bun-*.js | head -5
echo '=== 各类清行/删除绑定名 ==='
grep -o 'delete-to-start\|delete-to-end\|kill-line\|clear-line\|delete-line\|delete-char' chunk-bun-*.js | sort | uniq -c | sort -rn | head -10
echo '=== textarea 默认 bindings 片段 ==='
grep -n 'delete-to-start' chunk-bun-*.js | head -3

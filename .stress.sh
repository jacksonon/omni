#!/bin/bash
# TUI 闪退压力复现：6 轮交互，每轮流式期间快速连按滚动键
# （按键 paint 与节流 paint 并发，模拟真实用户操作，不污染输入框）
cd /Users/os/Downloads/questions/talk-20260810/omni || exit 1
pkill -f mock-server.mjs 2>/dev/null
pkill -f tui-entry.ts 2>/dev/null
sleep 0.5

rm -f ~/.config/omni/tui-crash.log
MOCK_MARKDOWN=1 MOCK_LONGLINE=1 MOCK_REASONING=long nohup node scripts/mock-server.mjs > /tmp/mock-omni.log 2>&1 &
MOCK=$!
sleep 1

rm -f /tmp/tui-stress.log
{
  sleep 6
  for i in 1 2 3 4 5 6 7 8; do
    printf "测试问题%d\n" "$i"
    sleep 0.5
    # 流式期间：滚动键连按（并发重绘）+ 前 5 轮模拟打字（污染输入但不影响 /exit）
    if [ "$i" -le 5 ]; then
      printf 'abcdefghijklmnopqrstuvwxyz1234567890'
    fi
    printf '\x1b[5~\x1b[6~\x1b[5~\x1b[6~\x1b[5~\x1b[6~'
    sleep 1
    printf '\x1b[1;5A\x1b[1;5B\x1b[1;5H\x1b[1;5F'
    sleep 1
    printf '\x1b[5~\x1b[5~\x1b[6~'
    sleep 2.5
  done
  printf '/exit\n'
  sleep 3
} | OMNI_API_KEY=mock OMNI_BASE_URL=http://127.0.0.1:8787/v1 script -q /tmp/tui-stress.log bun run ./src/tui-entry.ts > /dev/null 2>&1
echo "EXIT=$?"

echo '=== 崩溃日志（~/.config/omni/tui-crash.log）==='
if [ -f ~/.config/omni/tui-crash.log ]; then
  cat ~/.config/omni/tui-crash.log
else
  echo '(无崩溃日志——未崩溃)'
fi

kill $MOCK 2>/dev/null
pkill -f mock-server.mjs 2>/dev/null
pkill -f tui-entry.ts 2>/dev/null
echo CLEANED

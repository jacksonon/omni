#!/usr/bin/env python3
"""真实 pty 验证 ask_user：MOCK_ASK=1 交互 TUI——等 ask 面板出现 → 发送 'a' 选择 →
检查面板关闭与最终回答（mock 固定回答含工具结果回传后的轮次标记）。"""
import os, pty, select, subprocess, sys, time, signal

ENV = dict(os.environ)
ENV.update({
    'MOCK_ASK': '1',
    'OMNI_BASE_URL': 'http://127.0.0.1:8787/v1',
    'OMNI_API_KEY': 'sk-mock',
    'OMNI_MODEL': 'mock-model',
    'NO_COLOR': '1',
})

def read_all(fd, timeout=0.5):
    out = b''
    while True:
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        timeout = 0.3
    return out

def send(fd, data):
    os.write(fd, data)

def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe('bun', ['bun', 'run', './src/tui-entry.ts'], ENV)
    buf = b''
    start = time.time()
    asked = False
    try:
        while time.time() - start < 60:
            buf += read_all(fd)
            text = buf.decode('utf-8', 'replace')
            if not asked and time.time() - start > 3 and '接下来怎么做' not in text:
                # TUI 就绪后发送第一条用户消息（ask 在第一轮工具调用触发）
                send(fd, '你好\r'.encode())
                print('[pty] 已发送用户消息', flush=True)
                time.sleep(0.5)
                continue
            if not asked and '接下来怎么做' in text:
                asked = True
                print('[pty] ask 面板出现 ✓', flush=True)
                time.sleep(0.5)
                send(fd, b'\x1b[B')  # ↓ 移到选项二
                time.sleep(0.2)
                send(fd, b' ')      # 空格勾选
                time.sleep(0.2)
                send(fd, b'\r')     # Enter 提交
                print('[pty] 已发送 ↓+空格+Enter（勾选选项二）', flush=True)
            if asked and '任务完成' in text:
                print('[pty] 任务完成（ask 链路跑通）✓', flush=True)
                send(fd, b'/exit\r')
                time.sleep(0.5)
                buf += read_all(fd)
                os.kill(pid, signal.SIGTERM)
                return 0
            time.sleep(0.2)
        print('[pty] 超时——ask 面板或完成未出现', flush=True)
        os.kill(pid, signal.SIGTERM)
        return 1
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

if __name__ == '__main__':
    sys.exit(main())

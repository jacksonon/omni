#!/usr/bin/env python3
"""真实 pty 验证：/exit 或 Ctrl+C 退出 TUI 后是否恢复终端（?1049l）并打印会话恢复提示。
用法：pty-exit-hint.py <exit-key>（exit-key: exit | ctrlc）"""
import os, pty, select, sys, time, shutil

EXIT_KEY = {'exit': '/exit\r', 'ctrlc': '\x03'}[sys.argv[1] if len(sys.argv) > 1 else 'exit']

ENV = dict(os.environ)
ENV.update({
    'OMNI_BASE_URL': 'http://127.0.0.1:8799/v1',
    'OMNI_API_KEY': 'sk-mock',
    'OMNI_MODEL': 'mock-model',
    'XDG_CONFIG_HOME': f'/tmp/omni-exit-hint-xdg-{sys.argv[1] if len(sys.argv) > 1 else "exit"}',
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

def main():
    shutil.rmtree(ENV['XDG_CONFIG_HOME'], ignore_errors=True)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe('bun', ['bun', 'run', './src/tui-entry.ts'], ENV)
    buf = b''
    start = time.time()
    sent = False
    exited = False
    exit_sent = 0
    while time.time() - start < 45:
        buf += read_all(fd)
        text = buf.decode('utf-8', 'replace')
        if not sent and time.time() - start > 4:
            try:
                os.write(fd, '你好\r'.encode())
                print('[pty] 已发送用户消息', flush=True)
                sent = True
                time.sleep(1)
            except OSError as e:
                print(f'[pty] 发送用户消息失败: {e}', flush=True)
                print('[pty] 启动输出:', repr(text[:300]), flush=True)
                break
            continue
        if sent and time.time() - start > 10:
            try:
                os.write(fd, EXIT_KEY.encode())
                print(f'[pty] 已发送退出按键 {EXIT_KEY!r}', flush=True)
                exit_sent = time.time()
            except OSError as e:
                print(f'[pty] 发送退出按键失败: {e}', flush=True)
                break
        if exit_sent and time.time() - exit_sent > 2:
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    print(f'[pty] 进程退出 status={status}', flush=True)
                    exited = True
                    break
            except ChildProcessError:
                exited = True
                break
        time.sleep(0.2)
    time.sleep(1)
    buf += read_all(fd, 1.0)
    if not exited:
        try:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
        except Exception:
            pass
    text = buf.decode('utf-8', 'replace')
    restored = b'\x1b[?1049l' in buf
    hint = 'omni -s ' in text
    print(f'=== {EXIT_KEY!r} === 终端恢复(?1049l): {restored} · 恢复提示: {hint}')
    idx = text.find('omni -s')
    if idx >= 0:
        print('  提示上下文:', repr(text[max(0, idx - 30): idx + 70]))
    print('  启动输出:', repr(buf[:150]))
    print('  尾部输出:', repr(buf[-150:]))
    if not (restored and hint):
        print(f'  ✗ 退出：恢复={restored} 提示={hint}')
        sys.exit(1)
    print('  ✓ 退出：终端恢复 + 显示恢复提示')

if __name__ == '__main__':
    main()

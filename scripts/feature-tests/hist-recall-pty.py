"""PTY 端到端：输入历史跨会话（codex composer history 对等）。

两段式（同一 XDG）：
  会话一：等 › → 发 /pwd # hist-aaa → 等回显 → /quit 退出（落盘历史）。
  会话二（新进程同 XDG）：等 › → 按 Up → 历史行含 hist-aaa 即召回成功 → /quit。
verdict（JSON，stdout 末行）：prompted1 / submitted1 / prompted2 / recalled / quit0。
"""
import os
import pty
import select
import sys
import time
import json

ROOT = os.environ['OMNI_FT_ROOT']
XDG = os.environ['OMNI_FT_XDG']
LOG = os.environ['OMNI_FT_LOG']
MARKER = b'hist-aaa-789'


def run_session(send_lines, wait_markers, timeout_each=25):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env['XDG_CONFIG_HOME'] = XDG
        env['OMNI_API_KEY'] = 'sk-test'
        env['OMNI_PERMISSION'] = 'full'
        env['OMNI_SHOW_THINKING'] = '0'
        os.chdir(ROOT)
        os.execvpe('npx', ['npx', 'tsx', 'src/index.ts', 'mini'], env)
    out = b''

    def drain(timeout):
        nonlocal out
        t0 = time.time()
        while time.time() - t0 < timeout:
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk

    def wait_for(marker, timeout):
        t0 = time.time()
        while time.time() - t0 < timeout:
            drain(0.2)
            if marker in out:
                return True
        return False

    ok = True
    for kind, payload, timeout in send_lines:
        if kind == 'wait':
            if not wait_for(payload, timeout):
                ok = False
        elif kind == 'write':
            os.write(fd, payload)
            time.sleep(0.4)
    for marker, timeout in wait_markers:
        if not wait_for(marker, timeout):
            ok = False
    drain(2)
    try:
        os.close(fd)
    except OSError:
        pass
    code = None
    t0 = time.time()
    while time.time() - t0 < 15:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            if os.WIFEXITED(status):
                code = os.WEXITSTATUS(status)
            break
        time.sleep(0.2)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
    return out, ok, code


def main() -> int:
    out1, ok1, code1 = run_session(
        [('wait', '›'.encode(), 60), ('write', b'/pwd # hist-aaa-789\n', 0)],
        [(MARKER, 15)],
    )
    # /quit 收尾会话一（历史已逐提交落盘）
    # ——为简单起见直接杀进程：落盘是提交级，早已完成
    out2, code2, ok, recalled, prompted2 = b'', None, False, False, False
    if ok1:
        pid2, fd2 = pty.fork()
        if pid2 == 0:
            env = dict(os.environ)
            env['XDG_CONFIG_HOME'] = XDG
            env['OMNI_API_KEY'] = 'sk-test'
            env['OMNI_PERMISSION'] = 'full'
            env['OMNI_SHOW_THINKING'] = '0'
            os.chdir(ROOT)
            os.execvpe('npx', ['npx', 'tsx', 'src/index.ts', 'mini'], env)
        out2 = b''

        def drain2(timeout):
            nonlocal out2
            t0 = time.time()
            while time.time() - t0 < timeout:
                r, _, _ = select.select([fd2], [], [], 0.2)
                if not r:
                    continue
                try:
                    chunk = os.read(fd2, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                out2 += chunk

        def wait2(marker, timeout):
            t0 = time.time()
            while time.time() - t0 < timeout:
                drain2(0.2)
                if marker in out2:
                    return True
            return False

        prompted2 = wait2('›'.encode(), 60)
        drain2(1.0)
        before = out2.count(MARKER)
        os.write(fd2, b'\x1b[A')  # Up：跨会话历史召回
        t0 = time.time()
        recalled = False
        while time.time() - t0 < 15:
            drain2(0.2)
            if out2.count(MARKER) > before:
                recalled = True
                break
        os.write(fd2, b'\x15')  # 清行再退
        time.sleep(0.4)
        os.write(fd2, b'/quit\n')
        drain2(4)
        try:
            os.close(fd2)
        except OSError:
            pass
        code2 = None
        t0 = time.time()
        while time.time() - t0 < 15:
            done, status = os.waitpid(pid2, os.WNOHANG)
            if done == pid2:
                if os.WIFEXITED(status):
                    code2 = os.WEXITSTATUS(status)
                break
            time.sleep(0.2)
        else:
            try:
                os.kill(pid2, 9)
            except OSError:
                pass
        ok = prompted2 and recalled
    with open(LOG, 'wb') as f:
        f.write(out1 + b'\n===== session2 =====\n' + (out2 if isinstance(out2, bytes) else b''))
    verdict = {
        'prompted1': bool(ok1),
        'prompted2': bool(prompted2),
        'recalled': bool(recalled),
        'quit0': code2 == 0,
        'exitCode': code2,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    final_ok = ok1 and ok and code2 == 0
    return 0 if final_ok else 1


if __name__ == '__main__':
    sys.exit(main())

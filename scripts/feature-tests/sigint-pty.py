"""PTY 端到端：审批提示处 Ctrl+C = 拒绝并继续（fail-safe deny）。

mock MOCK_DANGEROUS=1；safe 档位。审批提示出现后发 Ctrl+C(0x03)：
问题 readline 取消 → deny → 工具被拦截 → 模型收尾 → 会话存活可继续。
verdict：prompted / asked / deniedDone（拦截行+回答）/ alive（/pwd）/ quit0。
"""
import os
import pty
import select
import sys
import time
import json

ROOT = os.environ['OMNI_FT_ROOT']
XDG = os.environ['OMNI_FT_XDG']
PORT = os.environ['OMNI_FT_PORT']
LOG = os.environ['OMNI_FT_LOG']
CWD = os.environ.get('OMNI_FT_CWD', ROOT)


def main() -> int:
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env['XDG_CONFIG_HOME'] = XDG
        env['OMNI_BASE_URL'] = f'http://127.0.0.1:{PORT}/v1'
        env['OMNI_API_KEY'] = 'sk-mock'
        env['OMNI_MODEL'] = 'mock-model'
        env['OMNI_PERMISSION'] = 'safe'
        env['OMNI_SHOW_THINKING'] = '0'
        os.chdir(CWD)
        os.execvpe('npx', ['npx', 'tsx', os.path.join(ROOT, 'src/index.ts'), 'mini'], env)

    out = b''

    def drain(timeout: float) -> None:
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

    def wait_for(marker: bytes, timeout: float) -> bool:
        t0 = time.time()
        while time.time() - t0 < timeout:
            drain(0.2)
            if marker in out:
                return True
        return False

    def send(b: bytes) -> None:
        try:
            os.write(fd, b)
        except OSError:
            pass
        time.sleep(0.4)

    code = None
    asked = False
    done = False
    alive = False
    try:
        prompted = wait_for('›'.encode(), 60)
        send(b'do the dangerous task\n')
        asked = wait_for('批准执行'.encode(), 40)
        if asked:
            drain(1.0)
            send(b'\x03')  # Ctrl+C：取消问题 → deny
        done = wait_for('mock 端到端验证通过'.encode(), 60) if asked else False
        if done:
            drain(2.0)
            n0 = out.count(b'/pwd')
            send(b'/pwd\n')
            time.sleep(2.0)
            drain(2.0)
            alive = out.count(b'/pwd') > n0
        send(b'/quit\n')
        drain(4)
    finally:
        with open(LOG, 'wb') as f:
            f.write(out)
    try:
        os.close(fd)
    except OSError:
        pass
    t0 = time.time()
    while time.time() - t0 < 15:
        done_pid, status = os.waitpid(pid, os.WNOHANG)
        if done_pid == pid:
            if os.WIFEXITED(status):
                code = os.WEXITSTATUS(status)
            break
        time.sleep(0.2)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
    denied = '已拦截：用户拒绝了该操作'.encode() in out
    verdict = {
        'prompted': bool(prompted),
        'asked': bool(asked),
        'deniedDone': bool(done) and denied,
        'alive': bool(alive),
        'quit0': code == 0,
        'exitCode': code,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and asked and done and denied and alive and code == 0
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

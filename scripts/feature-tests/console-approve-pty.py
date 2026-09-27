"""PTY 端到端：console 模式审批往返（与 mini 同双 readline 修复覆盖）。

console 交互 = 无子命令 + TTY + 非 bun（npx tsx 即此路径），提示符 `omni> `，
审批文案 `[y/N]`（无本会话记住）。流程：等提示符 → 发任务 → 审批 → y →
回合完成 → 8s 幽灵静置 → /pwd 存活 → /quit。
verdict：prompted / asked / done / noGhost / alive / quit0。
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
        os.execvpe('npx', ['npx', 'tsx', os.path.join(ROOT, 'src/index.ts')], env)

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
    noGhost = False
    alive = False
    try:
        prompted = wait_for(b'omni> ', 60)
        send(b'do the dangerous task\n')
        asked = wait_for('批准执行'.encode(), 40)
        if asked:
            send(b'y\n')
        done = wait_for('mock 端到端验证通过'.encode(), 60) if asked else False
        if done:
            drain(8.0)
            noGhost = out.count('mock 端到端验证通过'.encode()) == 1
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
    verdict = {
        'prompted': bool(prompted),
        'asked': bool(asked),
        'done': bool(done),
        'noGhost': bool(noGhost),
        'alive': bool(alive),
        'quit0': code == 0,
        'exitCode': code,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and asked and done and noGhost and alive and code == 0
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

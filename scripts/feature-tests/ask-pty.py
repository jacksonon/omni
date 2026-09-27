"""PTY 端到端：ask_user 提问往返（codex ask 对等）。

mock MOCK_ASK=1 首轮发 ask_user（问题 + 3 选项）；safe 档位 ask 工具直通。
时序：等 › → 发任务 → 等提问 → 回序号 1 → 等 mock 最终回答 →
8s 静置（答案 '1' 若漏进主循环会再开一轮）→ /pwd 存活检查 → /quit。
verdict：prompted / asked / answered / noGhost / pwdAlive / quit0。
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

    def send(b: bytes) -> bool:
        try:
            os.write(fd, b)
            time.sleep(0.4)
            return True
        except OSError:
            return False

    code = None
    asked = False
    done = False
    noGhost = False
    pwdAlive = False
    try:
        prompted = wait_for('›'.encode(), 60)
        send('need your advice\n'.encode())
        asked = wait_for('接下来怎么做'.encode(), 40)
        if asked:
            send(b'1\n')
        done = wait_for('mock 端到端验证通过'.encode(), 60) if asked else False
        if done:
            drain(8.0)  # 幽灵锁定：答案 '1' 若漏进主循环，8s 内必再弹提问
            # 提问行计数口径：问题文本每轮出现 3 次（工具卡/提问/结果），输入行只出现 1 次
            noGhost = (
                out.count('mock 端到端验证通过'.encode()) == 1
                and out.count('回车确认；空输入取消'.encode()) == 1
            )
            n_before = out.count(b'/pwd')
            send(b'/pwd\n')
            time.sleep(2.0)
            drain(2.0)
            pwdAlive = out.count(b'/pwd') > n_before
        try:
            send(b'/quit\n')
        except OSError:
            pass
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
        'answeredDone': bool(done),
        'noGhost': bool(noGhost),
        'pwdAlive': bool(pwdAlive),
        'quit0': code == 0,
        'exitCode': code,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and asked and done and noGhost and pwdAlive and code == 0
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

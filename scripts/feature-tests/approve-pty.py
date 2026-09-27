"""PTY 端到端：危险命令审批往返（codex approval 对等）。

mock MOCK_DANGEROUS=1 首轮发 `git push origin main`（safe 档位触发审批）；
空目录 cwd 下执行必 fast-fail，无副作用。
时序：等 › → 发任务 → 等审批提示 → 回 y → 等 mock 最终回答 → /quit。
verdict：prompted / approvalAsked / approvedDone / quit0。
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

    code = None
    asked = False
    done = False
    remembered = False
    ghost = -1
    try:
        prompted = wait_for('›'.encode(), 60)
        os.write(fd, 'do the dangerous task\n'.encode())
        time.sleep(0.3)
        asked = wait_for('批准执行'.encode(), 40)
        answered = False
        if asked:
            try:
                os.write(fd, b'a\n')  # 本会话记住（第二轮同命令应免询问）
                answered = True
            except OSError:
                pass
        done = wait_for('mock 端到端验证通过'.encode(), 60) if answered else False
        # 第二轮同任务：记住后不再弹审批（批准执行出现次数保持 1）
        def trace(msg):
            with open(os.environ.get('OMNI_FT_TRACE', '/tmp/ap-trace.log'), 'a') as tf:
                tf.write('%s done=%s outlen=%d\n' % (msg, done, len(out)))
        trace('T2-ENTER')
        if done:
            drain(2.0)
            prompts_before = out.count('批准执行'.encode())
            trace('T2-PREWRITE prompts=%d' % prompts_before)
            try:
                n = os.write(fd, 'do the dangerous task\n'.encode())
            except OSError as e:
                n = 'EIO:%s' % e
            trace('T2-WROTE %r' % (n,))
            t1 = time.time()
            while time.time() - t1 < 60:
                drain(0.2)
                if out.count('mock 端到端验证通过'.encode()) >= 2:
                    break
            trace('T2-AFTER ans=%d prompts=%d' % (
                out.count('mock 端到端验证通过'.encode()),
                out.count('批准执行'.encode())))
            remembered = (
                out.count('mock 端到端验证通过'.encode()) >= 2
                and out.count('批准执行'.encode()) == prompts_before
            )
            # 幽灵消息锁定：答案 'y' 若漏进主循环会再开一轮（8s 内必现第三个回答）
            drain(8.0)
            ghost = out.count('mock 端到端验证通过'.encode())
        drain(2.0)
        try:
            os.write(fd, b'/quit\n')
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
        'approvalAsked': bool(asked),
        'approvedDone': bool(done),
        'remembered': bool(remembered),
        'noGhost': ghost == 2 if remembered else False,
        'quit0': code == 0,
        'exitCode': code,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and asked and done and remembered and verdict['noGhost'] and code == 0
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

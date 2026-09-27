"""PTY 端到端：/delete y 确认删除旧会话（codex /delete 对等）。

管道/非 TTY 下 /delete 一律拒绝（防误触），y 确认分支只能在真终端覆盖：
时序：等 › → 发任务 → 等 mock 最终回答 → /new → 等已新建会话 →
  按 meta.created 找最旧会话文件 → /delete <全 id> → 等“不可恢复” → 回 y →
  等“已删除会话” → /quit。
verdict：prompted / firstDone / newOk / confirmAsked / deleted / fileGone / quit0。
"""
import glob
import json
import os
import pty
import select
import sys
import time

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
        env['OMNI_PERMISSION'] = 'full'
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

    def oldest_session():
        """按首行 meta.created 找最旧会话（finalize 会刷新 mtime，不可用 mtime）"""
        try:
            files = glob.glob(os.path.join(XDG, 'omni', 'sessions', '*.jsonl'))
            if len(files) < 2:
                return None
            scored = []
            for fp in files:
                try:
                    with open(fp, 'r', encoding='utf-8') as f:
                        first = f.readline()
                    created = float(json.loads(first).get('created', 0) or 0)
                except Exception:
                    created = 0
                scored.append((created, fp))
            scored.sort(key=lambda t: t[0])
            return scored[0][1]
        except Exception:
            return None

    code = None
    first_done = False
    new_ok = False
    asked = False
    deleted = False
    victim = None
    try:
        prompted = wait_for('›'.encode(), 60)
        try:
            os.write(fd, 'delete-me-task\n'.encode())
        except OSError:
            pass
        first_done = wait_for('mock 端到端验证通过'.encode(), 60)
        if first_done:
            try:
                os.write(fd, b'/new\n')
            except OSError:
                pass
            new_ok = wait_for('已新建会话'.encode(), 30)
        if new_ok:
            t0 = time.time()
            while time.time() - t0 < 15 and victim is None:
                victim = oldest_session()
                if victim is None:
                    time.sleep(0.5)
            if victim is not None:
                vid = os.path.basename(victim)[:-len('.jsonl')]
                try:
                    os.write(fd, ('/delete %s\n' % vid).encode())
                except OSError:
                    pass
                asked = wait_for('不可恢复'.encode(), 30)
                if asked:
                    try:
                        os.write(fd, b'y\n')
                    except OSError:
                        pass
                    deleted = wait_for('已删除会话'.encode(), 30)
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
    file_gone = victim is not None and not os.path.exists(victim)
    verdict = {
        'prompted': bool(prompted),
        'firstDone': bool(first_done),
        'newOk': bool(new_ok),
        'confirmAsked': bool(asked),
        'deleted': bool(deleted),
        'fileGone': bool(file_gone),
        'quit0': code == 0,
        'exitCode': code,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = all([prompted, first_done, new_ok, asked, deleted, file_gone, code == 0])
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

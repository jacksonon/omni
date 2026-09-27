"""PTY 端到端：Ctrl+G 外部编辑器组稿（codex open_external_editor 对等）。

行缓冲种子 `seed`（不换行）→ Ctrl+G → $EDITOR 桩把暂存文件改写为
`<种子>-edited` → 回填行缓冲 → 回车提交 → mock 整轮完成。
verdict：prompted / done / quit0（提交文本由 TS 侧读会话文件断言）。
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
EDITOR = os.environ['OMNI_FT_EDITOR']


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
        env['EDITOR'] = EDITOR
        env.pop('VISUAL', None)
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
    done = False
    try:
        prompted = wait_for('›'.encode(), 60)
        try:
            os.write(fd, b'seed')
            time.sleep(0.5)
            os.write(fd, b'\x07')  # Ctrl+G：种子行进编辑器
        except OSError:
            pass
        time.sleep(3.0)  # 编辑器接管终端（同步阻塞主循环）
        try:
            os.write(fd, b'\r')  # 回车提交回填行
        except OSError:
            pass
        done = wait_for('mock 端到端验证通过'.encode(), 60)
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
        'done': bool(done),
        'quit0': code == 0,
        'exitCode': code,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and done and code == 0
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

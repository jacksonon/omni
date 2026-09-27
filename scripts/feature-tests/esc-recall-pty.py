"""PTY 端到端：空行 Esc 取回上一条输入（codex Esc edit-previous 对等）。

由 TS 套件调用（mock server 由调用方启动并就绪，普通极速 mock 即可）。
时序：
  等 `›` 提示符 → 发任务 marker → 等 mock 回答（turn 结束回提示符）→
  落定 1s 后记数 marker 出现次数 → 发 ESC(0x1b) → marker 次数必须增加
  （取回重画）→ /quit 干净退出。
verdict（JSON，stdout 末行）：prompted / answered / recalled / quit0。
计数法防重绘误判：turn 内流式重绘会重复 marker 字节，故 Esc 前后差值断言。
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
MARKER = b'recall-me-xyz-123'


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
        os.chdir(ROOT)
        os.execvpe('npx', ['npx', 'tsx', 'src/index.ts', 'mini'], env)

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

    def send(text: str) -> None:
        os.write(fd, text.encode() + b'\n')
        time.sleep(0.3)

    prompted = wait_for('›'.encode(), 60)
    send('recall-me-xyz-123')
    answered = wait_for('mock 端到端验证通过'.encode(), 60)
    drain(2.0)  # turn 落定：流式重绘停稳，计数基线
    before = out.count(MARKER)
    os.write(fd, b'\x1b')  # 空行 Esc → 取回上一条
    t0 = time.time()
    recalled = False
    while time.time() - t0 < 15:
        drain(0.2)
        if out.count(MARKER) > before:
            recalled = True
            break
    os.write(fd, b'\x15')  # Ctrl+U 清掉取回的行，再退（否则 /quit 会拼在取回文本后变成任务）
    time.sleep(0.5)
    send('/quit')
    drain(3)
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
    with open(LOG, 'wb') as f:
        f.write(out)
    verdict = {
        'prompted': bool(prompted),
        'answered': bool(answered),
        'recalled': bool(recalled),
        'quit0': code == 0,
        'exitCode': code,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and answered and recalled and code == 0
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

"""PTY 端到端：/ 联想面板「取消不上移」+「回车整块回收」（用户反馈回归锁）。

背景：此前取消（行清空/不再匹配）走 eraseAndClose —— 整块 DL 把输入行拽回面板
起点，实测「取消后输入框上移」；当前策略改为只放弃跟踪（面板留 scrollback，
bash 补全列表同款），回车提交才回收（面板 H 行 + 命令回显 1 行 = DL H+1 行）。

时序（确定性，全部字节断言；NO_COLOR=1 让面板行/提示符为连续字节）：
  等 `›` 提示符 → 打 `/m` 等面板候选行（`  /memory-apply`）→ 记偏移，发 Ctrl+U
  → 取消切片必须**没有 DL 序列**（\\x1b[<n>M；面板不擦屏、输入不搬家）
  → 打 `/pwd` 等面板行（`\\r\\x1b[2K  /pwd`，与回显区分）→ 记偏移，发回车
  → 提交切片必须有回收序列 \\x1b[2A\\x1b[2M（H=1 面板 + 回显）→ /quit 干净退出。
verdict（JSON，stdout 末行）：prompted / panelShown / cancelNoDelete / submitReclaim / quit0。
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

ROOT = os.environ['OMNI_FT_ROOT']
XDG = os.environ['OMNI_FT_XDG']
PORT = os.environ['OMNI_FT_PORT']
LOG = os.environ['OMNI_FT_LOG']

DL = re.compile(rb'\x1b\[\d*M')  # Delete Line（面板块删除的唯一手段）


def main() -> int:
    pid, fd = pty.fork()
    if pid == 0:
        # 真窗口尺寸（0x0 下 readline 行刷新字节不完整，回归断言会误判）
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
        env = dict(os.environ)
        env['XDG_CONFIG_HOME'] = XDG
        env['OMNI_BASE_URL'] = f'http://127.0.0.1:{PORT}/v1'
        env['OMNI_API_KEY'] = 'sk-mock'
        env['OMNI_MODEL'] = 'mock-model'
        env['OMNI_PERMISSION'] = 'full'
        env['OMNI_SHOW_THINKING'] = '0'
        env['NO_COLOR'] = '1'
        os.chdir(ROOT)
        os.execvpe('npx', ['npx', 'tsx', 'src/index.ts', 'mini'], env)

    out = b''
    notes = []

    def drain(timeout: float) -> None:
        nonlocal out
        t0 = time.time()
        while time.time() - t0 < timeout:
            r, _, _ = select.select([fd], [], [], 0.15)
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

    prompted = wait_for('›'.encode(), 60)
    drain(2.0)

    # 1) 打 /m：联想面板出现（`  /memory-apply` 只有面板会打）
    os.write(fd, b'/m')
    panel_shown = wait_for(b'  /memory-apply', 15)
    drain(1.2)
    cancel_mark = len(out)

    # 2) Ctrl+U 取消：面板不擦屏（无 DL）；输入行原地不动
    os.write(fd, b'\x15')
    drain(1.5)
    cancel_slice = out[cancel_mark:]
    cancel_dls = [m.group() for m in DL.finditer(cancel_slice)]
    cancel_no_delete = panel_shown and len(cancel_dls) == 0
    notes.append(f'cancel slice={len(cancel_slice)}B, DLs={cancel_dls[:5]}')

    # 3) /pwd + 回车：面板（H=1）与命令回显整块回收（上移 2 删 2）
    os.write(fd, b'/pwd')
    # 等面板行（`\r\x1b[2K  /pwd`——与 readline 回显 `› /pwd` 区分，防抢跑）
    pwd_panel = wait_for(b'\x1b[2K  /pwd', 15)
    drain(1.2)
    submit_mark = len(out)
    os.write(fd, b'\r')
    drain(1.5)
    submit_slice = out[submit_mark:]
    submit_reclaim = pwd_panel and b'\x1b[2A\x1b[2M' in submit_slice
    notes.append(f'submit slice={len(submit_slice)}B, reclaim={b"\x1b[2A\x1b[2M" in submit_slice}')

    # 4) 干净退出
    drain(0.3)
    os.write(fd, b'/quit\r')
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
        'panelShown': bool(panel_shown),
        'cancelNoDelete': bool(cancel_no_delete),
        'submitReclaim': bool(submit_reclaim),
        'quit0': code == 0,
        'exitCode': code,
        'notes': notes,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and panel_shown and cancel_no_delete and submit_reclaim and code == 0
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

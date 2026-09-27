"""PTY 端到端：轮内 `/stop` 中断（codex /stop 对等）。

由 TS 套件调用（mock server 由调用方启动并就绪，且带 MOCK_STREAM=1 + MOCK_SLOW_FIRST=1）。
时序（确定性，无需猜 app 回显）：
  等首个 `omni>` 提示符（主循环就绪）→ 发任务（turn 在毫秒级内启动，
  slow-first 首 chunk 延迟 2s）→ 1.0s 后发 `/stop`（落在 turn 窗口内）
  → 5s 落定 → `/pwd`（存活证明）→ `/exit`（干净退出）。
verdict（JSON，stdout 末行）：
  swallowed（stop 未被当空闲命令分发）、aborted（无模型最终回答）、
  alive（exit 0 且 pwd 输出）、prompted（看到过提示符）。
mini 输出只增不擦（无清屏），absence 断言可靠。
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


def main() -> int:
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env['XDG_CONFIG_HOME'] = XDG
        env['OMNI_BASE_URL'] = f'http://127.0.0.1:{PORT}/v1'
        env['OMNI_API_KEY'] = 'sk-mock'
        env['OMNI_MODEL'] = 'mock-model'
        env['OMNI_PERMISSION'] = 'full'
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
        return marker in out

    def send(text: str) -> None:
        os.write(fd, text.encode() + b'\n')
        time.sleep(0.3)

    # mini 提示符 `› `（此前零输入，pty 回显不可能伪造；首个即主循环就绪）
    prompted = wait_for('›'.encode(), 60)
    send('讲个故事')
    time.sleep(0.5)
    os.write(fd, b'\x14')  # 轮内 Ctrl+T：账本经 dumpLedger 落盘（先清 live 块，不与 Working 抢区域）
    time.sleep(0.5)  # turn 已跑 ~0.9s，深处 slow-first 2s 窗口
    send('/stop')
    time.sleep(5)  # 中止落定（slow 窗口已过： abort 成功则无回答）
    send('/pwd')
    time.sleep(1.5)
    # 空闲 /stop → 提示无执行中任务（与轮内吞掉相对：同一字符串，两种出处）
    send('/stop')
    time.sleep(1.0)
    # ? 快捷键帮助（含 /stop 行）
    send('?')
    time.sleep(1.0)
    send('/exit')
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
        'swallowed': out.count('当前没有正在执行的任务'.encode()) == 1,
        'aborted': 'mock 端到端验证通过'.encode() not in out,
        'alive': code == 0 and ROOT.encode() in out,
        'exitCode': code,
        'idleHint': '当前没有正在执行的任务'.encode() in out,
        'helpStop': 'Esc 或 /stop'.encode() in out,
        'introStop': '/stop 停止'.encode() in out,
        'ledgerDumped': '完整轨迹'.encode() in out,
    }
    sys.stdout.write(json.dumps(verdict) + '\n')
    ok = prompted and verdict['swallowed'] and verdict['aborted'] and verdict['alive'] and verdict['idleHint'] and verdict['helpStop'] and verdict['introStop'] and verdict['ledgerDumped']
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

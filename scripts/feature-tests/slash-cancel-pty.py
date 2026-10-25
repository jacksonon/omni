"""PTY 回归：斜杠列表是临时区域，过滤/取消/补全/提交不堆积、不移动输入行。

重建 ANSI 屏幕和 scrollback，断言用户实际看到的结果（不是只断言擦除字节）。
分别跑普通、短窄、输入可折行的窗口；每次 PTY 写入都在 try 内，finally 落盘与回收。
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import unicodedata

ROOT = os.environ['OMNI_FT_ROOT']
XDG = os.environ['OMNI_FT_XDG']
PORT = os.environ['OMNI_FT_PORT']
LOG = os.environ['OMNI_FT_LOG']
CSI = re.compile(r'\x1b\[([0-9;?]*)([ -/]*)([@-~])')
OSC = re.compile(r'\x1b\].*?(?:\x07|\x1b\\)', re.S)
CANDIDATE = re.compile(r'^  /[a-z-]+…?(?: +/[a-z-]+…?)*$')


def screen(data, width, height):
    """按完整 transcript 重建有界屏幕；处理自动折行、CJK、CUU/ED/EL 和 DL。"""
    grid = [[' '] * width for _ in range(height)]
    history = []
    row = col = 0
    normal = None
    saved_cursor = (0, 0)
    text = OSC.sub('', data.decode('utf-8', errors='replace'))

    def newline():
        nonlocal row
        row += 1
        if row >= height:
            history.append(''.join(grid.pop(0)).rstrip())
            grid.append([' '] * width)
            row = height - 1

    def erase_line(mode):
        if mode == 2:
            grid[row] = [' '] * width
        elif mode == 1:
            grid[row][:min(width, col + 1)] = [' '] * min(width, col + 1)
        else:
            grid[row][col:] = [' '] * max(0, width - col)

    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\x1b':
            if text[i + 1:i + 2] == '7':
                saved_cursor = (row, col)
                i += 2
                continue
            if text[i + 1:i + 2] == '8':
                row, col = saved_cursor
                row = min(height - 1, row)
                col = min(width - 1, col)
                i += 2
                continue
            m = CSI.match(text, i)
            if m:
                nums = [int(p) for p in m[1].replace('?', '').split(';') if p] or [0]
                n = nums[0] or 1
                cmd = m[3]
                if m[1] == '?1049' and cmd == 'h' and normal is None:
                    # 1049 = DECSC + 切备用屏，复用主屏 ESC 7 的保存槽。
                    # 旧模拟器为它单独留槽，漏掉了 composer 锚点被覆盖的真实故障。
                    saved_cursor = (row, col)
                    normal = (grid, history, saved_cursor)
                    saved_cursor = (0, 0)
                    grid = [[' '] * width for _ in range(height)]
                    history = []
                    row = col = 0
                elif m[1] == '?1049' and cmd == 'l' and normal is not None:
                    grid, history, saved_cursor = normal
                    row, col = saved_cursor
                    normal = None
                elif cmd == 'A': row = max(0, row - n)
                elif cmd == 'B': row = min(height - 1, row + n)
                elif cmd == 'C': col = min(width - 1, col + n)
                elif cmd == 'D': col = max(0, col - n)
                elif cmd == 'G': col = min(width - 1, n - 1)
                elif cmd in ('H', 'f'):
                    row = min(height - 1, n - 1)
                    col = min(width - 1, (nums[1] if len(nums) > 1 else 1) - 1)
                elif cmd == 'K': erase_line(nums[0])
                elif cmd == 'J':
                    if nums[0] == 2:
                        grid = [[' '] * width for _ in range(height)]
                    elif nums[0] == 0:
                        erase_line(0)
                        for r in range(row + 1, height): grid[r] = [' '] * width
                elif cmd == 'M':
                    count = min(n, height - row)
                    grid[row:] = grid[row + count:] + [[' '] * width for _ in range(count)]
                i = m.end()
                continue
            i += 2
            continue
        if ch == '\r': col = 0
        elif ch == '\n': newline()
        elif ch == '\b': col = max(0, col - 1)
        elif ord(ch) >= 32 and not unicodedata.combining(ch):
            w = 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1
            if col + w > width:
                col = 0
                newline()
            grid[row][col:col + w] = [ch] + [''] * (w - 1)
            col += w
        i += 1
    lines = [''.join(r).rstrip() for r in grid]
    return {'lines': lines, 'history': history, 'cursor': (row, col), 'alternate': normal is not None}


def run_case(width, height, warp=False):
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        env = dict(os.environ, XDG_CONFIG_HOME=XDG,
                   OMNI_BASE_URL=f'http://127.0.0.1:{PORT}/v1', OMNI_API_KEY='sk-mock',
                   OMNI_MODEL='mock-model', OMNI_PERMISSION='full', OMNI_SHOW_THINKING='0', NO_COLOR='1',
                   TERM_PROGRAM='WarpTerminal' if warp else 'test-vt')
        os.chdir(ROOT)
        os.execvpe('node', ['node', '--import', './node_modules/tsx/dist/loader.mjs', 'src/index.ts', 'mini'], env)

    out = b''
    checks = {}
    snapshots = {}
    code = None

    def drain(timeout=0.2):
        nonlocal out
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            ready, _, _ = select.select([fd], [], [], min(0.03, max(0, end - time.monotonic())))
            if not ready: continue
            try: chunk = os.read(fd, 65536)
            except OSError: break
            if not chunk: break
            out += chunk

    def snap(name):
        s = screen(out, width, height)
        snapshots[name] = s
        return s

    def send(data, name, delay=0.2):
        os.write(fd, data)
        drain(delay)
        return snap(name)

    def candidates(s):
        if warp:
            return [l for l in s['lines'] if l.startswith('›') and ('  Tab' in l or re.search(r'  /[a-z-]', l))]
        return [l for l in s['lines'] if CANDIDATE.fullmatch(l)]

    def anchor(s):
        return next((i for i in range(len(s['lines']) - 1, -1, -1) if s['lines'][i].startswith('›')), -1)

    def no_history(s):
        return not any(CANDIDATE.fullmatch(l) for l in s['history'])

    try:
        end = time.monotonic() + 30
        while '›'.encode() not in out and time.monotonic() < end: drain()
        checks['prompted'] = '›'.encode() in out
        baseline = snap('before-slash')
        first = send(b'/', 'slash')
        checks['panelShown'] = bool(candidates(first)) if warp else '  /exit' in candidates(first)
        m = send(b'm', 'm')
        mo = send(b'o', 'mo')
        model = send(b'del', 'model')
        checks['filterStable'] = all(anchor(s) == anchor(first) for s in (m, mo, model))
        checks['filteredOnly'] = (bool(candidates(model)) if warp else candidates(model) == ['  /model']) and no_history(model)
        esc = send(b'\x1b', 'escape', 0.7)
        left = send(b'\x1b[D', 'escape-left')
        right = send(b'\x1b[C', 'escape-right')
        checks['escapeClears'] = all(not candidates(s) and anchor(s) == anchor(model) for s in (esc, left, right))
        cleared = send(b'\x7f' * 6, 'clear-backspace')
        checks['cancelStable'] = not candidates(cleared) and anchor(cleared) == anchor(model)
        repeated = True
        for n in range(4):
            send(b'/m', f'repeat-{n}')
            s = send(b'\x15', f'repeat-clear-{n}')
            repeated = repeated and not candidates(s) and no_history(s) and anchor(s) == anchor(cleared)
        checks['noAccumulation'] = repeated
        checks['inlineNoGrowth'] = not warp or (anchor(first) == anchor(baseline) == anchor(cleared) and s['history'] == baseline['history'])

        send(b'/', 'tab-prefix')
        tab = send(b'\t', 'tab')
        if warp:
            checks['tabStable'] = tab['alternate'] and not tab['history']
            tab2 = send(b'\x1b', 'tab-close', 0.7)
        else:
            tab2 = send(b'\t', 'tab-again')
        tab_clear = send(b'\x15', 'tab-clear')
        if warp:
            checks['tabStable'] = checks['tabStable'] and not tab2['alternate'] and anchor(tab2) == anchor(tab_clear) == anchor(cleared)
        else:
            checks['tabStable'] = bool(candidates(tab)) and anchor(tab2) == anchor(tab) == anchor(tab_clear)
        checks['tabClears'] = not candidates(tab_clear) and no_history(tab_clear)
        if warp:
            send(b'/p', 'command-pick-prefix')
            send(b'\t', 'command-pick-open')
            filled = send(b'\r', 'command-pick-confirm')
            checks['commandPickRefills'] = not filled['alternate'] and filled['lines'][anchor(filled)].startswith('› /plan')
            send(b'\x15', 'command-pick-clear')
        else:
            checks['commandPickRefills'] = True
        send(b'/mo', 'complete-prefix')
        completed = send(b'\t', 'completed')
        spaced = send(b'\t', 'completed-space')
        checks['completionClears'] = (bool(candidates(completed)) if warp else candidates(completed) == ['  /model']) and '› /model' in spaced['lines'][anchor(spaced)] and not candidates(spaced)
        send(b'\x15', 'complete-clear')

        # 窄屏时 /memory-apply 正好折行；行内左移不能让面板盖住输入尾行。
        wrapped = send(b'/memory-apply', 'wrapped')
        moved = send(b'\x1b[D\x1b[D\x1b[D', 'wrapped-left')
        checks['wrappedCursor'] = anchor(moved) == anchor(wrapped) and (not moved['alternate'] if warp else len(candidates(moved)) == 1 and candidates(moved)[0].startswith('  /memory-'))
        backspace = send(b'\x05\x15', 'wrapped-clear')
        checks['wrappedClear'] = not candidates(backspace)
        send(b'/m', 'ctrl-l-prefix')
        clear_screen = send(b'\x0c', 'ctrl-l')
        fresh = send(b'o', 'ctrl-l-next')
        checks['clearScreen'] = not candidates(clear_screen) and (bool(candidates(fresh)) if warp else candidates(fresh).count('  /model') == 1)
        send(b'\x15', 'ctrl-l-clear')

        # 在列表显示时打开历史选择，取消后输入仍可编辑，旧候选未进入历史。
        send(b'/m', 'history-prefix')
        send(b'\x12', 'history-open')
        history_closed = send(b'\x1b', 'history-close', 0.7)
        checks['historyClears'] = not candidates(history_closed) and no_history(history_closed)
        send(b'\x15', 'history-clear')
        # 真正的 /model 模态菜单：长模型名、项目数超过窗口、反复导航和取消。
        menu_stable = True
        for n in range(3):
            draft = send(b'/model', f'model-draft-{n}')
            opened = send(b'\r', f'model-open-{n}')
            navigated = send(b'\x1b[B' * 25 + b'\x1b[A', f'model-navigate-{n}')
            closed = send(b'\x1b', f'model-cancel-{n}', 0.7)
            menu_stable = menu_stable and opened['alternate'] and navigated['alternate'] and not navigated['history'] and not closed['alternate']
            menu_stable = menu_stable and anchor(closed) == min(height - 1, anchor(draft) + 1)
            menu_stable = menu_stable and not any('picker-model-' in l for l in closed['lines'] + closed['history'])
        checks['modelMenuRestores'] = menu_stable
        # 确认当前 mock 模型，不修改配置；确认键不能泄漏到主 readline 提交幽灵轮。
        send(b'/model\r', 'model-confirm-open')
        mark = len(out)
        confirmed = send(b'\r', 'model-confirm', 0.5)
        checks['modelConfirmRestores'] = not confirmed['alternate'] and '已是当前模型'.encode() in out[mark:] and not any('picker-model-' in l for l in confirmed['lines'] + confirmed['history'])
        send(b'/pwd', 'pwd')
        mark = len(out)
        submitted = send(b'\r', 'submitted', 0.5)
        checks['submitClears'] = not candidates(submitted) and ROOT.encode() in out[mark:]
        checks['noDeleteLine'] = re.search(rb'\x1b\[\d*M', out[:mark]) is None
        send(b'/quit\r', 'quit', 1)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                code = os.waitstatus_to_exitcode(status)
                break
            drain(0.1)
        checks['quit0'] = code == 0
    finally:
        suffix = f'{width}x{height}' + ('-warp' if warp else '')
        with open(f'{LOG}.{suffix}', 'wb') as f: f.write(out)
        with open(f'{LOG}.{suffix}.json', 'w') as f: json.dump(snapshots, f, ensure_ascii=False, indent=2)
        if code is None:
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass
        os.close(fd)
    return {'size': f'{width}x{height}', 'terminal': 'warp' if warp else 'vt', 'checks': checks, 'exitCode': code}


def main():
    cases = [run_case(w, h, warp) for warp in (False, True) for w, h in [(100, 30), (24, 12), (14, 12)]]
    keys = cases[0]['checks'].keys()
    verdict = {key: all(c['checks'].get(key, False) for c in cases) for key in keys}
    verdict['cases'] = cases
    print(json.dumps(verdict))
    return 0 if all(verdict[key] for key in keys) else 1


if __name__ == '__main__':
    sys.exit(main())

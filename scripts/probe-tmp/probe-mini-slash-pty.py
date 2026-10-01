#!/usr/bin/env python3
"""PTY 探针：mini 模式下 `/` 命令联想 / Tab 补全 / 取消 时输入行位置。

用最小 ANSI 屏幕模拟器重建终端画面（行式）：每步打印屏幕尾部与光标位置，
用于定位「取消后输入框上移」类光标错位 bug。

用法：python3 scripts/probe-tmp/probe-mini-slash-pty.py [flow]
flow: slash=输入 / + Tab + Esc；tab2=输入 /m + Tab + Tab + Esc；
      bs=输入 / + 退格清掉；model=/model 选择器 Esc。缺省全部依次跑。
"""
import os
import pty
import re
import select
import struct
import sys
import time
import fcntl
import termios
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = 100
H = 30
CSI = re.compile(rb'\x1b\[([0-9;?]*)([ -/]?)([@-~])')


def char_width(ch):
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


class Screen:
    """有界屏幕（行=H，超出滚动进 scrollback；DL 在屏内补空行——真终端语义）。"""

    def __init__(self, cols, rows):
        self.cols = cols
        self.rows = rows
        self.scrollback = []
        self.grid = [[' '] * cols for _ in range(rows)]
        self.cursor = [0, 0]

    def _scroll(self):
        self.scrollback.append(self.grid.pop(0))
        self.grid.append([' '] * self.cols)

    def _put(self, ch):
        row, col = self.cursor
        w = char_width(ch)
        if col + w > self.cols:
            col = 0
            row += 1
            if row >= self.rows:
                self._scroll()
                row = self.rows - 1
        line = self.grid[row]
        line[col:col + w] = [ch] + [''] * (w - 1)
        self.cursor = [row, col + w]
        if self.cursor[1] >= self.cols:
            self.cursor = [row + 1, 0]

    def erase_line(self, mode):
        row, col = self.cursor
        line = self.grid[row]
        if mode in (0, '0'):
            line[col:] = [' '] * (self.cols - col)
        elif mode in (1, '1'):
            line[:col] = [' '] * col
        else:
            self.grid[row] = [' '] * self.cols

    def erase_down(self, mode=0):
        row, col = self.cursor
        if mode in (0, '0'):
            self.erase_line(0)
            for r in range(row + 1, self.rows):
                self.grid[r] = [' '] * self.cols
        elif mode in (1, '1'):
            for r in range(0, row):
                self.grid[r] = [' '] * self.cols
            self.erase_line(1)
        else:
            for r in range(row, self.rows):
                self.grid[r] = [' '] * self.cols

    def delete_lines(self, n):
        row = self.cursor[0]
        n = max(1, n)
        keep = self.grid[:row] + self.grid[row + n:]
        blanks = [[' '] * self.cols for _ in range(min(n, self.rows - len(keep)))]
        self.grid = (keep + blanks)[:self.rows]
        self.cursor[1] = 0

    def insert_lines(self, n):
        row = self.cursor[0]
        for _ in range(max(1, n)):
            if len(self.grid) >= self.rows:
                self.grid.pop()
            self.grid.insert(row, [' '] * self.cols)
        self.cursor[1] = 0

    def feed(self, data):
        i = 0
        while i < len(data):
            b = data[i:i + 1]
            if b == b'\x1b':
                # OSC
                if data[i + 1:i + 2] == b']':
                    end = data.find(b'\x07', i)
                    st = data.find(b'\x1b\\', i)
                    if end < 0 and st < 0:
                        i = len(data)
                        break
                    i = (end + 1) if (end >= 0 and (st < 0 or end < st)) else (st + 2)
                    continue
                m = CSI.match(data, i)
                if m:
                    params, _inter, cmd = m.groups()
                    try:
                        nums = [int(p) for p in params.replace(b'?', b'').split(b';') if p != b''] or [0]
                    except ValueError:
                        nums = [0]
                    n = nums[0] or 1
                    c = cmd.decode()
                    if c == 'A':
                        self.cursor[0] = max(0, self.cursor[0] - n)
                    elif c == 'B':
                        self.cursor[0] = min(self.rows - 1, self.cursor[0] + n)
                    elif c == 'C':
                        self.cursor[1] = min(self.cols - 1, self.cursor[1] + n)
                    elif c == 'D':
                        self.cursor[1] = max(0, self.cursor[1] - n)
                    elif c == 'G':
                        self.cursor[1] = max(0, n - 1)
                    elif c == 'd':
                        self.cursor[0] = max(0, min(self.rows - 1, n - 1))
                    elif c in 'Hf':
                        self.cursor[0] = max(0, min(self.rows - 1, (nums[0] or 1) - 1))
                        self.cursor[1] = max(0, (nums[1] if len(nums) > 1 else 1) - 1)
                    elif c == 'K':
                        self.erase_line(nums[0])
                    elif c == 'J':
                        self.erase_down(nums[0])
                    elif c == 'M':
                        self.delete_lines(n)
                    elif c == 'L':
                        self.insert_lines(n)
                    elif c == 'S':
                        for _ in range(n):
                            self._scroll()
                    elif c == 'T':
                        for _ in range(n):
                            self.grid.insert(0, [' '] * self.cols)
                            self.grid.pop()
                    i = m.end()
                    continue
                i += 2
                continue
            if b == b'\r':
                self.cursor[1] = 0
            elif b == b'\n':
                self.cursor[0] += 1
                if self.cursor[0] >= self.rows:
                    self._scroll()
                    self.cursor[0] = self.rows - 1
            elif b == b'\x08':
                self.cursor[1] = max(0, self.cursor[1] - 1)
            elif b == b'\x07':
                pass
            else:
                for ln in (1, 2, 3, 4):
                    try:
                        ch = data[i:i + ln].decode('utf-8')
                        if len(ch) == 1:
                            break
                    except UnicodeDecodeError:
                        continue
                else:
                    i += 1
                    continue
                ch = data[i:i + ln].decode('utf-8')
                if len(ch) == 1 and ch != '\x1b':
                    self._put(ch)
                    i += ln
                    continue
                i += 1
                continue
            i += 1

    def render(self):
        lines = []
        for r in range(self.rows):
            lines.append(f'{r:3} | ' + ''.join(self.grid[r]).rstrip())
        lines.append(f'    cursor=({self.cursor[0]},{self.cursor[1]})  scrollback={len(self.scrollback)}')
        return '\n'.join(lines)


def main():
    flow = sys.argv[1] if len(sys.argv) > 1 else 'all'
    env = dict(os.environ)
    env['OMNI_BASE_URL'] = 'http://127.0.0.1:1/v1'
    env['OMNI_API_KEY'] = 'sk-mock'
    env['OMNI_MODEL'] = 'mock-model'
    env['OMNI_PERMISSION'] = 'full'
    env['XDG_CONFIG_HOME'] = '/tmp/omni-probe-xdg'
    env['NO_COLOR'] = '1'
    os.makedirs('/tmp/omni-probe-xdg/omni', exist_ok=True)
    with open('/tmp/omni-probe-xdg/omni/trusted-workspaces.json', 'w') as f:
        f.write('{"workspaces": ["' + ROOT + '"]}\n')

    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
        os.chdir(ROOT)
        argv = ['npx', 'tsx', 'src/index.ts']
        if os.environ.get('PROBE_MODE') != 'console':
            argv.append('mini')
        os.execvpe('npx', argv, env)

    screen = Screen(W, H)
    raw = bytearray()

    def drain(timeout=0.6):
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
            raw.extend(chunk)
            screen.feed(chunk)
            t0 = time.time()

    def send(data, wait=0.5):
        os.write(fd, data)
        drain(wait)

    def snap(title):
        print(f'\n===== {title} =====')
        print(screen.render())
        print(f'    rawOffset={len(raw)}')

    drain(8)  # 等启动
    snap('启动后')

    steps = {
        'slash': [('输入 /', b'/'), ('Tab（列出全部命令）', b'\t'), ('Esc（取消）', b'\x1b'), ('再输 m', b'm'), ('Ctrl+U 清行', b'\x15')],
        'tab2': [('输入 /m', b'/m'), ('Tab#1', b'\t'), ('Tab#2', b'\t'), ('Esc', b'\x1b')],
        'bs': [('输入 /', b'/'), ('退格删 /', b'\x7f'), ('输入 /s', b'/s'), ('Ctrl+U 清行', b'\x15')],
        'updown': [('输入 /', b'/'), ('↓', b'\x1b[B'), ('↑', b'\x1b[A')],
        'tabcancel': [('输入 /', b'/'), ('Tab 列表', b'\t'), ('Ctrl+U 取消', b'\x15'), ('输入 hi', b'hi')],
        'completecancel': [('输入 /mo', b'/mo'), ('Tab 补全', b'\t'), ('Esc', b'\x1b'), ('Ctrl+U 取消', b'\x15'), ('输入 hi', b'hi')],
        'permcancel': [('输入 /permission', b'/permission'), ('Enter', b'\r'), ('Esc 取消选择', b'\x1b'), ('输入 hi', b'hi')],
        'modelcancel': [('输入 /model', b'/model'), ('Enter', b'\r'), ('Esc 取消选择', b'\x1b'), ('输入 hi', b'hi')],
        'tab2cancel': [('输入 /m', b'/m'), ('Tab#1', b'\t'), ('Tab#2', b'\t'), ('Ctrl+U 取消', b'\x15'), ('输入 hi', b'hi')],
        'submit': [('输入 /pwd', b'/pwd'), ('Enter 提交', b'\r'), ('输入 hi', b'hi')],
        'submithint': [('输入 /status', b'/status'), ('Enter 提交', b'\r')],
        'submitbig': [('输入 /s', b'/s'), ('Enter 提交', b'\r'), ('输入 hi', b'hi')],
        'tabagain': [('输入 /', b'/'), ('Tab 列表', b'\t'), ('Ctrl+U 取消', b'\x15'), ('再输 /', b'/'), ('再输 s', b's')],
        'submitaftertab': [('输入 /', b'/'), ('Tab 列表', b'\t'), ('Enter 提交', b'\r'), ('输入 hi', b'hi')],
        'mention': [('输入 @s', b'@s'), ('Ctrl+U 取消', b'\x15'), ('输入 hi', b'hi')],
        'esckeep': [('输入 /mo', b'/mo'), ('Esc', b'\x1b'), ('Ctrl+U', b'\x15'), ('输入 hi', b'hi')],
        'messageafterpanel': [('输入 /s', b'/s'), ('继续输消息', b' hello'), ('Enter 提交', b'\r'), ('等一轮', b'')],
        'drift': [('输入 /', b'/'), ('+m', b'm'), ('+o', b'o'), ('+d', b'd'), ('+e', b'e'), ('+l', b'l')],
        'histrecall': [('输入 hello', b'hello'), ('Enter 提交', b'\r'), ('等回合', b''), ('等回合2', b''), ('输入 /m', b'/m'), ('Ctrl+R', b'\x12'), ('Enter 选历史', b'\r'), ('Enter 提交', b'\r')],
        'ctrll': [('输入 /m', b'/m'), ('Ctrl+L', b'\x0c'), ('再输 o', b'o'), ('Ctrl+U', b'\x15')],
    }
    if flow != 'all':
        flows = [flow]
    else:
        flows = list(steps.keys())
    for name in flows:
        print(f'\n\n########## flow: {name} ##########')
        for label, data in steps[name]:
            send(data)
            snap(label)

    send(b'/exit\r', 1.0)
    drain(2)
    with open('/tmp/omni-probe-raw.bin', 'wb') as f:
        f.write(bytes(raw))
    try:
        os.kill(pid, 9)
    except OSError:
        pass


if __name__ == '__main__':
    main()

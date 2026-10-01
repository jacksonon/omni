#!/usr/bin/env python3
"""对照探针：bash（readline 原生）Tab 补全列表时输入行的位置与取消后的行为。"""
import os, pty, re, select, struct, sys, time, fcntl, termios, unicodedata

W, H = 80, 20
CSI = re.compile(rb'\x1b\[([0-9;?]*)([ -/]?)([@-~])')

def cw(ch):
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1

class Screen:
    def __init__(self, cols):
        self.cols = cols
        self.grid = [[]]
        self.cursor = [0, 0]
    def _ensure(self, r):
        while len(self.grid) <= r:
            self.grid.append([])
    def _put(self, ch):
        r, c = self.cursor
        self._ensure(r)
        line = self.grid[r]
        while len(line) < c:
            line.append(' ')
        w = cw(ch)
        line[c:c+w] = [ch] + [''] * (w - 1)
        self.cursor[1] = c + w
        if self.cursor[1] >= self.cols:
            self.cursor = [r + 1, 0]
    def erase_line(self, mode):
        r, c = self.cursor
        self._ensure(r)
        line = self.grid[r]
        while len(line) < self.cols:
            line.append(' ')
        if mode == 0:
            line[c:] = [' '] * (self.cols - c)
        elif mode == 1:
            line[:c] = [' '] * c
        else:
            self.grid[r] = [' '] * self.cols
    def erase_down(self, mode=0):
        r, c = self.cursor
        self._ensure(r)
        if mode == 0:
            self.erase_line(0)
            for rr in range(r + 1, len(self.grid)):
                self.grid[rr] = [' '] * self.cols
        elif mode == 1:
            for rr in range(r):
                self.grid[rr] = [' '] * self.cols
            self.erase_line(1)
    def delete_lines(self, n):
        r = self.cursor[0]
        self.grid = self.grid[:r] + self.grid[r+n:]
        self.cursor = [r, 0]
    def feed(self, data):
        i = 0
        while i < len(data):
            b = data[i:i+1]
            if b == b'\x1b':
                if data[i+1:i+2] == b']':
                    end = data.find(b'\x07', i)
                    st = data.find(b'\x1b\\', i)
                    if end < 0 and st < 0:
                        break
                    i = (end + 1) if (end >= 0 and (st < 0 or end < st)) else (st + 2)
                    continue
                m = CSI.match(data, i)
                if m:
                    params, _i, cmd = m.groups()
                    try:
                        nums = [int(p) for p in params.replace(b'?', b'').split(b';') if p] or [0]
                    except ValueError:
                        nums = [0]
                    n = nums[0] or 1
                    c = cmd.decode()
                    if c == 'A':
                        self.cursor[0] = max(0, self.cursor[0] - n)
                    elif c == 'B':
                        self.cursor[0] += n
                    elif c == 'C':
                        self.cursor[1] = min(self.cols - 1, self.cursor[1] + n)
                    elif c == 'D':
                        self.cursor[1] = max(0, self.cursor[1] - n)
                    elif c == 'K':
                        self.erase_line(nums[0])
                    elif c == 'J':
                        self.erase_down(nums[0])
                    elif c == 'M':
                        self.delete_lines(n)
                    i = m.end()
                    continue
                i += 2
                continue
            if b == b'\r':
                self.cursor[1] = 0
            elif b == b'\n':
                self.cursor[0] += 1
                self._ensure(self.cursor[0])
            else:
                for ln in (1, 2, 3, 4):
                    try:
                        ch = data[i:i+ln].decode('utf-8')
                        break
                    except UnicodeDecodeError:
                        continue
                else:
                    i += 1
                    continue
                if len(ch) == 1:
                    self._put(ch)
                    i += ln
                    continue
                i += 1
            i += 1
    def render(self):
        out = []
        last = len(self.grid)
        for r in range(max(0, last - HH), last):
            out.append(f'{r:3} | ' + ''.join(self.grid[r]).rstrip())
        out.append(f'    cursor=({self.cursor[0]},{self.cursor[1]})')
        return '\n'.join(out)

HH = H

def main():
    env = dict(os.environ)
    env['PS1'] = 'PROMPT> '
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', H, W, 0, 0))
        os.execvpe('bash', ['bash', '--noprofile', '--norc', '-i'], env)
    sc = Screen(W)
    def drain(t=0.5):
        t0 = time.time()
        while time.time() - t0 < t:
            r, _, _ = select.select([fd], [], [], 0.15)
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            sc.feed(chunk)
            t0 = time.time()
    def send(b, t=0.5):
        os.write(fd, b)
        drain(t)
    drain(2)
    send(b'ls /usr/libe')   # partial path with multiple matches
    print('=== 输入后 ===')
    print(sc.render())
    send(b'\t')
    print('\n=== Tab#1 ===')
    print(sc.render())
    send(b'\t')
    print('\n=== Tab#2（列表） ===')
    print(sc.render())
    send(b'\x15')  # Ctrl+U cancel
    print('\n=== Ctrl+U 取消后 ===')
    print(sc.render())
    send(b'echo after\r', 0.8)
    print('\n=== 再来一条命令 ===')
    print(sc.render())
    send(b'/exit\r', 0.5)
    try:
        os.kill(pid, 9)
    except OSError:
        pass

if __name__ == '__main__':
    main()

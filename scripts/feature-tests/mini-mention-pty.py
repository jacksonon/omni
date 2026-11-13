"""mini 文件菜单真 PTY：超过 15 个匹配仍可滚动选择，插入/取消与缩放保持草稿。

独立运行：python3 scripts/feature-tests/mini-mention-pty.py
使用临时配置与文件，不请求模型或复用用户 broker。
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True


def run_case(width, height):
    with tempfile.TemporaryDirectory(prefix='mini-mention-') as temp:
        base = Path(temp)
        work = base / 'workspace'
        work.mkdir()
        for i in range(1, 21):
            (work / f'entry{i:02}.txt').write_text('fixture\n')
        cfg = base / 'config.json'
        cfg.write_text(json.dumps({
            'model': 'model-a', 'autoMemory': False, 'skills': False, 'repoMap': False,
            'agentsFile': False, 'globalAgentsFile': False,
            'providers': {'mock': {'baseURL': 'http://127.0.0.1:1/v1', 'apiKey': 'sk-mock', 'models': {'model-a': {}}}},
        }))
        directory = base / 'omni'
        directory.mkdir()
        (directory / 'trusted-workspaces.json').write_text(json.dumps({'workspaces': [str(work)]}))
        os.environ.update(OMNI_FT_ROOT=str(ROOT), OMNI_FT_XDG=temp, OMNI_FT_PORT='1', OMNI_FT_LOG=str(base / 'log'))
        spec = importlib.util.spec_from_file_location('screen_helper', Path(__file__).with_name('slash-cancel-pty.py'))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
            env = {key: value for key, value in os.environ.items() if not key.startswith('OMNI_')}
            env.update(XDG_CONFIG_HOME=temp, OMNI_CONFIG=str(cfg), OMNI_LOCAL='1', OMNI_PET='off',
                       OMNI_MODEL='model-a', OMNI_API_KEY='sk-mock', OMNI_PERMISSION='full',
                       FORCE_COLOR='1', COLORFGBG='0;0' if width == 80 else '0;15')
            os.chdir(work)
            os.execvpe('node', ['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'), str(ROOT / 'src/index.ts'), 'mini'], env)
        data = bytearray()
        snapshots = {}

        def drain(seconds=.2):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if not select.select([fd], [], [], .02)[0]:
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                data.extend(chunk)

        def view():
            return helper.screen(bytes(data), width, height)

        def send(keys, seconds=.2):
            os.write(fd, keys)
            drain(seconds)

        def check_input(text):
            state = view()
            assert any(line.startswith('› ' + text) for line in state['lines']), (text, state)
            return state

        try:
            drain(1.2)
            expected_status = b'\x1b[38;2;215;180;124m' if width == 80 else b'\x1b[38;2;146;64;14m'
            assert expected_status in data, ('status must follow terminal light/dark theme', bytes(data[-600:]))
            send(b'@entry')
            snapshots['open'] = check_input('@entry')
            for _ in range(19):
                send(b'\x1b[B', .025)
            drain(.2)
            snapshots['last'] = view()
            assert any(line.startswith('› @entry20.txt') for line in view()['lines']), ('20th candidate must be reachable', view())
            original_width = width
            for size in [max(32, width - 20), original_width]:
                width = size
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
                os.kill(pid, signal.SIGWINCH)
                drain(.3)
                assert any(line.startswith('› @entry20.txt') for line in view()['lines']), ('resize preserves selected candidate', view())
            snapshots['resized'] = view()
            send(b'\t')
            snapshots['inserted'] = check_input('@entry20.txt')
            assert not any(line.strip() == '文件' for line in view()['lines']), ('menu should close after file insertion', view())
            send(b'\x15@entry')
            send(b'\x1b', .6)
            snapshots['cancelled'] = check_input('@entry')
            assert not any(line.strip() == '文件' for line in view()['lines']), ('Esc should close the menu without erasing draft', view())
            send(b'\x15/exit\r', .6)
            done, status = os.waitpid(pid, 0)
            pid = None
            assert os.waitstatus_to_exitcode(status) == 0
            print(f'PASS {width}x{height}: terminal theme, 20th file reachable, resize selection, Tab insertion, Esc preserves draft, clean exit')
        finally:
            artifact = os.environ.get('OMNI_FT_ARTIFACT_DIR')
            if artifact:
                target = Path(artifact)
                target.mkdir(parents=True, exist_ok=True)
                (target / f'mention-{width}x{height}.log').write_bytes(data)
                (target / f'mention-{width}x{height}.json').write_text(json.dumps(snapshots, ensure_ascii=False, indent=2))
            if pid is not None:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except ProcessLookupError:
                    pass
            os.close(fd)


if __name__ == '__main__':
    for size in [(80, 24), (40, 16)]:
        run_case(*size)

"""mini 工具输出展开/收起真 PTY 回归：本地 HTTP mock，不调用外部模型。"""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
import threading
import time

ROOT = str(Path(__file__).resolve().parents[2])
WIDTH = int(os.environ.get('OMNI_FT_WIDTH', '100'))
HEIGHT = int(os.environ.get('OMNI_FT_HEIGHT', '40'))
sys.dont_write_bytecode = True
requests = []
holds = {}


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            self.respond()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def respond(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        messages = body['messages']
        task = next(m['content'] for m in reversed(messages) if m['role'] == 'user')
        if task == 'ASK_LATER':
            holds['ASK_LATER'].wait(8)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def emit(delta, finish=None):
            chunk = {'id': 'expand-test', 'object': 'chat.completion.chunk', 'model': 'model-a',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.flush()
        emit({'role': 'assistant'})
        if messages[-1]['role'] == 'user' and task == 'TOOLS':
            lines = [f'EXP_{i:02}' for i in range(1, 13)]
            command = "printf '" + '\\n'.join(lines + ['LONG_' + 'Z' * 190 + '_END']) + "\\n'"
            calls = [
                {'index': 0, 'id': 'cmd', 'type': 'function', 'function': {'name': 'run_command', 'arguments': json.dumps({'command': command})}},
                {'index': 1, 'id': 'read', 'type': 'function', 'function': {'name': 'read_file', 'arguments': '{"path":"fixture_unique.txt"}'}},
            ]
            emit({'tool_calls': calls}, 'tool_calls')
        elif messages[-1]['role'] == 'user' and task == 'WAIT_TOOL':
            command = "printf 'TOOL_START\\n'; sleep 1; printf 'TOOL_END\\n'"
            emit({'tool_calls': [{'index': 0, 'id': 'live', 'type': 'function', 'function': {'name': 'run_command', 'arguments': json.dumps({'command': command})}}]}, 'tool_calls')
        elif messages[-1]['role'] == 'user' and task == 'ASK_LATER':
            emit({'tool_calls': [{'index': 0, 'id': 'ask', 'type': 'function', 'function': {'name': 'ask_user', 'arguments': '{"question":"EXPAND_QUESTION","options":["YES","NO"]}'}}]}, 'tool_calls')
        elif task == 'SLOW':
            emit({'content': 'LIVE_FIRST\n'})
            holds['SLOW'].wait(8)
            emit({'content': 'LIVE_LAST'}, 'stop')
        elif task == 'TABLE':
            emit({'content': 'TABLE_INTRO\n\n| 项目 | 数值'})
            holds['TABLE_HEADER'].wait(8)
            emit({'content': ' |\n| --- | --- |\n| 气温 | 14°C |\n| 天气 | 烟霾 /'})
            holds['TABLE_MIDDLE_READY'].set()
            holds['TABLE_MIDDLE'].wait(8)
            emit({'content': ' 雾霾 |\n| 湿度 | 58% |\n\nTABLE_DONE\n'}, 'stop')
        else:
            emit({'content': 'DONE_' + task}, 'stop')
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


def main():
    for name in ['SLOW', 'ASK_LATER', 'TABLE_HEADER', 'TABLE_MIDDLE_READY', 'TABLE_MIDDLE']:
        holds[name] = threading.Event()
    server = ThreadingHTTPServer(('127.0.0.1', 0), MockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f'http://127.0.0.1:{server.server_port}/v1'
    with tempfile.TemporaryDirectory(prefix='mini-follow-up-') as temp:
        config = Path(temp) / 'config.json'
        config.write_text(json.dumps({
            'autoMemory': False, 'skills': False, 'repoMap': False, 'agentsFile': False,
            'globalAgentsFile': False, 'model': 'model-a',
            'providers': {'mock': {'baseURL': base_url, 'apiKey': 'sk-mock', 'models': {'model-a': {}}}},
        }))
        (Path(temp) / 'omni').mkdir()
        (Path(temp) / 'omni' / 'trusted-workspaces.json').write_text(json.dumps({'workspaces': [temp]}))
        (Path(temp) / 'fixture_unique.txt').write_text('\n'.join('FILE_%02d_%s' % (i, '内容' * 12) for i in range(1, 21)) + '\nFILE_FINAL\n')
        os.environ.update(OMNI_FT_ROOT=ROOT, OMNI_FT_XDG=temp, OMNI_FT_PORT=str(server.server_port), OMNI_FT_LOG=str(Path(temp) / 'log'))
        spec = importlib.util.spec_from_file_location('screen_helper', Path(__file__).with_name('slash-cancel-pty.py'))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        # 与真实终端相同：1049 会覆盖主屏 DECSC 槽，不是独立的光标保存机制。
        sample = b'\x1b[2;1H\x1b7\x1b[10;1H\x1b[?1049h\x1b[?1049l\x1b8'
        assert helper.screen(sample, 80, 24)['cursor'] == (9, 0)
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', HEIGHT, WIDTH, 0, 0))
            env = dict(os.environ, XDG_CONFIG_HOME=temp, OMNI_CONFIG=str(config), OMNI_MODEL='model-a',
                       OMNI_BASE_URL=base_url, OMNI_API_KEY='sk-mock', OMNI_PERMISSION='full', NO_COLOR='1')
            env.pop('FORCE_COLOR', None)
            if os.environ.get('OMNI_FT_COLOR') == '1':
                env.pop('NO_COLOR', None)
                env['FORCE_COLOR'] = '1'
            os.chdir(temp)
            os.execvpe('node', ['node', '--import', ROOT + '/node_modules/tsx/dist/loader.mjs', ROOT + '/src/index.ts', 'mini'], env)
        output = bytearray()
        dimensions = [WIDTH, HEIGHT]

        def drain(seconds=.1):
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
                output.extend(chunk)

        def send(data, delay=.1):
            os.write(fd, data.encode() if isinstance(data, str) else data)
            drain(delay)

        def view():
            return helper.screen(bytes(output), *dimensions)

        def resize(width, height):
            dimensions[:] = [width, height]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            drain(.3)

        def wait(condition, label, timeout=6):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                drain(.05)
                if condition():
                    return
            raise AssertionError((label, view(), output[-2500:].decode(errors='replace')))

        def plain():
            state = view()
            return '\n'.join(state['history'] + state['lines'])

        def idle(marker):
            wait(lambda: marker in plain() and 'Ready' in view()['lines'][-2], marker)
            assert view()['lines'][HEIGHT - 4] == '› Ask Omni to do anything', view()

        try:
            wait(lambda: b'Ask Omni to do anything' in output, 'startup')
            send('TOOLS\r')
            idle('DONE_TOOLS')
            assert 'ctrl+t to expand' in plain(), view()
            assert 'EXP_12' not in plain(), view()
            send('draft中文')
            send(b'\x1b[D')
            original = view()
            send(b'\x14')
            expanded = view()
            assert expanded['alternate'], expanded
            send(b'\x1b[F')
            assert 'FILE_FINAL' in plain(), view()
            for _ in range(160):
                if '    EXP_12' in view()['lines']:
                    break
                send(b'\x1b[A', .01)
            assert '    EXP_12' in view()['lines'], view()
            assert '    LONG_' in plain() or '_END' in plain(), view()
            if os.environ.get('OMNI_FT_SCREEN'):
                Path(os.environ['OMNI_FT_SCREEN']).write_text(json.dumps(view(), ensure_ascii=False))
            assert '完整轨迹' not in plain(), view()
            assert view()['lines'][HEIGHT - 4] == '› draft中文', view()
            send(b'\x14')
            assert view() == original, (view(), original)
            for key in [b'\x14', b'\x1b[116;5u', b'\x14']:
                send(key)
                assert view()['alternate'], view()
                send(b'\x14')
                assert view() == original, (view(), original)
            send(b'\x14')
            send('X')
            assert not view()['alternate'] and '› draft中X文' in plain(), view()
            send(b'\x05\x15')
            print('PASS idle: full parallel command/read output, long lines, scrolling, repeated collapse restores exact history/cursor/draft')

            send('WAIT_TOOL\r')
            wait(lambda: b'TOOL_START' in output, 'running tool')
            send(b'\x14')
            wait(lambda: 'TOOL_END' in plain() and 'DONE_WAIT_TOOL' in plain(), 'tool completed while expanded')
            assert view()['alternate'], view()
            send(b'\x14')
            idle('DONE_WAIT_TOOL')
            assert plain().count('DONE_WAIT_TOOL') == 1, view()
            print('PASS running tool: expanded result updates, collapse replays normal output once')

            send('SLOW\r')
            wait(lambda: 'LIVE_FIRST' in plain(), 'stream start')
            send('preserved draft')
            send(b'\x14')
            holds['SLOW'].set()
            wait(lambda: 'LIVE_LAST' in plain(), 'stream completes inside expansion')
            assert view()['alternate'], view()
            send(b'\x1b')
            wait(lambda: not view()['alternate'], 'Esc closes expansion')
            assert not view()['alternate'] and '› preserved draft' in plain(), view()
            assert plain().count('LIVE_FIRST') == 1 and plain().count('LIVE_LAST') == 1, view()
            send(b'\x15')
            print('PASS stream: new answer remains visible, Esc restores editable draft without duplicate output')

            send('TABLE\r')
            wait(lambda: '| 项目 | 数值' in plain(), 'partial Markdown table header')
            send('table draft')
            send(b'\x14')
            holds['TABLE_HEADER'].set()
            wait(lambda: holds['TABLE_MIDDLE_READY'].is_set(), 'partial table rows')
            send(b'\x14')
            send(b'\x14')
            holds['TABLE_MIDDLE'].set()
            wait(lambda: 'TABLE_DONE' in plain() and 'Ready' in view()['lines'][-2], 'finished table in expanded view')
            send(b'\x14')
            state = view()
            text = plain()
            assert not state['alternate'], state
            # NO_COLOR 默认保留原始 Markdown；禁止的是未完成预览，不是最终表格的竖线。
            assert not any(line.strip() == '| 项目 | 数值' for line in state['history'] + state['lines']), state
            assert '▌' not in text, state
            assert text.count('TABLE_INTRO') == 1 and text.count('TABLE_DONE') == 1, state
            body = text[text.index('TABLE_INTRO'):text.index('TABLE_DONE')]
            assert '气温' in body and '天气' in body and '14°C' in body and '58%' in body, state
            assert all(body.count(label) == 1 for label in ['气温', '天气', '湿度']), state
            assert '\n\n\n\n\n' not in body, state  # 不得留下正文锚点错位形成的大块空白。
            assert state['lines'][HEIGHT - 4] == '› table draft', state
            send(b'\x05\x15')
            print('PASS Markdown table: toggles during header/rows preserve one final table, no partial preview or blank gap')

            send(b'\x14')
            resize(60, 28)
            assert view()['alternate'] and view()['lines'][24] == '› Ask Omni to do anything', view()
            send(b'\x1b[5~')
            resize(WIDTH, HEIGHT)
            assert view()['alternate'], view()
            send(b'\x14')
            wait(lambda: 'Ready' in view()['lines'][-2], 'resize collapse')
            assert view()['lines'][HEIGHT - 4] == '› Ask Omni to do anything', view()
            print('PASS resize: expanded scroll view reflows and collapses to bottom-docked composer')

            send('ASK_LATER\r')
            wait(lambda: len(requests) > 0 and requests[-1]['messages'][-1].get('content') == 'ASK_LATER', 'waiting for ask')
            send(b'\x14')
            holds['ASK_LATER'].set()
            wait(lambda: 'EXPAND_QUESTION' in plain() and not view()['alternate'], 'question closes expansion')
            send('\r')
            idle('DONE_ASK_LATER')
            send('/quit\r')
            assert b'\x1b[<u' in output
            print('PASS question: modal interrupts expansion safely, answer does not leak, normal exit')
        finally:
            for event in holds.values():
                event.set()
            (Path(temp) / 'transcript.ansi').write_bytes(output)
            os.close(fd)
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()

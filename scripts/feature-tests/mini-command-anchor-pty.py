"""mini 输入区统一页底：普通对话、流式/工具/中断、命令选择/取消和草稿编辑。

独立运行：python3 scripts/feature-tests/mini-command-anchor-pty.py
仅使用临时配置、本地 shell 和进程内 mock API，不调用外部模型。
"""
import fcntl
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
import threading

ROOT = str(Path(__file__).resolve().parents[2])
sys.dont_write_bytecode = True


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
        messages = body['messages']
        user_index = max(i for i, message in enumerate(messages) if message['role'] == 'user')
        user = messages[user_index]['content']
        tool_done = any(message['role'] == 'tool' for message in messages[user_index + 1:])
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def emit(delta, finish=None):
            chunk = {'id': 'footer-test', 'object': 'chat.completion.chunk', 'model': 'model-a',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.flush()
        emit({'role': 'assistant'})
        time.sleep(2 if user == 'CANCEL_FOOTER' else .2)
        emit({'reasoning_content': 'Check footer position.'})
        time.sleep(.15)
        if tool_done:
            emit({'content': 'FOOTER_ANSWER_' + user})
            time.sleep(.15)
            emit({}, 'stop')
        else:
            emit({'tool_calls': [{'index': 0, 'id': 'footer-tool', 'type': 'function',
                                 'function': {'name': 'run_command', 'arguments': '{"command":"echo footer-ok"}'}}]})
            emit({}, 'tool_calls')
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


def run_case(width, height):
    with tempfile.TemporaryDirectory(prefix='omni-command-anchor-') as temp:
        server = ThreadingHTTPServer(('127.0.0.1', 0), MockHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base_url = f'http://127.0.0.1:{server.server_port}/v1'
        config = Path(temp) / 'config.json'
        config.write_text(json.dumps({
            'autoMemory': False, 'skills': False, 'repoMap': False,
            'agentsFile': False, 'globalAgentsFile': False,
            'reasoningEffortOptions': ['low', 'medium', 'high'],
            'providers': {'test': {'baseURL': base_url, 'apiKey': 'sk-mock',
                                   'models': {'model-a': {}, 'model-b': {}, 'model-c': {}, **{f'extra-model-{i}': {} for i in range(20)}}}},
        }))
        directory = Path(temp) / 'omni'
        directory.mkdir()
        (directory / 'trusted-workspaces.json').write_text(json.dumps({'workspaces': [ROOT]}))
        # 复用已有的完整 transcript 屏幕模拟器，不按 ANSI 擦除字节猜最终画面。
        os.environ.update(OMNI_FT_ROOT=ROOT, OMNI_FT_XDG=temp, OMNI_FT_PORT='1', OMNI_FT_LOG=str(Path(temp) / 'log'))
        spec = importlib.util.spec_from_file_location('slash_screen', Path(__file__).with_name('slash-cancel-pty.py'))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
            env = dict(os.environ, XDG_CONFIG_HOME=temp, OMNI_CONFIG=str(config),
                       OMNI_MODEL='model-a', OMNI_API_KEY='sk-mock', OMNI_BASE_URL=base_url, OMNI_SHOW_THINKING='1',
                       OMNI_PERMISSION='full', NO_COLOR='0', FORCE_COLOR='1', COLORFGBG='0;0' if width == 100 else '0;15')
            os.chdir(ROOT)
            os.execvpe('node', ['node', '--import', './node_modules/tsx/dist/loader.mjs', 'src/index.ts', 'mini'], env)
        output = bytearray()

        def drain(seconds):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if not select.select([fd], [], [], .03)[0]:
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)

        def view():
            return helper.screen(bytes(output), width, height)

        def send(text, delay=.4):
            os.write(fd, text)
            drain(delay)

        def submit(command):
            send((command + '\r').encode())

        def content():
            state = view()
            end = state['lines'].index('› Ask Omni to do anything')
            lines = state['history'] + state['lines'][:end]
            while lines and not lines[-1]:
                lines.pop()
            return lines

        def records():
            return [line for line in content() if line]

        def check(label):
            state = view()
            inputs = [i for i, line in enumerate(state['lines']) if line == '› Ask Omni to do anything']
            assert inputs == [height - 4], (label, state)

        def check_panel(label):
            state = view()
            assert state['lines'][-1], ('panel is not docked to bottom', label, state)
            assert any(word in state['lines'][-1] for word in ['select', '选择', '确认']), (label, state)
            assert not any('Ask Omni to do anything' in line for line in state['lines']), (label, state)

        def resize_panel():
            nonlocal width
            original = width
            for size in [max(40, original - 30), original]:
                width = size
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
                os.kill(pid, signal.SIGWINCH)
                drain(.3)
                check_panel('resize')

        try:
            drain(2)
            submit('!printf ANCHOR_BEFORE')
            for command in ['/model', '/model', '/permission', '/variants']:
                previous = records()
                previous_content = content()
                submit(command)
                check_panel(command + ' open')
                send(b'\x1b[B')
                check_panel(command + ' navigate')
                if command == '/model':
                    resize_panel()
                send(b'\x1b', .8)  # readline 独立 Esc 需经过 escapeCodeTimeout。
                check(command + ' cancel')
                assert content() == previous_content, ('Esc changed conversation history or spacing', command, previous_content, content())
                assert records() == previous, ('Esc produced a record', command)
            previous = records()
            submit('/model')
            check_panel('model before confirm')
            send(b'\x1b[B\r')
            check('model confirm')
            current = records()
            assert current[:-1] == previous, ('model change produced extra records', current)
            assert current[-1].startswith('• Model changed to '), current
            assert not any(line.startswith('› /') for line in current), current
            for command, prefix in [('/variants', '• Reasoning effort changed to '), ('/permission', '• Permissions changed to ')]:
                previous = records()
                submit(command)
                send(b'\x1b[B\r')
                check(command + ' confirm')
                current = records()
                assert current[:-1] == previous and current[-1].startswith(prefix), (command, current)
            for command in ['/pwd', '/status', '/model model-a', '/permission full']:
                submit(command)
                check(command)
            # 两轮真实 Agent 流程，抽查等待、思考、工具、回答与空闲状态的页底位置。
            for user in ['CHAT_FOOTER_ONE', 'CHAT_FOOTER_TWO']:
                start_offset = len(output)
                send((user + '\r').encode(), .05)
                send(b'LIVE_DRAFT', .05)
                deadline = time.monotonic() + 8
                samples = 0
                while time.monotonic() < deadline:
                    drain(.12)
                    state = view()
                    if '› LIVE_DRAFT' in state['lines']:
                        assert state['lines'].index('› LIVE_DRAFT') == height - 4, state
                        assert state['lines'][-2].startswith('  model-'), state
                        samples += 1
                    recent = output[start_offset:]
                    if ('FOOTER_ANSWER_' + user).encode() in recent and 'Ready' in state['lines'][-2]:
                        break
                else:
                    raise AssertionError(('Agent turn did not finish', view()))
                assert samples >= 3, (samples, view())
                assert b'Think' in recent and b'Ran' in recent, recent.decode(errors='replace')
                send(b'\x7fZ')
                assert '› LIVE_DRAFZ' in view()['lines'], view()
                send(b'\x15')
                check('ordinary turn ready')
            offset = len(output)
            send(b'CANCEL_FOOTER\r', .2)
            deadline = time.monotonic() + 4
            while b'Working (' not in output[offset:] and time.monotonic() < deadline:
                drain(.1)
            check('before interrupt')
            send(b'\x03', .3)
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                drain(.1)
                if 'Ready' in view()['lines'][-2]:
                    break
            check('interrupted turn ready')
            assert b'Interrupted by user' in output[offset:], view()
            previous_content = content()
            submit('/model')
            send(b'\x1b', .8)
            check('model cancel after ordinary chat')
            assert content() == previous_content, ('cancel after chat changed history', content())
            # 下一条消息恢复正文锚点，临时填充不能留下大段历史空白。
            submit('!printf ANCHOR_AFTER')
            state = view()
            history = state['history'] + state['lines']
            assert any('ANCHOR_BEFORE' in line for line in history), state
            assert any('ANCHOR_AFTER' in line for line in history), state
            start = next(i for i, line in enumerate(history) if line.startswith('• Model changed to model-a'))
            stop = next(i for i in range(start + 1, len(history)) if 'ANCHOR_AFTER' in history[i])
            longest = current = 0
            for line in history[start:stop]:
                current = current + 1 if not line else 0
                longest = max(longest, current)
            assert longest <= 2, ('temporary gap leaked into history', history[start:stop])
            submit('/pwd')
            check('after shell')
            send(b'DRAFT_abc\x7fZ')
            assert '› DRAFT_abZ' in view()['lines'], view()
            send(b'\x15')
            draft = 'LONG_' + 'a' * 120
            send(draft.encode() + b'\x7fZ')
            state = view()
            start = next(i for i, line in enumerate(state['lines']) if line.startswith('› LONG_'))
            rendered = ''.join(state['lines'][start:height - 3])
            assert rendered == '› ' + draft[:-1] + 'Z', state
            send(b'\x15')
            check('wrapped draft cleared')
            submit('/quit')
            print(f'PASS {width}x{height}: silent Esc, one-line model result, docked input and open/navigating/resizing panels, waiting/thinking/tools/answer/ready, no history gap, draft editing')
        finally:
            os.close(fd)
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    for size in [(100, 40), (50, 24)]:
        run_case(*size)

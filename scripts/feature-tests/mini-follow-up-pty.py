"""mini queue/steer 真 PTY 回归：本地 HTTP mock，不调用外部模型。"""
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
        last_user = next(message['content'] for message in reversed(messages) if message['role'] == 'user')
        if last_user == 'SLOW_CREATE':
            holds[last_user].wait(10)  # 阻塞 create 阶段，尚未发响应头。
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def emit(delta, finish=None):
            chunk = {'id': 'follow-up-test', 'object': 'chat.completion.chunk', 'model': 'model-a',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.flush()
        emit({'role': 'assistant'})
        if last_user in ['SLOW_QUEUE', 'SLOW_STREAM', 'SLOW_MULTI', 'CANCEL_ME', 'CANCEL_CTRL']:
            emit({'content': 'PARTIAL_' + last_user})
            holds[last_user].wait(10)
        if last_user == 'SLOW_TOOL':
            emit({'tool_calls': [{'index': 0, 'id': 'slow-tool', 'type': 'function',
                                 'function': {'name': 'run_command', 'arguments': '{"command":"sleep 1.2; echo late-tool"}'}}]})
            emit({}, 'tool_calls')
        else:
            emit({'content': 'ANSWER_' + last_user})
            emit({}, 'stop')
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


def main():
    for name in ['SLOW_QUEUE', 'SLOW_CREATE', 'SLOW_STREAM', 'SLOW_MULTI', 'CANCEL_ME', 'CANCEL_CTRL']:
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
        (Path(temp) / 'fixture_unique.txt').write_text('fixture\n')
        os.environ.update(OMNI_FT_ROOT=ROOT, OMNI_FT_XDG=temp, OMNI_FT_PORT=str(server.server_port), OMNI_FT_LOG=str(Path(temp) / 'log'))
        spec = importlib.util.spec_from_file_location('screen_helper', Path(__file__).with_name('slash-cancel-pty.py'))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', HEIGHT, WIDTH, 0, 0))
            env = dict(os.environ, XDG_CONFIG_HOME=temp, OMNI_CONFIG=str(config), OMNI_MODEL='model-a',
                       OMNI_BASE_URL=base_url, OMNI_API_KEY='sk-mock', OMNI_PERMISSION='full', NO_COLOR='1')
            env.pop('FORCE_COLOR', None)
            os.chdir(temp)
            os.execvpe('node', ['node', '--import', ROOT + '/node_modules/tsx/dist/loader.mjs', ROOT + '/src/index.ts', 'mini'], env)
        output = bytearray()

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
            return helper.screen(bytes(output), WIDTH, HEIGHT)

        def wait(condition, label, timeout=6):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                drain(.05)
                if condition():
                    return
            raise AssertionError((label, view(), output[-2500:].decode(errors='replace')))

        def users(body):
            return [message['content'] for message in body['messages'] if message['role'] == 'user']

        def requested(text):
            return any(users(body)[-1] == text for body in requests)

        def ready(text):
            wait(lambda: ('ANSWER_' + text).encode() in output and 'Ready' in view()['lines'][-2], 'ready ' + text)
            assert view()['lines'][HEIGHT - 4] == '› Ask Omni to do anything', view()

        def events():
            result = []
            for file in (Path(temp) / 'omni' / 'sessions').glob('*.jsonl'):
                for line in file.read_text().splitlines():
                    item = json.loads(line)
                    if item.get('t') == 'ev':
                        result.append(item.get('e', item.get('ev', item)))
            return result

        def turns():
            return len([event for event in events() if event.get('k') == 'turn/start'])

        try:
            wait(lambda: b'Ask Omni to do anything' in output, 'startup')
            assert b'\x1b[>1u' in output
            send('SLOW_QUEUE\r')
            wait(lambda: b'PARTIAL_SLOW_QUEUE' in output, 'stream begins')
            send('Q_ONE\t')
            state = view()
            assert '• Queued follow-up inputs' in state['lines'], state
            assert '  ↳ Q_ONE' in state['lines'], state
            assert '  ↑ edit last queued message' in state['lines'], state
            assert state['lines'][HEIGHT - 4] == '› Ask Omni to do anything', state
            assert not requested('Q_ONE'), requests
            send('Q_TWO\t')
            send(b'\x1b[A')
            assert '› Q_TWO' in view()['lines'], view()
            assert '  ↳ Q_TWO' not in view()['lines'], view()
            send(b'\x15Q_TWO_EDIT\t')
            state = view()
            assert state['lines'].index('  ↳ Q_ONE') < state['lines'].index('  ↳ Q_TWO_EDIT'), state
            assert not requested('Q_TWO_EDIT'), requests
            send('Q_THREE_ENTER\r')
            assert '  ↳ Q_THREE_ENTER' in view()['lines'], view()
            holds['SLOW_QUEUE'].set()
            ready('Q_THREE_ENTER')
            assert [users(body)[-1] for body in requests[:4]] == ['SLOW_QUEUE', 'Q_ONE', 'Q_TWO_EDIT', 'Q_THREE_ENTER'], requests
            assert not any('Q_TWO' in users(body) for body in requests), requests
            assert output.count('› [Queue] Q_ONE'.encode()) == 1
            assert '› [Queue] Q_TWO_EDIT'.encode() in output
            state = view()
            assert '• Queued follow-up inputs' not in state['history'] + state['lines'], state
            print('PASS queue: immediate list, FIFO, edit/requeue last item, no premature API calls')

            for initial, follow, key in [('SLOW_CREATE', 'STEER_CREATE', b'\x1b[13;9u'),
                                         ('SLOW_STREAM', 'STEER_STREAM', b'\x1b[13;5u'),
                                         ('SLOW_TOOL', 'STEER_TOOL', b'\x1b[27;5;13~')]:
                before = turns()
                send(initial + '\r')
                wait(lambda: requested(initial), 'request ' + initial)
                if initial == 'SLOW_STREAM':
                    wait(lambda: b'PARTIAL_SLOW_STREAM' in output, 'stream partial')
                if initial == 'SLOW_TOOL':
                    wait(lambda: b'Running sleep 1.2' in output, 'tool phase')
                send(follow.encode() + key)
                ready(follow)
                assert turns() == before + 1, (initial, before, turns(), events())
                assert ('› [Steer] ' + follow).encode() in output
                assert any(event.get('source') == 'interrupt' and event.get('text') == follow for event in events()), events()
                if initial in holds:
                    holds[initial].set()
                count_before_release = len(requests)
                send(b'\x1b[13;9:3u')
                assert len(requests) == count_before_release, requests
                body = next(body for body in reversed(requests) if users(body)[-1] == follow)
                pending_calls = set()
                for message in body['messages']:
                    if message['role'] == 'assistant':
                        pending_calls.update(call['id'] for call in message.get('tool_calls', []))
                    elif message['role'] == 'tool':
                        assert message['tool_call_id'] in pending_calls, body
                        pending_calls.remove(message['tool_call_id'])
                assert not pending_calls, body
                print('PASS steer same-turn:', initial)

            send('SLOW_MULTI\r')
            wait(lambda: b'PARTIAL_SLOW_MULTI' in output, 'multi steer start')
            send(b'STEER_A\x1b[13;9uSTEER_B\x1b[13;9u')
            ready('STEER_B')
            body = next(body for body in reversed(requests) if users(body)[-1] == 'STEER_B')
            assert users(body)[-2:] == ['STEER_A', 'STEER_B'], body
            assert output.count('› [Steer] STEER_A'.encode()) == 1
            assert output.count('› [Steer] STEER_B'.encode()) == 1
            holds['SLOW_MULTI'].set()
            print('PASS multiple steers: no overwrite or duplicate messages')

            send('CANCEL_ME\r')
            wait(lambda: b'PARTIAL_CANCEL_ME' in output, 'cancel start')
            send('AFTER_CANCEL_QUEUE\t')
            send(b'\x1b[27u')  # 增强键盘模式的 Esc 仍是取消。
            ready('AFTER_CANCEL_QUEUE')
            holds['CANCEL_ME'].set()
            print('PASS cancel then queue: fresh abort signal and queue retained')

            send('CANCEL_CTRL\r')
            wait(lambda: b'PARTIAL_CANCEL_CTRL' in output, 'Ctrl+C cancel start')
            send(b'\x1b[99;5u')
            wait(lambda: 'Ready' in view()['lines'][-2], 'Ctrl+C idle')
            holds['CANCEL_CTRL'].set()
            count = len(requests)
            send('/model\r')
            wait(lambda: b'Select Model' in output, 'CSI-u modal')
            send(b'\x1b[27u')
            wait(lambda: 'Ready' in view()['lines'][-2], 'CSI-u modal cancel')
            send('/mo\t')
            assert any(line.startswith('› /model') for line in view()['lines']), view()
            send(b'\x15@fixture_\t')
            assert any(line.startswith('› @fixture_unique.txt') for line in view()['lines']), view()
            assert len(requests) == count
            send(b'\x15/quit\r')
            assert b'\x1b[<u' in output
            print('PASS completion and protocol cleanup')
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

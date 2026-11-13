"""Console 真 PTY：审批/提问串行、排队和当前交互外部取消、stdin 恢复。"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix='omni-console-ui-') as temp:
        control = Path(temp) / 'control.json'
        control.write_text('{}')
        fixture = Path(temp) / 'fixture.mts'
        fixture.write_text('''import fs from 'node:fs';
import readline from 'node:readline/promises';
import { ConsoleOutput } from ''' + json.dumps(str(ROOT / 'src/output/console.ts')) + ''';
const out = new ConsoleOutput({stream:true,showThinking:false});
const primary = readline.createInterface({input:process.stdin,output:process.stdout});
out.attachInput(primary);
primary.write('draft');
const first = new AbortController(), queued = new AbortController(), fourth = new AbortController();
const timer = setInterval(() => {
 const state = JSON.parse(fs.readFileSync(''' + json.dumps(str(control)) + ''', 'utf8'));
 if (state.first) first.abort();
 if (state.queued) queued.abort();
 if (state.fourth) fourth.abort();
}, 20);
try {
 const a = out.requestApproval({tool:'FIRST_APPROVAL',summary:'first',reason:'approval first'},first.signal);
 const b = out.askUser('SECOND_QUESTION',['one','two'],false);
 const c = out.requestApproval({tool:'CANCELLED_QUEUED',summary:'queued',reason:'queued'},queued.signal);
 const d = out.askUser('FOURTH_QUESTION',['one','two'],false,fourth.signal);
 c.then(() => console.log('QUEUED_CANCEL_RESOLVED'));
 const results = await Promise.all([a,b,c,d]);
 const restored = {line:primary.line,raw:process.stdin.isRaw};
 const final = await out.askUser('FINAL_INPUT_ALIVE',['one','two'],false);
 primary.write(null,{ctrl:true,name:'u'});
 const next = await primary.question('PRIMARY_AFTER_CANCEL> ');
 console.log('VERDICT '+JSON.stringify({results,final,restored,next}));
} finally {clearInterval(timer);primary.close();process.stdin.pause();}
''')
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 90, 0, 0))
            env = dict(os.environ, NO_COLOR='1', XDG_CONFIG_HOME=temp, OMNI_LOCAL='1', OMNI_PET='off')
            os.chdir(temp)
            os.execvpe('node', ['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'), str(fixture)], env)
        output = bytearray()

        def update_control(state):
            pending = control.with_suffix('.new')
            pending.write_text(json.dumps(state))
            pending.replace(control)

        def drain(seconds=.1):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if not select.select([fd], [], [], .02)[0]:
                    continue
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                output.extend(chunk)

        def wait(marker):
            end = time.monotonic() + 8
            while marker.encode() not in output:
                assert time.monotonic() < end, f'等待 {marker} 超时: {output.decode("utf-8", "replace")}'
                drain()

        try:
            wait('FIRST_APPROVAL')
            assert b'SECOND_QUESTION' not in output, '审批与提问不应同时占用 stdin'
            os.write(fd, b'partial-approval')
            drain(.1)
            update_control({'queued': True})
            wait('QUEUED_CANCEL_RESOLVED')
            assert b'CANCELLED_QUEUED' not in output, '排队取消的交互不应显示'
            update_control({'queued': True, 'first': True})
            wait('SECOND_QUESTION')
            os.write(fd, b'2\r')
            wait('FOURTH_QUESTION')
            os.write(fd, b'partial-ask')
            drain(.1)
            update_control({'queued': True, 'first': True, 'fourth': True})
            wait('FINAL_INPUT_ALIVE')
            os.write(fd, b'1\r')
            wait('PRIMARY_AFTER_CANCEL> ')
            os.write(fd, b'hello\r')
            wait('VERDICT ')
            drain(.1)
            text = output.decode('utf-8', 'replace')
            verdict = json.loads(text.split('VERDICT ', 1)[1].splitlines()[0])
            assert verdict['results'][0] is False
            assert verdict['results'][1]['choices'] == ['two']
            assert verdict['results'][2] is False
            assert verdict['results'][3] is None
            assert verdict['final']['choices'] == ['one']
            assert verdict['restored'] == {'line': 'draft', 'raw': True}, verdict
            assert verdict['next'] == 'hello', '取消问答的半截输入不能进入主输入'
            end = time.monotonic() + 4
            while time.monotonic() < end:
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    assert os.waitstatus_to_exitcode(status) == 0
                    pid = None
                    break
                drain()
            assert pid is None, '交互结束后进程必须能退出'
            print('Console PTY: serialized approval/ask, queued/current cancel, primary draft/raw mode and stdin recovery passed')
        finally:
            if pid:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except ProcessLookupError:
                    pass
            os.close(fd)


if __name__ == '__main__':
    main()

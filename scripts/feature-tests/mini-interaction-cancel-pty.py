"""mini 审批/提问取消真 PTY：独立信号、跨类型队列、自定义输入与草稿恢复。"""
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


def main():
    with tempfile.TemporaryDirectory(prefix='mini-cancel-') as temp:
        os.environ.update(OMNI_FT_ROOT=str(ROOT), OMNI_FT_XDG=temp, OMNI_FT_PORT='1', OMNI_FT_LOG=temp + '/log')
        spec = importlib.util.spec_from_file_location('screen_helper', Path(__file__).with_name('slash-cancel-pty.py'))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        driver = Path(temp) / 'driver.ts'
        driver.write_text('''
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { createInterface } from 'node:readline';
import { getEventListeners } from 'node:events';
import { MiniOutput } from %s;
const output = new MiniOutput({stream:true,showThinking:false});
const main = readline.createInterface({input:process.stdin,output:process.stdout,prompt:'› '});
output.markInteractive();
output.setComposerStatus(()=>({model:'model-a',plan:false}));
output.attachInput(main);
main.prompt(true);
const control = createInterface({input:fs.createReadStream('',{fd:Number(process.env.CANCEL_CONTROL_FD)})});
const controllers = new Map<string,AbortController>();
const emit = (value:any)=>fs.writeSync(Number(process.env.CANCEL_RESULT_FD),JSON.stringify(value)+'\\n');
const count = ()=>({draft:main.line,keys:process.stdin.listenerCount('keypress'),resize:process.stdout.listenerCount('resize'),raw:process.stdin.isRaw});
main.on('line',text=>{emit({message:text,submitted:!(output as any).swallowQaLine?.(text)});main.prompt(true);});
const baseline = count();
emit({ready:true,...baseline});
control.on('line',line=>{
 const command=JSON.parse(line);
 if(command.action==='cancel'){controllers.get(command.id)?.abort();return;}
 if(command.action==='inspect'){emit({inspect:true,...count()});return;}
 if(command.action==='turn'){output.onTurnStart();output.repaintInput();return;}
 if(command.action==='endTurn'){output.onTurnEnd();return;}
 if(command.action==='exit'){output.onTurnEnd();main.close();emit({exit:true,...count()});control.close();process.exit(0);}
 const controller=new AbortController();controllers.set(command.id,controller);
 if(command.aborted)controller.abort();
 const promise=command.action==='approval'
  ? output.requestApproval({tool:'run_command',summary:command.id,reason:'Cancellation test'},controller.signal)
  : output.askUser(command.id,command.custom?[]:['Option A','Option B'],false,controller.signal);
 promise.then(result=>setImmediate(()=>emit({id:command.id,result,abortListeners:getEventListeners(controller.signal,'abort').length,...count()})));
});
''' % json.dumps(str(ROOT / 'src/output/mini.ts')))
        control_read, control_write = os.pipe()
        result_read, result_write = os.pipe()
        os.set_inheritable(control_read, True)
        os.set_inheritable(result_write, True)
        pid, fd = pty.fork()
        if pid == 0:
            os.close(control_write)
            os.close(result_read)
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
            env = dict(os.environ, CANCEL_CONTROL_FD=str(control_read), CANCEL_RESULT_FD=str(result_write), FORCE_COLOR='1', COLORFGBG='0;15', OMNI_PET='off')
            os.execvpe('node', ['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'), str(driver)], env)
        os.close(control_read)
        os.close(result_write)
        data = bytearray()
        pending = b''
        events = []
        snapshots = {}

        def drain(seconds=.2):
            nonlocal pending
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                ready = select.select([fd, result_read], [], [], .02)[0]
                for source in ready:
                    try:
                        chunk = os.read(source, 65536)
                    except OSError:
                        continue
                    if source == fd:
                        data.extend(chunk)
                    else:
                        pending += chunk
                        while b'\n' in pending:
                            raw, pending = pending.split(b'\n', 1)
                            events.append(json.loads(raw))

        def view():
            return helper.screen(bytes(data), 80, 24)

        def wait(predicate, label):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                drain()
                if predicate():
                    return
            raise AssertionError((label, view(), events, bytes(data[-1800:])))

        def control(command):
            os.write(control_write, (json.dumps(command) + '\n').encode())
            drain()

        def event(id):
            return next((item for item in events if item.get('id') == id), None)

        def visible(text):
            return any(text in line for line in view()['lines'])

        try:
            wait(lambda: any(item.get('ready') for item in events), 'startup')
            baseline = next(item for item in events if item.get('ready'))
            os.write(fd, b'saved draft')
            drain()
            control({'action': 'turn'})
            assert b'\x1b[38;2;109;40;217mWorking' in data, ('Working must use light-terminal dark purple', bytes(data[-600:]))
            control({'action': 'ask', 'id': 'ASK_ONE'})
            wait(lambda: visible('ASK_ONE'), 'first question')
            control({'action': 'approval', 'id': 'QUEUED_APPROVAL'})
            assert not visible('QUEUED_APPROVAL'), ('cross-type queue must not overlap', view())
            control({'action': 'ask', 'id': 'ASK_THREE'})
            control({'action': 'cancel', 'id': 'QUEUED_APPROVAL'})
            wait(lambda: event('QUEUED_APPROVAL') is not None, 'queued cancellation returns immediately')
            assert event('QUEUED_APPROVAL')['result'] is False
            assert visible('ASK_ONE') and not visible('ASK_THREE')
            snapshots['queued-cancel'] = view()
            control({'action': 'cancel', 'id': 'ASK_ONE'})
            wait(lambda: visible('ASK_THREE'), 'following question survives')
            assert event('ASK_ONE')['result'] is None
            os.write(fd, b'\x1b[B\r')
            wait(lambda: event('ASK_THREE') is not None and visible('› saved draft'), 'choice and original draft restore')
            assert event('ASK_THREE')['result']['choice'] == 'Option B'
            snapshots['ask-restored'] = view()
            control({'action': 'approval', 'id': 'ACTIVE_APPROVAL'})
            wait(lambda: visible('ACTIVE_APPROVAL') and visible('拒绝'), 'active approval')
            control({'action': 'cancel', 'id': 'ACTIVE_APPROVAL'})
            wait(lambda: event('ACTIVE_APPROVAL') is not None and visible('› saved draft'), 'active approval cancel restore')
            assert event('ACTIVE_APPROVAL')['result'] is False
            control({'action': 'endTurn'})
            control({'action': 'ask', 'id': 'CUSTOM_ASK', 'custom': True})
            wait(lambda: visible('输入自定义回答'), 'custom question')
            os.write(fd, b'custom scratch')
            drain()
            control({'action': 'cancel', 'id': 'CUSTOM_ASK'})
            wait(lambda: event('CUSTOM_ASK') is not None and visible('› saved draft'), 'custom cancellation restores original draft')
            assert event('CUSTOM_ASK')['result'] is None
            snapshots['custom-restored'] = view()
            control({'action': 'ask', 'id': 'CUSTOM_ACCEPT', 'custom': True})
            wait(lambda: visible('CUSTOM_ACCEPT'), 'custom question for accepted answer')
            os.write(fd, b'answer\r')
            wait(lambda: event('CUSTOM_ACCEPT') is not None and visible('› saved draft'), 'custom answer preserves existing main draft')
            assert event('CUSTOM_ACCEPT')['result']['choice'] == 'answer'
            assert event('CUSTOM_ACCEPT')['draft'] == 'saved draft'
            assert not any(item.get('message') == 'answer' for item in events), ('custom answer must not leak into main readline', events)
            assert event('CUSTOM_ACCEPT')['raw'] == baseline['raw'], ('custom completion must restore raw mode', events)
            os.write(fd, b'\x15answer\r')
            wait(lambda: any(item.get('message') == 'answer' for item in events), 'same text reaches next normal submission')
            assert next(item for item in events if item.get('message') == 'answer')['submitted'], ('later normal message must not be swallowed', events)
            os.write(fd, b'saved draft')
            drain()
            snapshots['custom-accepted-and-repeated'] = view()
            control({'action': 'ask', 'id': 'PRE_ABORTED', 'aborted': True})
            wait(lambda: event('PRE_ABORTED') is not None, 'pre-aborted request')
            assert event('PRE_ABORTED')['result'] is None and not visible('PRE_ABORTED')
            control({'action': 'inspect'})
            state = next(item for item in reversed(events) if item.get('inspect'))
            assert state['draft'] == 'saved draft'
            assert state['raw'] == baseline['raw']
            assert state['keys'] == baseline['keys'] and state['resize'] == baseline['resize'], (baseline, state)
            assert all(item.get('abortListeners', 0) == 0 for item in events if 'id' in item), events
            control({'action': 'exit'})
            exit_state = next(item for item in events if item.get('exit'))
            assert exit_state['raw'] is False and exit_state['keys'] == 0 and exit_state['resize'] == 0, exit_state
            _, status = os.waitpid(pid, 0)
            pid = None
            assert os.waitstatus_to_exitcode(status) == 0
            print('PASS mini cancellation: cross-type queue, independent queued/current abort, custom draft/raw restore, accepted answer repeat, pre-aborted skip, listener cleanup')
        finally:
            artifact = os.environ.get('OMNI_FT_ARTIFACT_DIR')
            if artifact:
                target = Path(artifact)
                target.mkdir(parents=True, exist_ok=True)
                (target / 'cancel.log').write_bytes(data)
                (target / 'cancel.json').write_text(json.dumps({'events': events, 'snapshots': snapshots}, ensure_ascii=False, indent=2))
            if pid is not None:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except ProcessLookupError:
                    pass
            os.close(fd)
            os.close(control_write)
            os.close(result_read)


if __name__ == '__main__':
    main()

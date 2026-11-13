/** 真实 Electron DOM 验证播放器；无需 API key，不连接用户 broker。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-pet-player-'));
  app.setPath('userData', temp);
  app.whenReady().then(async () => {
    let win;
    try {
      win = new BrowserWindow({ width: 900, height: 620, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
      const html = `<html><head><style>${fs.readFileSync(path.join(ROOT, 'web/pet.css'), 'utf8')}</style></head><body style="background:#f4f3fa"><div id="host"></div></body></html>`;
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      win.showInactive();
      await win.webContents.executeJavaScript(`
        window.qaNow=Date.now();Date.now=()=>qaNow;
        window.qaActions=[];window.qaSnapshot={tasks:[],settings:{enabled:true,selected:'omni'},pets:[{id:'omni',url:''}]};
        window.qaUpdate=null;window.qaPointer=null;
        window.omniPet={info:async()=>qaSnapshot,action:async(action,input)=>qaActions.push({action,input}),onUpdate:fn=>(qaUpdate=fn,()=>qaUpdate=null),onPointer:fn=>(qaPointer=fn,()=>qaPointer=null)};
        void 0;
      `);
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT, 'web/pet.js'), 'utf8'));
      await win.webContents.executeJavaScript(`window.qaPet=OmniPet.mount(document.getElementById('host'),{desktop:true});void 0;`);
      const run = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`);
      const state = () => run(`const r=document.querySelector('.omni-pet'),s=document.querySelector('.pet-sprite');return {phase:r.dataset.phase,attention:r.dataset.attention,row:s.dataset.row,frame:s.dataset.frame,look:r.style.getPropertyValue('--pet-look-x'),classes:r.className,actions:qaActions};`);
      const send = async task => run(`qaSnapshot.tasks=${JSON.stringify(task ? [task] : [])};qaUpdate(qaSnapshot);`);
      const task = (phase, id='one') => ({ sessionId:id,title:'播放器验收',phase,pending:phase==='needs-input'?1:0,running:['thinking','working','answering','needs-input'].includes(phase),unread:['ready','blocked'].includes(phase),revision:1,updatedAt:1 });
      let count=0;const check=(name,ok)=>{assert.ok(ok,name);console.log('✓ '+name);count++;};
      const artifacts=path.join(ROOT,'.omni/pet-qa/round2');fs.mkdirSync(artifacts,{recursive:true});
      await run('await qaPet.refresh();');
      check('空闲启用受控桌面注视',(await state()).actions.some(x=>x.action==='watch-pointer'&&x.input.enabled));
      await run('qaPointer({x:700,y:80});await new Promise(requestAnimationFrame);');
      check('原创小猫向鼠标方向移动目光',parseFloat((await state()).look)>0);
      await send(task('working'));
      check('工具阶段立即停止空闲注视',(await state()).look==='0px'&&(await state()).actions.at(-1).input.enabled===false);
      await send(task('ready'));
      check('完成时短暂庆祝',(await state()).attention==='active');
      await run('qaNow+=2300;await qaPet.refresh();');
      check('完成后保持未读标记并安静陪伴',(await state()).phase==='ready'&&(await state()).attention==='quiet');
      await run('await qaPet.refresh();');
      check('相同快照不重播庆祝',(await state()).attention==='quiet');
      await send(task('ready','two'));await send(task('ready'));
      check('任务往返不反复庆祝',(await state()).attention==='quiet');
      await run(`qaSnapshot.tasks=${JSON.stringify([task('working'),task('needs-input','two')])};qaUpdate(qaSnapshot);`);
      await send(task('ready'));
      check('未跟随会话的新一轮完成仍会提醒',(await state()).attention==='active');
      await send(task('needs-input'));
      await run('qaNow+=2300;await qaPet.refresh();');
      check('等待审批静置但保留真实状态',(await state()).phase==='needs-input'&&(await state()).attention==='quiet');
      await run('qaNow+=28000;await qaPet.refresh();');
      check('等待审批 30 秒后短暂提醒',(await state()).attention==='active');
      await run('qaSnapshot.tasks[0].pending=2;qaNow+=2400;await qaPet.refresh();');
      check('新增待处理事项重新提醒',(await state()).attention==='active');
      await send(task('blocked'));await run('qaNow+=2300;await qaPet.refresh();');
      check('失败提示静置后保留',(await state()).phase==='blocked'&&(await state()).attention==='quiet');
      await run('qaNow+=58000;await qaPet.refresh();');
      check('失败按 60 秒节奏提醒',(await state()).attention==='active');
      await send(null);
      await run(`qaSnapshot.pets.push({id:'omni-dog',name:'Omni 小狗',url:''});qaSnapshot.settings.selected='omni-dog';qaUpdate(qaSnapshot);`);
      check('小狗使用独立 SVG 造型并保留注视组件',await run(`return document.querySelector('.omni-pet').dataset.kind==='dog'&&!!document.querySelector('.pet-ear')&&!!document.querySelector('.pet-gaze');`));
      for(const p of ['thinking','working','answering','needs-input','ready','blocked']){
        await send(task(p));assert.equal((await state()).phase,p);
      }
      check('小狗与猫共用完整任务状态',true);
      await send(null);await run('qaPointer({x:700,y:80});await new Promise(requestAnimationFrame);');
      fs.writeFileSync(path.join(artifacts,'dog-look.png'),(await win.webContents.capturePage()).toPNG());
      await run(`qaSnapshot.settings.selected='omni';qaUpdate(qaSnapshot);`);
      check('猫狗切换恢复对应造型',await run(`return document.querySelector('.omni-pet').dataset.kind==='cat'&&!document.querySelector('.pet-ear');`));
      // 每格用编号验证 16 向定位，不分发第三方形象。
      await run(`const c=document.createElement('canvas');c.width=1536;c.height=2288;const ctx=c.getContext('2d');for(let r=0;r<11;r++)for(let f=0;f<8;f++){ctx.fillStyle='#b6a7ea';ctx.fillRect(f*192+40,r*208+20,112,160);ctx.fillStyle='#353851';ctx.font='24px sans-serif';ctx.fillText(r+':'+f,f*192+60,r*208+95);}qaSnapshot.pets.push({id:'test-v2',rows:11,url:c.toDataURL()});qaSnapshot.settings.selected='test-v2';qaUpdate(qaSnapshot);`);
      for(let i=0;i<16;i++){
        const result=await run(`const b=document.querySelector('.pet-figure').getBoundingClientRect(),a=${i}*Math.PI/8;qaPointer({x:b.x+b.width/2+Math.sin(a)*300,y:b.y+b.height*.43-Math.cos(a)*300});await new Promise(requestAnimationFrame);const s=document.querySelector('.pet-sprite');return [Number(s.dataset.row),Number(s.dataset.frame)];`);
        assert.deepEqual(result,[9+Math.floor(i/8),i%8],`方向 ${i}`);
      }
      check('v2 16 个方向逐格正确',true);
      await run('await new Promise(r=>setTimeout(r,2300));');
      check('鼠标静止后恢复空闲呼吸',(await state()).row==='0');
      await run(`qaSnapshot.pets.find(p=>p.id==='test-v2').rows=9;qaUpdate(qaSnapshot);qaPointer({x:700,y:80});await new Promise(requestAnimationFrame);`);
      check('v1 不使用额外方向帧',(await state()).row==='0');
      await send(task('working'));
      check('导入形象工具动作优先',(await state()).row==='7');
      await send(task('ready'));await run('qaNow+=2300;await qaPet.refresh();');
      check('导入形象完成后停在完成帧',(await state()).row==='8'&&(await state()).frame==='5');
      // 真实鼠标事件覆盖拖动与 click 抑制；窗口移动在 main.test 中另行校验。
      await send(null);
      await run(`qaSnapshot.settings.selected='omni';qaUpdate(qaSnapshot);`);
      app.focus({ steal: true }); win.focus();
      await new Promise(r=>setTimeout(r,100));
      const point=await run(`const b=document.querySelector('.pet-figure').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height*.46)};`);
      let mouseHeld=false;
      const sendMouse=(type,x,y)=>{if(type==='mouseDown')mouseHeld=true;if(type==='mouseUp')mouseHeld=false;const b=win.getBounds();win.webContents.sendInputEvent({type,x,y,globalX:b.x+x,globalY:b.y+y,button:'left',clickCount:1,modifiers:mouseHeld?['leftbuttondown']:[]});};
      sendMouse('mouseMove',point.x,point.y);
      await new Promise(r=>setTimeout(r,40));
      sendMouse('mouseDown',point.x,point.y);
      await new Promise(r=>setTimeout(r,40));
      sendMouse('mouseMove',point.x+20,point.y+10);
      await new Promise(r=>setTimeout(r,80));
      check('实际指针拖动显示携带反馈',(await state()).classes.includes('pet-dragging'));
      sendMouse('mouseUp',point.x+20,point.y+10);
      await new Promise(r=>setTimeout(r,80));
      const dragged=await state();
      check('拖动释放保存位置且不误开对话',dragged.actions.some(x=>x.action==='position')&&!dragged.actions.some(x=>x.action==='chat'));
      await run('qaNow+=300;document.querySelector(".pet-figure").click();');
      check('普通点击保留打开对话并短暂回应',(await state()).actions.some(x=>x.action==='chat')&&(await state()).classes.includes('pet-touched'));
      await send(task('working'));
      check('任务开始立即撤下装饰互动',!(await state()).classes.includes('pet-touched'));
      await send(null);await run('qaPointer({x:700,y:80});await new Promise(requestAnimationFrame);');
      fs.writeFileSync(path.join(artifacts,'original-look.png'),(await win.webContents.capturePage()).toPNG());
      await run(`qaSnapshot.settings.selected='test-v2';qaSnapshot.pets.find(p=>p.id==='test-v2').rows=11;qaUpdate(qaSnapshot);qaPointer({x:700,y:80});await new Promise(requestAnimationFrame);`);
      fs.writeFileSync(path.join(artifacts,'v2-look.png'),(await win.webContents.capturePage()).toPNG());
      win.hide();await new Promise(r=>setTimeout(r,100));
      const hiddenFrame=(await state()).frame;
      await new Promise(r=>setTimeout(r,350));
      check('原生隐藏时暂停帧与指针采样',(await state()).frame===hiddenFrame&&(await state()).classes.includes('pet-paused')&&(await state()).actions.at(-1).input.enabled===false);
      win.showInactive();await new Promise(r=>setTimeout(r,100));
      check('再次显示恢复空闲注视',(await state()).actions.at(-1).input.enabled===true);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await new Promise(r=>setTimeout(r,100));
      const reducedFrame=(await state()).frame;
      await new Promise(r=>setTimeout(r,350));
      check('减少动态效果停用注视和精灵动画',(await state()).frame===reducedFrame&&(await state()).actions.at(-1).input.enabled===false&&await run('return getComputedStyle(document.querySelector(".pet-body")).animationName==="none";'));
      await run('qaPet.destroy();');
      check('销毁释放指针订阅和播放器',await run('return qaUpdate===null&&qaPointer===null&&!document.querySelector(".omni-pet")&&qaActions.at(-1).input.enabled===false;'));
      await run(`window.fetch=async()=>({ok:true,json:async()=>qaSnapshot});qaPet=OmniPet.mount(document.getElementById('host'));await qaPet.refresh();`);
      win.setContentSize(390,844);await new Promise(r=>setTimeout(r,100));
      check('390px 窄屏保持标题栏内且不遮挡输入',await run(`const r=document.querySelector('.omni-pet').getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.height===40&&getComputedStyle(document.querySelector('.pet-controls')).display==='none';`));
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-color-scheme',value:'dark'}]});
      await new Promise(r=>setTimeout(r,100));
      fs.writeFileSync(path.join(artifacts,'mobile-dark.png'),(await win.webContents.capturePage()).toPNG());
      await run('qaSnapshot.settings.enabled=false;await qaPet.refresh();');
      check('页面关闭宠物后暂停播放器',await run(`return document.querySelector('.omni-pet').hidden&&document.querySelector('.omni-pet').classList.contains('pet-paused');`));
      await run('qaPet.destroy();');
      win.webContents.debugger.detach();
      console.log(`宠物播放器真实 DOM 验收通过 ${count} 项。截图：.omni/pet-qa/round2/`);
    } finally {
      win?.destroy(); app.quit(); fs.rmSync(temp,{recursive:true,force:true});
    }
  }).catch(error=>{console.error(error);app.exit(1);});
}

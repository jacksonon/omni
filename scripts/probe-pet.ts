/** 真 broker / 两个工作区 / 独立 CLI 的离线宠物验收。--keep 保留 UI 检查环境。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ensureSharedServer } from '../src/server/manager.js';
import { ServerClient } from '../src/server/client.js';
import { selectPetTask, type PetTask } from '../src/pet/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'omni-pet-qa-')));
const keep = process.argv.includes('--keep');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let count = 0;
function check(label: string, condition: unknown) { assert.ok(condition, label); count++; console.log(`✓ ${label}`); }
async function until<T>(fn: () => Promise<T | undefined | false>, label: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value as T; if (Date.now() > end) throw new Error('超时：' + label); await sleep(35); }
}
async function port() { const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p; }
function spritePng(height: number): Buffer {
  function chunk(type: string, data: Buffer) {
    const name=Buffer.from(type), raw=Buffer.concat([name,data]);let crc=0xffffffff;
    for(const byte of raw){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);raw.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(1536);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((1536*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
async function main() {
  const mockPort=await port(), xdg=path.join(TEMP,'config'), runtime=path.join(TEMP,'runtime');
  const aDir=path.join(TEMP,'project-a'), bDir=path.join(TEMP,'project-b');
  for(const dir of [xdg,runtime,aDir,bDir])mkdirSync(dir);
  Object.assign(process.env,{XDG_CONFIG_HOME:xdg,OMNI_SERVER_RUNTIME_DIR:runtime,OMNI_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,OMNI_API_KEY:'sk-mock-only',OMNI_MODEL:'mock-model'});
  for(const key of ['OMNI_CONFIG','OMNI_WEB_TOKEN','OMNI_WEB_WORKSPACE','OMNI_INTERNAL_WORKER','OMNI_LOCAL'])delete process.env[key];
  const config={autoMemory:false,agentsFile:false,repoMap:false,auditLog:false,providers:{mock:{baseURL:process.env.OMNI_BASE_URL,apiKey:'sk-mock-only',models:{'mock-model':{}}}}};
  for(const dir of [aDir,bDir])writeFileSync(path.join(dir,'omni.json'),JSON.stringify(config));
  const {addTrustedWorkspace}=await import('../src/safety/trust.js');addTrustedWorkspace(TEMP);
  const mock=spawn(process.execPath,[path.join(ROOT,'scripts/mock-server.mjs')],{env:{...process.env,PORT:String(mockPort)},stdio:'ignore'});
  let connection: Awaited<ReturnType<typeof ensureSharedServer>> | undefined;
  let eventAbort = new AbortController();
  const mockConfig=async(body:unknown)=>{const r=await fetch(`http://127.0.0.1:${mockPort}/__mock/config`,{method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200);};
  try {
    await until(async()=>{try{await mockConfig({});return true;}catch{return false;}},'mock ready');
    const command={executable:process.execPath,args:['--import',createRequire(import.meta.url).resolve('tsx'),path.join(ROOT,'src/index.ts')]};
    connection=await ensureSharedServer({cwd:aDir,port:0,command});
    const b=await ensureSharedServer({cwd:bDir,command});
    const a=new ServerClient(connection), cb=new ServerClient(b);
    const auth={authorization:`Bearer ${connection.token}`,'content-type':'application/json'};
    const aggregate=async()=>await(await fetch(connection!.serverUrl+'/_omni/pet',{headers:auth})).json() as {tasks:PetTask[]};
    const snapshot=async()=>a.request<{tasks:PetTask[];settings:{selected:string};pets:any[]}>('/api/pet');
    check('未认证宠物聚合接口拒绝访问',(await fetch(connection.serverUrl+'/_omni/pet')).status===401);
    const stream=await fetch(connection.serverUrl+'/_omni/pet/events',{headers:auth,signal:eventAbort.signal});
    const reader=stream.body!.getReader(); await reader.read();
    const s=await a.createSession({permission:'ask',showThinking:false,autoTitle:false});
    await mockConfig({slow:true});
    await a.request(`/api/sessions/${s.id}/messages`,{text:'宠物联动：等待审批'});
    const thinking=await until(async()=>{const t=(await snapshot()).tasks.find(t=>t.sessionId===s.id);return t?.phase==='thinking'?t:false;},'thinking without text');
    check('关闭思考正文仍有请求准备状态',thinking.running);
    const pending=await until(async()=>{const p=await a.request<{approvals:any[]}>('/api/pending');return p.approvals.find(x=>x.sessionId===s.id);},'approval');
    check('思考显示关闭仍有 needs-input 状态',(await snapshot()).tasks.find(t=>t.sessionId===s.id)?.phase==='needs-input');
    check('聚合任务带正确工作区与会话地址',(await aggregate()).tasks.some(t=>t.sessionId===s.id&&t.url===connection!.url&&t.cwd===aDir));
    const update=await Promise.race([reader.read(),sleep(3000).then(()=>{throw new Error('未收到宠物实时事件');})]);
    check('broker 推送跨端宠物状态变化',new TextDecoder().decode(update.value).includes('pet.changed'));eventAbort.abort();
    await a.request(`/api/sessions/${s.id}/approval`,{approvalId:pending.approvalId,allow:true});
    const done=await until(async()=>{const t=(await snapshot()).tasks.find(t=>t.sessionId===s.id);return t?.phase==='ready'?t:false;},'done');
    check('审批解决后完整工具与回答流程完成',done.unread===true&&!done.running);
    await a.request('/api/pet/read',{sessionId:s.id,revision:done.revision});
    check('明确读取完成水位清除未读',(await snapshot()).tasks.find(t=>t.sessionId===s.id)?.unread===false);
    await mockConfig({slow:false});
    const sb=await cb.createSession({permission:'ask',autoTitle:false});
    await cb.request(`/api/sessions/${sb.id}/messages`,{text:'另一个目录的任务'});
    await until(async()=>{const t=(await aggregate()).tasks.find(t=>t.sessionId===sb.id);return t?.phase==='needs-input'?t:false;},'workspace b');
    check('自动跟随优先其它工作区待处理任务',selectPetTask((await aggregate()).tasks)?.sessionId===sb.id);
    await cb.request(`/api/sessions/${sb.id}/cancel`,{});
    await until(async()=>{const t=(await aggregate()).tasks.find(t=>t.sessionId===sb.id);return t?.phase==='idle'&&!t.running?t:false;},'cancel');
    check('取消不会误报任务完成',true);
    await mockConfig({ask:true});
    const ask=await a.createSession({permission:'full',autoTitle:false});
    await a.request(`/api/sessions/${ask.id}/messages`,{text:'宠物联动：需要用户回答'});
    const question=await until(async()=>{const p=await a.request<{asks:any[]}>('/api/pending');return p.asks.find(x=>x.sessionId===ask.id);},'ask');
    check('提问对应 needs-input',(await snapshot()).tasks.find(t=>t.sessionId===ask.id)?.phase==='needs-input');
    await a.request(`/api/sessions/${ask.id}/ask`,{askId:question.askId,choices:[question.options[0]]});
    await until(async()=>{const t=(await snapshot()).tasks.find(t=>t.sessionId===ask.id);return t?.phase==='ready'?t:false;},'ask done');
    const reconnect=await a.request<{pet:{tasks:PetTask[]}}>('/api/snapshot');
    check('重连快照恢复完成和未读状态',reconnect.pet.tasks.some(t=>t.sessionId===ask.id&&t.phase==='ready'&&t.unread));
    await mockConfig({ask:false});
    const limited=await a.createSession({permission:'full',maxSteps:1,autoTitle:false});
    await a.request(`/api/sessions/${limited.id}/messages`,{text:'运行到步数上限'});
    const blocked=await until(async()=>{const t=(await snapshot()).tasks.find(t=>t.sessionId===limited.id);return t?.phase==='blocked'?t:false;},'max steps');
    check('步数上限对应 blocked 而非成功',blocked.unread&&!blocked.running);
    await mockConfig({ask:false,slow:true});
    const child=spawn(process.execPath,[...command.args,'--local','exec','独立 CLI 宠物联动','--output-format','json'],{cwd:aDir,env:{...process.env},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=String(x));child.stderr.on('data',x=>stderr+=String(x));
    const ended=new Promise<number|null>(resolve=>child.on('close',resolve));
    const local=await until(async()=>{const t=(await aggregate()).tasks.find(t=>t.source==='local'&&t.running);return t||false;},'local presence');
    check('--local 保持独立执行并广播宠物阶段',local.cwd===aDir&&local.phase==='thinking');
    assert.equal(await ended,0,stderr);
    check('headless stdout 仍为单一合法 JSON',typeof JSON.parse(stdout).result==='string');
    await until(async()=>{const t=(await aggregate()).tasks.find(t=>t.sessionId===local.sessionId);return t?.phase==='ready'?t:false;},'local ready');
    check('独立 CLI 结束更新宠物完成状态',true);
    await mockConfig({slow:false});
    check('拒绝脚本或非法网格图像',(await fetch(connection.url+'/api/pet/import',{method:'POST',headers:auth,body:JSON.stringify({dataUrl:'data:image/png;base64,YWJj'})})).status===400);
    for(const h of [1872,2288]){
      const png=spritePng(h), uploaded=await a.request<{id:string;url:string;rows:number}>('/api/pet/import',{name:'测试精灵图',dataUrl:'data:image/png;base64,'+png.toString('base64')});
      check(`合法 PNG v${h===1872?1:2} 导入`,uploaded.rows===h/208);
      await a.request('/api/pet/settings',{selected:uploaded.id});
      check('选用图像并通过认证资源地址读取',(await snapshot()).settings.selected===uploaded.id&&(await fetch(connection.url+uploaded.url,{headers:auth})).headers.get('content-type')==='image/png');
      const removed=await fetch(connection.url+uploaded.url,{method:'DELETE',headers:auth});
      check('删除选用形象后回退原创小猫',removed.ok&&(await snapshot()).settings.selected==='omni');
    }
    for(const resource of ['pet.html','pet.css','pet.js'])check('分发宠物资源 '+resource,(await fetch(connection.url+'/'+resource,{headers:auth})).status===200);
    const statusChild=spawn(process.execPath,[...command.args,'pet','status'],{cwd:aDir,env:{...process.env},stdio:['ignore','pipe','pipe']});
    let statusText='';statusChild.stdout.on('data',x=>statusText+=String(x));
    assert.equal(await new Promise(resolve=>statusChild.on('close',resolve)),0);
    check('CLI pet status 读取同一任务',JSON.parse(statusText).tasks.some((t:PetTask)=>t.sessionId===s.id));
    console.log(`宠物探针通过 ${count} 项。`);
    if(keep){
      writeFileSync('/tmp/omni-pet-qa.json',JSON.stringify({temp:TEMP,xdg,runtime,aDir,bDir,mockPort,connection,sessionId:s.id},null,2));
      console.log('UI 验收环境已保留；连接信息存于 /tmp/omni-pet-qa.json。');
      await new Promise(()=>{});
    }
  } finally {
    eventAbort.abort();
    if(connection)await fetch(connection.serverUrl+'/_omni/shutdown',{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:'{"force":true}'}).catch(()=>{});
    mock.kill();rmSync(TEMP,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

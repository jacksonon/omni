/** 同一播放器服务 Web/Electron/bot。所有动态文本使用 textContent。 */
(() => {
  'use strict';
  const LABELS = {idle:'陪你一起工作',thinking:'思考中',working:'执行工具',answering:'正在回答','needs-input':'需要你处理',ready:'完成，点击查看',blocked:'任务遇到问题',disconnected:'服务未连接'};
  const RANK = {'needs-input':6,blocked:5,ready:4,working:3,answering:3,thinking:3,idle:0};
  const TRACKS = {idle:[0,6,280],thinking:[7,6,180],working:[7,6,150],answering:[3,4,180],'needs-input':[6,6,200],ready:[8,6,200],blocked:[5,8,180],disconnected:[0,1,300]};
  const CAT = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="100" cy="175" rx="46" ry="8" fill="#4e537c" opacity=".12"/>
    <g class="pet-body" stroke="#45435d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path class="pet-tail" d="M144 143C181 149 184 119 167 117C156 116 158 133 166 130" fill="none" stroke="#b5adf8" stroke-width="15"/>
      <path d="M59 134C60 114 138 114 141 134L144 160C144 179 124 175 100 175S56 180 56 160Z" fill="#c6bdfa"/>
      <ellipse cx="77" cy="171" rx="18" ry="8" fill="#faf6ff"/><ellipse cx="123" cy="171" rx="18" ry="8" fill="#faf6ff"/>
      <ellipse cx="100" cy="144" rx="24" ry="23" fill="#f5f1ff" stroke="none"/>
      <path d="M52 72L49 30Q50 19 61 28L83 48M117 48L139 28Q150 19 151 30L149 72" fill="#c6bdfa"/>
      <path d="M59 54L58 36L72 47M128 47L142 36L141 54" stroke="#edb9d5" stroke-width="7"/>
      <path d="M48 80Q46 49 79 47L121 47Q154 49 152 80L151 101Q149 127 100 127Q51 127 49 101Z" fill="#ded7ff"/>
      <path d="M89 48L94 60M101 47L103 59M114 48L111 60" stroke="#a798de"/>
      <ellipse cx="63" cy="100" rx="9" ry="5" fill="#efaed0" stroke="none"/><ellipse cx="137" cy="100" rx="9" ry="5" fill="#efaed0" stroke="none"/>
      <g class="pet-eyes" fill="#45435d" stroke="none"><ellipse cx="77" cy="84" rx="8" ry="11"/><ellipse cx="123" cy="84" rx="8" ry="11"/><circle cx="80" cy="80" r="3" fill="white"/><circle cx="126" cy="80" r="3" fill="white"/></g>
      <path d="M95 98Q100 94 105 98L100 102Z" fill="#ae86bc" stroke="none"/>
      <path class="pet-mouth" d="M100 102Q97 110 91 105M100 102Q103 110 109 105" fill="none" stroke-width="2"/>
      <ellipse class="pet-mouth-talk" cx="100" cy="108" rx="5" ry="6" fill="#b26999" stroke="none"/>
      <path d="M60 98L43 95M60 104L44 108M140 98L157 95M140 104L156 108" fill="none" stroke-width="2"/>
      <g class="pet-keyboard"><rect x="64" y="151" width="72" height="16" rx="5" fill="#60627e"/><path d="M73 156H126M77 162H121" stroke="#b9b3ef" stroke-width="2"/></g>
      <ellipse class="pet-paw" cx="68" cy="139" rx="12" ry="16" fill="#ded7ff"/><ellipse class="pet-paw-right" cx="132" cy="139" rx="12" ry="16" fill="#ded7ff"/>
      <circle cx="100" cy="144" r="8" fill="none" stroke="#9783d0" stroke-width="4"/><path d="M96 138L104 150M104 138L96 150" stroke="#b5a1e0" stroke-width="1.5"/>
    </g>
    <g class="pet-thought" fill="#aaa0ea"><circle cx="159" cy="64" r="3"/><circle cx="169" cy="53" r="4"/><circle cx="180" cy="39" r="6"/></g>
    <g class="pet-mark-ready"><circle cx="162" cy="43" r="16" fill="#64bca2"/><path d="M154 43L160 49L170 37" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round"/></g>
    <g class="pet-mark-ask"><circle cx="164" cy="42" r="17" fill="#f4cf78"/><text x="164" y="49" text-anchor="middle" font-family="sans-serif" font-size="23" font-weight="700" fill="#6d5738">?</text></g>
    <g class="pet-warning"><path d="M155 32L173 60H137Z" fill="#e5adbb"/><path d="M155 42V48M155 53V54" stroke="#743f52" stroke-width="3" stroke-linecap="round"/></g>
  </svg>`;
  function node(tag, cls, text) { const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; }
  function button(text, action, cls='') { const b=node('button',cls,text); b.type='button'; b.addEventListener('click',action); return b; }
  function mount(host, options={}) {
    const native=options.desktop===true, prefix=/^\/w\/[a-f0-9]+/.exec(location.pathname)?.[0]||'';
    const scoped=p=>prefix+p;
    const request=async(p,body,method)=>{const r=await window.fetch(scoped(p),{method:method||(body?'POST':'GET'),headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j;};
    const root=node('div','omni-pet '+(native?'':'pet-web'));root.dataset.phase='idle';host.append(root);
    const figure=button('',()=>{if(Date.now()<ignoreClick)return;touch();if(native)void window.omniPet.action('chat');else if(task)void openTask(task);},'pet-figure');figure.setAttribute('aria-label','Omni 宠物：点击查看任务，拖动移动');figure.innerHTML=CAT;
    const sprite=node('div','pet-sprite');sprite.hidden=true;figure.append(sprite);
    const label=button(LABELS.idle,()=>task?void openTask(task):options.focus?.(),'pet-label');label.setAttribute('aria-live','polite');
    const caption=node('span','pet-caption','Omni 小猫');
    const controls=node('div','pet-controls');
    const panel=node('div','pet-panel');panel.hidden=true;
    controls.append(button('任务',()=>{panel.hidden=!panel.hidden;renderTasks();}),button('形象',()=>native?window.omniPet.action('settings'):openSettings()),button('隐藏',()=>native?window.omniPet.action('hide'):void save({enabled:false})));
    root.append(figure,label,caption,controls,panel);
    let snapshot={tasks:[],settings:{enabled:true,selected:'omni'},pets:[]}, selected=options.sessionId||null, task=null, connected=true, refreshPromise=null, dirty=false, disposed=false, imageKey='', frameTimer=0, touched=0, ignoreClick=0;
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    let alphaImage=null,alphaUrl='',alphaCanvas=document.createElement('canvas');alphaCanvas.width=192;alphaCanvas.height=208;
    function touch(){root.classList.add('pet-touched');clearTimeout(touched);touched=setTimeout(()=>root.classList.remove('pet-touched'),1100);}
    function choose(){
      const tasks=snapshot.tasks||[];
      if(selected){const fixed=tasks.find(t=>key(t)===selected||t.sessionId===selected);if(fixed)return fixed;}
      return [...tasks].sort((a,b)=>(b.unread||b.running||b.pending?RANK[b.phase]||0:0)-(a.unread||a.running||a.pending?RANK[a.phase]||0:0)||b.updatedAt-a.updatedAt)[0];
    }
    function key(t){return `${t.url||''}:${t.sessionId}`;}
    function phase(t){return !connected?'disconnected':t&&(t.running||t.pending||t.unread)?t.phase:'idle';}
    function render(){
      if(disposed)return;root.hidden=!native&&snapshot.settings?.enabled===false;task=choose();const p=phase(task);root.dataset.phase=p;label.textContent=LABELS[p]||LABELS.idle;caption.textContent=task?.title||'Omni 小猫';figure.setAttribute('aria-label',`Omni 宠物：${LABELS[p]||LABELS.idle}，点击查看任务`);
      const pet=(snapshot.pets||[]).find(p=>p.id===snapshot.settings?.selected);const url=pet?.url?pet.url.startsWith('/api/')?scoped(pet.url):pet.url:'';
      const next=`${url}|${p}|${root.hidden}|${motion.matches}`;
      if(next!==imageKey){imageKey=next;clearInterval(frameTimer);sprite.hidden=!url;figure.querySelector('svg').style.display=url?'none':'';
        if(url){sprite.style.backgroundImage=`url(${JSON.stringify(url)})`;sprite.style.height=`${208*154/192}px`;sprite.style.backgroundSize=`1232px ${208*154/192*(pet.rows||9)}px`;const [row,count,ms]=TRACKS[p]||TRACKS.idle;let frame=0;const tick=()=>{sprite.style.backgroundPosition=`${-154*frame}px ${-208*154/192*row}px`;sprite.dataset.frame=String(frame);sprite.dataset.row=String(row);frame=(frame+1)%count;};tick();if(native&&alphaUrl!==url){alphaUrl=url;alphaImage=new Image();alphaImage.src=url;}if(!motion.matches&&!root.hidden&&document.visibilityState!=='hidden')frameTimer=setInterval(tick,ms);}}
      if(!panel.hidden)renderTasks();
    }
    function renderTasks(){
      panel.replaceChildren();const title=node('div','pet-panel-title');title.append(node('strong','','任务'),button('×',()=>panel.hidden=true));panel.append(title);
      panel.append(button(selected?'返回自动跟随':'自动跟随 · 优先待处理',()=>{selected=null;render();}));
      for(const t of [...(snapshot.tasks||[])].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,20)){
        const row=button('',()=>{selected=key(t);panel.hidden=true;render();void openTask(t);});row.append(node('strong','',t.title||'Omni 任务'),node('small','',`${LABELS[phase(t)]||''} · ${t.cwd||''}${t.source==='local'?' · 独立终端':''}`));panel.append(row);
      }
      if(!snapshot.tasks?.length)panel.append(node('small','','任务开始后会在这里显示。'));
    }
    async function openTask(t){
      try{if(native){await window.omniPet.action('session',{sessionId:t.sessionId,url:t.url,revision:t.revision});}
        else {await options.openSession?.(t.sessionId);await request('/api/pet/read',{sessionId:t.sessionId,revision:t.revision});await refresh();}}
      catch(error){caption.textContent=error.message;}
    }
    function refresh(){
      if(disposed)return Promise.resolve();if(refreshPromise){dirty=true;return refreshPromise;}
      refreshPromise=(async()=>{do{dirty=false;try{snapshot=native?await window.omniPet.info():await request('/api/pet');connected=true;render();}catch{connected=false;render();}}while(dirty&&!disposed);})().finally(()=>refreshPromise=null);
      return refreshPromise;
    }
    async function save(patch){snapshot=await request('/api/pet/settings',patch);render();}
    function openSettings(){
      const d=node('dialog','pet-dialog');d.innerHTML='<h2>你的 Omni 伙伴</h2><p>宠物跟随任务，陪你一起工作。</p>';
      const on=node('input');on.type='checkbox';on.checked=snapshot.settings?.enabled!==false;const show=node('label','','在对话页显示宠物');show.append(on);
      const select=node('select');for(const p of snapshot.pets||[]){const o=node('option','',p.name);o.value=p.id;select.append(o);}select.value=snapshot.settings?.selected||'omni';const skin=node('label','','宠物形象');skin.append(select);
      const file=node('input');file.type='file';file.accept='image/png,image/webp';const note=node('p','','导入透明 PNG/WebP：1536×1872 或 1536×2288，最多 20 MiB。');const error=node('div','pet-error');error.setAttribute('role','status');
      const remove=button('删除此形象',async()=>{if(select.value==='omni')return;try{await request(`/api/pet/assets/${select.value}`,undefined,'DELETE');await refresh();d.close();openSettings();}catch(e){error.textContent=e.message;}});remove.disabled=select.value==='omni';select.onchange=()=>remove.disabled=select.value==='omni';
      file.onchange=async()=>{const f=file.files?.[0];if(!f)return;error.textContent='正在检查图像…';try{if(f.size>20*1024*1024)throw new Error('图像不能超过 20 MiB');const im=await createImageBitmap(f);const valid=im.width===1536&&[1872,2288].includes(im.height);im.close();if(!valid)throw new Error('图像尺寸不符合宠物网格');const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(f);});const imported=await request('/api/pet/import',{name:f.name.replace(/\.[^.]+$/,''),dataUrl});await save({selected:imported.id});d.close();openSettings();}catch(e){error.textContent=e.message;}};
      const footer=node('div','pet-dialog-footer');footer.append(button('关闭',()=>d.close()),button('保存',async()=>{try{await save({enabled:on.checked,selected:select.value});d.close();}catch(e){error.textContent=e.message;}},'pet-primary'));
      if(window.omni?.setPetEnabled){const toggle=button('显示 / 隐藏桌面宠物',async()=>{try{const info=await window.omni.desktopInfo();await window.omni.setPetEnabled(!info.petEnabled);}catch(e){error.textContent=e.message;}});d.append(toggle);}
      d.append(show,skin,note,file,remove,error,footer);document.body.append(d);d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();
    }
    let drag=null;
    if(native){figure.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.screenX,y:e.screenY,moved:false};figure.setPointerCapture(e.pointerId);});figure.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.screenX-drag.x,dy=e.screenY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;if(drag.moved){void window.omniPet.action('move',{dx,dy});drag.x=e.screenX;drag.y=e.screenY;}});figure.addEventListener('pointerup',()=>{if(drag?.moved){ignoreClick=Date.now()+200;void window.omniPet.action('position');}drag=null;});figure.addEventListener('pointercancel',()=>drag=null);
      document.addEventListener('pointermove',e=>{
        let hit=!!e.target.closest('.pet-panel,.pet-label,.pet-controls button');
        const shape=e.target.closest('svg path,svg ellipse,svg circle,svg text');
        if(shape){let visible=true;for(let p=shape;p&&p!==figure;p=p.parentElement)if(getComputedStyle(p).opacity==='0')visible=false;hit=hit||visible;}
        if(!sprite.hidden&&alphaImage?.complete&&alphaImage.naturalWidth){
          const box=sprite.getBoundingClientRect(),x=Math.floor((e.clientX-box.x)/box.width*192),y=Math.floor((e.clientY-box.y)/box.height*208);
          if(x>=0&&y>=0&&x<192&&y<208){try{const ctx=alphaCanvas.getContext('2d',{willReadFrequently:true});ctx.clearRect(0,0,192,208);ctx.drawImage(alphaImage,Number(sprite.dataset.frame)*192,Number(sprite.dataset.row)*208,192,208,0,0,192,208);hit=hit||ctx.getImageData(x,y,1,1).data[3]>32;}catch{hit=true;}}
        }
        void window.omniPet.action('hit',{interactive:hit||!!drag});
      });
      root.addEventListener('contextmenu',e=>{e.preventDefault();void window.omniPet.action('menu');});
    }
    const visibility=()=>{imageKey='';render();};document.addEventListener('visibilitychange',visibility);motion.addEventListener('change',visibility);
    const timer=setInterval(()=>{if(!native&&!document.hidden)void refresh();},2000);const off=native?window.omniPet.onUpdate(s=>{snapshot=s;connected=s.connected!==false;render();}):null;
    void refresh();
    return {refresh,openSettings,setSession(id){selected=id||null;render();},destroy(){disposed=true;clearInterval(timer);clearInterval(frameTimer);clearTimeout(touched);off?.();document.removeEventListener('visibilitychange',visibility);motion.removeEventListener('change',visibility);root.remove();}};
  }
  window.OmniPet={mount};
  if(document.body.classList.contains('pet-desktop')&&window.omniPet)mount(document.getElementById('pet-root'),{desktop:true});
})();

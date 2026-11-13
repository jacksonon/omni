'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { petBounds, petChatBounds, isPetPage, taskForAction } = require('./pet-utils.cjs');
test('宠物拖动与外接屏移除保持整个窗口可见', () => {
  const area = {x:-1280,y:25,width:1280,height:775};
  const b = petBounds({x:9000,y:-9000},area);
  assert.deepEqual(b,{x:-240,y:25,width:240,height:286});
});
test('宠物对话窗在左右/上下与负坐标屏幕内，按宠物位置避让',()=>{
  for(const area of [{x:0,y:25,width:1440,height:875},{x:-1920,y:0,width:1920,height:1080},{x:1440,y:-200,width:2560,height:1440},{x:0,y:-1080,width:1920,height:1080}]){
    for(const x of [area.x,area.x+area.width-240]){
      const pet={x,y:area.y+area.height-286,width:240,height:286};
      const b=petChatBounds(pet,area);
      assert.ok(b.x>=area.x&&b.x+b.width<=area.x+area.width);
      assert.ok(b.y>=area.y&&b.y+b.height<=area.y+area.height);
      assert.ok(b.x+b.width<=pet.x||b.x>=pet.x+pet.width,'有空间时不盖住宠物');
    }
  }
});
test('宠物 IPC 只接受实际宠物页面，会话动作精确匹配工作区', () => {
  const connection={url:'http://127.0.0.1:3080/w/abcd'};
  assert.equal(isPetPage(connection.url+'/pet.html',connection),true);
  for(const url of [connection.url+'/',connection.url+'/pet.html/','http://evil.example/w/abcd/pet.html'])assert.equal(isPetPage(url,connection),false);
  const tasks=[{sessionId:'same',url:'a'},{sessionId:'same',url:'b'}];
  assert.equal(taskForAction(tasks,{sessionId:'same',url:'b'}),tasks[1]);
  assert.equal(taskForAction(tasks,{sessionId:'same',url:'c'}),undefined);
});

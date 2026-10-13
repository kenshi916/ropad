'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=fs.existsSync(path.join(__dirname,'parallax/dist/live-playtest.js'))?path.join(__dirname,'parallax/dist/live-playtest.js'):path.join(__dirname,'../dist/live-playtest.js');
const source=fs.readFileSync(file,'utf8'),build={id:'skyline-one',jobId:'execution-one'};
const record=(extra={})=>({buildId:build.id,jobId:build.jobId,studioId:'studio-one',state:'live',mode:'playtest',capturedAt:Date.now(),frameId:'frame-1',action:'Running toward checkpoint 1',...extra});
function fixture(initial=record()){
  const listeners={},windowListeners={},timers=new Map(),intervals=new Map(),requests=[],nodes=new Map();let next=0,response=initial,imageFails=false;
  function node(name){if(!nodes.has(name)){const classes=new Set();nodes.set(name,{name,isConnected:true,hidden:false,style:{},textContent:'',attrs:{},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){if(on===undefined)on=!classes.has(c);on?classes.add(c):classes.delete(c);return on;}},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this[k];},querySelector(selector){return node(selector);}});}return nodes.get(name);}
  const document={hidden:false,body:{style:{overflow:'auto'}},fullscreenElement:null,getElementById:node,addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener:(name,fn)=>{if(listeners[name]===fn)delete listeners[name];},exitFullscreen:async()=>{document.fullscreenElement=null;listeners.fullscreenchange?.();}};
  const root=node('.rp-live-playtest'),content=node('content');
  const window={addEventListener:(name,fn)=>windowListeners[name]=fn};const context={window,document,Date,AbortController,Promise,Image:class{set src(value){queueMicrotask(()=>imageFails?this.onerror?.():this.onload?.());}},encodeURIComponent,setTimeout(fn){const id=++next;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),setInterval(fn){const id=++next;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id),fetch:async(url,options)=>{requests.push({url,options});if(response instanceof Error)throw response;return{ok:response!==404,status:response===404?404:200,json:async()=>response};}};
  vm.runInNewContext(source,context,{filename:file});
  return{api:window.RopadLivePlaytest,node,root,content,document,listeners,windowListeners,requests,timers,intervals,setRecord:value=>response=value,setImageFails:value=>imageFails=value,flush:()=>new Promise(resolve=>setImmediate(resolve)),poll(){const [id,fn]=[...timers].at(-1);timers.delete(id);fn();}};
}
test('live badge requires exact project execution and a frame no older than five seconds',()=>{
  const h=fixture();const r=record({capturedAt:10000});
  assert.equal(h.api.inspect(build,r,15000).kind,'live');assert.equal(h.api.inspect(build,r,15001).kind,'last');
  assert.equal(h.api.inspect(build,{...r,jobId:'other-job'},10000).kind,'unavailable');
  assert.equal(h.api.inspect(build,{...r,buildId:'another-game'},10000).kind,'unavailable');
  assert.equal(h.api.inspect(build,{...r,mode:'edit'},10000).kind,'unavailable');
  assert.equal(h.api.inspect(build,{...r,studioId:''},10000).kind,'unavailable');
});
test('stopped and errored captures can keep their evidence image but cannot claim live',()=>{
  const h=fixture();assert.equal(h.api.inspect(build,record({state:'stopped'})).kind,'last');
  const result=h.api.inspect(build,record({state:'error',error:'Studio disconnected'}));assert.equal(result.kind,'error');assert.equal(result.hasFrame,true);assert.equal(result.message,'Studio disconnected');
  assert.equal(h.api.inspect(build,record({capturedAt:Date.now()+60000})).hasFrame,false);
  assert.equal(h.api.inspect(build,record({frameId:'../../private'})).hasFrame,false);
});
test('viewer loads only local assigned frame and waits for image load before showing live',async()=>{
  const h=fixture();h.api.mount(build,h.content);await h.flush();
  assert.equal(h.requests[0].url,'/runtime-playtest/skyline-one/status.json');assert.equal(h.requests[0].options.credentials,'omit');
  assert.equal(h.node('img').src,'/runtime-playtest/skyline-one/frame.jpg?v=frame-1');assert.equal(h.node('[data-live-state]').textContent,'Waiting for Studio');
  h.node('img').onload();assert.equal(h.node('[data-live-state]').textContent,'Live playtest');assert.equal(h.node('[data-live-action]').textContent,'Running toward checkpoint 1');
  h.api.mount({...build,canManage:false},h.content);assert.equal(h.requests.length,1);h.api.stop();
});
test('a newer status for a different job clears the displayed frame and never requests it',async()=>{
  const h=fixture();h.api.mount(build,h.content);await h.flush();h.node('img').onload();h.setRecord(record({jobId:'old-execution',frameId:'frame-2'}));h.poll();await h.flush();
  assert.equal(h.node('img').hidden,true);assert.equal(h.node('img').src,undefined);assert.equal(h.node('[data-live-state]').textContent,'Waiting for Studio');h.api.stop();
});
test('network and image errors cannot leave a live badge behind',async()=>{
  const h=fixture();h.api.mount(build,h.content);await h.flush();h.node('img').onload();h.setRecord(new Error('Studio stream disconnected'));h.poll();await h.flush();
  assert.equal(h.node('[data-live-state]').textContent,'Last frame');assert.equal(h.root.classList.contains('is-live'),false);
  h.setRecord(record({frameId:'frame-2'}));h.poll();await h.flush();h.node('img').onerror();assert.equal(h.node('img').hidden,true);assert.equal(h.node('[data-live-message]').textContent,'The latest image could not be loaded');h.api.stop();
});
test('fullscreen rejection uses theater view and Escape restores page scrolling',async()=>{
  const h=fixture();h.root.requestFullscreen=async()=>{throw Error('Not allowed');};h.api.mount(build,h.content);await h.flush();
  await h.node('button').onclick();assert.equal(h.root.classList.contains('is-theater'),true);assert.equal(h.document.body.style.overflow,'hidden');assert.equal(h.node('button').attrs['aria-pressed'],'true');
  h.listeners.keydown({key:'Escape'});assert.equal(h.root.classList.contains('is-theater'),false);assert.equal(h.document.body.style.overflow,'auto');h.api.stop();
});
test('native fullscreen works and leaving route clears polling, listeners, and fullscreen',async()=>{
  const h=fixture();h.root.requestFullscreen=async()=>{h.document.fullscreenElement=h.root;h.listeners.fullscreenchange?.();};h.api.mount(build,h.content);await h.flush();
  await h.node('button').onclick();assert.equal(h.document.fullscreenElement,h.root);assert.equal(h.node('button').attrs['aria-pressed'],'true');
  h.api.stop();await h.flush();assert.equal(h.document.fullscreenElement,null);assert.equal(h.timers.size,0);assert.equal(h.intervals.size,0);assert.equal(Object.keys(h.listeners).length,0);assert.equal(h.node('img').onload,null);
});
test('missing capture returns a truthful waiting message and never selects a random build frame',async()=>{
  const h=fixture(404);h.api.mount(build,h.content);await h.flush();assert.equal(h.node('img').src,undefined);assert.equal(h.node('[data-live-message]').textContent,'No Studio playtest is streaming for this game yet');h.api.stop();
});
test('cover preview reads once per project version per page visit and always labels a still frame',async()=>{
  const h=fixture(record({capturedAt:Date.now()-90000,state:'stopped'})),covers=[];
  h.api.preview(build,h.content,image=>covers.push(image));h.api.preview(build,h.root,image=>covers.push(image));await h.flush();
  assert.equal(h.requests.length,1);assert.equal(covers.length,2);assert.equal(covers[0].label,'Last Studio playtest frame');assert.equal(covers[0].url,'/runtime-playtest/skyline-one/frame.jpg?v=frame-1');assert.equal(h.api.cachedPreview(build).kind,'playtest');
  h.api.preview(build,h.content,()=>{});await h.flush();assert.equal(h.requests.length,1);assert.equal(h.intervals.size,0);
  h.windowListeners.hashchange();assert.equal(h.api.cachedPreview(build),null);h.api.preview(build,h.content,()=>{});await h.flush();assert.equal(h.requests.length,2);
});
test('wrong-job and broken-image previews keep existing covers and never claim new imagery',async()=>{
  for(const variant of ['mismatch','broken']){
    const h=fixture(record(variant==='mismatch'?{jobId:'other-job'}:{}));h.setImageFails(variant==='broken');let applied=false;
    h.api.preview(build,h.content,()=>applied=true);await h.flush();assert.equal(applied,false);assert.equal(h.api.cachedPreview(build),null);
  }
});
test('removed covers do not update after a snapshot request completes',async()=>{
  const h=fixture();let applied=false;h.api.preview(build,h.content,()=>applied=true);h.content.isConnected=false;await h.flush();assert.equal(applied,false);
});

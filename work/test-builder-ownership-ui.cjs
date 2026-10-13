'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sourcePath=fs.existsSync(path.join(__dirname,'parallax/dist/builders.js'))?path.join(__dirname,'parallax/dist/builders.js'):path.join(__dirname,'../dist/builders.js');
const source=fs.readFileSync(sourcePath,'utf8');
class Element{
  constructor(){this.innerHTML='';this.textContent='';this.dataset={};this.isConnected=true;this.classList={add(){},remove(){},toggle(){}};this.children=[];}
  querySelector(selector){if(selector==='[data-builder-action="stop-screen"]')return this.children.find(child=>child.dataset.builderAction==='stop-screen')||null;if(selector==='.b-screen-awaiting')return this.innerHTML.includes('b-screen-awaiting')?{}:null;return null;}
  querySelectorAll(){return [];}contains(element){return element?.parent===this;}append(element){this.children.push(element);}before(){}setAttribute(){}addEventListener(){}insertAdjacentHTML(_,value){this.innerHTML+=value;}close(){this.open=false;}
}
function fixture({plan=null}={}){
  const nodes=new Map(),events={},requests=[],computeReads=[],invalidations=[],document={activeElement:null,visibilityState:'visible',hidden:false};
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  document.getElementById=id=>id==='b-agent-prompt-form'?null:node(id);
  document.querySelector=selector=>selector==='.b-screen-footer'?node('screen-footer'):selector==='.b-screen-footer [data-builder-action="connect"]'?node('connect-screen'):null;
  document.querySelectorAll=()=>[];document.createElement=()=>new Element();document.addEventListener=(name,fn)=>events[name]=fn;
  let owner=true,brief='Original public game brief',invalidating=Promise.resolve(),queueReady=false;
  const build=()=>({id:'game-one',gameName:'Original game',brief,plan,canManage:owner,modelId:'google/gemini-2.5-pro',status:'waiting_for_studio',events:[],agent:null});
  const window={addEventListener:(name,fn)=>events[name]=fn,scrollTo(){},RopadStudioQueue:{availability:()=>({ready:queueReady,compatible:1,idle:1,reason:queueReady?'Compatible one-build worker available':'Activate the updated Ropad server'})},RopadSolana:{get:()=>({address:'wallet-new'}),whenInvalidated:()=>invalidating},RopadBuildAgent:{panel:b=>b.canManage?'<button>Start private workflow</button>':'Only the verified creator can start',wire(){},isActive:()=>false},RopadCompute:{panel:b=>b.canManage?'PRIVATE OWNER LEDGER':'Public accounting summary',wire(){},refresh:b=>computeReads.push(b.canManage),invalidate:()=>invalidations.push('compute')}};
  const context={window,document,location:{hash:'#/build/game-one',origin:'http://localhost'},navigator:{},setInterval:()=>0,setTimeout:()=>0,clearTimeout(){},AbortSignal,URL,fetch:async url=>{requests.push(url);return{ok:true,json:async()=>url==='/api/builds/pool'?{capacity:1,workers:[],active:0,queued:0}:{build:build()}};}};
  vm.runInNewContext(source,context,{filename:sourcePath});
  return{window,document,events,requests,node,computeReads,invalidations,setOwner:value=>owner=value,setBrief:value=>brief=value,setInvalidating:value=>invalidating=value,setQueueReady:value=>queueReady=value,flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('creator controls repaint on lost ownership even while the old prompt remains focused',async()=>{
  const h=fixture();await h.flush();const sidebar=h.node('b-build-sidebar');assert.match(sidebar.innerHTML,/b-owner-chip/);assert.match(sidebar.innerHTML,/PRIVATE OWNER LEDGER/);
  h.document.activeElement={tagName:'TEXTAREA',parent:sidebar};h.setOwner(false);await h.window.ParallaxBuilders.refresh();
  assert.doesNotMatch(sidebar.innerHTML,/b-owner-chip|PRIVATE OWNER LEDGER|Start private workflow/);assert.match(sidebar.innerHTML,/The creator directs this agent/);
  await h.window.ParallaxBuilders.refresh();assert.doesNotMatch(sidebar.innerHTML,/b-owner-chip/);
});
test('wallet invalidation immediately removes privileged controls and waits for logout before owner reads',async()=>{
  const h=fixture();await h.flush();const sidebar=h.node('b-build-sidebar');h.document.activeElement={tagName:'TEXTAREA',parent:sidebar};
  let release;h.setInvalidating(new Promise(resolve=>release=resolve));const before=h.requests.length;h.events['ropad-solana-wallet-change']();
  assert.doesNotMatch(sidebar.innerHTML,/b-owner-chip|PRIVATE OWNER LEDGER/);assert.equal(h.invalidations.length,1);await h.flush();assert.equal(h.requests.length,before);
  h.setOwner(false);release();await h.flush();assert.ok(h.requests.length>before);assert.doesNotMatch(sidebar.innerHTML,/b-owner-chip/);
});
test('failed wallet logout leaves creator controls unavailable instead of trusting the prior session',async()=>{
  const h=fixture();await h.flush();const before=h.requests.length;h.setInvalidating(Promise.reject(Error('Logout unavailable')));h.events['ropad-solana-wallet-change']();await h.flush();
  assert.equal(h.requests.length,before);assert.doesNotMatch(h.node('b-build-sidebar').innerHTML,/b-owner-chip|PRIVATE OWNER LEDGER/);assert.match(h.node('toast').textContent,/Creator session could not be cleared/);
});
test('unchanged workspaces still refresh accounting and deferred content catches up after editing',async()=>{
  const h=fixture();await h.flush();const reads=h.computeReads.length;await h.window.ParallaxBuilders.refresh();assert.equal(h.computeReads.length,reads+1);
  const sidebar=h.node('b-build-sidebar');h.document.activeElement={tagName:'TEXTAREA',parent:sidebar};h.setBrief('New public game direction');await h.window.ParallaxBuilders.refresh();assert.doesNotMatch(sidebar.innerHTML,/New public game direction/);
  h.document.activeElement=null;await h.window.ParallaxBuilders.refresh();assert.match(sidebar.innerHTML,/New public game direction/);
  assert.match(sidebar.innerHTML,/gemini-2.5-pro/);assert.doesNotMatch(sidebar.innerHTML,/<strong>GPT-6 Astra<\/strong>|<strong>Claude Opus 5.5<\/strong>/);
});

test('queue labels never equate a prepared plan or online connection with a validated worker',async()=>{
  const h=fixture({plan:{parts:[],summary:'Saved historical plan'}});await h.flush();const queue=h.node('b-detail-queue');assert.match(queue.innerHTML,/worker validation required/);assert.match(queue.innerHTML,/Activate the updated Ropad server/);assert.doesNotMatch(queue.innerHTML,/data-builder-action="enqueue"|Ready for a worker/);
  h.setQueueReady(true);await h.window.ParallaxBuilders.refresh();assert.match(queue.innerHTML,/data-builder-action="enqueue"/);assert.match(queue.innerHTML,/Plan prepared for Studio/);
});

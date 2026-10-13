'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=fs.existsSync(path.join(__dirname,'parallax/dist/builders.js'))?path.join(__dirname,'parallax/dist/builders.js'):path.join(__dirname,'../dist/builders.js');
const source=fs.readFileSync(file,'utf8');
function fixture(hash='#/token/game-one'){
  const requests=[],rendered=[],events={},nodes=new Map(),location={hash,origin:'http://localhost'};
  let owner=true,gate=null;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',isConnected:true,dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},querySelector(){return null;},querySelectorAll(){return[];},contains(){return false;}});return nodes.get(id);};
  const document={hidden:false,activeElement:null,getElementById:node,querySelector(selector){if(selector==='.rp-token-page'&&node('builder-app').innerHTML.includes('rp-token-page'))return node('token-root');if(selector==='.rp-play-page'&&node('builder-app').innerHTML.includes('rp-play-page'))return node('play-root');return null;},querySelectorAll(){return[];},addEventListener(){}};
  const component=page=>({render(b){rendered.push([page,'render',b.id,b.canManage]);return `<main class="rp-${page}-page">${b.id}</main>`;},wire(){},refresh(b){rendered.push([page,'refresh',b.id,b.canManage]);}});
  const window={RopadTokenPage:component('token'),RopadPlayPage:component('play'),addEventListener:(name,fn)=>events[name]=fn,scrollTo(){},RopadSolana:{whenInvalidated:()=>Promise.resolve()}};
  const context={window,document,location,navigator:{},setInterval(){},setTimeout(){},clearTimeout(){},AbortSignal,URL,fetch:async(url,options={})=>{requests.push({url,method:options.method||'GET'});const id=url.split('/').at(-1);if(gate)await gate;return{ok:true,json:async()=>({build:{id,gameName:'Game '+id,status:'waiting_for_studio',canManage:owner,events:[]}})};}};
  vm.runInNewContext(source,context,{filename:file});
  return{location,window,node,rendered,requests,events,setOwner:value=>owner=value,setGate:value=>gate=value,flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('token and play links open separate pages for the same game with read-only requests',async()=>{
  const h=fixture();await h.flush();assert.deepEqual(h.rendered[0],['token','render','game-one',true]);
  h.location.hash='#/play/game-one';await h.window.ParallaxBuilders.refresh();assert.deepEqual(h.rendered.at(-1),['play','render','game-one',true]);
  h.location.hash='#/token/game-one';await h.window.ParallaxBuilders.refresh();assert.deepEqual(h.rendered.at(-1),['token','render','game-one',true]);
  assert.ok(h.requests.every(row=>row.method==='GET'&&row.url==='/api/builds/game-one'));
});
test('periodic token updates retain the mounted form through module refresh',async()=>{
  const h=fixture();await h.flush();await h.window.ParallaxBuilders.refresh();
  assert.equal(h.rendered.filter(row=>row[1]==='render').length,1);assert.equal(h.rendered.at(-1)[1],'refresh');
});
test('creator wallet invalidation immediately removes privilege on public pages',async()=>{
  const h=fixture('#/play/game-one');await h.flush();h.setOwner(false);h.events['ropad-solana-wallet-change']();
  assert.deepEqual(h.rendered.at(-1),['play','refresh','game-one',false]);await h.flush();assert.equal(h.rendered.at(-1)[3],false);
});
test('malformed or incomplete game links never dispatch a build request',async()=>{
  for(const hash of ['#/token','#/play/','#/token/%E0%A4%A','#/play/../private','#/token/%2fprivate','#/token/'+('a'.repeat(129))]){
    const h=fixture(hash);await h.flush();assert.equal(h.requests.length,0);assert.match(h.node('builder-app').innerHTML,/link is incomplete/);
  }
});
test('navigation cancels a stale in-flight page response including a malformed destination',async()=>{
  const h=fixture();await h.flush();let release;h.setGate(new Promise(resolve=>release=resolve));
  const pending=h.window.ParallaxBuilders.refresh();await h.flush();const count=h.rendered.length;
  h.location.hash='#/play/%zz';await h.window.ParallaxBuilders.refresh();release();await pending;
  assert.equal(h.rendered.length,count);assert.match(h.node('builder-app').innerHTML,/link is incomplete/);
});

test('launch route mounts once, preserves its draft across polling and unmounts when leaving',async()=>{
 const h=fixture();await h.flush();let mounted=0,unmounted=0;
 h.window.RopadLaunchPage={mount(){mounted++;},unmount(){unmounted++;}};
 h.location.hash='#/launch';await h.window.ParallaxBuilders.refresh();
 const count=h.requests.length;await h.window.ParallaxBuilders.refresh();await h.window.ParallaxBuilders.refresh();
 assert.equal(mounted,1);assert.equal(h.requests.length,count);assert.match(h.node('builder-app').innerHTML,/id="rp-launch-page"/);
 h.location.hash='#/token/game-one';await h.window.ParallaxBuilders.refresh();assert.equal(unmounted,1);
});

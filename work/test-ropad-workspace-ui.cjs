'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const sourcePath=fs.existsSync(path.join(__dirname,'parallax/dist/builder-shell.js'))?path.join(__dirname,'parallax/dist/builder-shell.js'):path.join(__dirname,'../dist/builder-shell.js');
const source=fs.readFileSync(sourcePath,'utf8');
class Element{
  constructor(){this.innerHTML='';this.textContent='';this.nodes=new Map();this.open=false;this.isConnected=true;this.classList={add(){},remove(){},toggle(){}};}
  querySelector(selector){if(!this.nodes.has(selector))this.nodes.set(selector,new Element());return this.nodes.get(selector);}
  querySelectorAll(){return [];}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
function fixture({owner=true,generationError='',conceptConfigured=true,buildGate=null,configChanges={},pool={capacity:1,active:0,workers:[]}}={}){
  const requests=[],host=new Element(),dialog=new Element(),toast=new Element(),kicker=new Element();
  const build={id:'build-parent',gameName:'Test Game',brief:'A complete original game direction',canManage:owner,modelId:'anthropic/claude-opus-5.5'};
  const window={addEventListener(){},ParallaxBuilders:{refresh(){}}},location={hash:'#/build/build-parent'};
  const nodes={'#info-body':host,'#info-dialog':dialog,'#toast':toast,'#info-kicker':kicker};
  const context={window,location,document:{querySelector:selector=>nodes[selector],querySelectorAll:()=>[]},AbortSignal,setTimeout:()=>0,clearTimeout(){},navigator:{},FormData:class{*[Symbol.iterator](){}},fetch:async(url,options={})=>{
    requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
    if(buildGate&&url==='/api/builds/build-parent')await buildGate;
    if(url.endsWith('/generate')&&generationError)return{ok:false,json:async()=>({error:generationError})};
    const payload=url==='/api/status'?{csrf:'OFFLINE_TOKEN'}:url==='/api/builds/config'?{apiVersion:2,creationMode:'prompt',revisions:true,releaseReview:true,conceptGeneration:true,thumbnailGeneration:true,...configChanges}:url==='/api/builds/pool'?pool:url==='/api/builds/concept-models'?{configured:conceptConfigured,defaultModelId:'black-forest-labs/flux-3-image',maxConceptEstimateUsd:.15,data:[{id:'black-forest-labs/flux-3-image',name:'FLUX.3 Image'}]}:url.endsWith('/revisions')?{build:{...build,id:'build-revision'}}:{build};
    return{ok:true,json:async()=>payload};
  }};
  vm.runInNewContext(source,context,{filename:sourcePath});
  return{window,requests,location,host,toast,dialog};
}
test('direct creator prompt saves a version then generates its plan without queueing or trading',async()=>{
  const h=fixture();await h.window.promptRobloxAgent('build-parent',{brief:'An improved collection game with a clear finish',modelId:'openai/gpt-6-astra'});
  const writes=h.requests.filter(item=>item.method==='POST');
  assert.deepEqual(writes.map(item=>item.url),['/api/builds/build-parent/revisions','/api/builds/build-revision/generate']);
  assert.equal(writes[0].body.modelId,'openai/gpt-6-astra');assert.equal(writes[1].body.modelId,'openai/gpt-6-astra');
  assert.equal(h.location.hash,'#/build/build-revision');assert.match(h.toast.textContent,/Review the plan before queueing Studio/);
});
test('non-owner cannot send direct creator prompts',async()=>{
  const h=fixture({owner:false});await assert.rejects(h.window.promptRobloxAgent('build-parent',{brief:'An improved original collection game',modelId:'openai/gpt-6-astra'}),/Only the project creator/);
  assert.equal(h.requests.filter(item=>item.method==='POST').length,0);
});
test('direct prompts reject a cheap model before creating a revision',async()=>{
  const h=fixture();await assert.rejects(h.window.promptRobloxAgent('build-parent',{brief:'An improved original collection game',modelId:'google/gemini-2.5-flash'}),/Choose Claude Opus 5.5 or GPT-6 Astra/);
  assert.equal(h.requests.filter(item=>item.method==='POST').length,0);
});
test('a failed AI request preserves and opens the saved revision without starting Studio',async()=>{
  const h=fixture({generationError:'Daily budget exhausted'});await assert.rejects(h.window.promptRobloxAgent('build-parent',{brief:'An improved original collection game',modelId:'openai/gpt-6-astra'}),/Daily budget exhausted/);
  assert.equal(h.location.hash,'#/build/build-revision');assert.match(h.toast.textContent,/update was saved/);
  assert.equal(h.requests.some(item=>item.url.endsWith('/enqueue')),false);
});
test('opening concept editor reads pricing without performing paid image generation',async()=>{
  const h=fixture();await h.window.openRobloxConcept('build-parent');
  assert.match(h.host.innerHTML,/FLUX.3 Image/);assert.match(h.host.innerHTML,/paid image generation/);assert.match(h.host.innerHTML,/design target/);
  assert.equal(h.requests.some(item=>item.method==='POST'),false);
});
test('thumbnail creation has a distinct explicit action and never calls the concept or Studio endpoints',async()=>{
  const h=fixture();await h.window.openRobloxThumbnail('build-parent');
  assert.match(h.host.innerHTML,/original 16:9 thumbnail/);assert.equal(h.requests.some(item=>item.method==='POST'),false);
  await h.host.querySelector('form').onsubmit({preventDefault(){}});
  assert.deepEqual(h.requests.filter(item=>item.method==='POST').map(item=>item.url),['/api/builds/build-parent/thumbnail']);
  assert.match(h.toast.textContent,/Game thumbnail saved/);
});

test('wallet invalidation closes creator tools and prevents a late owner read from rebuilding their form',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),h=fixture({buildGate:gate});const opening=h.window.openRobloxConcept('build-parent');
  assert.equal(h.dialog.open,true);h.window.RopadCreatorTools.invalidate();assert.equal(h.dialog.open,false);assert.equal(h.host.innerHTML,'');
  release();await opening;assert.equal(h.host.innerHTML,'');assert.equal(h.requests.some(request=>request.method==='POST'),false);
});

test('manual queue refuses old services and workers without fresh one-build capability',async()=>{
  const config={workerPlanSchema:'scene-v1',manualQueueRequiresAgentWorker:true,oneBuildPerStudio:true},worker={online:true,agentCompatible:true,agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,capabilitySeenAt:Date.now(),status:'idle',buildId:null};
  for(const options of [{configChanges:{}},{configChanges:{...config,oneBuildPerStudio:false}},{configChanges:config,workerChanges:{oneBuildPerStudio:false}},{configChanges:config,workerChanges:{agentCompatible:false}},{configChanges:config,workerChanges:{capabilitySeenAt:Date.now()-60000}},{configChanges:config,workerChanges:{status:'busy'}}]){
    const h=fixture({configChanges:options.configChanges,pool:{capacity:1,active:0,workers:[{...worker,...options.workerChanges}]}});await h.window.queueRobloxBuild('build-parent');
    assert.equal(h.requests.some(request=>request.method==='POST'),false);assert.match(h.toast.textContent,/updated Ropad server|compatible idle/);
  }
});

test('manual queue explicitly requests the protected worker requirement after fresh readiness checks',async()=>{
  const h=fixture({configChanges:{workerPlanSchema:'scene-v1',manualQueueRequiresAgentWorker:true,oneBuildPerStudio:true},pool:{capacity:1,active:0,workers:[{online:true,agentCompatible:true,agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,capabilitySeenAt:Date.now(),status:'idle',buildId:null}]}});
  await h.window.queueRobloxBuild('build-parent');const writes=h.requests.filter(request=>request.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/builds/build-parent/enqueue');assert.deepEqual(writes[0].body,{requireAgentWorker:true});
});
test('visual scene queue requires the visual worker protocol while old plans retain their compatible workers',()=>{
  const h=fixture(),config={workerPlanSchema:'scene-v1',manualQueueRequiresAgentWorker:true,oneBuildPerStudio:true,visualSceneVersion:1},worker={online:true,agentCompatible:true,agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,capabilitySeenAt:Date.now(),status:'idle',buildId:null},pool={capacity:1,active:0,workers:[worker]};
  assert.equal(h.window.RopadStudioQueue.availability(config,pool,{plan:{parts:[]}}).ready,true);
  for(const build of [{plan:{presentation:{lighting:{brightness:2}},parts:[]}},{plan:{parts:[{behavior:'decoration'}]}},{queue:{requireVisualReview:true}}]){
    assert.equal(h.window.RopadStudioQueue.availability(config,pool,build).ready,false);assert.match(h.window.RopadStudioQueue.availability(config,pool,build).reason,/visual-review Studio worker/);
    assert.equal(h.window.RopadStudioQueue.availability(config,{...pool,workers:[{...worker,visualReviewProtocol:1}]},build).ready,true);
  }
});

class ViewerElement{
  constructor(){this.html='';this.textContent='';this.dataset={};this.isConnected=true;this.children=[];this.nodes=new Map();this.classList={add(){},remove(){},toggle(){}};}
  set innerHTML(value){this.html=value;this.nodes=new Map();}get innerHTML(){return this.html;}get firstElementChild(){return this.html?{}:null;}
  querySelector(selector){
    if(this.nodes.has(selector))return this.nodes.get(selector);
    if(selector==='[data-builder-action="stop-screen"]')return this.children.find(child=>child.dataset.builderAction==='stop-screen')||null;
    if(selector==='.b-screen-awaiting')return this.html.includes('b-screen-awaiting')?{}:null;
    if(selector==='img'&&this.html.includes('<img')||selector==='.b-screen-failure'&&this.html.includes('b-screen-failure')){const child=new ViewerElement();this.nodes.set(selector,child);return child;}
    return null;
  }
  querySelectorAll(){return [];}contains(){return false;}getAttribute(name){return this[name]||null;}setAttribute(name,value){this[name]=value;}append(element){this.children.push(element);}before(){}addEventListener(){}insertAdjacentHTML(_,value){this.html+=value;}close(){}
}
function viewerFixture({visualFrames=[],screenshot=null,concept=null}={}){
  const nodes=new Map(),requests=[],node=id=>{if(!nodes.has(id))nodes.set(id,new ViewerElement());return nodes.get(id);};
  const build={id:'view-build',jobId:'current-job',gameName:'Rooftop Race',brief:'An original route',status:'ready',canManage:false,modelId:'anthropic/claude-opus-5.5',visualFrames,screenshot,concept,events:[]};
  const document={activeElement:null,hidden:false,getElementById:id=>node(id),querySelector:selector=>selector==='.b-screen-footer'?node('footer'):selector==='.b-screen-footer [data-builder-action="connect"]'?node('connect'):null,querySelectorAll:()=>[],createElement:()=>new ViewerElement(),addEventListener(){}};
  const window={addEventListener(){},scrollTo(){},RopadStudioQueue:{availability:()=>({ready:false,reason:'Fixture worker status'})}};
  const context={window,document,location:{hash:'#/build/view-build',origin:'http://localhost'},navigator:{},URL,AbortSignal,setTimeout:()=>0,setInterval:()=>0,clearTimeout(){},fetch:async(url,options={})=>{requests.push({url,method:options.method||'GET'});return{ok:true,json:async()=>url==='/api/builds/pool'?{capacity:1,active:0,workers:[]}:url==='/api/builds/config'?{}:{build}};}};
  const file=sourcePath.replace('builder-shell.js','builders.js');vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  return{window,build,node,requests,flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('Studio viewer selects real named captures and retains their hash in source URLs',async()=>{
  const visualFrames=['overview','spawn','finish'].map((view,i)=>({view,hash:String(i+1).repeat(64),jobId:'current-job',source:'pooled_studio_worker',capturedAt:1000+i,bytes:100,contentType:'image/png'}));
  const h=viewerFixture({visualFrames});await h.flush();const bar=h.node('b-capture-views');assert.equal(bar.hidden,false);assert.match(bar.innerHTML,/data-capture-view="overview"/);assert.match(bar.innerHTML,/data-capture-view="finish"/);
  assert.match(h.node('b-screen-content').querySelector('img').src,/screen\?view=overview&v=11111111/);
  h.window.ParallaxBuilders.showView('studio','finish');assert.match(h.node('b-screen-content').querySelector('img').src,/screen\?view=finish&v=33333333/);assert.match(h.node('b-screen-note').textContent,/Studio finish capture/);
  assert.equal(h.requests.some(item=>item.method==='POST'),false);
});
test('comparison labels the concept separately from actual capture and handles missing evidence honestly',async()=>{
  const h=viewerFixture({concept:{imageUrl:'/api/builds/view-build/concept/image?v=fixture'},visualFrames:[{view:'overview',hash:'a'.repeat(64),jobId:'current-job',source:'pooled_studio_worker',capturedAt:1000}]});await h.flush();h.window.ParallaxBuilders.showView('compare');
  assert.match(h.node('b-screen-content').innerHTML,/AI-generated concept/);assert.match(h.node('b-screen-content').innerHTML,/Actual Studio overview/);assert.match(h.node('b-screen-content').innerHTML,/screen\?view=overview&amp;v=aaaa/);assert.match(h.node('b-screen-content').innerHTML,/does not certify gameplay/);
  const empty=viewerFixture();await empty.flush();empty.window.ParallaxBuilders.showView('compare');assert.match(empty.node('b-screen-content').innerHTML,/No concept image saved/);assert.match(empty.node('b-screen-content').innerHTML,/has not supplied an actual capture/);assert.doesNotMatch(empty.node('b-screen-content').innerHTML,/<img/);
});
test('stale or untrusted named frames never appear as actual review views; legacy shared screens remain visible',async()=>{
  const h=viewerFixture({screenshot:{capturedAt:500,source:'owner_screen_share'},visualFrames:[{view:'overview',hash:'a'.repeat(64),jobId:'old-job',source:'pooled_studio_worker',capturedAt:1000},{view:'spawn',hash:'b'.repeat(64),jobId:'current-job',source:'owner_screen_share',capturedAt:1000}]});await h.flush();
  assert.equal(h.node('b-capture-views').hidden,true);assert.equal(h.node('b-screen-content').querySelector('img').src,'/api/builds/view-build/screen?v=500');assert.match(h.node('b-screen-note').textContent,/Owner-shared screen/);
});

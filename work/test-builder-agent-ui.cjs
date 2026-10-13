'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sourcePath=fs.existsSync(path.join(__dirname,'parallax/dist/builder-shell.js'))?path.join(__dirname,'parallax/dist/builder-shell.js'):path.join(__dirname,'../dist/builder-shell.js');
const source=fs.readFileSync(sourcePath,'utf8');
class Element{
  constructor(html=''){this.innerHTML=html;this.isConnected=true;this.value='';this.checked=false;this.textContent='';this.classList={add(){},remove(){},toggle(){}};}
  set innerHTML(value){this.html=value;this.nodes=new Map();}get innerHTML(){return this.html;}
  querySelector(selector){
    if(this.nodes.has(selector))return this.nodes.get(selector);
    let node=null;
    if(selector==='[data-agent-start-form]'&&this.html.includes('data-agent-start-form'))node=new Element(this.html);
    else if(selector==='[data-agent-pause]'&&this.html.includes('data-agent-pause'))node=new Element();
    else if(selector==='[data-build-feedback]')node=new Element();
    else if(selector.startsWith('[name=')){const name=selector.match(/name="([^"]+)"/)[1],tag=this.html.match(new RegExp('<input[^>]*name="'+name+'"[^>]*>'))?.[0];if(tag){node=new Element();node.value=tag.match(/value="([^"]*)"/)?.[1]||'';node.checked=/ checked/.test(tag);node.disabled=/ disabled/.test(tag);}}
    else if(selector==='button[type="submit"]'){node=new Element();node.disabled=/<button[^>]*type="submit"[^>]* disabled/.test(this.html);}
    if(node)this.nodes.set(selector,node);return node;
  }
  querySelectorAll(){return [];}contains(){return false;}showModal(){this.open=true;}close(){this.open=false;}
}
const run={runId:'run-one',buildId:'build-one',status:'running',stage:'planning',pauseRequested:false,budgetUsd:1,spentUsd:0,reservedUsd:.25,remainingUsd:.75,includeConcept:true,includeThumbnail:false,message:'Preparing an AI plan',history:[{at:'2026-10-09T12:00:00Z',stage:'planning',message:'Planning request recorded'}]};
function fixture({owner=true,serverOwner=owner,enabled=true,visualEnabled=true,agent=null}={}){
  const requests=[],root=new Element(),host=new Element(),dialog=new Element(),toast=new Element(),nodes={'#info-body':host,'#info-dialog':dialog,'#toast':toast,'#info-kicker':new Element()};
  const build={id:'build-one',gameName:'Original Game',brief:'An original complete game brief',canManage:owner,agent};let current=agent;
  const window={addEventListener(){},ParallaxBuilders:{refresh(){}}};
  const context={window,document:{querySelector:selector=>nodes[selector],querySelectorAll:()=>[],activeElement:null},location:{hash:''},navigator:{},setTimeout:()=>0,clearTimeout(){},AbortSignal,fetch:async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({url,method:options.method||'GET',body});
    if(url.endsWith('/agent/start'))current={...run};if(url.endsWith('/agent/pause'))current={...run,pauseRequested:true,message:'Pause requested The current step may finish'};
    const payload=url==='/api/status'?{csrf:'OFFLINE_CSRF'}:url==='/api/builds/config'?{apiVersion:2,creationMode:'prompt',revisions:true,autonomousBuilds:enabled,...(visualEnabled?{visualReviewVersion:1,visualSceneVersion:1}:{})}:{build:{...build,canManage:serverOwner,agent:current},agent:current};
    return{ok:true,json:async()=>payload};
  }};
  vm.runInNewContext(source,context,{filename:sourcePath});root.innerHTML=window.RopadBuildAgent.panel(build);window.RopadBuildAgent.wire(build,root);
  return{window,root,requests,toast,setVisualEnabled:value=>visualEnabled=value,flush:()=>new Promise(resolve=>setImmediate(resolve)),submit:()=>root.querySelector('[data-agent-start-form]').onsubmit({preventDefault(){}})};
}
test('opening the workflow loads status without starting paid work or queueing Studio',async()=>{
  const h=fixture();await h.flush();assert.match(h.root.innerHTML,/Maximum \$1 per run/);assert.match(h.root.innerHTML,/Paid AI requests/);assert.match(h.root.innerHTML,/Full gameplay review and publishing stay with the creator/);
  assert.equal(h.requests.some(item=>item.method==='POST'),false);assert.equal(h.root.querySelector('[data-agent-start-form]').querySelector('button[type="submit"]').disabled,false);
});
test('Start agent is disabled with a clear activation message on an older backend',async()=>{
  const h=fixture({enabled:false});await h.flush();assert.match(h.root.innerHTML,/Restart the local Ropad server/);
  assert.equal(h.root.querySelector('[data-agent-start-form]').querySelector('button[type="submit"]').disabled,true);await h.submit();assert.equal(h.requests.some(item=>item.method==='POST'),false);
});
test('non-owners can inspect agent stages and reservations without receiving controls',async()=>{
  const h=fixture({owner:false,agent:run});await h.flush();assert.match(h.root.innerHTML,/Preparing game plan/);assert.match(h.root.innerHTML,/Reserved \/ unresolved/);
  assert.doesNotMatch(h.root.innerHTML,/data-agent-start-form|data-agent-pause/);assert.equal(h.requests.some(item=>item.method==='POST'),false);
});
test('explicit Start submits the selected cap and artwork choices once',async()=>{
  const h=fixture();await h.flush();const form=h.root.querySelector('[data-agent-start-form]');form.querySelector('[name="budgetUsd"]').value='0.90';form.querySelector('[name="includeConcept"]').checked=true;form.querySelector('[name="includeThumbnail"]').checked=false;
  await h.submit();const writes=h.requests.filter(item=>item.method==='POST');assert.deepEqual(writes.map(item=>item.url),['/api/builds/build-one/agent/start']);assert.deepEqual(writes[0].body,{budgetUsd:.9,includeConcept:true,includeThumbnail:false,includeVisualReview:true});assert.match(h.root.innerHTML,/data-agent-pause/);assert.doesNotMatch(h.root.innerHTML,/data-agent-start-form/);
});
test('invalid budgets and a changed creator permission prevent starting',async()=>{
  for(const cap of ['0','1.01','not-a-number']){const h=fixture();await h.flush();h.root.querySelector('[data-agent-start-form]').querySelector('[name="budgetUsd"]').value=cap;await h.submit();assert.match(h.root.innerHTML,/no more than \$1/);assert.equal(h.requests.some(item=>item.method==='POST'),false);}
  const h=fixture({serverOwner:false});await h.flush();await h.submit();assert.match(h.root.innerHTML,/Only the project creator/);assert.equal(h.requests.some(item=>item.method==='POST'),false);
});
test('Pause reports a safe boundary without claiming the running step was cancelled',async()=>{
  const h=fixture({agent:run});await h.flush();await h.root.querySelector('[data-agent-pause]').onclick();assert.match(h.root.innerHTML,/Pausing safely/);assert.match(h.root.innerHTML,/current paid request or Studio step may finish/);
  assert.deepEqual(h.requests.filter(item=>item.method==='POST').map(item=>item.url),['/api/builds/build-one/agent/pause']);assert.doesNotMatch(h.root.innerHTML,/data-agent-start-form/);
});
test('resuming a paused run preserves its original cap and artwork choices',async()=>{
  const h=fixture({agent:{...run,status:'paused',budgetUsd:.6,includeConcept:false,includeThumbnail:true}});await h.flush();const form=h.root.querySelector('[data-agent-start-form]');assert.equal(form.querySelector('[name="budgetUsd"]').disabled,true);
  form.querySelector('[name="budgetUsd"]').value='1';await h.submit();const request=h.requests.find(item=>item.url.endsWith('/agent/start'));assert.deepEqual(request.body,{budgetUsd:.6,includeConcept:false,includeThumbnail:true,includeVisualReview:false});
});
test('review, failed and interrupted runs never offer an automatic restart',async()=>{
  for(const status of ['review','failed','interrupted']){const h=fixture({agent:{...run,status,stage:status==='review'?'review':'failure'}});await h.flush();assert.doesNotMatch(h.root.innerHTML,/data-agent-start-form|data-agent-pause/);assert.equal(h.requests.some(item=>item.method==='POST'),false);if(status==='review')assert.match(h.root.innerHTML,/creator review/i);else assert.match(h.root.innerHTML,/not retried automatically/);}
});
test('unknown provider charges are disclosed as estimates counted toward the cap',async()=>{
  const h=fixture({agent:{...run,spentUsd:.45,unknownChargeUsd:.25,unknownChargeCount:1}});await h.flush();
  assert.match(h.root.innerHTML,/Counted toward cap/);assert.match(h.root.innerHTML,/Includes \$0\.25 in conservative estimates for 1 request with unconfirmed charges/);assert.match(h.root.innerHTML,/not an exact billed total/);assert.doesNotMatch(h.root.innerHTML,/Recorded spend/);
  const known=fixture({agent:{...run,unknownChargeUsd:0,unknownChargeCount:0}});await known.flush();assert.doesNotMatch(known.root.innerHTML,/unconfirmed charges/);
});
test('structured agent errors display their message instead of an object placeholder',async()=>{
  const h=fixture({agent:{...run,status:'failed',stage:'failure',error:{code:'COMPUTE_CREDITS_EXHAUSTED',message:'The project allowance cannot cover this request'}}});await h.flush();
  assert.match(h.root.innerHTML,/The project allowance cannot cover this request/);assert.doesNotMatch(h.root.innerHTML,/\[object Object\]/);
});
test('new workflows explicitly include visual review by default without scheduling recurring work',async()=>{
  const h=fixture();await h.flush();const form=h.root.querySelector('[data-agent-start-form]');
  assert.equal(form.querySelector('[name="includeVisualReview"]').checked,true);assert.match(h.root.innerHTML,/Review screenshots and improve once/);assert.match(h.root.innerHTML,/dedicated project worker/);assert.match(h.root.innerHTML,/No recurring tasks or new chats/);
  assert.equal(h.requests.some(item=>item.method==='POST'),false);
});
test('older backends cannot start a visual run, including when support changes before the click',async()=>{
  const h=fixture({visualEnabled:false});await h.flush();assert.match(h.root.innerHTML,/activate screenshot review/);assert.equal(h.root.querySelector('[data-agent-start-form]').querySelector('button[type="submit"]').disabled,true);
  await h.submit();assert.equal(h.requests.some(item=>item.method==='POST'),false);
  const fresh=fixture();await fresh.flush();fresh.setVisualEnabled(false);await fresh.submit();assert.match(fresh.root.innerHTML,/activate screenshot review/);assert.equal(fresh.requests.some(item=>item.method==='POST'),false);
});
test('creators may explicitly choose a non-visual run on an older autonomous backend',async()=>{
  const h=fixture({visualEnabled:false});await h.flush();const visual=h.root.querySelector('[data-agent-start-form]').querySelector('[name="includeVisualReview"]');visual.checked=false;visual.onchange();
  assert.equal(h.root.querySelector('[data-agent-start-form]').querySelector('button[type="submit"]').disabled,false);await h.submit();assert.equal(h.requests.find(item=>item.url.endsWith('/agent/start')).body.includeVisualReview,false);
});
test('paused legacy workflows never gain visual review silently and modern choices stay immutable',async()=>{
  for(const includeVisualReview of [undefined,true]){
    const h=fixture({agent:{...run,status:'paused',includeVisualReview}});await h.flush();const option=h.root.querySelector('[data-agent-start-form]').querySelector('[name="includeVisualReview"]');assert.equal(option.disabled,true);assert.equal(option.checked,includeVisualReview===true);option.checked=!option.checked;
    await h.submit();assert.equal(h.requests.find(item=>item.url.endsWith('/agent/start')).body.includeVisualReview,includeVisualReview===true);
  }
});
test('visual feedback exposes a bounded public assessment, provenance links and the improved version',async()=>{
  const h=fixture({owner:false,agent:{...run,stage:'visual_review',currentBuildId:'child-version',visualRevisionCount:1,visualReviews:[{buildId:'build-one',modelId:'anthropic/claude-opus-5.5',reviewedAt:1700000000000,result:{version:1,verdict:'improve',summary:'The route has weak contrast <script>bad</script>',issues:[{category:'readability',description:'Finish needs a brighter color'}],revisionBrief:'Brighten the finish while preserving the route',reasoning:'PRIVATE_REASONING'},sourceFrames:[{view:'overview',hash:'a'.repeat(64),capturedAt:1000},{view:'javascript:bad',hash:'b'.repeat(64)}]}]}});
  await h.flush();assert.match(h.root.innerHTML,/Inspecting Studio captures/);assert.match(h.root.innerHTML,/Improvements identified/);assert.match(h.root.innerHTML,/Claude Opus 5.5/);assert.match(h.root.innerHTML,/Finish needs a brighter color/);assert.match(h.root.innerHTML,/Next build instructions/);assert.match(h.root.innerHTML,/href="#\/build\/child-version"/);
  assert.match(h.root.innerHTML,/\/api\/builds\/build-one\/screen\?view=overview&amp;v=aaaaaaaa/);assert.match(h.root.innerHTML,/does not replace a full gameplay test/);assert.match(h.root.innerHTML,/&lt;script&gt;bad&lt;\/script&gt;/);assert.doesNotMatch(h.root.innerHTML,/PRIVATE_REASONING|<script>|javascript:bad|data-agent-start-form/);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createApp}=require('./parallax/server.cjs');
const {createTemplatePlan}=require('./parallax/roblox-builds.cjs');
const MODEL={id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5',architecture:{input_modalities:['text'],output_modalities:['text']},pricing:{prompt:'0.0000001',completion:'0.0000001'}};
const SAFE_WORKER={workerId:'worker-1',studioId:'studio-1',status:'idle',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true};
const fixturePlan=()=>({...createTemplatePlan('obby'),design:{coreLoop:'Jump and collect',objective:'Reach the finish',progression:'Touch checkpoint platforms',inspiration:'Original obstacle course',limitations:['Creator playtest and publishing remain'],acceptanceCriteria:['Safe spawn','Checkpoints work','Coins collected','Finish works'],unsupportedFeatures:[]}});

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'parallax-pool-http-'));
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  let clock=100000;
  const app=createApp({port,stateDirectory:dir,key:'OFFLINE_ONLY',orbioKey:'',cameraWorkers:false,monitor:false,models:[MODEL],now:()=>clock,fetcher:async()=>Response.json({choices:[{message:{content:JSON.stringify(fixturePlan())},finish_reason:'stop'}],usage:{cost:.0002}})});
  await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port;
  const csrf=(await(await fetch(base+'/api/status')).json()).csrf;
  async function request(endpoint,{body,headers={},cookie='',browser=false}={}){
    const raw=Buffer.isBuffer(body);
    const response=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{Connection:'close',...(browser?{Origin:base,'X-Parallax-Token':csrf,Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':raw?'image/png':'application/json'}:{}),...headers},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
    const content=await response.text();let data;try{data=JSON.parse(content);}catch{}
    return {status:response.status,data,text:content,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  await request('/api/builds/pool');
  const poolKey=fs.readFileSync(path.join(dir,'studio-pool.key'),'utf8').trim();
  const pool=(endpoint,body,headers={})=>request('/api/builds/pool/'+endpoint,{body,headers:{Authorization:'Bearer '+poolKey,...headers}});
  const owner=async()=>{const identity=await request('/api/builds/config',{browser:true});return (endpoint,body,headers={})=>request(endpoint,{body,browser:true,cookie:identity.cookie,headers});};
  const make=async(client,name='Queue test')=>{const created=await client('/api/builds',{gameName:name,brief:'A short obstacle course with checkpoints and a finish',modelId:MODEL.id});assert.equal(created.status,201,created.text);const id=created.data.build.id;const planned=await client('/api/builds/'+id+'/generate',{});assert.equal(planned.status,200,planned.text);return id;};
  return {request,pool,poolKey,owner,make,tick:n=>clock+=n};
}

test('pool control needs a separate credential and rejects browser origins; public status contains no secrets',async t=>{
  const h=await fixture(t);
  assert.equal((await h.request('/api/builds/pool/presence',{body:{workerId:'w1',studioId:'s1',status:'idle'}})).status,401);
  assert.equal((await h.pool('presence',{workerId:'w1',studioId:'s1',status:'idle'},{Origin:'http://127.0.0.1'})).status,403);
  assert.equal((await h.pool('presence',{workerId:'w1',studioId:'s1',status:'idle'})).status,200);
  const status=await h.request('/api/builds/pool');assert.equal(status.status,200);assert.equal(status.data.capacity,2);assert.equal(status.data.workers[0].online,true);
  assert.equal(status.text.includes(h.poolKey),false);assert.doesNotMatch(status.text,/leaseToken|workerHash|owner/);
});

test('owner submits or cancels jobs; independent worker claims, captures and completes a job',async t=>{
  const h=await fixture(t),owner=await h.owner(),other=await h.owner(),id=await h.make(owner),url='/api/builds/'+id;
  assert.equal((await other(url+'/enqueue',{})).status,403);
  assert.equal((await owner(url+'/enqueue',{}, {'X-Parallax-Token':'wrong'})).status,403);
  assert.equal((await h.pool('presence',SAFE_WORKER)).status,200);
  assert.equal((await owner(url+'/enqueue',{})).status,200);
  assert.equal((await owner(url+'/connect',{})).status,409);
  const claimed=await h.pool('claim',{workerId:'worker-1',studioId:'studio-1'});assert.equal(claimed.status,200,claimed.text);
  const job=claimed.data.job;assert.equal(job.buildId,id);assert.ok(job.plan.parts.length>0);
  const lease={leaseId:job.leaseId,leaseToken:job.leaseToken};
  assert.equal((await owner(url+'/cancel-queue',{})).status,409);
  assert.equal((await h.pool('heartbeat',{...lease,leaseToken:'0'.repeat(64)})).status,401);
  assert.equal((await h.pool('heartbeat',lease)).status,200);
  assert.equal((await h.pool('report',{...lease,status:'building',objectCount:10,message:'Ten real objects created'})).status,200);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(56)]);
  const frame=await h.pool('screen',png,{'X-Parallax-Lease':job.leaseId,'X-Parallax-Lease-Token':job.leaseToken});assert.equal(frame.status,200,frame.text);
  const bad=await h.pool('report',{...lease,status:'ready',objectCount:job.plan.parts.length});assert.equal(bad.status,400);
  assert.equal((await h.pool('report',{...lease,status:'ready',objectCount:job.plan.parts.length+1,message:'Scene assembled'})).status,200);
  const result=await owner(url);assert.equal(result.data.build.status,'ready');assert.equal(result.data.build.queue.state,'completed');assert.equal(result.data.build.published,false);
  const late=await h.pool('report',{...lease,status:'failed',message:'late'});assert.ok([401,409].includes(late.status));
});

test('download returns an actual XML place; secret fields cannot enter delivery or unknown formats',async t=>{
  const h=await fixture(t),owner=await h.owner(),id=await h.make(owner);
  const build=(await owner('/api/builds/'+id)).data.build;
  assert.equal(build.delivery.available,true);assert.equal(build.delivery.kind,'generated_project');
  const file=await h.request(build.delivery.url);assert.equal(file.status,200,file.text);assert.match(file.text,/<roblox/);assert.match(file.text,/class="Script"/);assert.match(file.headers.get('content-disposition'),/\.rbxlx/);
  assert.equal(file.text.includes(h.poolKey),false);assert.doesNotMatch(file.text,/https?:\/\/|workerToken|leaseToken/);
  assert.equal((await h.request('/api/builds/'+id+'/artifact?format=exe')).status,400);
  assert.equal((await h.pool('presence',SAFE_WORKER)).status,200);
  assert.equal((await owner('/api/builds/'+id+'/enqueue',{})).status,200);
  assert.equal((await owner('/api/builds/'+id+'/cancel-queue',{})).status,200);
  assert.equal((await h.pool('claim',{workerId:'worker-1',studioId:'studio-1'})).data.job,null);
});

test('manual queues require authenticated one-build worker capability and claim payloads cannot bypass it',async t=>{
  const h=await fixture(t),owner=await h.owner(),id=await h.make(owner),url='/api/builds/'+id;
  const config=(await owner('/api/builds/config')).data;assert.equal(config.manualQueueRequiresAgentWorker,true);assert.equal(config.oneBuildPerStudio,true);
  assert.equal((await owner(url+'/enqueue',{requireAgentWorker:false})).status,409);
  assert.equal((await h.pool('presence',{workerId:'legacy',studioId:'legacy'})).status,200);
  const {oneBuildPerStudio,...oldProtocol}=SAFE_WORKER;
  assert.equal((await h.pool('presence',oldProtocol)).status,400);
  assert.equal((await h.pool('presence',{...SAFE_WORKER,oneBuildPerStudio:false})).status,400);
  assert.equal((await owner(url+'/enqueue',{requireAgentWorker:false})).status,409);
  assert.equal((await h.pool('presence',SAFE_WORKER)).status,200);
  const queued=await owner(url+'/enqueue',{requireAgentWorker:false});assert.equal(queued.status,200,queued.text);assert.equal(queued.data.build.queue.requireAgentWorker,true);
  const forged=await h.pool('claim',{...SAFE_WORKER,workerId:'legacy',studioId:'legacy'});assert.equal(forged.data.job,null);
  const valid=await h.pool('claim',{workerId:SAFE_WORKER.workerId,studioId:SAFE_WORKER.studioId});assert.equal(valid.data.job.buildId,id);
});

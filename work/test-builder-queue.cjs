'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRobloxBuildService,createTemplatePlan,validatePlan} = require('./parallax/roblox-builds.cjs');
const owner = 'queue-test-owner';
function fixture(t, options = {}) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(),'parallax-queue-'));
  t.after(()=>fs.rmSync(stateDirectory,{recursive:true,force:true}));
  let time = 1_800_000_000_000;
  const config = {stateDirectory,now:()=>time,...options};
  const service = createRobloxBuildService(config);
  const create = (name = 'Queue game') => service.create({owner,gameName:name,brief:'Build a compact obstacle course',template:'obby'});
  const enqueue = name => {const build=create(name);service.prepare({id:build.id,owner});modernPresence(service,1);modernPresence(service,2);return service.enqueue({id:build.id,owner});};
  return {service,create,enqueue,config,tick:n=>time+=n};
}
function lease(service, worker = 1) { return service.claim({workerId:`worker-${worker}`,studioId:`studio-${worker}`}); }
function modernPresence(service, worker = 1, status = 'idle') { return service.workerPresence({workerId:`worker-${worker}`,studioId:`studio-${worker}`,status,agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true}); }

test('worker plans keep the v1 geometry contract while public artifacts retain validated design metadata',t=>{
  const {service,create}=fixture(t);
  const design={coreLoop:'Jump between platforms',objective:'Reach the finish',progression:'Complete the checkpoint route',inspiration:'Original sky world',limitations:['Human playtest remains'],acceptanceCriteria:['Safe spawn','Reachable checkpoints','Coins collected','Finish works'],unsupportedFeatures:[]};
  const plan={...createTemplatePlan('obby'),design};
  const prepare=()=>{const build=create();service.prepare({id:build.id,owner,plan,source:'ai',modelId:'anthropic/claude-opus-5.5'});return build;};
  const pooled=prepare();modernPresence(service);service.enqueue({id:pooled.id,owner});const claimed=lease(service);
  const manual=prepare(),{workerToken}=service.issueWorkerToken({id:manual.id,owner});const polled=service.poll({id:manual.id,workerToken});
  const geometry={version:plan.version,template:plan.template,summary:plan.summary,parts:plan.parts};
  for(const workerPlan of [claimed.plan,polled.job.plan]){
    assert.deepEqual(Object.keys(workerPlan).sort(),['parts','summary','template','version']);
    assert.deepEqual(workerPlan,geometry);assert.deepEqual(validatePlan(workerPlan),geometry);
  }
  for(const build of [pooled,manual]){
    assert.deepEqual(service.get(build.id).plan.design,design);
    assert.deepEqual(JSON.parse(service.artifact({id:build.id,format:'json'}).content).design,design);
  }
  const invalid=create();
  assert.throws(()=>service.prepare({id:invalid.id,owner,plan:{...plan,design:{...design,executable:'not allowed'}},source:'ai'}),/game design fields/);
  assert.throws(()=>service.prepare({id:invalid.id,owner,plan:{...plan,parts:plan.parts.map((part,index)=>index ? part : {...part,source:'not allowed'})},source:'ai'}),/Unsupported part fields/);
  assert.equal(service.get(invalid.id).plan,null);
});
test('only owners can enqueue prepared plans, and duplicate submission is idempotent',t=>{
  const {service,create}=fixture(t); const b=create();
  assert.throws(()=>service.enqueue({id:b.id,owner}),/Prepare/);
  service.prepare({id:b.id,owner});
  assert.throws(()=>service.enqueue({id:b.id,owner:'attacker'}),/belongs/);
  assert.throws(()=>service.enqueue({id:b.id,owner,requireAgentWorker:false}),{code:'AGENT_WORKER_REQUIRED'});modernPresence(service);
  const queued=service.enqueue({id:b.id,owner});assert.equal(queued.queue.position,1);
  const again=service.enqueue({id:b.id,owner});assert.equal(again.events.length,queued.events.length);
  assert.equal(service.queueStatus().queued,1);
});
test('durable FIFO queue assigns at most two unique Studio workers without duplicate claims',t=>{
  const {service,enqueue,config,tick}=fixture(t);
  const a=enqueue('A');tick(1);const b=enqueue('B');tick(1);const c=enqueue('C');
  assert.equal(service.get(c.id).queue.position,3);
  const one=lease(service,1);const two=lease(service,2);
  assert.equal(one.buildId,a.id);assert.equal(two.buildId,b.id);
  assert.equal(lease(service,3),null);assert.equal(lease(service,1),null);
  assert.throws(()=>service.claim({workerId:'worker-4',studioId:'studio-1'}),/active lease/);
  const restart=createRobloxBuildService(config);
  assert.equal(restart.queueStatus().active,2);assert.equal(restart.get(c.id).queue.position,1);
  assert.equal(lease(restart,3),null);
  assert.match(one.artifactLuau,/ParallaxGameplay/);assert.equal(one.scriptSources.length,1);
});
test('lease tokens are private, hashed on disk, and scoped to exactly one build',t=>{
  const {service,enqueue,config}=fixture(t);enqueue('A');enqueue('B');
  const one=lease(service,1),two=lease(service,2);
  assert.match(one.leaseToken,/^[a-f0-9]{64}$/);
  const publicJson=JSON.stringify([service.list(),service.queueStatus()]);
  for(const secret of [one.leaseToken,two.leaseToken,'tokenHash','poolLease']) assert.equal(publicJson.includes(secret),false);
  assert.equal(fs.readFileSync(path.join(config.stateDirectory,'roblox-builds','sessions.json'),'utf8').includes(one.leaseToken),false);
  assert.throws(()=>service.heartbeat({leaseId:one.leaseId,leaseToken:two.leaseToken}),/Invalid Studio worker lease/);
  assert.throws(()=>service.report({...one,leaseToken:'invalid',status:'ready',objectCount:one.plan.parts.length+1}),/Invalid Studio worker lease/);
});
test('heartbeat extends the lease; expiry fails a claimed job and never automatically retries it',t=>{
  const {service,enqueue,config,tick}=fixture(t);const b=enqueue();const one=lease(service);
  tick(50_000);const renewed=service.heartbeat(one);assert.equal(renewed.leaseExpiresAt,one.leaseExpiresAt+50_000);
  tick(20_000);assert.equal(service.queueStatus().active,1);
  const restart=createRobloxBuildService(config);tick(40_000);
  assert.equal(restart.queueStatus().active,0);assert.equal(restart.get(b.id).queue.state,'failed');
  assert.equal(restart.get(b.id).queue.failureReason,'lease_expired');
  assert.throws(()=>restart.heartbeat(one),/closed/);
  assert.throws(()=>restart.report({...one,status:'ready',objectCount:one.plan.parts.length+1}),/closed/);
  assert.throws(()=>restart.enqueue({id:b.id,owner}),/closed/);
  assert.equal(lease(restart,2),null);assert.equal(restart.queueStatus().queued,0);
});
test('only queued entries can be cancelled; cancelling cannot abort an executing Studio change',t=>{
  const {service,enqueue}=fixture(t);const a=enqueue('A'),b=enqueue('B');lease(service);
  assert.throws(()=>service.cancelQueued({id:a.id,owner}),/Only a waiting/);
  assert.throws(()=>service.cancelQueued({id:b.id,owner:'attacker'}),/belongs/);
  assert.equal(service.cancelQueued({id:b.id,owner}).queue.state,'cancelled');
  assert.equal(service.queueStatus().queued,0);
  assert.equal(service.enqueue({id:b.id,owner}).queue.state,'queued');
});
test('manual bridge and pool cannot execute the same job',t=>{
  const {service,create,tick}=fixture(t);const b=create();service.prepare({id:b.id,owner});
  const manual=service.issueWorkerToken({id:b.id,owner});service.poll({id:b.id,workerToken:manual.workerToken});
  assert.throws(()=>service.enqueue({id:b.id,owner}),/Disconnect the manual/);
  tick(46_000);modernPresence(service);service.enqueue({id:b.id,owner});
  assert.throws(()=>service.issueWorkerToken({id:b.id,owner}),/worker pool/);
  assert.throws(()=>service.poll({id:b.id,workerToken:manual.workerToken}),/missing or expired/);
  const one=lease(service);assert.throws(()=>service.issueWorkerToken({id:b.id,owner}),/worker pool/);
  service.report({...one,status:'ready',objectCount:one.plan.parts.length+1});
  assert.throws(()=>service.issueWorkerToken({id:b.id,owner}),/worker pool/);
});
test('reports require exact object count, monotonic progress, and explicit terminal acknowledgment',t=>{
  const {service,enqueue}=fixture(t);const b=enqueue();const one=lease(service);
  service.report({...one,status:'building',objectCount:10});
  assert.throws(()=>service.report({...one,status:'building',objectCount:9}),/decreasing/);
  assert.throws(()=>service.report({...one,status:'ready',objectCount:one.plan.parts.length}),/expected assembled/);
  assert.throws(()=>service.report({...one,status:'invented'}),/Invalid worker status/);
  const completed=service.report({...one,status:'ready',objectCount:one.plan.parts.length+1,playtest:{result:'passed',message:'Runtime smoke check only'}});
  assert.equal(completed.queue.state,'completed');assert.equal(completed.playtested,false);assert.equal(completed.playtestReport.independentlyVerified,false);
  assert.equal(completed.playtestReport.result,'passed');assert.equal(service.queueStatus().active,0);
  assert.throws(()=>service.report({...one,status:'failed'}),/closed/);
  assert.throws(()=>service.heartbeat(one),/closed/);
  assert.throws(()=>service.enqueue({id:b.id,owner}),/closed/);
});
test('failure releases capacity without replaying the failed job',t=>{
  const {service,enqueue}=fixture(t);const a=enqueue('A'),b=enqueue('B'),c=enqueue('C');
  const one=lease(service,1);lease(service,2);
  const failed=service.report({...one,status:'failed',message:'Studio rejected the command'});
  assert.equal(failed.id,a.id);assert.equal(failed.queue.state,'failed');
  modernPresence(service,3);assert.equal(lease(service,3).buildId,c.id);assert.equal(service.get(b.id).queue.state,'claimed');
});
test('authenticated frames belong to the claimed worker and terminal leases cannot overwrite them',t=>{
  const {service,enqueue}=fixture(t);const b=enqueue(),one=lease(service);
  const bytes=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  assert.throws(()=>service.workerScreenshot({...one,leaseToken:'bad',bytes,contentType:'image/png'}),/Invalid Studio/);
  assert.throws(()=>service.workerScreenshot({...one,bytes,contentType:'image/svg+xml'}),/PNG or JPEG/);
  const screen=service.workerScreenshot({...one,bytes,contentType:'image/png'});assert.equal(screen.source,'pooled_studio_worker');
  assert.throws(()=>service.screenshot({id:b.id,owner,bytes,contentType:'image/png'}),/owns this active screen/);
  assert.throws(()=>service.stopScreen({id:b.id,owner}),/owns this active screen/);
  service.report({...one,status:'ready',objectCount:one.plan.parts.length+1});
  assert.throws(()=>service.workerScreenshot({...one,bytes,contentType:'image/png'}),/closed/);
});
test('idle worker presence and stale status expose availability without inventing sessions',t=>{
  const {service,enqueue,tick}=fixture(t);
  assert.equal(service.queueStatus().workers.length,0);
  service.workerPresence({workerId:'worker-1',studioId:'studio-1',status:'idle'});
  let worker=service.queueStatus().workers[0];assert.equal(worker.online,true);assert.equal(worker.status,'idle');assert.equal(worker.buildId,null);
  tick(46_000);assert.equal(service.queueStatus().workers[0].online,false);
  enqueue();lease(service);worker=service.queueStatus().workers[0];assert.equal(worker.status,'busy');assert.equal(worker.online,true);
  assert.throws(()=>service.workerPresence({workerId:'worker-2',studioId:'studio-1'}),/active lease/);
});
test('worker capacity is explicit and bounded',t=>{
  const {service,enqueue,config}=fixture(t,{workerCapacity:1});enqueue('A');enqueue('B');lease(service,1);
  assert.equal(lease(service,2),null);assert.equal(service.queueStatus().capacity,1);
  assert.throws(()=>createRobloxBuildService({...config,workerCapacity:0}),/workerCapacity/);
});

test('autonomous enqueue requires a validated fresh idle dedicated worker and preserves its capability',t=>{
  const {service,create,config,tick}=fixture(t),build=create();
  assert.equal(service.canAutoEnqueue(build.id).eligible,false);service.prepare({id:build.id,owner});
  assert.throws(()=>service.enqueue({id:build.id,owner,requireAgentWorker:true}),{code:'AGENT_WORKER_REQUIRED'});
  service.workerPresence({workerId:'legacy',studioId:'legacy'});assert.equal(service.canAutoEnqueue(build.id).eligible,false);
  for(const capability of [{agentProtocol:1},{agentProtocol:2,planSchema:'scene-v1',dedicatedStudio:true},{agentProtocol:1,planSchema:'scene-v2',dedicatedStudio:true},{agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:false},{agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true},{agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:false}]) {
    assert.throws(()=>service.workerPresence({workerId:'candidate',studioId:'candidate',...capability}),{code:'INVALID_WORKER_CAPABILITY'});
  }
  modernPresence(service,1,'busy');assert.equal(service.queueStatus().workers.find(w=>w.workerId==='worker-1').status,'busy');assert.equal(service.canAutoEnqueue(build.id).eligible,false);
  modernPresence(service);assert.deepEqual(service.canAutoEnqueue(build.id),{eligible:true,reason:null});
  const restarted=createRobloxBuildService(config),worker=restarted.queueStatus().workers.find(w=>w.workerId==='worker-1');
  assert.equal(worker.agentProtocol,1);assert.equal(worker.planSchema,'scene-v1');assert.equal(worker.dedicatedStudio,true);assert.equal(worker.oneBuildPerStudio,true);assert.equal(worker.agentCompatible,true);
  tick(45_000);assert.equal(restarted.canAutoEnqueue(build.id).eligible,false);assert.equal(restarted.queueStatus().workers.find(w=>w.workerId==='worker-1').agentCompatible,false);
  assert.throws(()=>restarted.enqueue({id:build.id,owner,requireAgentWorker:true}),{code:'AGENT_WORKER_REQUIRED'});
  assert.equal(restarted.get(build.id).queue,null);
});

test('old workers cannot claim agent, manual, or legacy waiting jobs after restart',t=>{
  const {service,create,enqueue,config,tick}=fixture(t),build=create('Agent build');service.prepare({id:build.id,owner});modernPresence(service,9);
  service.enqueue({id:build.id,owner,requireAgentWorker:true});tick(1);const manual=enqueue('Manual build');
  const file=path.join(config.stateDirectory,'roblox-builds','sessions.json'),stored=JSON.parse(fs.readFileSync(file,'utf8'));
  delete stored.sessions.find(s=>s.id===manual.id).queue.requireAgentWorker;
  const previousWorker=stored.poolWorkers.find(w=>w.workerId==='worker-1');delete previousWorker.oneBuildPerStudio;
  fs.writeFileSync(file,JSON.stringify(stored));
  const restarted=createRobloxBuildService(config);assert.equal(restarted.get(build.id).queue.requireAgentWorker,true);assert.equal(restarted.queueStatus().workers.find(w=>w.workerId==='worker-1').agentCompatible,false);
  // A claim payload cannot self-declare compatibility; only authenticated presence registers it.
  const old=restarted.claim({workerId:'old',studioId:'old',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true});
  assert.equal(old,null);assert.equal(lease(restarted,1),null);assert.equal(restarted.get(build.id).queue.state,'queued');assert.equal(restarted.get(manual.id).queue.state,'queued');
  assert.equal(lease(restarted,8),null);assert.equal(lease(restarted,9).buildId,build.id);
  assert.equal(restarted.get(build.id).queue.requireAgentWorker,true);
  assert.equal(lease(restarted,2).buildId,manual.id);assert.equal(restarted.get(manual.id).queue.requireAgentWorker,true);
});

test('claim polling cannot refresh stale capabilities or inherit them for a different Studio',t=>{
  const {service,create,tick}=fixture(t),build=create();service.prepare({id:build.id,owner});modernPresence(service);
  service.enqueue({id:build.id,owner,requireAgentWorker:true});tick(45_001);
  assert.equal(lease(service),null);const stale=service.queueStatus().workers[0];assert.equal(stale.online,true);assert.equal(stale.agentCompatible,false);
  assert.equal(service.canAutoEnqueue(build.id).eligible,false);
  modernPresence(service);assert.equal(service.canAutoEnqueue(build.id).eligible,true);
  assert.equal(service.claim({workerId:'worker-1',studioId:'different-studio'}),null);
  assert.equal(service.queueStatus().workers[0].agentCompatible,false);
  modernPresence(service);service.workerPresence({workerId:'worker-1',studioId:'studio-1'});
  assert.equal(lease(service),null);assert.equal(service.queueStatus().workers[0].agentProtocol,0);
  modernPresence(service);assert.equal(lease(service).buildId,build.id);
});

test('autonomous requirements cannot be downgraded by duplicate or cancelled manual enqueues',t=>{
  const {service,create,tick}=fixture(t),build=create();service.prepare({id:build.id,owner});modernPresence(service);
  service.enqueue({id:build.id,owner,requireAgentWorker:true});tick(46_000);
  assert.equal(service.enqueue({id:build.id,owner}).queue.requireAgentWorker,true);
  service.cancelQueued({id:build.id,owner});assert.throws(()=>service.enqueue({id:build.id,owner}),{code:'AGENT_WORKER_REQUIRED'});
  modernPresence(service);assert.equal(service.enqueue({id:build.id,owner}).queue.requireAgentWorker,true);
  assert.throws(()=>service.enqueue({id:build.id,owner,requireAgentWorker:'true'}),/Invalid autonomous worker requirement/);
});

test('manual waiting jobs can be upgraded while capacity, active leases and failed jobs prevent autonomous replay',t=>{
  const {service,create,enqueue}=fixture(t,{workerCapacity:1}),manual=enqueue();modernPresence(service);
  assert.equal(service.enqueue({id:manual.id,owner,requireAgentWorker:true}).queue.requireAgentWorker,true);
  const current=lease(service),next=create();service.prepare({id:next.id,owner});modernPresence(service,2);
  assert.equal(service.canAutoEnqueue(next.id).eligible,false);assert.throws(()=>service.enqueue({id:next.id,owner,requireAgentWorker:true}),{code:'AGENT_WORKER_REQUIRED'});
  service.report({...current,status:'failed',message:'Uncertain initialization — do not replay'});
  assert.equal(service.canAutoEnqueue(manual.id).eligible,false);assert.throws(()=>service.enqueue({id:manual.id,owner,requireAgentWorker:true}),{code:'BUILD_LOCKED'});
  assert.equal(service.canAutoEnqueue(next.id).eligible,true);
});

test('malformed durable worker capability or queue requirements fail closed on reload',t=>{
  for(const mutate of [state=>{state.poolWorkers[0].agentProtocol=2;},state=>{state.poolWorkers[0].oneBuildPerStudio='true';},state=>{state.sessions[0].queue.requireAgentWorker='false';}]) {
    const {service,create,config}=fixture(t),build=create();service.prepare({id:build.id,owner});modernPresence(service);service.enqueue({id:build.id,owner,requireAgentWorker:true});
    const file=path.join(config.stateDirectory,'roblox-builds','sessions.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));mutate(state);const changed=JSON.stringify(state);fs.writeFileSync(file,changed);
    assert.throws(()=>createRobloxBuildService(config),{code:'BUILD_STORAGE_UNAVAILABLE'});assert.equal(fs.readFileSync(file,'utf8'),changed);
  }
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createBuilderAgentService,FILE_NAME}=require('./parallax/builder-agent.cjs');
const {createRobloxBuildService,createTemplatePlan}=require('./parallax/roblox-builds.cjs');
const MODEL='anthropic/claude-opus-5.5',OWNER='agent-creator';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const design={coreLoop:'Jump between platforms',objective:'Reach the finish',progression:'Ordered checkpoints',inspiration:'Original sky course',limitations:['Creator review and publication remain manual'],unsupportedFeatures:[],acceptanceCriteria:['Safe spawn','Reachable checkpoints','Replay after finish','Finish reports completion']};
const plan=()=>({...createTemplatePlan('obby'),design:structuredClone(design)});
function fixture(t,options={}) {
  const stateDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-agent-'));t.after(()=>fs.rmSync(stateDirectory,{recursive:true,force:true}));
  let clock=1800000000000,planCalls=0,imageCalls=0,reviewCalls=0;
  const now=()=>clock,builds=createRobloxBuildService({stateDirectory,now});
  const build=builds.create({owner:OWNER,gameName:'Cloud Steps',brief:options.brief || 'Build an original course with checkpoints and a clear finish',template:'auto',modelId:MODEL});
  const generatePlan=async args=>{planCalls++;if(options.plan)return options.plan(args,planCalls);const release=args.reserve(.25);try{args.settle(.25,.1);return plan();}finally{release();}};
  const generateConcept=async args=>{imageCalls++;if(options.image)return options.image(args,imageCalls);const release=args.reserve(.048),metadata={purpose:args.purpose,modelId:'fixture/image',modelName:'Offline image fixture',prompt:'An original visual target',artDirection:'',estimatedCostUsd:.048};try{args.onStart(metadata);args.settle(.048,.048);return {...metadata,bytes:PNG,contentType:'image/png',costUsd:.048,generatedAt:now()};}finally{release();}};
  const config={stateDirectory,getBuilds:()=>builds,generatePlan,generateConcept,...(options.review?{reviewVisual:async args=>{reviewCalls++;return options.review(args,reviewCalls);}}:{}),provider:'fixture',now,canEnqueue:(b,flags)=>builds.canAutoEnqueue(b.id,flags)};
  const agent=createBuilderAgentService(config),id=build.id;
  return {agent,builds,build,id,stateDirectory,config,now,advance:n=>clock+=n,get planCalls(){return planCalls;},get imageCalls(){return imageCalls;},get reviewCalls(){return reviewCalls;},start:args=>agent.start({id,owner:OWNER,...args}),current:()=>agent.get(id,{owner:OWNER}),worker:()=>builds.workerPresence({workerId:'agent-worker',studioId:'agent-studio',status:'idle',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1})};
}
async function until(f,predicate,limit=30) {for(let i=0;i<limit && !predicate();i++)await f.agent.tick();assert.ok(predicate(),'Expected agent boundary was not reached');}
async function queued(f,id=f.current().currentBuildId) {f.worker();await until(f,()=>f.builds.get(id).queue?.state==='queued');}
function finish(f,result='passed',capture=true) {const job=f.builds.claim({workerId:'agent-worker',studioId:'agent-studio'});assert.ok(job);if(capture)for(const captureView of ['overview','spawn','finish'])f.builds.workerScreenshot({...job,bytes:PNG,contentType:'image/png',captureView});f.builds.report({...job,status:'ready',objectCount:job.plan.parts.length+1,playtest:{result,message:'Offline worker fixture'}});return job;}

test('explicit owner approval produces plan and art, queues once and stops for human review',async t=>{
  const f=fixture(t);f.start();await queued(f);assert.equal(f.planCalls,1);assert.equal(f.imageCalls,2);
  assert.equal(f.builds.get(f.id).queue.requireAgentWorker,true);const queuedAt=f.builds.get(f.id).queue.queuedAt;
  await f.agent.tick();assert.equal(f.builds.get(f.id).queue.queuedAt,queuedAt);
  finish(f);await until(f,()=>f.current().status==='review');
  assert.equal(f.current().spentUsd,.196);assert.equal(f.current().reservedUsd,0);assert.equal(f.current().publication,'not_published');
  assert.equal(f.builds.get(f.id).published,false);assert.equal(f.builds.get(f.id).creatorReview,undefined);
  assert.equal(f.agent.get(f.id).canManage,false);assert.equal('owner' in f.agent.get(f.id),false);assert.equal('charges' in f.agent.get(f.id),false);
});

test('ownership, approved cap, advanced model and manual exclusion are enforced before work',async t=>{
  const f=fixture(t);assert.throws(()=>f.agent.start({id:f.id,owner:'stranger'}),{status:403});
  for(const budgetUsd of [0,1.01,NaN,'1'])assert.throws(()=>f.start({budgetUsd}));
  const old=f.builds.create({owner:OWNER,gameName:'Legacy',brief:'A legacy template scene',modelId:'template'});assert.throws(()=>f.agent.start({id:old.id,owner:OWNER}),/Opus/);
  f.start();assert.throws(()=>f.agent.assertManualAllowed(f.id),{code:'AGENT_ACTIVE'});
  const duplicate=f.start();assert.equal(duplicate.runId,f.current().runId);assert.equal(f.planCalls,0);
  f.agent.pause({id:f.id,owner:OWNER});assert.equal(f.current().status,'paused');assert.doesNotThrow(()=>f.agent.assertManualAllowed(f.id));
  assert.throws(()=>f.start({budgetUsd:.9}),{code:'AGENT_APPROVAL_UNCHANGED'});f.start();assert.equal(f.current().status,'running');
});

test('budget exhaustion stops before the provider request and cannot refresh the same approval',async t=>{
  let providerRequests=0;const f=fixture(t,{plan:async args=>{const release=args.reserve(.25);try{providerRequests++;args.settle(.25,.2);return plan();}finally{release();}}});
  f.start({budgetUsd:.1});await until(f,()=>f.current().status==='failed');assert.equal(providerRequests,0);assert.equal(f.current().spentUsd,0);
  assert.equal(f.current().error.code,'AGENT_BUDGET_EXHAUSTED');assert.throws(()=>f.start(),{code:'AGENT_REVISION_REQUIRED'});
});

test('pause during a provider request saves its result and cost but starts no next step',async t=>{
  let resolve,entered;const started=new Promise(r=>entered=r);const f=fixture(t,{plan:async args=>{const release=args.reserve(.25);entered();await new Promise(r=>resolve=r);try{args.settle(.25,.1);return plan();}finally{release();}}});
  f.start();await f.agent.tick();const pending=f.agent.tick();await started;
  assert.equal(f.current().reservedUsd,.25);f.agent.pause({id:f.id,owner:OWNER});assert.equal(f.current().status,'running');assert.equal(f.current().pauseRequested,true);
  resolve();await pending;assert.equal(f.current().status,'paused');assert.ok(f.builds.get(f.id).plan);assert.equal(f.current().spentUsd,.1);assert.equal(f.imageCalls,0);
  f.start();await f.agent.tick();assert.equal(f.planCalls,1);assert.equal(f.current().stage,'concept');
});

test('pause cancels a waiting queue entry and resumes without another plan or fee',async t=>{
  const f=fixture(t);f.start({includeConcept:false,includeThumbnail:false});await queued(f);f.agent.pause({id:f.id,owner:OWNER});
  assert.equal(f.current().status,'paused');assert.equal(f.builds.get(f.id).queue.state,'cancelled');f.start();await queued(f);assert.equal(f.planCalls,1);assert.equal(f.current().spentUsd,.1);
});

test('claimed Studio work may finish after pause without advancing to another stage',async t=>{
  const f=fixture(t);f.start({includeConcept:false,includeThumbnail:false});await queued(f);const job=f.builds.claim({workerId:'agent-worker',studioId:'agent-studio'});
  f.agent.pause({id:f.id,owner:OWNER});assert.equal(f.current().status,'running');await f.agent.tick();assert.equal(f.current().pauseRequested,true);
  f.builds.report({...job,status:'ready',objectCount:job.plan.parts.length+1,playtest:{result:'passed'}});await f.agent.tick();assert.equal(f.current().status,'paused');assert.equal(f.current().stage,'assembly');
  assert.equal(f.current().publication,'not_published');assert.equal(f.planCalls,1);
});

test('no old worker can satisfy agent eligibility and unsupported mechanics stop before queueing',async t=>{
  const f=fixture(t);f.start({includeConcept:false,includeThumbnail:false});f.builds.workerPresence({workerId:'old-worker',studioId:'old-studio'});
  await until(f,()=>f.current().waitingForWorker);assert.equal(f.builds.get(f.id).queue,null);assert.equal(f.current().stage,'assembly');
  f.worker();await f.agent.tick();assert.equal(f.builds.get(f.id).queue.state,'queued');
  const unsupported=fixture(t,{plan:async args=>{const release=args.reserve(.2);try{args.settle(.2,.1);const result=plan();result.design.unsupportedFeatures=['Persistent saving'];return result;}finally{release();}}});
  unsupported.start();await until(unsupported,()=>unsupported.current().status==='failed');assert.equal(unsupported.current().error.code,'UNSUPPORTED_FEATURES');assert.equal(unsupported.imageCalls,0);assert.equal(unsupported.builds.get(unsupported.id).queue,null);
});

test('failed or absent runtime smoke never reaches review or automatically repairs Studio',async t=>{
  for(const result of ['failed','not_run']) {const f=fixture(t);f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f,result);await until(f,()=>f.current().status==='failed');assert.equal(f.current().error.code,'SMOKE_REQUIRED');assert.equal(f.current().repairAttempts,0);assert.equal(f.planCalls,1);}
  const f=fixture(t);f.start({includeConcept:false,includeThumbnail:false});await queued(f);const job=f.builds.claim({workerId:'agent-worker',studioId:'agent-studio'});f.builds.report({...job,status:'failed',objectCount:0,message:'Failure after an unknown amount of Studio work'});await f.agent.tick();assert.equal(f.current().error.code,'STUDIO_FAILED');assert.equal(f.planCalls,1);
});

test('exactly one known-cost tagged plan repair is allowed before any Studio mutation',async t=>{
  const f=fixture(t,{plan:async(args,attempt)=>{const release=args.reserve(.25);try{args.settle(.25,.1);if(attempt===1)throw Object.assign(Error('Fix disconnected finish geometry'),{code:'PLAN_VALIDATION_FAILED',repairable:true});assert.match(args.build.repairFeedback,/disconnected/);return plan();}finally{release();}}});
  f.start({includeConcept:false,includeThumbnail:false});await queued(f);assert.equal(f.planCalls,2);assert.equal(f.current().repairAttempts,1);assert.equal(f.current().spentUsd,.2);
  const twice=fixture(t,{plan:async args=>{const release=args.reserve(.25);try{args.settle(.25,.1);throw Object.assign(Error('Invalid geometry'),{code:'PLAN_VALIDATION_FAILED',repairable:true});}finally{release();}}});
  twice.start();await until(twice,()=>twice.current().status==='failed');assert.equal(twice.planCalls,2);assert.equal(twice.current().repairAttempts,1);assert.equal(twice.current().spentUsd,.2);
});

test('ambiguous provider completion keeps its allowance and is not repaired or restarted',async t=>{
  const f=fixture(t,{plan:async args=>{const release=args.reserve(.25);try{throw Object.assign(Error('Connection ended after request'),{code:'PLAN_VALIDATION_FAILED',repairable:true});}finally{release();}}});
  f.start();await until(f,()=>f.current().status==='interrupted');assert.equal(f.current().spentUsd,.25);assert.equal(f.current().reservedUsd,0);assert.equal(f.current().repairAttempts,0);assert.throws(()=>f.start(),{code:'AGENT_REVISION_REQUIRED'});await f.agent.tick();assert.equal(f.planCalls,1);
});

test('restart adopts a matching durable plan but never repeats a missing paid result',async t=>{
  for(const savedResult of [true,false]) {
    let entered;const started=new Promise(r=>entered=r);const f=fixture(t,{plan:async args=>{args.reserve(.25);entered();return new Promise(()=>{});}});
    f.start({includeConcept:false,includeThumbnail:false});await f.agent.tick();f.agent.tick();await started;
    if(savedResult)f.builds.prepare({id:f.id,owner:OWNER,plan:plan(),source:'ai',modelId:MODEL});
    const recovered=createBuilderAgentService(f.config);await recovered.tick();const state=recovered.get(f.id,{owner:OWNER});
    assert.equal(f.planCalls,1);assert.equal(state.spentUsd,.25);assert.equal(state.reservedUsd,0);
    assert.equal(state.status,savedResult?'running':'interrupted');
    await recovered.tick();assert.equal(f.planCalls,1);if(savedResult)assert.equal(recovered.get(f.id).stage,'concept');
  }
});

test('damaged or externally changed history is preserved and prevents provider work',async t=>{
  for(const changed of ['not json',JSON.stringify({version:1,runs:[]})]) {
    const f=fixture(t);f.start();const file=path.join(f.stateDirectory,FILE_NAME);fs.writeFileSync(file,changed);
    await assert.rejects(f.agent.tick(),{code:'AGENT_STORAGE_UNAVAILABLE'});assert.equal(f.planCalls,0);assert.equal(fs.readFileSync(file,'utf8'),changed);
    if(changed==='not json')assert.throws(()=>createBuilderAgentService(f.config),{code:'AGENT_STORAGE_UNAVAILABLE'});
  }
});

test('concurrent ticks cannot duplicate paid generation and close saves a safe pause',async t=>{
  let resolve,entered;const started=new Promise(r=>entered=r);const f=fixture(t,{plan:async args=>{const release=args.reserve(.25);entered();await new Promise(r=>resolve=r);try{args.settle(.25,.1);return plan();}finally{release();}}});
  f.start();await f.agent.tick();const first=f.agent.tick(),second=f.agent.tick();assert.equal(first,second);await started;const closing=f.agent.close();resolve();await Promise.all([first,closing]);
  assert.equal(f.planCalls,1);assert.equal(f.current().status,'paused');assert.ok(f.builds.get(f.id).plan);await f.agent.tick();assert.equal(f.imageCalls,0);assert.throws(()=>f.start(),{code:'AGENT_CLOSED'});
});

test('paused resumes reject a manual Studio bridge, manual queue, active artwork and excess active runs',async t=>{
  const bridge=fixture(t);bridge.start();bridge.agent.pause({id:bridge.id,owner:OWNER});bridge.builds.issueWorkerToken({id:bridge.id,owner:OWNER});assert.throws(()=>bridge.start(),/manual build activity/);assert.equal(bridge.planCalls,0);
  const queue=fixture(t);queue.start();queue.agent.pause({id:queue.id,owner:OWNER});queue.builds.prepare({id:queue.id,owner:OWNER,plan:plan(),source:'ai',modelId:MODEL});queue.worker();queue.builds.enqueue({id:queue.id,owner:OWNER});assert.throws(()=>queue.start(),/manual build activity/);
  const art=fixture(t);art.start();art.agent.pause({id:art.id,owner:OWNER});art.builds.beginConcept({id:art.id,owner:OWNER,modelId:'fixture/image',modelName:'Fixture',prompt:'Original target',estimatedCostUsd:.048});assert.throws(()=>art.start(),/manual build activity/);
  const limit=fixture(t);limit.start();limit.agent.pause({id:limit.id,owner:OWNER});
  for(let i=0;i<4;i++){const b=limit.builds.create({owner:OWNER,gameName:'Queued '+i,brief:'Original game with a reachable finish',template:'auto',modelId:MODEL});limit.agent.start({id:b.id,owner:OWNER});}
  assert.throws(()=>limit.start(),{code:'AGENT_LIMIT'});assert.equal(limit.current().status,'paused');
});

test('history corruption at assembly prevents even a queue side effect',async t=>{
  const f=fixture(t);f.start({includeConcept:false,includeThumbnail:false});await until(f,()=>f.current().stage==='assembly');f.worker();
  const file=path.join(f.stateDirectory,FILE_NAME);fs.writeFileSync(file,'retain this damaged evidence');
  await assert.rejects(f.agent.tick(),{code:'AGENT_STORAGE_UNAVAILABLE'});assert.equal(f.builds.get(f.id).queue,null);assert.equal(fs.readFileSync(file,'utf8'),'retain this damaged evidence');
});

test('repair accounting belongs to its exact action even when both attempts share a timestamp',async t=>{
  const f=fixture(t,{plan:async(args,attempt)=>{if(attempt===1){const release=args.reserve(.25);try{args.settle(.25,.1);throw Object.assign(Error('Known invalid plan'),{code:'PLAN_VALIDATION_FAILED',repairable:true});}finally{release();}}return plan();}});
  f.start();await until(f,()=>f.current().status==='failed');assert.equal(f.current().error.code,'AGENT_ACCOUNTING_INVALID');assert.equal(f.builds.get(f.id).plan,null);assert.equal(f.current().spentUsd,.1);assert.equal(f.planCalls,2);
});

test('restart adopts a saved matching image without regenerating it and labels unknown spend',async t=>{
  let entered;const started=new Promise(r=>entered=r);let metadata;
  const f=fixture(t,{image:async args=>{args.reserve(.048);metadata={purpose:args.purpose,modelId:'fixture/image',modelName:'Offline image fixture',prompt:'Original visual target',estimatedCostUsd:.048};args.onStart(metadata);entered();return new Promise(()=>{});}});
  f.start({includeThumbnail:false});await until(f,()=>f.current().stage==='concept');f.agent.tick();await started;
  f.builds.finishConcept({id:f.id,owner:OWNER,...metadata,bytes:PNG,contentType:'image/png',costUsd:.048,generatedAt:f.now()});
  const recovered=createBuilderAgentService(f.config);await recovered.tick();assert.equal(recovered.get(f.id).status,'running');assert.equal(recovered.get(f.id).unknownChargeUsd,.048);assert.equal(recovered.get(f.id).unknownChargeCount,1);
  await recovered.tick();assert.equal(recovered.get(f.id).stage,'thumbnail');assert.equal(f.imageCalls,1);
});

const critique=(verdict='improve')=>({version:1,verdict,summary:verdict==='improve'?'The finish landmark and route need clearer visual separation':'The route reads clearly in the captured views',issues:verdict==='improve'?[{category:'readability',description:'The finish uses the same color as the background skyline'}]:[],revisionBrief:verdict==='improve'?'Keep the full playable course and checkpoints. Make the finish a distinctive mint landmark and strengthen route contrast with restrained lighting.':''});
const reviewer=(choose=()=> 'acceptable')=>async(args,count)=>{const release=args.reserve(.06);try{args.settle(.06,.02);return critique(choose(count));}finally{release();}};
async function reviewed(f) {await until(f,()=>f.current().visualReviews.length>0);}

test('new visual runs create a target before planning and save actual screenshot critique provenance',async t=>{
  const sequence=[];
  const f=fixture(t,{plan:async args=>{sequence.push('plan');assert.equal(args.build.concept.status,'ready');const release=args.reserve(.25);try{args.settle(.25,.1);return plan();}finally{release();}},review:async args=>{sequence.push('review');assert.equal(args.build.visualFrames.length,3);return reviewer()(args);}});
  f.start();assert.equal(f.current().includeVisualReview,true);assert.equal(f.current().visualLoopVersion,1);
  await f.agent.tick();assert.equal(f.current().stage,'concept');await f.agent.tick();assert.equal(f.imageCalls,1);assert.equal(f.planCalls,0);
  await queued(f);assert.deepEqual(sequence,['plan']);assert.equal(f.builds.get(f.id).queue.requireVisualReview,true);
  finish(f);await until(f,()=>f.current().status==='review');assert.deepEqual(sequence,['plan','review']);
  const log=f.current().visualReviews[0];assert.equal(log.buildId,f.id);assert.equal(log.modelId,MODEL);assert.equal(log.result.verdict,'acceptable');
  assert.deepEqual(log.sourceFrames.map(row=>row.view),['overview','spawn','finish']);assert.ok(log.sourceFrames.every(row=>row.hash.length===64 && row.jobId===f.builds.get(f.id).jobId));
  assert.equal(f.current().visualRevisionCount,0);assert.equal(f.current().spentUsd,.216);assert.equal(f.current().publication,'not_published');assert.equal(f.builds.get(f.id).creatorReview,undefined);
});

test('one immutable visual child uses the same approval and budget then stops with unresolved issues',async t=>{
  const f=fixture(t,{review:reviewer(()=> 'improve')});f.start();await queued(f);finish(f);
  const original=f.builds.get(f.id),originalPlan=structuredClone(original.plan),originalScreen=structuredClone(original.screenshot);
  await until(f,()=>f.current().currentBuildId!==f.id);const childId=f.current().currentBuildId,child=f.builds.get(childId,{owner:OWNER});
  assert.equal(child.lineage.parentBuildId,f.id);assert.equal(child.lineage.projectId,f.id);assert.equal(child.visualReviewContext.sourceBuildId,f.id);assert.equal(child.visualReviewContext.originalBrief,original.brief);
  assert.equal(f.current().budgetUsd,1);assert.equal(f.agent.get(childId).runId,f.current().runId);assert.throws(()=>f.agent.assertManualAllowed(childId),{code:'AGENT_ACTIVE'});
  assert.equal(f.agent.start({id:childId,owner:OWNER}).runId,f.current().runId);
  assert.deepEqual(f.builds.get(f.id).plan,originalPlan);assert.deepEqual(f.builds.get(f.id).screenshot,originalScreen);
  await queued(f,childId);finish(f);await until(f,()=>f.current().status==='review');
  assert.equal(f.current().visualRevisionCount,1);assert.equal(f.current().visualReviews.length,2);assert.equal(f.reviewCalls,2);assert.equal(f.planCalls,2);assert.equal(f.imageCalls,2);assert.equal(f.current().spentUsd,.336);
  assert.match(f.current().message,/unresolved visual issues/);assert.equal(f.builds.get(f.id).revisions.length,2);assert.equal(f.builds.get(childId).published,false);
  for(let i=0;i<4;i++)await f.agent.tick();assert.equal(f.reviewCalls,2);assert.equal(f.builds.get(f.id).revisions.length,2);
});

test('visual revision budget cannot reset when switching from the original game to its child',async t=>{
  const f=fixture(t,{review:reviewer(()=> 'improve')});f.start({includeConcept:false,includeThumbnail:false,budgetUsd:.3});await queued(f);finish(f);
  await until(f,()=>f.current().status==='failed');assert.equal(f.current().error.code,'AGENT_BUDGET_EXHAUSTED');assert.equal(f.current().spentUsd,.12);assert.equal(f.reviewCalls,1);
  const childId=f.current().currentBuildId;assert.notEqual(childId,f.id);assert.equal(f.builds.get(childId).plan,null);assert.throws(()=>f.agent.start({id:childId,owner:OWNER,budgetUsd:1}),{code:'AGENT_REVISION_REQUIRED'});
});

test('missing Studio captures or a failed smoke test stop before a paid visual review',async t=>{
  for(const smoke of ['passed','failed']) {
    const f=fixture(t,{review:reviewer()});f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f,smoke,false);
    await until(f,()=>f.current().status==='failed');assert.equal(f.reviewCalls,0);assert.equal(f.current().error.code,smoke==='passed'?'VISUAL_EVIDENCE_REQUIRED':'SMOKE_REQUIRED');
  }
});

test('unknown visual review cost never creates a revision or repeats the request',async t=>{
  const f=fixture(t,{review:async args=>{const release=args.reserve(.06);try{args.settle(.06,null);return critique();}finally{release();}}});
  f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await until(f,()=>f.current().status==='interrupted');
  assert.equal(f.current().unknownChargeUsd,.06);assert.equal(f.current().spentUsd,.16);assert.equal(f.current().visualReviews.length,1);assert.equal(f.current().visualRevisionCount,0);assert.equal(f.builds.get(f.id).revisions.length,1);
  const recovered=createBuilderAgentService(f.config);await recovered.tick();assert.equal(f.reviewCalls,1);assert.equal(recovered.get(f.id).status,'interrupted');
});

test('restart during a visual request retains its reservation and cannot repeat the paid request',async t=>{
  let entered;const started=new Promise(r=>entered=r);
  const f=fixture(t,{review:async args=>{args.reserve(.06);entered();return new Promise(()=>{});}});
  f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await until(f,()=>f.current().stage==='visual_review');f.agent.tick();await started;
  const recovered=createBuilderAgentService(f.config);await recovered.tick();const run=recovered.get(f.id);assert.equal(run.status,'interrupted');assert.equal(run.unknownChargeUsd,.06);assert.equal(run.visualReviews.length,0);await recovered.tick();assert.equal(f.reviewCalls,1);
});

test('pause during visual review saves the critique but defers the child until the creator resumes',async t=>{
  let entered,resolve;const started=new Promise(r=>entered=r);
  const f=fixture(t,{review:async args=>{const release=args.reserve(.06);entered();await new Promise(r=>resolve=r);try{args.settle(.06,.02);return critique();}finally{release();}}});
  f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await until(f,()=>f.current().stage==='visual_review');const work=f.agent.tick();await started;
  f.agent.pause({id:f.id,owner:OWNER});resolve();await work;assert.equal(f.current().status,'paused');assert.equal(f.current().visualReviews.length,1);assert.equal(f.current().currentBuildId,f.id);
  assert.throws(()=>f.start({includeVisualReview:false}),{code:'AGENT_APPROVAL_UNCHANGED'});f.start();await f.agent.tick();assert.notEqual(f.current().currentBuildId,f.id);assert.equal(f.reviewCalls,1);
});

test('a paused visual child is owner protected and manual changes require new approval',async t=>{
  const f=fixture(t,{review:reviewer(()=> 'improve')});f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await until(f,()=>f.current().currentBuildId!==f.id);
  const childId=f.current().currentBuildId;assert.throws(()=>f.agent.pause({id:childId,owner:'stranger'}),{status:403});f.agent.pause({id:childId,owner:OWNER});assert.equal(f.current().status,'paused');
  f.builds.prepare({id:childId,owner:OWNER,plan:plan(),source:'ai',modelId:MODEL});assert.throws(()=>f.start(),{code:'AGENT_BUILD_CHANGED'});assert.equal(f.planCalls,1);
});

test('restart between creating the child and recording its id adopts exactly one immutable revision',async t=>{
  const f=fixture(t,{review:reviewer(()=> 'improve')});f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await reviewed(f);
  const file=path.join(f.stateDirectory,FILE_NAME),revise=f.builds.revise;let durablePending,childId;
  f.builds.revise=args=>{durablePending=fs.readFileSync(file);const child=revise(args);childId=child.id;throw Error('Simulated process loss after durable child write');};
  await f.agent.tick();assert.ok(childId);assert.equal(f.builds.get(f.id).revisions.length,2);
  // Restore the exact last durable pre-crash checkpoint, excluding the synthetic
  // exception handler which a terminated process could not have executed.
  fs.writeFileSync(file,durablePending);f.builds.revise=revise;
  const recovered=createBuilderAgentService(f.config);await recovered.tick();assert.equal(recovered.get(f.id).currentBuildId,childId);assert.equal(recovered.get(f.id).visualRevisionCount,1);assert.equal(f.builds.get(f.id).revisions.length,2);assert.equal(f.reviewCalls,1);assert.equal(recovered.get(f.id).spentUsd,.12);
});

test('visual review requires strict output, exact screenshot evidence, and recorded provider cost',async t=>{
  for(const kind of ['unknown-field','bad-evidence','no-accounting']) {
    const f=fixture(t,{review:async args=>{if(kind!=='no-accounting'){const release=args.reserve(.06);args.settle(.06,.02);release();}return {...critique(),...(kind==='unknown-field'?{autoPublish:true}:{}),...(kind==='bad-evidence'?{evidence:[{view:'overview',hash:'0'.repeat(64),capturedAt:0,jobId:'wrong'}]}:{})};}});
    f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await until(f,()=>f.current().status==='failed');
    assert.equal(f.current().error.code,kind==='no-accounting'?'AGENT_ACCOUNTING_INVALID':'VISUAL_REVIEW_INVALID');assert.equal(f.builds.get(f.id).revisions.length,1);assert.equal(f.reviewCalls,1);
  }
});

test('an existing approval never silently opts in to new paid visual review after an update',async t=>{
  const f=fixture(t);f.start({includeConcept:false,includeThumbnail:false});const file=path.join(f.stateDirectory,FILE_NAME),state=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const key of ['includeVisualReview','currentBuildId','maxVisualRevisions','visualRevisionCount','visualReviews','rootFingerprint'])delete state.runs[0][key];fs.writeFileSync(file,JSON.stringify(state));
  let reviews=0;const recovered=createBuilderAgentService({...f.config,reviewVisual:async()=>{reviews++;return critique();}});assert.equal(recovered.get(f.id).includeVisualReview,false);
  f.worker();for(let i=0;i<8;i++)await recovered.tick();finish(f);for(let i=0;i<4;i++)await recovered.tick();assert.equal(recovered.get(f.id).status,'review');assert.equal(reviews,0);
});

test('the full original Unicode brief survives visual improvement without truncation',async t=>{
  const brief='Build an original safe sky course. '+ '空'.repeat(775);
  assert.ok(Buffer.byteLength(brief)<=2400);const f=fixture(t,{brief,review:reviewer(()=> 'improve')});f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await until(f,()=>f.current().currentBuildId!==f.id);
  const child=f.builds.get(f.current().currentBuildId);assert.equal(child.brief,brief);assert.equal(child.visualReviewContext.originalBrief,brief);assert.equal(child.visualReviewContext.review.revisionBrief,critique().revisionBrief);
});

test('damaged persisted visual review provenance stops restart before another paid action',async t=>{
  for(const change of [run=>run.visualReviews[0].sourceFrames[0].hash='bad',run=>run.visualReviews[0].sourceFrames[1].view='overview',run=>run.visualReviews[0].modelId='wrong-model',run=>run.visualReviews[0].result.publish=true]) {
    const f=fixture(t,{review:reviewer(()=> 'improve')});f.start({includeConcept:false,includeThumbnail:false});await queued(f);finish(f);await reviewed(f);
    const file=path.join(f.stateDirectory,FILE_NAME),state=JSON.parse(fs.readFileSync(file,'utf8'));change(state.runs[0]);fs.writeFileSync(file,JSON.stringify(state));
    assert.throws(()=>createBuilderAgentService(f.config),{code:'AGENT_STORAGE_UNAVAILABLE'});assert.equal(f.reviewCalls,1);assert.equal(f.planCalls,1);assert.equal(f.builds.get(f.id).revisions.length,1);
  }
});

test('recovering a saved visual-run plan with unknown cost stops before artwork or Studio queueing',async t=>{
  let entered;const started=new Promise(r=>entered=r);const f=fixture(t,{review:reviewer(),plan:async args=>{args.reserve(.25);entered();return new Promise(()=>{});}});
  f.start({includeConcept:false});await f.agent.tick();f.agent.tick();await started;f.builds.prepare({id:f.id,owner:OWNER,plan:plan(),source:'ai',modelId:MODEL});
  const recovered=createBuilderAgentService(f.config);await recovered.tick();assert.equal(recovered.get(f.id).status,'interrupted');await recovered.tick();assert.equal(f.planCalls,1);assert.equal(f.imageCalls,0);assert.equal(f.reviewCalls,0);assert.equal(f.builds.get(f.id).queue,null);
});

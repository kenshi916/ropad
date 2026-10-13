'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRobloxBuildService, createTemplatePlan, validatePlan } = require('./parallax/roblox-builds.cjs');
function fixture(t) {
 const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-build-test-')); t.after(() => fs.rmSync(stateDirectory, {recursive:true,force:true}));
 let time = 1700000000000;
 const config = {stateDirectory,now:()=>time};
 return {service:createRobloxBuildService(config),config,tick:n=>time+=n};
}
const brief = {owner:'owner-cookie-123',gameName:'Sky Steps',brief:'A colorful sky obstacle course',template:'obby',modelId:'template'};
const ADVANCED='anthropic/claude-opus-5.5';
const DESIGN={coreLoop:'Collect coins and cross platforms',objective:'Reach the finish',progression:'Checkpoints mark route progress',inspiration:'Original floating-island setting with obstacle-course pacing',limitations:['Creator playtest and manual publishing remain'],acceptanceCriteria:['Spawn works','Checkpoints work','Coins work','Finish works'],unsupportedFeatures:[]};
function assembledPrompt(service,{design=DESIGN,result='passed'}={}) {
 const build=service.create({...brief,template:'auto',modelId:ADVANCED});
 const plan={...createTemplatePlan('obby'),...(design ? {design:structuredClone(design)} : {})};
 service.prepare({id:build.id,owner:brief.owner,plan,source:'ai',modelId:ADVANCED});
 service.workerPresence({workerId:'test-worker',studioId:'test-studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true});
 service.enqueue({id:build.id,owner:brief.owner});const lease=service.claim({workerId:'test-worker',studioId:'test-studio'});
 service.report({leaseId:lease.leaseId,leaseToken:lease.leaseToken,status:'ready',objectCount:plan.parts.length+1,playtest:{result,message:'Offline simulated worker report'}});
 return service.get(build.id,{owner:brief.owner});
}

test('prompt creation defers gameplay choice and preserves validated design requirements',t=>{
 const {service,config}=fixture(t),build=service.create({...brief,template:'auto',modelId:ADVANCED,inspiration:'Upgrade pacing from popular tycoons; original art'});
 assert.equal(build.plan,null);assert.equal(build.template,'auto');
 const plan={...createTemplatePlan('tycoon'),design:structuredClone(DESIGN)};
 const planned=service.prepare({id:build.id,owner:brief.owner,plan,source:'ai',modelId:ADVANCED});
 assert.equal(planned.template,'tycoon');assert.deepEqual(planned.plan.design,DESIGN);assert.equal(planned.readiness.readyForCreatorPublish,false);
 assert.deepEqual(createRobloxBuildService(config).get(build.id).plan.design,DESIGN);
 assert.throws(()=>validatePlan({...plan,design:{...DESIGN,unsupportedFeatures:['x'.repeat(241)]}}),/240 bytes/);
 assert.throws(()=>validatePlan({...plan,design:{...DESIGN,executable:'bad'}}),/game design fields/);
});

test('creator updates are immutable versions of one token project without inherited completion evidence',t=>{
 const {service,config}=fixture(t),original=service.create({...brief,template:'auto',modelId:ADVANCED,token:{address:'0x'+'a'.repeat(40),symbol:'SKY',transactionHash:'0x'+'b'.repeat(64),verified:true},idempotencyKey:'launch-once'});
 service.prepare({id:original.id,owner:brief.owner,plan:{...createTemplatePlan('obby'),design:DESIGN},source:'ai',modelId:ADVANCED});
 const before=service.get(original.id);
 assert.throws(()=>service.revise({id:original.id,owner:'another',brief:'Take over'}),/belongs to another/);
 assert.throws(()=>service.revise({id:original.id,owner:brief.owner,brief:'Update',modelId:'google/gemini-2.5-flash'}),/advanced|Opus|Astra/i);
 const updated=service.revise({id:original.id,owner:brief.owner,brief:'A new complete harbor tycoon brief',modelId:'openai/gpt-6-astra',inspiration:'Upgrade pacing only'});
 assert.deepEqual(updated.lineage,{projectId:original.id,parentBuildId:original.id,version:2});assert.deepEqual(updated.token,original.token);
 assert.equal(updated.plan,null);assert.equal(updated.queue,null);assert.equal(updated.screenshot,null);assert.equal(updated.creatorReview,undefined);assert.equal(updated.status,'queued');
 assert.deepEqual(updated.previousDesign,{summary:before.plan.summary,template:'obby',design:DESIGN});
 const after=service.get(original.id);assert.deepEqual(after.events,before.events);assert.deepEqual(after.plan,before.plan);assert.equal(after.updatedAt,before.updatedAt);
 assert.equal(service.create({...brief,idempotencyKey:'launch-once'}).id,original.id);
 const branch=service.revise({id:original.id,owner:brief.owner,brief:'Another complete game brief'});assert.equal(branch.lineage.version,3);
 const stored=createRobloxBuildService(config);assert.equal(stored.get(updated.id).lineage.parentBuildId,original.id);assert.equal(stored.get(original.id).revisions.length,3);
 service.workerPresence({workerId:'test-worker',studioId:'test-studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true});service.enqueue({id:original.id,owner:brief.owner});assert.throws(()=>service.revise({id:original.id,owner:brief.owner,brief:'While queued'}),/Wait for this Studio build/);
});

test('assembly and smoke checks never replace creator review or prove publication',t=>{
 const {service,config}=fixture(t),build=assembledPrompt(service),id=build.id,owner=brief.owner;
 assert.equal(build.readiness.stage,'needs_review');assert.equal(build.readiness.readyForCreatorPublish,false);
 const form={id,owner,gameplayPassed:true,performancePassed:true,contentReviewed:true,notes:'Played every checkpoint and the finish; checked controls and original content',publishedUrl:'https://www.roblox.com/games/12345/Original-Game'};
 assert.throws(()=>service.review({...form,owner:'another'}),/belongs to another/);
 for(const url of ['http://www.roblox.com/games/123','https://evil.invalid/games/123','https://www.roblox.com.evil.invalid/games/123','https://name@www.roblox.com/games/123','https://www.roblox.com/users/123'])assert.throws(()=>service.review({...form,publishedUrl:url}),/HTTPS Roblox game URL/);
 assert.equal(service.get(id).creatorReview,undefined);
 const reviewed=service.review(form);assert.equal(reviewed.readiness.stage,'creator_approved');assert.equal(reviewed.readiness.readyForCreatorPublish,true);
 assert.deepEqual(reviewed.readiness.publication,{url:'https://www.roblox.com/games/12345',verified:false,source:'creator_report'});assert.equal(reviewed.published,false);assert.equal(reviewed.playtested,false);
 assert.equal(reviewed.creatorReview.source,'creator_attestation');assert.equal(createRobloxBuildService(config).get(id).creatorReview.notes,form.notes);
 const issues=service.review({...form,gameplayPassed:false,notes:'Finish did not increment score consistently',publishedUrl:''});assert.equal(issues.readiness.stage,'needs_fixes');assert.equal(issues.readiness.readyForCreatorPublish,false);assert.equal(issues.readiness.publication,null);
});

test('missing requested features, missing design reports and failed smoke checks block shipping',t=>{
 const {service}=fixture(t),owner=brief.owner;
 const form={owner,gameplayPassed:true,performancePassed:true,contentReviewed:true,notes:'Owner approved but requirements must still block readiness'};
 const unsupported=assembledPrompt(service,{design:{...DESIGN,unsupportedFeatures:['Requested persistent inventory is not implemented']}});
 const reviewed=service.review({...form,id:unsupported.id});assert.equal(reviewed.readiness.stage,'needs_fixes');assert.equal(reviewed.readiness.readyForCreatorPublish,false);assert.ok(reviewed.readiness.blockers.includes('Requested features covered by the design'));
 const legacy=assembledPrompt(service,{design:null});assert.equal(service.review({...form,id:legacy.id}).readiness.readyForCreatorPublish,false);
 const failed=assembledPrompt(service,{result:'failed'});assert.throws(()=>service.review({...form,id:failed.id}),/passing runtime smoke check/);assert.equal(failed.readiness.stage,'needs_fixes');
});
test('durable build lifecycle only becomes ready after authenticated matching Studio acknowledgment', t => {
 const {service,config} = fixture(t); const first = service.create(brief);
 assert.equal(first.status,'queued'); assert.equal(first.canManage,true); assert.equal(first.owner,undefined);
 const prepared = service.prepare({id:first.id,owner:brief.owner});
 assert.equal(prepared.status,'waiting_for_studio'); assert.equal(prepared.planSource,'starter_template');
 const issued = service.issueWorkerToken({id:first.id,owner:brief.owner}); assert.match(issued.workerToken,/^[a-f0-9]{64}$/);
 const restarted = createRobloxBuildService(config);
 const polled = restarted.poll({id:first.id,workerToken:issued.workerToken}); assert.equal(polled.job.id,prepared.jobId);
 assert.equal(restarted.get(first.id).status,'waiting_for_studio'); assert.equal(restarted.get(first.id).studioConnected,true);
 assert.throws(()=>restarted.acknowledge({id:first.id,workerToken:issued.workerToken,jobId:'other',status:'ready',objectCount:20}),/another job/);
 restarted.acknowledge({id:first.id,workerToken:issued.workerToken,jobId:prepared.jobId,status:'building'});
 assert.throws(()=>restarted.acknowledge({id:first.id,workerToken:issued.workerToken,jobId:prepared.jobId,status:'ready',objectCount:0}),/object count/);
 const ready = restarted.acknowledge({id:first.id,workerToken:issued.workerToken,jobId:prepared.jobId,status:'ready',objectCount:prepared.plan.parts.length+1});
 assert.equal(ready.status,'ready'); assert.equal(ready.playtested,false); assert.equal(ready.published,false);
 assert.equal(restarted.poll({id:first.id,workerToken:issued.workerToken}).job,null);
 assert.throws(()=>restarted.acknowledge({id:first.id,workerToken:issued.workerToken,jobId:prepared.jobId,status:'building'}),/earlier state/);
});
test('worker tokens are hashed, bounded, rotated, and cannot access another build', t => {
 const {service,config,tick} = fixture(t); const a = service.create(brief); const b = service.create({...brief,gameName:'Second'});
 const one = service.issueWorkerToken({id:a.id,owner:brief.owner});
 assert.throws(()=>service.poll({id:b.id,workerToken:one.workerToken}),/missing or expired/);
 assert.equal(JSON.stringify(service.get(a.id)).includes(one.workerToken),false);
 assert.equal(fs.readFileSync(path.join(config.stateDirectory,'roblox-builds','sessions.json'),'utf8').includes(one.workerToken),false);
 const two = service.issueWorkerToken({id:a.id,owner:brief.owner});
 assert.throws(()=>service.poll({id:a.id,workerToken:one.workerToken}),/Invalid worker token/);
 service.poll({id:a.id,workerToken:two.workerToken}); tick(46_000); assert.equal(service.get(a.id).studioConnected,false);
 tick(12*60*60*1000); assert.throws(()=>service.poll({id:a.id,workerToken:two.workerToken}),/expired/);
});
test('owner checks protect mutations, visibility separates ownership, and launch retries do not duplicate builds', t => {
 const {service} = fixture(t); const a = service.create({...brief,idempotencyKey:'confirmed-intent'});
 assert.equal(service.create({...brief,idempotencyKey:'confirmed-intent'}).id,a.id);
 assert.equal(service.list().length,1); assert.equal(service.list('someoneelse').length,0);
 assert.equal(service.get(a.id,{owner:'someoneelse'}).canManage,false); assert.equal(service.get(a.id,{owner:brief.owner}).canManage,true);
 assert.throws(()=>service.prepare({id:a.id,owner:'someoneelse'}),/belongs to another/);
 assert.throws(()=>service.issueWorkerToken({id:a.id,owner:'someoneelse'}),/belongs to another/);
 service.prepare({id:a.id,owner:brief.owner});
 assert.throws(()=>service.prepare({id:a.id,owner:brief.owner}),/already has a plan/);
 assert.throws(()=>service.appendEvent({id:a.id,owner:'someoneelse',message:'fake success'}),/belongs to another/);
});
test('plans reject executable instructions, external assets, duplicate IDs and unbounded geometry', () => {
 for (const template of ['obby','tycoon','racing']) assert.equal(validatePlan(createTemplatePlan(template)).template,template);
 const plan = createTemplatePlan('obby');
 assert.throws(()=>validatePlan({...plan,scripts:['delete everything']}),/unsupported fields/);
 assert.throws(()=>validatePlan({...plan,parts:[...plan.parts,{...plan.parts[0]}]}),/unique/);
 assert.throws(()=>validatePlan({...plan,parts:plan.parts.map((p,i)=>i? p:{...p,assetId:'rbxassetid://1'})}),/Unsupported part/);
 assert.throws(()=>validatePlan({...plan,parts:plan.parts.map((p,i)=>i? p:{...p,size:[1,Infinity,1]})}),/Invalid size/);
 assert.throws(()=>validatePlan({...plan,parts:plan.parts.map((p,i)=>i? p:{...p,position:[0,0,99999]})}),/Invalid position/);
 assert.throws(()=>validatePlan({...plan,parts:plan.parts.map(p=>({...p,behavior:'solid'}))}),/spawn and a finish/);
 assert.throws(()=>validatePlan({...plan,parts:Array(181).fill(plan.parts[0])}),/3–180/);
});
test('template plans do not pretend to be AI; model plans require explicit source provenance', t => {
 const {service} = fixture(t);
 const a = service.create(brief); assert.equal(service.prepare({id:a.id,owner:brief.owner,plan:createTemplatePlan('obby')}).planSource,'custom_plan');
 const b = service.create(brief); const ai = service.prepare({id:b.id,owner:brief.owner,plan:createTemplatePlan('obby'),source:'ai',modelId:'verified-model',inferenceProvider:'orbio'});
 assert.equal(ai.planSource,'model'); assert.equal(ai.modelId,'verified-model'); assert.equal(ai.inferenceProvider,'orbio');
 const c = service.create(brief); assert.throws(()=>service.prepare({id:c.id,owner:brief.owner,plan:createTemplatePlan('racing')}),/selected template/);
});
test('downloaded artifacts contain bounded scene and fixed game logic without secrets or external execution', t => {
 const {service} = fixture(t); const a = service.create({...brief,gameName:'A " quoted game \\ 🦊'}); service.prepare({id:a.id,owner:brief.owner});
 const token = service.issueWorkerToken({id:a.id,owner:brief.owner});
 const data = JSON.parse(service.artifact({id:a.id,format:'json'}).content); assert.equal(data.template,'obby');
 const code = service.artifact({id:a.id,format:'luau'}).content;
 assert.match(code,/ScriptEditorService/); assert.match(code,/ParallaxGameplay/); assert.doesNotMatch(code,/loadstring|HttpGet|require\(/); assert.equal(code.includes(token.workerToken),false);
 assert.throws(()=>service.artifact({id:a.id,format:'exe'}),/json or luau/);
});
test('screens only exist after authorized image upload and disappear when sharing stops', t => {
 const {service} = fixture(t); const a = service.create(brief);
 assert.equal(service.get(a.id).screenshot,null); assert.throws(()=>service.getScreenshot(a.id),/No worker screenshot/);
 const bytes = Buffer.alloc(64); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
 assert.throws(()=>service.screenshot({id:a.id,owner:'someoneelse',bytes,contentType:'image/png'}),/belongs to another/);
 assert.throws(()=>service.screenshot({id:a.id,owner:brief.owner,bytes,contentType:'image/svg+xml'}),/PNG or JPEG/);
 service.screenshot({id:a.id,owner:brief.owner,bytes,contentType:'image/png'});
 assert.equal(service.get(a.id).screenshot.source,'owner_screen_share'); assert.equal(service.getScreenshot(a.id).bytes.length,64);
 service.stopScreen({id:a.id,owner:brief.owner}); assert.equal(service.get(a.id).screenshot,null); assert.throws(()=>service.getScreenshot(a.id),/No worker screenshot/);
});
test('failed jobs remain inspectable and cannot silently replay', t => {
 const {service} = fixture(t); const a = service.create(brief); const p = service.prepare({id:a.id,owner:brief.owner}); const token = service.issueWorkerToken({id:a.id,owner:brief.owner});
 service.acknowledge({id:a.id,workerToken:token.workerToken,jobId:p.jobId,status:'failed',message:'Studio permission declined'});
 assert.equal(service.poll({id:a.id,workerToken:token.workerToken}).job,null);
 assert.equal(service.get(a.id).events.at(-1).message,'Studio permission declined');
 assert.throws(()=>service.acknowledge({id:a.id,workerToken:token.workerToken,jobId:p.jobId,status:'ready',objectCount:p.plan.parts.length+1}),/closed/);
});
test('Studio progress records actual acknowledged counts and rejects impossible counts', t => {
 const {service} = fixture(t); const a = service.create(brief); const prepared = service.prepare({id:a.id,owner:brief.owner}); const {workerToken} = service.issueWorkerToken({id:a.id,owner:brief.owner});
 const payload = {id:a.id,workerToken,jobId:prepared.jobId,status:'building'};
 service.acknowledge({...payload,objectCount:10,message:'Studio created 10 objects'});
 service.acknowledge({...payload,objectCount:20,message:'Studio created 20 objects'});
 const after = service.get(a.id); assert.equal(after.progress.completed,20); assert.equal(after.events.at(-1).message,'Studio created 20 objects');
 const count = after.events.length; service.acknowledge({...payload,objectCount:20,message:'Retry'}); assert.equal(service.get(a.id).events.length,count);
 assert.throws(()=>service.acknowledge({...payload,objectCount:999}),/progress count/);
});
test('unreachable courses and unsatisfiable game objectives are rejected before Studio', () => {
 const disconnected = createTemplatePlan('obby'); disconnected.parts.find(p=>p.behavior==='finish').position=[1000,1000,1000];
 assert.throws(()=>validatePlan(disconnected),/connected surface path/);
 const tycoon = createTemplatePlan('tycoon'); tycoon.parts.find(p=>p.behavior==='finish').value=100;
 assert.throws(()=>validatePlan(tycoon),/enough purchase pads/);
 const racing = createTemplatePlan('racing'); racing.parts.find(p=>p.behavior==='checkpoint').value=99;
 assert.throws(()=>validatePlan(racing),/unique sequential/);
});

test('bounded presentation decorates without changing route collision or reachability',t=>{
 const {service}=fixture(t),plan=createTemplatePlan('obby');
 plan.presentation={lighting:{clockTime:17.5,brightness:2.4,ambient:[120,130,150]}};
 plan.parts.push({id:'spire',name:'Skyline spire',position:[40,20,-30],size:[10,40,10],behavior:'decoration',color:[80,95,120],material:'Metal',rotation:[0,35,0],shape:'Cylinder'});
 const parsed=validatePlan(plan);assert.deepEqual(parsed.presentation,plan.presentation);assert.equal(parsed.parts.at(-1).rotation[1],35);
 for(const mutate of [p=>p.parts[0].rotation=[0,45,0],p=>p.parts.at(-1).rotation=[1,0,0],p=>p.parts.at(-1).shape='MeshPart',p=>p.presentation.lighting.brightness=40,p=>p.presentation.lighting.clockTime=NaN,p=>p.presentation.lighting.script='bad']) {const bad=structuredClone(plan);mutate(bad);assert.throws(()=>validatePlan(bad));}
 const disconnected=structuredClone(plan);disconnected.parts.find(p=>p.behavior==='finish').position=[1500,100,1500];disconnected.parts.at(-1).position=[700,50,700];disconnected.parts.at(-1).size=[512,100,512];assert.throws(()=>validatePlan(disconnected),/connected surface path/);
 const build=service.create({...brief,modelId:ADVANCED});service.prepare({id:build.id,owner:brief.owner,plan,source:'ai'});
 assert.throws(()=>service.issueWorkerToken({id:build.id,owner:brief.owner}),/current Studio worker/);
 const xml=service.artifact({id:build.id,format:'rbxlx'}).content;assert.match(xml,/<float name="ClockTime">17.5/);assert.match(xml,/<Color3 name="Ambient">/);assert.match(xml,/<token name="shape">2/);assert.match(xml,/<bool name="CanCollide">false/);assert.match(xml,/<bool name="CanTouch">false/);
 const luau=service.artifact({id:build.id,format:'luau'}).content;assert.match(luau,/p.CanTouch = false/);assert.match(luau,/CFrame.Angles/);assert.match(luau,/lighting.ClockTime/);
});

test('three trusted worker views persist with current-job hashes and reject tampered bytes',t=>{
 const {service,config,tick}=fixture(t),build=service.create({...brief,modelId:ADVANCED});service.prepare({id:build.id,owner:brief.owner});
 service.workerPresence({workerId:'visual-worker',studioId:'visual-studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1});
 service.enqueue({id:build.id,owner:brief.owner,requireVisualReview:true});const lease=service.claim({workerId:'visual-worker',studioId:'visual-studio'});
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40)]);
 for(const [i,view] of ['overview','spawn','finish'].entries()){tick(1);const bytes=Buffer.from(png);bytes[20]=i;service.workerScreenshot({...lease,bytes,contentType:'image/png',captureView:view});}
 const view=service.get(build.id),frames=service.getVisualFrames(build.id);assert.equal(frames.length,3);assert.deepEqual(view.visualFrames.map(f=>f.view),['overview','spawn','finish']);
 for(const frame of frames){assert.equal(frame.jobId,lease.jobId);assert.equal(frame.hash,require('node:crypto').createHash('sha256').update(frame.bytes).digest('hex'));assert.equal(view.visualFrames.find(f=>f.view===frame.view).bytes,frame.bytes.length);assert.deepEqual(service.getScreenshot(build.id,{view:frame.view}).bytes,frame.bytes);}
 assert.equal(service.getScreenshot(build.id).bytes[20],0,'Primary screen stays the overview');
 assert.throws(()=>service.workerScreenshot({...lease,bytes:png,contentType:'image/png',captureView:'../../private'}),/Invalid worker capture view/);
 assert.equal(createRobloxBuildService(config).getVisualFrames(build.id).length,3);
 const file=path.join(config.stateDirectory,'roblox-builds',`${build.id}.spawn.${frames[1].hash}.screen`);fs.writeFileSync(file,png);
 assert.throws(()=>service.getVisualFrames(build.id),/integrity validation/);
});

test('visual revisions bind idempotency to owner, parent, exact inputs and durable evidence',t=>{
 const {service,config}=fixture(t),build=service.create({...brief,modelId:ADVANCED});service.prepare({id:build.id,owner:brief.owner});
 service.workerPresence({workerId:'visual-worker',studioId:'visual-studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1});service.enqueue({id:build.id,owner:brief.owner,requireVisualReview:true});const lease=service.claim({workerId:'visual-worker',studioId:'visual-studio'});
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(40)]);service.workerScreenshot({...lease,bytes:png,contentType:'image/png',captureView:'overview'});
 service.report({...lease,status:'ready',objectCount:lease.plan.parts.length+1});
 const context={version:1,sourceBuildId:build.id,sourceFrames:service.get(build.id).visualFrames.map(({url,...f})=>f),originalBrief:brief.brief,review:{version:1,verdict:'improve',summary:'Improve the skyline silhouette',issues:[{category:'composition',description:'The landmark is too low'}],revisionBrief:'Raise the decorative landmark and keep the route unchanged'}};
 const args={id:build.id,owner:brief.owner,brief:'The same course with a clearer skyline silhouette',modelId:ADVANCED,inspiration:'Original skyline',idempotencyKey:'visual:revision:one',visualReviewContext:context};
 const child=service.revise(args);assert.deepEqual(child.visualReviewContext,context);assert.equal(service.revise(args).id,child.id);assert.equal(createRobloxBuildService(config).revise(args).id,child.id);assert.equal(service.list(brief.owner).length,2);
 assert.equal(child.revisionFingerprint,undefined);assert.equal(child.idempotencyKey,undefined);
 for(const patch of [{brief:'Different route'},{modelId:'openai/gpt-6-astra'},{inspiration:'Different reference'}])assert.throws(()=>service.revise({...args,...patch}),/different inputs/);
 const forged=structuredClone(context);forged.sourceFrames[0].hash='f'.repeat(64);assert.throws(()=>service.revise({...args,idempotencyKey:'visual:revision:two',visualReviewContext:forged}),/evidence changed/);
 assert.throws(()=>service.revise({...args,owner:'another-owner'}),/another session/);
 service.stopScreen({id:build.id,owner:brief.owner});assert.equal(service.getVisualFrames(build.id).length,0);assert.equal(service.revise(args).id,child.id,'Already-created revision remains recoverable after source share stops');
});

test('visual and enhanced scene jobs cannot be claimed by older dedicated workers',t=>{
 const {service}=fixture(t),older={workerId:'old-worker',studioId:'old-studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true},modern={...older,workerId:'new-worker',studioId:'new-studio',visualReviewProtocol:1};
 const build=service.create({...brief,modelId:ADVANCED});const plan=createTemplatePlan('obby');plan.presentation={lighting:{clockTime:14,brightness:2,ambient:[120,120,120]}};service.prepare({id:build.id,owner:brief.owner,plan});service.workerPresence(older);
 assert.equal(service.canAutoEnqueue(build.id).eligible,false);assert.throws(()=>service.enqueue({id:build.id,owner:brief.owner}),/visual review protocol/);
 service.workerPresence(modern);service.enqueue({id:build.id,owner:brief.owner});assert.equal(service.get(build.id).queue.requireVisualReview,true);assert.equal(service.claim(older),null);assert.equal(service.claim(modern).buildId,build.id);
 const core=service.create({...brief});service.prepare({id:core.id,owner:brief.owner});assert.equal(service.canAutoEnqueue(core.id).eligible,true);assert.equal(service.canAutoEnqueue(core.id,{requireVisualReview:true}).eligible,false);service.enqueue({id:core.id,owner:brief.owner});assert.equal(service.claim(older).buildId,core.id);
});

test('revision retry identities fail closed if their durable body is changed',t=>{
 const {service,config}=fixture(t),parent=service.create({...brief,modelId:ADVANCED});
 const child=service.revise({id:parent.id,owner:brief.owner,brief:'A clearer route with original geometry',modelId:ADVANCED,idempotencyKey:'revision:durable:body'});
 const file=path.join(config.stateDirectory,'roblox-builds','sessions.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.sessions.find(s=>s.id===child.id).brief='A different request';fs.writeFileSync(file,JSON.stringify(saved));
 assert.throws(()=>createRobloxBuildService(config),/history is unreadable/);
});

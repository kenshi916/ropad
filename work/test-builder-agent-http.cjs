'use strict';
// This integration uses temporary state, fake provider responses and worker
// evidence fixtures. It never contacts OpenRouter, Studio or a blockchain.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createApp}=require('./parallax/server.cjs');
const {createTemplatePlan}=require('./parallax/roblox-builds.cjs');
const MODEL={id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5',architecture:{input_modalities:['text','image'],output_modalities:['text']},pricing:{prompt:'0.0000001',completion:'0.0000001'}};
const IMAGE='black-forest-labs/flux-3-image';
const DESIGN={coreLoop:'Traverse the gates and replay',objective:'Reach the finish',progression:'Complete checkpoints in order',inspiration:'Original route with clear goals',limitations:['Human playtesting and publishing remain'],acceptanceCriteria:['Spawn safely','Checkpoints work','Reach the finish','Replay from the start'],unsupportedFeatures:[]};
const plan=()=>({...createTemplatePlan('racing'),design:structuredClone(DESIGN)});
const png=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHdsAAAAASUVORK5CYII=','base64');
async function harness(t,{respondPlan,respondReview,globalBudget=1}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-agent-http-'));
 const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const base='http://127.0.0.1:'+port,calls=[];
 const fetcher=async(url,options={})=>{
   if(url.endsWith('/chat/completions')){const visual=options.headers?.['X-Title']==='Ropad Studio Visual Review';calls.push(visual?'visual_review':'planning');return visual?respondReview(JSON.parse(options.body)):respondPlan?respondPlan(JSON.parse(options.body)):Response.json({choices:[{message:{content:JSON.stringify(plan())},finish_reason:'stop'}],usage:{cost:.05}});}
   if(url.endsWith('/images/models'))return Response.json({data:[{id:IMAGE,name:'Image fixture',architecture:{input_modalities:['text'],output_modalities:['image']},supported_parameters:{resolution:{values:['1K']},aspect_ratio:{values:['16:9']}}}]});
   if(url.endsWith('/endpoints'))return Response.json({id:IMAGE,endpoints:[{supported_parameters:{resolution:{values:['1K']},aspect_ratio:{values:['16:9']}},pricing:[{billable:'output_image',unit:'image',cost_usd:'.048'}]}]});
   if(url.endsWith('/images')){calls.push('image');return Response.json({data:[{b64_json:png().toString('base64')}],usage:{cost:.02}});}
   throw Error('Unexpected provider endpoint');
 };
 const app=createApp({port,stateDirectory:directory,key:'OFFLINE_ONLY',models:[MODEL],budget:globalBudget,fetcher,cameraWorkers:false,autonomousWorkers:false});
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);});fs.rmSync(directory,{recursive:true,force:true});});
 const csrf=(await (await fetch(base+'/api/status')).json()).csrf;
 function client(){let cookie='';return async(endpoint,body,headers={})=>{const response=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{Connection:'close',Origin:base,'X-Parallax-Token':csrf,Cookie:cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});const saved=response.headers.getSetCookie().find(c=>c.startsWith('parallax_builder='));if(saved)cookie=saved.split(';')[0];return {status:response.status,data:await response.json()};};}
 const owner=client(),other=client();await owner('/api/builds/config');
 const created=await owner('/api/builds',{gameName:'Agent Fixture',brief:'Build an original rooftop footrace',modelId:MODEL.id});assert.equal(created.status,201);
 const id=created.data.build.id,endpoint='/api/builds/'+id;
 const worker=async(action,body)=>{const key=fs.readFileSync(path.join(directory,'studio-pool.key'),'utf8').trim();return owner('/api/builds/pool/'+action,body,{Origin:'',Authorization:'Bearer '+key});};
 const read=async()=>(await owner(endpoint+'/agent')).data.agent;
 const tick=async()=>{await app.agentTick();return read();};
 const capture=async(job,view)=>{const key=fs.readFileSync(path.join(directory,'studio-pool.key'),'utf8').trim();const response=await fetch(base+'/api/builds/pool/screen',{method:'POST',headers:{Authorization:'Bearer '+key,'X-Parallax-Lease':job.leaseId,'X-Parallax-Lease-Token':job.leaseToken,'X-Ropad-Capture-View':view,'Content-Type':'image/png'},body:png()});assert.equal(response.status,200,await response.text());};
 return {app,directory,calls,owner,other,id,endpoint,worker,read,tick,capture};
}

test('owner starts one bounded real pipeline and only authenticated compatible worker evidence reaches review',async t=>{
 const h=await harness(t);await h.app.agentTick();assert.equal(h.calls.length,0);
 assert.equal((await h.other(h.endpoint+'/agent/start',{})).status,403);
 assert.equal((await h.owner(h.endpoint+'/agent/start',{}, {'X-Parallax-Token':'wrong'})).status,403);
 const start=await h.owner(h.endpoint+'/agent/start',{budgetUsd:1,includeConcept:true,includeThumbnail:true,includeVisualReview:false});assert.equal(start.status,200,JSON.stringify(start.data));
 for(const action of ['generate','concept','thumbnail','enqueue','revisions','connect'])assert.equal((await h.owner(h.endpoint+'/'+action,{})).status,409,action);
 for(let i=0;i<12;i++){const a=await h.tick();if(a.stage==='assembly')break;}
 assert.deepEqual(h.calls,['planning','image','image']);
 const waiting=(await h.owner(h.endpoint)).data.build;assert.equal(waiting.plan.template,'racing');assert.equal(waiting.queue,null);
 const legacy=await h.worker('presence',{workerId:'old-worker',studioId:'old-studio'});assert.equal(legacy.status,200);await h.tick();assert.equal((await h.owner(h.endpoint)).data.build.queue,null);
 const presence=await h.worker('presence',{workerId:'modern-worker',studioId:'fresh-studio',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true});assert.equal(presence.status,200,JSON.stringify(presence.data));
 await h.tick();const claim=await h.worker('claim',{workerId:'modern-worker',studioId:'fresh-studio'});assert.equal(claim.status,200);const job=claim.data.job;assert.equal(job.buildId,h.id);
 const report=await h.worker('report',{leaseId:job.leaseId,leaseToken:job.leaseToken,status:'ready',objectCount:job.plan.parts.length+1,playtest:{result:'passed',message:'Fixture runtime initialization only'}});assert.equal(report.status,200,JSON.stringify(report.data));
 for(let i=0;i<6;i++){const a=await h.tick();if(a.status==='review')break;}
 const final=(await h.owner(h.endpoint)).data.build;assert.equal(final.agent.status,'review');assert.equal(final.readiness.readyForCreatorPublish,false);assert.equal(final.published,false);assert.equal(final.agent.owner,undefined);
 await h.tick();assert.deepEqual(h.calls,['planning','image','image']);
 const publicState=(await h.other(h.endpoint+'/agent')).data;assert.equal(publicState.build.canManage,false);assert.equal(publicState.agent.owner,undefined);
});

test('run cap and shared daily cap stop further paid calls instead of claiming completion',async t=>{
 const h=await harness(t);const start=await h.owner(h.endpoint+'/agent/start',{budgetUsd:.06,includeConcept:true,includeThumbnail:true,includeVisualReview:false});assert.equal(start.status,200,JSON.stringify(start.data));
 for(let i=0;i<9;i++){const a=await h.tick();if(a.status!=='running')break;}
 const a=await h.read();assert.notEqual(a.status,'review');assert.equal(h.calls.filter(x=>x==='planning').length,1);assert.equal(h.calls.includes('image'),false);assert.ok(a.spentUsd>=.05);assert.ok(a.spentUsd<=.06);
 const ledger=JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json'),'utf8'));assert.ok(Math.abs(ledger.spent-.05)<1e-9,'failed run reservation refunded from shared ledger');
});

test('ambiguous provider charges stop the run and do not enter the repair loop',async t=>{
 const h=await harness(t,{respondPlan:()=>new Response('unknown upstream outcome',{status:502})});await h.owner(h.endpoint+'/agent/start',{budgetUsd:1,includeConcept:false,includeThumbnail:false,includeVisualReview:false});
 for(let i=0;i<6;i++){const a=await h.tick();if(a.status!=='running')break;}
 assert.equal(h.calls.length,1);assert.notEqual((await h.read()).status,'review');assert.equal((await h.owner(h.endpoint+'/agent/start',{})).status,409);
 const ledger=JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json'),'utf8'));assert.ok(ledger.spent>0);assert.equal(ledger.unknownCharges,1);
});

test('pause during a provider call checkpoints the saved result and prevents the next paid stage',async t=>{
 let resolveResponse,entered;const reached=new Promise(resolve=>{entered=resolve;});const response=new Promise(resolve=>{resolveResponse=resolve;});
 const h=await harness(t,{respondPlan:()=>{entered();return response;}});await h.owner(h.endpoint+'/agent/start',{budgetUsd:1,includeConcept:true,includeThumbnail:true,includeVisualReview:false});
 // Prompt may occupy its own checkpoint before planning.
 let work=h.app.agentTick();await Promise.race([reached,work]);if(!h.calls.length){await work;work=h.app.agentTick();}await reached;
 const pause=await h.owner(h.endpoint+'/agent/pause',{});assert.equal(pause.status,200,JSON.stringify(pause.data));
 resolveResponse(Response.json({choices:[{message:{content:JSON.stringify(plan())},finish_reason:'stop'}],usage:{cost:.05}}));await work;
 const a=await h.read();assert.equal(a.status,'paused');assert.ok((await h.owner(h.endpoint)).data.build.plan);await h.tick();assert.deepEqual(h.calls,['planning']);
});

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('visual agent uses concept pixels, reviews real worker frames, builds one child and shares its compute cap',async t=>{
 let reviews=0;const plans=[],reviewInputs=[];
 const h=await harness(t,{respondPlan:body=>{plans.push(body);return Response.json({choices:[{message:{content:JSON.stringify(plan())},finish_reason:'stop'}],usage:{cost:.05}});},respondReview:body=>{
   reviewInputs.push(body);reviews++;
   const result=reviews===1?{version:1,verdict:'improve',summary:'Finish lacks visual contrast',issues:[{category:'readability',description:'Finish and floor blend together'}],revisionBrief:'Keep the route and make the finish a mint focal point'}:{version:1,verdict:'acceptable',summary:'Route and finish are visually distinct in the supplied views',issues:[],revisionBrief:''};
   return Response.json({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}],usage:{cost:.01}});
 }});
 const config=(await h.owner('/api/builds/config')).data;assert.equal(config.visualReviewVersion,1);
 assert.equal((await h.owner(h.endpoint+'/agent/start',{budgetUsd:.5,includeConcept:true,includeThumbnail:false,includeVisualReview:true})).status,200);
 async function assemble(buildId,workerId){
   assert.equal((await h.worker('presence',{workerId,studioId:workerId,agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1})).status,200);
   let current;for(let i=0;i<16;i++){await h.tick();current=(await h.owner('/api/builds/'+buildId)).data.build;if(current.queue?.state==='queued')break;}
   assert.equal(current.queue?.state,'queued',JSON.stringify(await h.read()));
   const job=(await h.worker('claim',{workerId,studioId:workerId})).data.job;assert.equal(job.buildId,buildId);
   for(const view of ['overview','spawn','finish'])await h.capture(job,view);
   assert.equal((await h.worker('report',{leaseId:job.leaseId,leaseToken:job.leaseToken,status:'ready',objectCount:job.plan.parts.length+1,playtest:{result:'passed',message:'Offline worker fixture'}})).status,200);
 }
 await assemble(h.id,'visual-worker-one');
 let run;for(let i=0;i<8;i++){run=await h.tick();if(run.currentBuildId!==h.id)break;}
 assert.notEqual(run.currentBuildId,h.id,JSON.stringify(run));const childId=run.currentBuildId;
 assert.equal(run.visualRevisionCount,1);assert.equal(run.budgetUsd,.5);
 assert.equal((await h.owner('/api/builds/'+childId+'/generate',{})).status,409);
 await assemble(childId,'visual-worker-two');
 for(let i=0;i<8;i++){run=await h.tick();if(run.status==='review')break;}
 assert.equal(run.status,'review',JSON.stringify(run));assert.equal(run.visualReviews.length,2);assert.equal(run.visualReviews[1].result.verdict,'acceptable');
 assert.equal(reviews,2);assert.equal(plans.length,2);assert.equal(h.calls.filter(c=>c==='image').length,1);
 for(const request of plans)assert.ok(request.messages[1].content.some(c=>c.type==='image_url'),'both plans use original concept pixels');
 for(const request of reviewInputs)assert.equal(request.messages[1].content.filter(c=>c.type==='image_url').length,4,'three actual views plus original concept');
 const child=(await h.owner('/api/builds/'+childId)).data.build;assert.equal(child.lineage.parentBuildId,h.id);assert.equal(child.agent.runId,run.runId);assert.equal(child.readiness.readyForCreatorPublish,false);
 assert.equal((await h.owner(h.endpoint)).data.build.status,'ready');
 const compute=(await h.owner('/api/builds/'+childId+'/compute')).data.compute;
 assert.ok(compute.reservations.some(row=>row.purpose==='visual_review'));
 assert.ok(run.spentUsd<=run.budgetUsd);assert.equal(run.visualReviews[0].sourceFrames.length,3);
 await h.tick();assert.equal(reviews,2);assert.equal((await h.owner('/api/builds')).data.builds.length,2);
});

function routerRace(t){
 const {createBuildRouter}=require('./parallax/builder-http.cjs');
 const {createRobloxBuildService}=require('./parallax/roblox-builds.cjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-agent-race-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const service=createRobloxBuildService({stateDirectory:directory}),b=service.create({owner:'creator',gameName:'Race fixture',brief:'A safe original rooftop footrace',template:'auto',modelId:MODEL.id});
 const firstCatalog=deferred(),catalogReached=deferred(),providerReply=deferred(),providerReached=deferred();let catalogs=0,generations=0,active=false;
 const agents={get:()=>active?{status:'running'}:null,start:()=>{active=true;return {status:'running'};},assertManualAllowed:()=>{if(active)throw Object.assign(Error('Agent active'),{status:409});}};
 const router=createBuildRouter({stateDirectory:directory,getService:()=>service,getAgentService:()=>agents,walletSessions:()=>[{address:'creator'}],authorizeMutation:()=>{},json:(res,status,data)=>{res.result={status,data};},readJson:async()=>({}),getModels:async()=>{catalogs++;if(catalogs===1){catalogReached.resolve();await firstCatalog.promise;}return [MODEL];},generatePlan:async()=>{generations++;providerReached.resolve();await providerReply.promise;return plan();},configured:true,provider:'openrouter'});
 const call=async action=>{const req={method:'POST',headers:{}},res={setHeader:()=>{}},url=new URL('http://127.0.0.1/api/builds/'+b.id+'/'+action);await router(req,res,url,'127.0.0.1');return res.result;};
 return {call,firstCatalog,catalogReached,providerReply,providerReached,get generations(){return generations;}};
}

test('a manual generation waiting on catalog cannot cross a newly started agent lock',async t=>{
 const h=routerRace(t),manual=h.call('generate');await h.catalogReached.promise;
 assert.equal((await h.call('agent/start')).status,200);h.firstCatalog.resolve();
 await assert.rejects(manual,error=>error.status===409);assert.equal(h.generations,0);
});

test('agent start rechecks a manual generation that began during catalog loading',async t=>{
 const h=routerRace(t),start=h.call('agent/start');await h.catalogReached.promise;
 const manual=h.call('generate');await h.providerReached.promise;h.firstCatalog.resolve();
 await assert.rejects(start,error=>error.status===409);h.providerReply.resolve();assert.equal((await manual).status,200);assert.equal(h.generations,1);
});

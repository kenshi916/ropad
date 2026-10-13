'use strict';
// Local HTTP tests use temporary state, unfunded signing fixtures and mocked providers only.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('./parallax/server.cjs');
const {createTemplatePlan:baseTemplatePlan,createRobloxBuildService}=require('./parallax/roblox-builds.cjs');
const DESIGN={coreLoop:'Jump between checkpoint platforms',objective:'Reach the finish',progression:'Complete each checkpoint',inspiration:'Original sky course inspired by general obstacle-course pacing',limitations:['Creator playtest and manual publishing remain'],acceptanceCriteria:['Player spawns safely','Checkpoints work','Coins can be collected','Finish records completion'],unsupportedFeatures:[]};
const createTemplatePlan=template=>({...baseTemplatePlan(template),design:structuredClone(DESIGN)});
const mockPlan=async()=>Response.json({choices:[{message:{content:JSON.stringify(createTemplatePlan('obby'))},finish_reason:'stop'}],usage:{cost:.0002}});
const {privateKeyToAccount}=require('./parallax/node_modules/viem/accounts');
const ALICE=privateKeyToAccount('0x'+'31'.repeat(32)),BOB=privateKeyToAccount('0x'+'42'.repeat(32));
const MODEL={id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5',architecture:{input_modalities:['text'],output_modalities:['text']},pricing:{prompt:'0.0000001',completion:'0.0000001'}};
const ASTRA={...MODEL,id:'openai/gpt-6-astra',name:'GPT-6 Astra'};
const GEMINI={...MODEL,id:'google/gemini-2.5-flash',name:'Gemini 2.5 Flash'};
const IMAGE={id:'test/image-only',name:'Image generator',architecture:{input_modalities:['text'],output_modalities:['image']},pricing:MODEL.pricing};
const DRAFT={gameName:'Orbit Builder',brief:'Build a neon obby with checkpoints and a finish',modelId:MODEL.id};
const MISSION={kind:'roblox',name:'Orbit Builder',ticker:'ORBIT',brief:DRAFT.brief,template:'auto',modelId:MODEL.id,inspiration:''};
const TOKEN='0x'+'77'.repeat(20),HASH='0x'+'88'.repeat(32);

async function harness(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'parallax-builder-http-'));
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port;
  const calls=[];
  const launch=options.launch||{list:()=>[],prepare:async input=>{calls.push({method:'prepare',...input});return {intentId:'fixture-intent',status:'prepared',mission:input.mission};},confirm:async input=>{calls.push({method:'confirm',...input});return {intentId:input.intentId,status:'confirmed',owner:input.owner,mission:MISSION,token:TOKEN,hash:HASH,agentId:'42'};}};
  let app,csrf;
  const start=async()=>{
    app=createApp({port,stateDirectory:directory,key:'',orbioKey:'',provider:'openrouter',budget:1,models:[MODEL,ASTRA,IMAGE,{...MODEL,id:'test/text-builder:batch'},{...MODEL,id:'openai/gpt-4o-mini'}],cameraWorkers:false,monitor:false,fetcher:async()=>{throw new Error('Unexpected network request in offline test');},orbioService:{models:async()=>({data:[MODEL,ASTRA,GEMINI,IMAGE]}),status:async()=>({chainId:4663})},orbioLaunchService:launch,...options});
    await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
    csrf=(await (await fetch(base+'/api/status',{headers:{Connection:'close'}})).json()).csrf;
  };
  const stop=async()=>{if(app?.server.listening)await new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);});};
  await start();
  t.after(async()=>{await stop();fs.rmSync(directory,{recursive:true,force:true});});
  const client=(initialCookie='')=>{
    const cookies=new Map(initialCookie.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
    const cookie=()=>[...cookies].map(([k,v])=>k+'='+v).join('; ');
    const req=async(endpoint,body,headers={},method=body===undefined?'GET':'POST')=>{
      const raw=Buffer.isBuffer(body);
      const response=await fetch(base+endpoint,{method,headers:{Connection:'close',Origin:base,'X-Parallax-Token':csrf,Cookie:cookie(),...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'}),...headers},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
      for(const c of response.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
      const bytes=Buffer.from(await response.arrayBuffer()),text=bytes.toString('utf8');let data;try{data=JSON.parse(text);}catch{}
      return {status:response.status,headers:response.headers,bytes,text,data};
    };
    const login=async(account=ALICE)=>{const c=await req('/api/orbio/auth/challenge',{address:account.address});assert.equal(c.status,200,c.text);const signature=await account.signMessage({message:c.data.message});const r=await req('/api/orbio/auth/verify',{id:c.data.id,signature});assert.equal(r.status,200,r.text);};
    return {req,cookie,login};
  };
  return {client,calls,directory,base,restart:async(beforeStart)=>{await stop();if(beforeStart)await beforeStart();await start();}};
}
async function create(client,patch={}){const response=await client.req('/api/builds',{...DRAFT,...patch});assert.equal(response.status,201,response.text);return response.data.build;}
const frame=()=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(56)]);

test('build ownership uses an HttpOnly signed cookie, survives restart and rejects another browser or a tampered cookie',async t=>{
  const h=await harness(t),owner=h.client(),other=h.client();
  const config=await owner.req('/api/builds/config');assert.equal(config.status,200);assert.match(config.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal(config.data.apiVersion,2);assert.equal(config.data.creationMode,'prompt');assert.equal(config.data.workerPlanSchema,'scene-v1');
  assert.equal(config.data.manualQueueRequiresAgentWorker,true);assert.equal(config.data.oneBuildPerStudio,true);
  const b=await create(owner);assert.equal(b.canManage,true);assert.equal(b.owner,undefined);
  assert.equal((await other.req('/api/builds/'+b.id)).data.build.canManage,false);
  assert.equal((await other.req('/api/builds/'+b.id+'/prepare',{})).status,403);
  assert.equal((await other.req('/api/builds/'+b.id+'/connect',{})).status,403);
  const saved=owner.cookie();await h.restart();
  const recovered=h.client(saved);assert.equal((await recovered.req('/api/builds/'+b.id)).data.build.canManage,true);
  const tampered=h.client(saved.replace(/.$/,saved.endsWith('a')?'b':'a'));assert.equal((await tampered.req('/api/builds/'+b.id)).data.build.canManage,false);
});

test('browser mutations require origin and CSRF, and public creates cannot forge token linkage or ownership',async t=>{
  const h=await harness(t),c=h.client();
  assert.equal((await c.req('/api/builds',DRAFT,{Origin:'https://other.invalid'})).status,403);
  assert.equal((await c.req('/api/builds',DRAFT,{'X-Parallax-Token':'wrong'})).status,403);
  const b=await create(c,{owner:BOB.address,token:{address:TOKEN,symbol:'FAKE',marketCapUsd:999999},idempotencyKey:'forged',status:'ready',workerToken:'a'.repeat(64),url:'https://untrusted.invalid/execute'});
  assert.equal(b.token,null);assert.equal(b.status,'queued');assert.equal(b.canManage,true);assert.equal(b.workerConfigured,false);
  const publicView=(await h.client().req('/api/builds/'+b.id)).data.build;
  for(const key of ['owner','workerToken','workerHash','workerExpiresAt','idempotencyKey','url'])assert.equal(publicView[key],undefined,key);
  assert.equal((await c.req('/api/builds/'+b.id+'/prepare',{}, {'X-Parallax-Token':'wrong'})).status,403);
});

test('Studio worker uses a scoped bearer token, rotating it revokes the old token, and wrong jobs cannot acknowledge progress',async t=>{
  const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:mockPlan}),owner=h.client(),worker=h.client(),b=await create(owner);
  const prepared=await owner.req('/api/builds/'+b.id+'/generate',{});assert.equal(prepared.status,200,prepared.text);
  assert.equal((await worker.req('/api/builds/'+b.id+'/worker')).status,401);
  const issued=await owner.req('/api/builds/'+b.id+'/connect',{});assert.equal(issued.status,200);assert.match(issued.data.workerToken,/^[a-f0-9]{64}$/);
  const auth={Authorization:'Bearer '+issued.data.workerToken,'X-Parallax-Token':'',Origin:''};
  const polled=await worker.req('/api/builds/'+b.id+'/worker',undefined,auth);assert.equal(polled.status,200,polled.text);assert.ok(polled.data.job.plan.parts.length>3);
  assert.equal((await worker.req('/api/builds/'+b.id+'/worker/ack',{jobId:'wrong',status:'ready',objectCount:30},auth)).status,409);
  const missingScript=await worker.req('/api/builds/'+b.id+'/worker/ack',{jobId:polled.data.job.id,status:'ready',objectCount:polled.data.job.plan.parts.length},auth);assert.equal(missingScript.status,400,missingScript.text);
  const ack=await worker.req('/api/builds/'+b.id+'/worker/ack',{jobId:polled.data.job.id,status:'ready',objectCount:polled.data.job.plan.parts.length+1},auth);assert.equal(ack.status,200,ack.text);assert.equal(ack.data.playtested,false);assert.equal(ack.data.published,false);
  const second=await owner.req('/api/builds/'+b.id+'/connect',{});assert.notEqual(second.data.workerToken,issued.data.workerToken);
  assert.equal((await worker.req('/api/builds/'+b.id+'/worker',undefined,auth)).status,401);
  const other=await create(owner);assert.equal((await worker.req('/api/builds/'+other.id+'/worker',undefined,{Authorization:'Bearer '+second.data.workerToken})).status,401);
});

test('screens require owner or worker authorization and bounded image bytes; URLs and active content are never fetched',async t=>{
  const h=await harness(t),owner=h.client(),other=h.client(),b=await create(owner),endpoint='/api/builds/'+b.id;
  assert.equal((await owner.req(endpoint+'/screen')).status,404);
  assert.equal((await other.req(endpoint+'/screen',frame(),{'Content-Type':'image/png'})).status,403);
  assert.equal((await owner.req(endpoint+'/screen',{url:'https://untrusted.invalid/screen.png'})).status,415);
  assert.equal((await owner.req(endpoint+'/screen',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),{'Content-Type':'image/svg+xml'})).status,415);
  assert.equal((await owner.req(endpoint+'/screen',Buffer.alloc(700001),{'Content-Type':'image/png'})).status,413);
  const uploaded=await owner.req(endpoint+'/screen',frame(),{'Content-Type':'image/png'});assert.equal(uploaded.status,200,uploaded.text);assert.equal(uploaded.data.source,'owner_screen_share');
  const read=await other.req(endpoint+'/screen');assert.equal(read.status,200);assert.equal(read.headers.get('content-type'),'image/png');assert.equal(read.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(read.bytes,frame());
  assert.equal((await owner.req(endpoint)).data.build.studioConnected,false);
  assert.equal((await other.req(endpoint+'/screen-stop',{})).status,403);
  assert.equal((await owner.req(endpoint+'/screen-stop',{})).status,200);assert.equal((await owner.req(endpoint+'/screen')).status,404);
});

test('Roblox launches accept listed advanced text models, reject other models and use the signed-in owner',async t=>{
  const h=await harness(t),c=h.client();
  assert.equal((await c.req('/api/orbio/launches/prepare',{mission:MISSION})).status,401);await c.login();
  for(const patch of [{template:'script'},{modelId:IMAGE.id},{modelId:GEMINI.id},{modelId:'unlisted'}])assert.equal((await c.req('/api/orbio/launches/prepare',{mission:{...MISSION,...patch}})).status,400);
  assert.equal((await c.req('/api/orbio/launches/prepare',{mission:MISSION,agentWallet:BOB.address})).status,400);
  const result=await c.req('/api/orbio/launches/prepare',{mission:{...MISSION,owner:BOB.address,cameraId:'ignored'},owner:BOB.address});assert.equal(result.status,200,result.text);
  const call=h.calls.find(c=>c.method==='prepare');assert.equal(call.owner,ALICE.address.toLowerCase());assert.equal(call.agentWallet,ALICE.address.toLowerCase());assert.deepEqual(call.mission,MISSION);
});

test('confirmed Roblox launches create exactly one coin-linked workspace and pending launches do not create one',async t=>{
  let confirmed=false;
  const h=await harness(t,{launch:{list:()=>[],prepare:async({owner,mission})=>({intentId:'launch-42',status:'prepared',owner,mission}),confirm:async({owner,intentId})=>({intentId,status:confirmed?'confirmed':'pending',owner,mission:MISSION,token:TOKEN,hash:HASH,agentId:'42'})}}),c=h.client();await c.login();
  const pending=await c.req('/api/orbio/launches/confirm',{intentId:'launch-42',hash:HASH});assert.equal(pending.status,200);assert.equal(pending.data.buildSession,undefined);assert.equal((await c.req('/api/builds')).data.builds.length,0);
  confirmed=true;const first=await c.req('/api/orbio/launches/confirm',{intentId:'launch-42',hash:HASH});assert.equal(first.status,200,first.text);assert.ok(first.data.buildSession?.id,first.text);
  const second=await c.req('/api/orbio/launches/confirm',{intentId:'launch-42',hash:HASH});assert.equal(second.data.buildSession.id,first.data.buildSession.id);
  const builds=(await c.req('/api/builds')).data.builds;assert.equal(builds.length,1);assert.equal(builds[0].token.address,TOKEN);assert.equal(builds[0].token.marketCapUsd,null);assert.equal(builds[0].canManage,true);assert.equal(builds[0].studioConnected,false);
});

test('AI generation fails before network for a missing provider key, invalid model or insufficient allowance',async t=>{
  for(const scenario of [{key:'',status:503},{key:'OFFLINE_ONLY',budget:0.00001,status:402},{key:'OFFLINE_ONLY',modelId:IMAGE.id,status:400}]){
    let calls=0;const h=await harness(t,{key:scenario.key,budget:scenario.budget??1,fetcher:async()=>{calls++;throw Error('Must not call provider');}}),c=h.client(),b=await create(c);
    const r=await c.req('/api/builds/'+b.id+'/generate',{modelId:scenario.modelId||MODEL.id});assert.equal(r.status,scenario.status,r.text);assert.equal(calls,0);assert.equal((await c.req('/api/status')).data.spent,0);
  }
});

test('provider key rejection releases the reservation without leaking credentials or creating a scene',async t=>{
  let calls=0;const h=await harness(t,{key:'OFFLINE_PROVIDER_KEY',fetcher:async(url,options)=>{calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer OFFLINE_PROVIDER_KEY');return new Response('',{status:401});}}),c=h.client(),b=await create(c);
  const r=await c.req('/api/builds/'+b.id+'/generate',{modelId:MODEL.id});assert.equal(r.status,401,r.text);assert.doesNotMatch(r.text,/OFFLINE_PROVIDER_KEY/);assert.equal(calls,1);
  assert.equal((await c.req('/api/status')).data.spent,0);assert.equal((await c.req('/api/builds/'+b.id)).data.build.plan,null);
});

test('AI output is validated before queueing, excludes reasoning, and settles measured cost',async t=>{
  const plan=createTemplatePlan('obby');let payload;
  const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async(url,options)=>{payload=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify(plan),reasoning:'PRIVATE_INTERNAL_REASONING'},finish_reason:'stop'}],usage:{cost:0.0002}});}}),c=h.client(),b=await create(c);
  const r=await c.req('/api/builds/'+b.id+'/generate',{modelId:MODEL.id});assert.equal(r.status,200,r.text);assert.equal(r.data.build.planSource,'model');assert.equal(r.data.build.status,'waiting_for_studio');assert.doesNotMatch(r.text,/PRIVATE_INTERNAL_REASONING/);assert.equal(payload.reasoning.exclude,true);assert.equal(payload.stream,false);
  const status=(await c.req('/api/status')).data;assert.ok(Math.abs(status.spent-0.0002)<1e-10);assert.equal(status.busy,false);
  const artifact=await c.req('/api/builds/'+b.id+'/artifact?format=luau');assert.equal(artifact.status,200);assert.match(artifact.text,/Creates a new isolated folder/);assert.doesNotMatch(artifact.text,/OFFLINE_ONLY|PRIVATE_INTERNAL_REASONING/);
});

test('arbitrary code in model plans is rejected and uncertain charges keep their allowance reserved',async t=>{
  const plan={...createTemplatePlan('obby'),script:'loadstring("untrusted")()'};
  const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}]})}),c=h.client(),b=await create(c);
  const r=await c.req('/api/builds/'+b.id+'/generate',{modelId:MODEL.id});assert.equal(r.status,400,r.text);assert.match(r.text,/unsupported fields/);
  const status=(await c.req('/api/status')).data;assert.ok(status.spent>0);assert.equal(status.unknownCharges,1);assert.equal(status.busy,false);assert.equal((await c.req('/api/builds/'+b.id)).data.build.plan,null);
});

test('a prepared build rejects a second paid generation before contacting the provider',async t=>{
  let calls=0;const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(createTemplatePlan('obby'))},finish_reason:'stop'}],usage:{cost:0.0002}});}}),c=h.client(),b=await create(c);
  assert.equal((await c.req('/api/builds/'+b.id+'/generate',{})).status,200);
  const r=await c.req('/api/builds/'+b.id+'/generate',{modelId:MODEL.id});assert.equal(r.status,409,r.text);assert.equal(calls,1);
});

test('a pending AI design blocks duplicate paid generation and a competing starter plan',async t=>{
  let entered,finish,calls=0;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
  const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async()=>{calls++;entered();await gate;return Response.json({choices:[{message:{content:JSON.stringify(createTemplatePlan('obby'))},finish_reason:'stop'}],usage:{cost:0.0002}});}}),c=h.client(),b=await create(c);
  const first=c.req('/api/builds/'+b.id+'/generate',{modelId:MODEL.id});
  try{
    await started;
    assert.equal((await c.req('/api/builds/'+b.id+'/generate',{modelId:MODEL.id})).status,409);
    assert.equal((await c.req('/api/builds/'+b.id+'/prepare',{})).status,410);
    assert.equal((await c.req('/api/builds/'+b.id+'/revisions',{brief:'Rebuild with a longer course'})).status,409);
    assert.equal(calls,1);
  }finally{finish();}
  assert.equal((await first).status,200);
  assert.equal((await c.req('/api/builds/'+b.id)).data.build.planSource,'model');
});

test('multibyte model text survives provider chunk boundaries without corrupting the public plan',async t=>{
  const plan={...createTemplatePlan('obby'),summary:'A café skyline course 🌌'};
  const data=Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:0.0002}}));
  const split=data.indexOf(Buffer.from('🌌'))+1;
  async function* body(){yield data.subarray(0,split);yield data.subarray(split,split+1);yield data.subarray(split+1);}
  const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async()=>({ok:true,body:body()})}),c=h.client(),b=await create(c);
  const r=await c.req('/api/builds/'+b.id+'/generate',{modelId:MODEL.id});assert.equal(r.status,200,r.text);assert.equal(r.data.build.plan.summary,plan.summary);
});

test('builder catalog exposes only exact available advanced models with a shared plan cap',async t=>{
  const h=await harness(t),c=h.client(),result=await c.req('/api/builds/models');
  assert.equal(result.status,200,result.text);assert.deepEqual(result.data.data.map(m=>m.id),[MODEL.id,ASTRA.id]);
  assert.equal(result.data.defaultModelId,MODEL.id);assert.deepEqual(result.data.allowedModelIds,[MODEL.id,ASTRA.id]);assert.equal(result.data.maxPlanEstimateUsd,.75);
  for(const m of result.data.data){assert.equal(typeof m.estimatedPlanCostUsd,'number');assert.equal(m.withinPlanAllowance,true);}
});

test('creation and paid generation reject crafted lower-tier IDs with no provider call or workspace side effect',async t=>{
  let calls=0;const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async()=>{calls++;throw Error('Must not call provider');}}),c=h.client();
  for(const modelId of ['openai/gpt-4o-mini','openrouter/auto','anthropic/claude-opus-latest','']){
    const r=await c.req('/api/builds',{...DRAFT,modelId});assert.equal(r.status,400,r.text);
  }
  assert.equal((await c.req('/api/builds')).data.builds.length,0);
  const b=await create(c);
  for(const modelId of ['openai/gpt-4o-mini','openrouter/auto']){
    const r=await c.req('/api/builds/'+b.id+'/generate',{modelId});assert.equal(r.status,400,r.text);
  }
  assert.equal(calls,0);assert.equal((await c.req('/api/builds/'+b.id)).data.build.plan,null);assert.equal((await c.req('/api/status')).data.spent,0);
});

test('prompt-only creation uses Opus and removes the public starter bypass',async t=>{
  const h=await harness(t),c=h.client(),draft={...DRAFT};delete draft.modelId;
  const result=await c.req('/api/builds',draft);assert.equal(result.status,201,result.text);assert.equal(result.data.build.modelId,MODEL.id);assert.equal(result.data.build.template,'auto');
  assert.equal((await c.req('/api/builds',{...draft,modelId:'template'})).status,400);
  assert.equal((await c.req('/api/builds',{...draft,template:'obby'})).status,400);
  assert.equal((await c.req('/api/builds/'+result.data.build.id+'/prepare',{})).status,410);
  assert.equal((await c.req('/api/builds/'+result.data.build.id)).data.build.plan,null);
});

test('prompt revisions preserve wallet ownership and coin identity without launching or charging again',async t=>{
  let inferenceCalls=0;
  const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async()=>{inferenceCalls++;return mockPlan();}}),c=h.client(),other=h.client();
  await c.login();
  const confirmed=await c.req('/api/orbio/launches/confirm',{intentId:'revision-token',hash:HASH});assert.equal(confirmed.status,200,confirmed.text);
  const original=confirmed.data.buildSession,endpoint='/api/builds/'+original.id;
  assert.equal((await c.req(endpoint+'/generate',{})).status,200);const before=(await c.req(endpoint)).data.build;
  const launchCalls=h.calls.length,spent=(await c.req('/api/status')).data.spent;
  assert.equal((await other.req(endpoint+'/revisions',{brief:'Hijack game'})).status,403);
  assert.equal((await c.req(endpoint+'/revisions',{brief:'New game'}, {'X-Parallax-Token':'wrong'})).status,403);
  assert.equal((await c.req(endpoint+'/revisions',{brief:'New game',modelId:GEMINI.id})).status,400);
  const revised=await c.req(endpoint+'/revisions',{brief:'Turn this into a coastal tycoon with coin collection and purchase pads',modelId:ASTRA.id,inspiration:'Original harbor theme; inspired by tycoon upgrade pacing',token:{address:'forged'},owner:BOB.address});
  assert.equal(revised.status,201,revised.text);const b=revised.data.build;
  assert.notEqual(b.id,original.id);assert.equal(b.modelId,ASTRA.id);assert.equal(b.template,'auto');assert.equal(b.plan,null);assert.equal(b.canManage,true);
  assert.deepEqual(b.token,original.token);assert.deepEqual(b.lineage,{projectId:original.id,parentBuildId:original.id,version:2});assert.equal(b.previousDesign.summary,before.plan.summary);
  assert.equal(h.calls.length,launchCalls);assert.equal(inferenceCalls,1);assert.equal((await c.req('/api/status')).data.spent,spent);
  assert.deepEqual((await c.req(endpoint)).data.build.plan,before.plan);assert.equal((await c.req('/api/builds/'+b.id)).data.build.revisions.length,2);
  const saved=c.cookie();await h.restart();const recovered=h.client(saved);assert.equal((await recovered.req('/api/builds/'+b.id)).data.build.lineage.version,2);
});

test('review API protects owner and CSRF and refuses unassembled builds',async t=>{
  const h=await harness(t),c=h.client(),other=h.client(),b=await create(c),endpoint='/api/builds/'+b.id+'/review';
  const review={gameplayPassed:true,performancePassed:true,contentReviewed:true,notes:'Checked in Studio',publishedUrl:'https://www.roblox.com/games/1234'};
  assert.equal((await other.req(endpoint,review)).status,403);assert.equal((await c.req(endpoint,review,{'X-Parallax-Token':'wrong'})).status,403);
  assert.equal((await c.req(endpoint,review)).status,409);
  const after=(await c.req('/api/builds/'+b.id)).data.build;assert.equal(after.creatorReview,undefined);assert.equal(after.readiness.readyForCreatorPublish,false);assert.equal(after.published,false);
});

test('trade routes derive verified tokens from saved builds and wallet identity from signed sessions',async t=>{
  const calls=[],trade={market:async input=>{calls.push({action:'market',...input});return {available:true,token:input.token};},quote:async input=>{calls.push({action:'quote',...input});return {intentId:'fixture-trade',simulation:'passed'};},receipt:async input=>{calls.push({action:'receipt',...input});return {status:'pending'};}};
  const h=await harness(t,{orbioTradeService:trade}),store=createRobloxBuildService({stateDirectory:h.directory});
  const createToken=token=>store.create({owner:ALICE.address.toLowerCase(),...DRAFT,template:'auto',token});
  const verified={address:TOKEN,symbol:'ORBIT',chainId:4663,transactionHash:HASH,verified:true};
  const valid=createToken(verified),draft=createToken(null),unverified=createToken({...verified,verified:false}),wrongChain=createToken({...verified,chainId:1});
  const anonymous=h.client(),buyer=h.client();
  for(const build of [draft,unverified,wrongChain])assert.equal((await anonymous.req('/api/orbio/trades/market?buildId='+build.id)).status,409);
  assert.equal(calls.length,0);
  const market=await anonymous.req('/api/orbio/trades/market?buildId='+valid.id+'&token='+BOB.address);assert.equal(market.status,200,market.text);assert.equal(calls[0].token,TOKEN);
  const payload={buildId:valid.id,side:'buy',amount:'2',slippageBps:100,token:BOB.address,owner:ALICE.address};
  assert.equal((await anonymous.req('/api/orbio/trades/quote',payload)).status,401);await buyer.login(BOB);
  assert.equal((await buyer.req('/api/orbio/trades/quote',payload,{'X-Parallax-Token':'wrong'})).status,403);
  assert.equal((await buyer.req('/api/orbio/trades/quote',{...payload,buildId:unverified.id})).status,409);
  const quote=await buyer.req('/api/orbio/trades/quote',payload);assert.equal(quote.status,200,quote.text);
  assert.deepEqual(calls.at(-1),{action:'quote',token:TOKEN,owner:BOB.address.toLowerCase(),side:'buy',amount:'2',slippageBps:100});
  assert.equal((await buyer.req('/api/builds/'+valid.id)).data.build.canManage,false);
  assert.equal((await anonymous.req('/api/orbio/trades/receipt',{intentId:'fixture-trade',hash:HASH})).status,401);
  assert.equal((await buyer.req('/api/orbio/trades/receipt',{intentId:'fixture-trade',hash:HASH,owner:ALICE.address})).status,200);
  assert.deepEqual(calls.at(-1),{action:'receipt',owner:BOB.address.toLowerCase(),intentId:'fixture-trade',hash:HASH});
});

test('a missing approved model is not silently replaced by another model',async t=>{
  const h=await harness(t,{models:[ASTRA,{...MODEL,id:'openai/gpt-4o-mini'}]}),c=h.client();
  const result=await c.req('/api/builds/models');assert.deepEqual(result.data.data.map(m=>m.id),[ASTRA.id]);
  const missing=await c.req('/api/builds',DRAFT);assert.equal(missing.status,503,missing.text);
  const available=await create(c,{modelId:ASTRA.id});assert.equal(available.modelId,ASTRA.id);
});

test('Orbio Roblox catalog applies the same advanced policy while its generic catalog remains complete',async t=>{
  const h=await harness(t),c=h.client(),roblox=await c.req('/api/orbio/models?kind=roblox'),generic=await c.req('/api/orbio/models');
  assert.equal(roblox.status,200,roblox.text);assert.deepEqual(roblox.data.data.map(m=>m.id),[MODEL.id,ASTRA.id]);assert.equal(roblox.data.defaultModelId,MODEL.id);assert.equal(roblox.data.maxPlanEstimateUsd,.75);
  assert.deepEqual(generic.data.data.map(m=>m.id),[MODEL.id,ASTRA.id,GEMINI.id,IMAGE.id]);
});

test('legacy workspace provenance remains readable but an old model cannot start new AI generation',async t=>{
  let calls=0;const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(createTemplatePlan('obby'))},finish_reason:'stop'}],usage:{cost:.0002}});}}),c=h.client();
  const pending=await create(c),prepared=await create(c);assert.equal((await c.req('/api/builds/'+prepared.id+'/generate',{})).status,200);calls=0;const cookie=c.cookie();
  await h.restart(()=>{
    const file=path.join(h.directory,'roblox-builds','sessions.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
    for(const session of state.sessions)session.modelId=GEMINI.id;
    fs.writeFileSync(file,JSON.stringify(state));
  });
  const owner=h.client(cookie);
  assert.equal((await owner.req('/api/builds/'+pending.id)).data.build.modelId,GEMINI.id);
  assert.equal((await owner.req('/api/builds/'+prepared.id)).data.build.modelId,GEMINI.id);
  const blocked=await owner.req('/api/builds/'+pending.id+'/generate',{});assert.equal(blocked.status,400,blocked.text);assert.equal(calls,0);
  const upgraded=await owner.req('/api/builds/'+pending.id+'/generate',{modelId:ASTRA.id});assert.equal(upgraded.status,200,upgraded.text);assert.equal(upgraded.data.build.modelId,ASTRA.id);assert.equal(calls,1);
  assert.equal((await owner.req('/api/builds/'+prepared.id)).data.build.modelId,GEMINI.id);
});

function projectPlanFixture(){
 const plan=createTemplatePlan('obby');plan.version=2;
 plan.project={version:1,scripts:[{id:'Welcome',target:'client',source:'local gui = Instance.new("ScreenGui"); gui.Name = root.Name .. "Welcome"; gui.Parent = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")'}],components:{hud:{title:'Orbit Builder',accent:[123,250,202],panel:[12,20,34]},environment:[{id:'Garden',kind:'planter',position:[20,4,0],size:[6,4,4],color:[70,90,80],accent:[100,170,110]}]}};
 return plan;
}
const mockProjectPlan=async()=>Response.json({choices:[{message:{content:JSON.stringify(projectPlanFixture())},finish_reason:'stop'}],usage:{cost:.0003}});
test('HTTP scene-v2 generation delivers complete editable source only to the owner endpoint',async t=>{
 const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:mockProjectPlan,autonomousWorkers:false}),owner=h.client(),other=h.client(),b=await create(owner);
 const generated=await owner.req('/api/builds/'+b.id+'/generate',{});assert.equal(generated.status,200,generated.text);assert.equal(generated.data.build.plan.version,2);assert.equal(generated.data.build.delivery.includesProjectSource,true);
 const files=await owner.req('/api/builds/'+b.id+'/project');assert.equal(files.status,200,files.text);assert.equal(files.data.files[0].id,'Welcome');assert.equal(files.data.manifest.sourceHash,generated.data.build.project.sourceHash);
 assert.equal((await other.req('/api/builds/'+b.id+'/project')).status,403);
 const publicView=(await other.req('/api/builds/'+b.id)).data.build;
 for(const key of ['owner','workerHash','workerToken','workerExpiresAt','poolLease'])assert.equal(publicView[key],undefined,key);
 assert.equal(publicView.canManage,false);assert.equal(publicView.project.sandboxed,false);assert.equal(publicView.delivery.playtested,false);
 const exported=await other.req('/api/builds/'+b.id+'/artifact?format=rbxlx');assert.equal(exported.status,200);assert.match(exported.text,/LocalScript/);assert.match(exported.text,/RopadPresentation/);assert.equal(exported.text.includes('OFFLINE_ONLY'),false);
});
test('HTTP code updates create replay-safe immutable versions and reject wrong owners or stale hashes',async t=>{
 const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:mockProjectPlan,autonomousWorkers:false}),owner=h.client(),other=h.client(),b=await create(owner);
 const original=(await owner.req('/api/builds/'+b.id+'/generate',{})).data.build;
 const before=(await owner.req('/api/builds/'+b.id+'/artifact?format=json')).text;
 const request={fileId:'Welcome',target:'client',source:'root:SetAttribute("ClientInstructions", "Follow the route")',expectedHash:original.project.sourceHash,idempotencyKey:'http-source-edit-01'};
 assert.equal((await other.req('/api/builds/'+b.id+'/project/file',request)).status,403);
 assert.equal((await owner.req('/api/builds/'+b.id+'/project/file',{...request,expectedHash:'0'.repeat(64)})).status,409);
 const changed=await owner.req('/api/builds/'+b.id+'/project/file',request);assert.equal(changed.status,201,changed.text);assert.notEqual(changed.data.build.id,b.id);assert.equal(changed.data.build.lineage.parentBuildId,b.id);assert.equal(changed.data.build.planSource,'creator_revision');
 const repeated=await owner.req('/api/builds/'+b.id+'/project/file',request);assert.equal(repeated.status,201,repeated.text);assert.equal(repeated.data.build.id,changed.data.build.id);
 assert.equal((await owner.req('/api/builds/'+b.id+'/project/file',{...request,source:'print("different code")'})).status,409);
 assert.equal((await owner.req('/api/builds/'+b.id+'/artifact?format=json')).text,before);
 assert.equal((await other.req('/api/builds/'+changed.data.build.id+'/project')).status,403);
 const child=(await owner.req('/api/builds/'+changed.data.build.id+'/project')).data;assert.equal(child.files[0].source,request.source);
});
test('HTTP code updates cannot race an approved running agent',async t=>{
 const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:mockProjectPlan,autonomousWorkers:false}),owner=h.client(),b=await create(owner);
 const original=(await owner.req('/api/builds/'+b.id+'/generate',{})).data.build;
 const started=await owner.req('/api/builds/'+b.id+'/agent/start',{budgetUsd:1,includeConcept:false,includeThumbnail:false,includeVisualReview:false});assert.equal(started.status,200,started.text);
 const edit=await owner.req('/api/builds/'+b.id+'/project/file',{fileId:'Welcome',target:'client',source:'print("revision")',expectedHash:original.project.sourceHash,idempotencyKey:'http-source-agent-01'});
 assert.equal(edit.status,409);assert.match(edit.text,/Pause the agent/);
 assert.equal((await owner.req('/api/builds/'+b.id)).data.build.plan.project.scripts[0].source,original.plan.project.scripts[0].source);
});
test('HTTP publishing preparation and submission are owner scoped and require explicit publication requests',async t=>{
 const calls=[];const publishingService={latest:()=>null,status:input=>({configured:true,buildId:input.buildId}),prepare:async input=>{calls.push({action:'prepare',...input});return {intentId:'publication-test',artifactHash:'a'.repeat(64),requiresConfirmation:true};},publish:async input=>{calls.push({action:'publish',...input});return {url:'https://www.roblox.com/games/123456',versionNumber:2,publicAccessVerified:false};}};
 const h=await harness(t,{key:'OFFLINE_ONLY',fetcher:mockProjectPlan,autonomousWorkers:false,publishingService}),owner=h.client(),other=h.client(),b=await create(owner);
 await owner.req('/api/builds/'+b.id+'/generate',{});assert.equal(calls.length,0);
 assert.equal((await other.req('/api/builds/'+b.id+'/publication')).status,403);assert.equal((await other.req('/api/builds/'+b.id+'/publication/prepare',{})).status,403);assert.equal(calls.length,0);
 const prepared=await owner.req('/api/builds/'+b.id+'/publication/prepare',{});assert.equal(prepared.status,200,prepared.text);assert.equal(calls.length,1);assert.equal(calls[0].buildId,b.id);
 const published=await owner.req('/api/builds/'+b.id+'/publication/publish',{intentId:prepared.data.intentId,artifactHash:prepared.data.artifactHash});assert.equal(published.status,200,published.text);assert.equal(calls.length,2);assert.equal(calls[1].owner,calls[0].owner);assert.equal(published.data.publicAccessVerified,false);
 assert.equal(JSON.stringify(published.data).includes(calls[0].owner),false);
});

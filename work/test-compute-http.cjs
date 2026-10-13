'use strict';
// Offline-only accounting integration: no provider calls, chain reads or signing.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createApp}=require('./parallax/server.cjs');
const {createBuildCompute}=require('./parallax/builder-compute.cjs');
const {createTemplatePlan}=require('./parallax/roblox-builds.cjs');
const MODEL={id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5',architecture:{input_modalities:['text'],output_modalities:['text']},pricing:{prompt:'0.0000001',completion:'0.0000001'}};
const plan=()=>({...createTemplatePlan('racing'),design:{coreLoop:'Run and replay',objective:'Finish',progression:'Checkpoints',inspiration:'Genre mechanics',limitations:['Human gameplay review required'],unsupportedFeatures:[],acceptanceCriteria:['Spawn','First checkpoint','Full route','Finish and replay']}});
async function harness(t,{sponsorDailyUsd=1,response,setup,now=Date.now}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-compute-http-')),probe=http.createServer();
 await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));let calls=0;
 setup?.(directory);
 const base='http://127.0.0.1:'+port,app=createApp({port,stateDirectory:directory,key:'OFFLINE_ONLY',models:[MODEL],cameraWorkers:false,autonomousWorkers:false,sponsorDailyUsd,now,fetcher:async url=>{
   assert.ok(url.endsWith('/chat/completions'));calls++;return response?response({directory}):Response.json({choices:[{message:{content:JSON.stringify(plan())},finish_reason:'stop'}],usage:{cost:.05}});
 }});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>{app.server.closeAllConnections();app.server.close(r);});const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^ropad-compute-http-/);fs.rmSync(resolved,{recursive:true,force:true});});
 const csrf=(await (await fetch(base+'/api/status')).json()).csrf;
 function client(){let cookie='';return async(endpoint,body,headers={})=>{
   const res=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{Origin:base,'X-Parallax-Token':csrf,Cookie:cookie,'Content-Type':'application/json',Connection:'close',...headers},body:body===undefined?undefined:JSON.stringify(body)});
   const saved=res.headers.getSetCookie().find(c=>c.startsWith('parallax_builder='));if(saved)cookie=saved.split(';')[0];return {status:res.status,data:await res.json()};
 };}
 const owner=client(),other=client(),config=await owner('/api/builds/config');assert.equal(config.data.computeAccounting,true);
 const created=await owner('/api/builds',{gameName:'Ledger Fixture',brief:'Create an original rooftop footrace',modelId:MODEL.id});assert.equal(created.status,201,JSON.stringify(created.data));
 const id=created.data.build.id,endpoint='/api/builds/'+id;
 return {directory,app,owner,other,id,endpoint,get calls(){return calls;}};
}
test('viewing compute grants nothing; manual plans charge project ledger and revisions share it',async t=>{
 const h=await harness(t),before=await h.owner(h.endpoint+'/compute');assert.equal(before.status,200,JSON.stringify(before.data));
 assert.equal(before.data.compute.sponsoredNanoUsd,'0');assert.equal(before.data.fees.status,'inactive');
 assert.equal(fs.existsSync(path.join(h.directory,'compute-ledger.json')),false);
 const generated=await h.owner(h.endpoint+'/generate',{});assert.equal(generated.status,200,JSON.stringify(generated.data));assert.equal(h.calls,1);
 const owner=(await h.owner(h.endpoint+'/compute')).data;assert.equal(owner.canManage,true);assert.equal(owner.compute.spentNanoUsd,'50000000');assert.ok(owner.compute.events.length);
 const publicState=(await h.other(h.endpoint+'/compute')).data;assert.equal(publicState.canManage,false);assert.equal(publicState.compute.spentNanoUsd,'50000000');
 for(const field of ['grants','events','reservations','operations'])assert.equal(publicState.compute[field],undefined);
 const revised=await h.owner(h.endpoint+'/revisions',{brief:'Add a longer original route with a visible finish'});assert.equal(revised.status,201,JSON.stringify(revised.data));
 const revisionEndpoint='/api/builds/'+revised.data.build.id;
 assert.equal((await h.owner(revisionEndpoint+'/compute')).data.compute.projectId,h.id);
 assert.equal((await h.owner(revisionEndpoint+'/generate',{})).status,200);
 assert.equal((await h.owner(h.endpoint+'/compute')).data.compute.spentNanoUsd,'100000000');
});
test('project allowance blocks provider work and refunds the global reservation',async t=>{
 const h=await harness(t,{sponsorDailyUsd:0});const denied=await h.owner(h.endpoint+'/generate',{});
 assert.equal(denied.status,402,JSON.stringify(denied.data));assert.equal(h.calls,0);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json'))).spent,0);
 assert.equal((await h.owner(h.endpoint+'/compute')).data.compute.spentNanoUsd,'0');
});
test('ambiguous provider result retains project reservation once as unknown',async t=>{
 const h=await harness(t,{response:()=>new Response('ambiguous',{status:502})});assert.equal((await h.owner(h.endpoint+'/generate',{})).status,502);
 const {compute}= (await h.owner(h.endpoint+'/compute')).data;assert.equal(compute.unknownChargeCount,1);assert.ok(BigInt(compute.unknownChargeNanoUsd)>0n);assert.equal(compute.reservedNanoUsd,'0');assert.equal(h.calls,1);
});
test('fee reconciliation is owner-only and rejects non-mainnet build before network access',async t=>{
 const h=await harness(t);
 assert.equal((await h.other(h.endpoint+'/fees/reconcile',{signature:'made-up',mint:'client-controlled'})).status,403);
 assert.equal((await h.owner(h.endpoint+'/fees/reconcile',{}, {'X-Parallax-Token':'wrong'})).status,403);
 assert.equal((await h.owner(h.endpoint+'/fees/reconcile',{signature:'made-up',mint:'client-controlled'})).status,409);
 assert.equal(h.calls,0);
});
test('daily settlement write failure stops work without claiming a successful build',async t=>{
 const rename=fs.renameSync;t.after(()=>{fs.renameSync=rename;});
 const h=await harness(t,{response:({directory})=>{
   fs.renameSync=(from,to)=>{if(to===path.join(directory,'runtime.json'))throw Error('fixture disk failure');return rename(from,to);};
   return Response.json({choices:[{message:{content:JSON.stringify(plan())},finish_reason:'stop'}],usage:{cost:.05}});
 }});
 const result=await h.owner(h.endpoint+'/generate',{});fs.renameSync=rename;
 assert.equal(result.status,503,JSON.stringify(result.data));assert.match(result.data.error,/settlement/);
 assert.equal((await h.owner(h.endpoint+'/compute')).data.compute.spentNanoUsd,'50000000');
 assert.equal((await h.owner(h.endpoint+'/generate',{})).status,503);assert.equal(h.calls,1);
});
test('startup restores lost daily cost increases while retaining other daily spending',async t=>{
 const now=()=>Date.parse('2026-10-09T20:00:00Z'),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',operationId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const h=await harness(t,{now,setup:directory=>{
   const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:directory,now});
   ledger.reserve({projectId:id,buildId:id,operationId,purpose:'planning',provider:'openrouter',estimateUsd:.1});ledger.settle({operationId,actualUsd:.6});
   fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({day:'2026-10-09',spent:.3,history:[],unknownCharges:0,builderCharges:{[operationId]:.1}}));
 }});
 const status=(await h.owner('/api/status')).data;assert.ok(Math.abs(status.spent-.8)<1e-9,JSON.stringify(status));
 const saved=JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json')));assert.equal(saved.builderCharges[operationId],.6);assert.ok(Math.abs(saved.spent-.8)<1e-9);assert.equal(h.calls,0);
});

async function localStatus(app){
 let status;await app.server.listeners('request')[0]({method:'GET',url:'/api/status',headers:{host:'127.0.0.1:61281'}},{setHeader(){},writeHead(){},end(raw){status=JSON.parse(raw);}});return status;
}
test('a known project-settlement write failure replays its exact charge once after same-day or next-day restart',async t=>{
 for(const afterMidnight of [false,true]){
   let clock=Date.parse('2026-10-09T20:00:00Z');const now=()=>clock,rename=fs.renameSync;t.after(()=>{fs.renameSync=rename;});
   const h=await harness(t,{now,response:({directory})=>{
     fs.renameSync=(from,to)=>{if(to===path.join(directory,'compute-ledger.json'))throw Error('fixture project write failure');return rename(from,to);};
     return Response.json({choices:[{message:{content:JSON.stringify(plan())},finish_reason:'stop'}],usage:{cost:.6}});
   }});
   const response=await h.owner(h.endpoint+'/generate',{});fs.renameSync=rename;assert.equal(response.status,503);assert.equal(h.calls,1);
   const pending=JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json')));assert.equal(pending.builderSettlements.length,1);assert.equal(pending.builderSettlements[0].actualNanoUsd,'600000000');assert.equal(pending.spent,.6);
   assert.equal((await h.owner('/api/status')).data.computeRecoveryRequired,true);
   assert.equal((await h.owner(h.endpoint+'/generate',{})).status,503);assert.equal(h.calls,1);
   await new Promise(resolve=>{h.app.server.closeAllConnections();h.app.server.close(resolve);});
   if(afterMidnight)clock+=86400000;
   const config={stateDirectory:h.directory,now,key:'OFFLINE_ONLY',models:[],cameraWorkers:false,autonomousWorkers:false,fetcher:()=>{throw Error('No external requests in recovery');}};
   const restored=createApp(config),status=await localStatus(restored);
   assert.equal(status.computeRecoveryRequired,false);assert.equal(status.spent,afterMidnight?0:.6);
   const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:h.directory,now});
   const view=ledger.view(h.id);assert.equal(view.spentUsd,'0.6');assert.equal(view.unknownChargeUsd,'0');assert.equal(view.availableUsd,afterMidnight?'0':'0.4');
   assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json'))).builderSettlements.length,0);
   const again=createApp(config);assert.equal((await localStatus(again)).spent,afterMidnight?0:.6);
   assert.equal(ledger.view(h.id).events.filter(event=>event.type==='settled').length,1);
 }
});

test('a settlement journal surviving a crash before daily commit reconciles exact overage or unknown hold',async t=>{
 for(const actualNanoUsd of ['600000000',null]){
   const now=()=>Date.parse('2026-10-10T20:00:00Z'),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',operationId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
   const h=await harness(t,{now,setup:directory=>{
     const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:directory,now:()=>now()-86400000});
     ledger.reserve({projectId:id,buildId:id,operationId,purpose:'planning',provider:'openrouter',estimateUsd:.1});
     fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({day:'2026-10-09',spent:.1,history:[],unknownCharges:0,builderCharges:{[operationId]:.1},builderSettlements:[{operationId,projectId:id,buildId:id,day:'2026-10-09',estimateNanoUsd:'100000000',actualNanoUsd,at:now()-86400000}]}));
   }});
   const status=(await h.owner('/api/status')).data;assert.equal(status.spent,0);assert.equal(status.computeRecoveryRequired,false);
   const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:h.directory,now}),view=ledger.view(id);
   assert.equal(view.spentUsd,actualNanoUsd?'0.6':'0');assert.equal(view.unknownChargeUsd,actualNanoUsd?'0':'0.1');assert.equal(view.availableUsd,'0');assert.equal(h.calls,0);
 }
});

test('same-day journal recovery preserves unrelated spend and applies exact refunds and unknown counts once',async t=>{
 for(const [actualNanoUsd,dailyApplied,expectedSpent,unknownCharges] of [['600000000',false,.8,0],['0',false,.2,0],[null,false,.3,0],[null,true,.3,1]]){
   const now=()=>Date.parse('2026-10-09T20:00:00Z'),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',operationId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
   const h=await harness(t,{now,setup:directory=>{
     const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:directory,now});ledger.reserve({projectId:id,buildId:id,operationId,purpose:'planning',provider:'openrouter',estimateUsd:.1});
     fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({day:'2026-10-09',spent:.3,history:[],unknownCharges,builderCharges:{[operationId]:.1},builderSettlements:[{operationId,projectId:id,buildId:id,day:'2026-10-09',estimateNanoUsd:'100000000',actualNanoUsd,dailyApplied,at:now()}]}));
   }});
   const status=(await h.owner('/api/status')).data;assert.ok(Math.abs(status.spent-expectedSpent)<1e-9,JSON.stringify(status));assert.equal(status.unknownCharges,actualNanoUsd===null?1:0);assert.equal(status.computeRecoveryRequired,false);assert.equal(h.calls,0);
   const again=createApp({stateDirectory:h.directory,now,key:'OFFLINE_ONLY',models:[],cameraWorkers:false,autonomousWorkers:false,fetcher:()=>{throw Error('No network permitted');}});
   const repeated=await localStatus(again);assert.equal(repeated.spent,status.spent);assert.equal(repeated.unknownCharges,status.unknownCharges);
 }
});

test('a mismatched pending settlement is preserved and blocks paid work across a daily rollover',async t=>{
 const now=()=>Date.parse('2026-10-10T20:00:00Z'),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',operationId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';let original;
 const h=await harness(t,{now,setup:directory=>{
   const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:directory,now:()=>now()-86400000});ledger.reserve({projectId:id,buildId:id,operationId,purpose:'planning',provider:'openrouter',estimateUsd:.1});
   original=JSON.stringify({day:'2026-10-09',spent:.1,history:[],builderCharges:{[operationId]:.1},builderSettlements:[{operationId,projectId:id,buildId:'cccccccc-cccc-cccc-cccc-cccccccccccc',day:'2026-10-09',estimateNanoUsd:'100000000',actualNanoUsd:'600000000',at:now()-86400000}]});
   fs.writeFileSync(path.join(directory,'runtime.json'),original);
 }});
 assert.equal((await h.owner('/api/status')).data.computeRecoveryRequired,true);assert.equal((await h.owner(h.endpoint+'/generate',{})).status,503);assert.equal(h.calls,0);
 assert.equal(fs.readFileSync(path.join(h.directory,'runtime.json'),'utf8'),original);
});

test('legacy actual-versus-unknown daily mismatches fail closed instead of overstating project allowance',async t=>{
 for(const currentDay of ['2026-10-09','2026-10-10']){
   const now=()=>Date.parse(currentDay+'T20:00:00Z'),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',operationId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';let original;
   const h=await harness(t,{now,setup:directory=>{
     const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:directory,now:()=>Date.parse('2026-10-09T20:00:00Z')});ledger.reserve({projectId:id,buildId:id,operationId,purpose:'planning',provider:'openrouter',estimateUsd:.1});
     original=JSON.stringify({day:'2026-10-09',spent:.6,history:[],builderCharges:{[operationId]:.6}});fs.writeFileSync(path.join(directory,'runtime.json'),original);
   }});
   assert.equal((await h.owner('/api/status')).data.computeRecoveryRequired,true);assert.equal((await h.owner(h.endpoint+'/generate',{})).status,503);assert.equal(h.calls,0);
   assert.equal(fs.readFileSync(path.join(h.directory,'runtime.json'),'utf8'),original);
 }
});

test('recovering one journal entry cannot erase previous-day evidence for another unresolved charge',async t=>{
 const now=()=>Date.parse('2026-10-10T20:00:00Z'),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',first='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',second='cccccccc-cccc-cccc-cccc-cccccccccccc';let original;
 const h=await harness(t,{now,setup:directory=>{
   const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:directory,now:()=>now()-86400000});
   for(const operationId of [first,second])ledger.reserve({projectId:id,buildId:id,operationId,purpose:'planning',provider:'openrouter',estimateUsd:.1});
   original=JSON.stringify({day:'2026-10-09',spent:.5,history:[],builderCharges:{[first]:.1,[second]:.4},builderSettlements:[{operationId:first,projectId:id,buildId:id,day:'2026-10-09',estimateNanoUsd:'100000000',actualNanoUsd:'200000000',at:now()-86400000}]});
   fs.writeFileSync(path.join(directory,'runtime.json'),original);
 }});
 assert.equal((await h.owner('/api/status')).data.computeRecoveryRequired,true);assert.equal((await h.owner(h.endpoint+'/generate',{})).status,503);assert.equal(h.calls,0);
 assert.equal(fs.readFileSync(path.join(h.directory,'runtime.json'),'utf8'),original);
});
test('missing legacy daily operation mappings stop paid work without double counting',async t=>{
 const now=()=>Date.parse('2026-10-09T20:00:00Z'),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',operationId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const h=await harness(t,{now,setup:directory=>{
   const ledger=require('./parallax/compute-ledger.cjs').createComputeLedger({stateDirectory:directory,now});
   ledger.reserve({projectId:id,buildId:id,operationId,purpose:'planning',provider:'openrouter',estimateUsd:.1});ledger.settle({operationId,actualUsd:.1});
   fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({day:'2026-10-09',spent:.3,history:[],unknownCharges:0}));
 }});
 const status=(await h.owner('/api/status')).data;assert.equal(status.spent,.3);assert.equal(status.computeRecoveryRequired,true);
 assert.equal((await h.owner(h.endpoint+'/generate',{})).status,503);assert.equal(h.calls,0);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json'))).spent,.3);
});
test('internally inconsistent daily charge totals cannot reopen paid requests',async t=>{
 const now=()=>Date.parse('2026-10-09T20:00:00Z'),operationId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const h=await harness(t,{now,setup:directory=>fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({day:'2026-10-09',spent:0,history:[],builderCharges:{[operationId]:.6}}))});
 assert.equal((await h.owner(h.endpoint+'/generate',{})).status,503);assert.equal(h.calls,0);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory,'runtime.json'))).spent,0);
});
function combined({runFails=false,ledgerFails=false}={}){
 const events=[];const input={build:{id:'build',lineage:{projectId:'project'}},operationId:'action',reserve:()=>{events.push('runReserve');if(runFails)throw Error('run cap');return ()=>events.push('runRelease');},settle:(_,actual)=>events.push(['runSettle',actual])};
 const api=createBuildCompute({input,provider:'openrouter',ledger:{reserve:value=>events.push(['projectReserve',value]),settle:value=>{events.push(['projectSettle',value.actualUsd]);if(ledgerFails)throw Error('disk fault');}},reserveDaily:()=>{events.push('dailyReserve');return ()=>events.push('dailyRelease');},settleDaily:(_,actual)=>events.push(['dailySettle',actual])});
 return {api,events};
}
test('settlement exceptions cannot double charge another ledger or leak the compute lock',()=>{
 const {api,events}=combined({ledgerFails:true}),release=api.reserve(.1);assert.throws(()=>api.settle(.1,.02),/disk fault/);api.settle(.1,null);release();release();
 assert.deepEqual(events.filter(e=>Array.isArray(e)&&e[0]==='dailySettle'),[['dailySettle',.02]]);
 assert.deepEqual(events.filter(e=>Array.isArray(e)&&e[0]==='runSettle'),[['runSettle',.02]]);
 assert.equal(events.filter(e=>e==='dailyRelease').length,1);
});
test('failed run reserve refunds project and global holds before provider request',()=>{
 const {api,events}=combined({runFails:true});assert.throws(()=>api.reserve(.1),/run cap/);
 assert.deepEqual(events.filter(e=>Array.isArray(e)&&/Settle$/.test(e[0])),[['projectSettle',0],['dailySettle',0]]);assert.ok(events.includes('dailyRelease'));
});
test('missing settlement becomes unknown once on release and uses durable action identity',()=>{
 const {api,events}=combined(),release=api.reserve(.1);release();release();const record=events.find(e=>Array.isArray(e)&&e[0]==='projectReserve')[1];
 assert.equal(record.projectId,'project');assert.equal(record.operationId,'action');assert.deepEqual(events.filter(e=>Array.isArray(e)&&e[0]==='projectSettle'),[['projectSettle',null]]);
 assert.throws(()=>api.reserve(.1),/already been reserved/);
});

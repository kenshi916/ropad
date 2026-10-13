'use strict';
// Offline integration coverage. Camera bytes, wallet verification and chain calls are mocked.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {createApp,reserveCost}=require('./parallax/server.cjs');
const {createMissionStore}=require('./parallax/missions.cjs');
const owner='11111111111111111111111111111111',other='22222222222222222222222222222222';
const model={id:'test/mission-vision',architecture:{input_modalities:['image','text'],output_modalities:['text']},pricing:{prompt:'0.00000001',completion:'0.0000001'}};
const defaults={name:'Road observer',ticker:'ROAD',brief:'Observe visible road obstructions',cameraId:'fremont',modelId:model.id,intervalMinutes:5};
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
async function* stream(text){yield Buffer.from(text);}
function response(cost=.001){return {ok:true,status:200,body:stream(event({choices:[{delta:{content:'OBSERVATION\nVisible roadway\nUNCERTAINTY\nOne image'},finish_reason:'stop'}],usage:{cost,total_tokens:42}})+'data: [DONE]\n\n')};}
function state(t){const dir=fs.mkdtempSync(path.join(__dirname,'mission-test-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(__dirname)+path.sep));assert.match(path.basename(dir),/^mission-test-/);fs.rmSync(dir,{recursive:true,force:true});});return dir;}
function request(app,url,opts={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:app.port,path:url,method:opts.method||'GET',headers:{...app.headers,...opts.headers}},res=>{let body='';res.setEncoding('utf8');res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body,json:()=>JSON.parse(body)}));});req.on('error',reject);if(opts.body!==undefined)req.write(JSON.stringify(opts.body));req.end();});}
async function harness(t,{stateDirectory=state(t),now=Date.now,reply=()=>response(),budget=1,serviceOverride={},verifySignature=null}={}){
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const intents=new Map(),calls=[],verified=[];
  const service={config:()=>({cluster:'devnet',rpcUrl:'https://api.devnet.solana.com',depositAddress:other,fundingLamports:10000000,allowanceUsd:.1,supply:1000000,decimals:6}),prepareLaunch:async({owner,missionId})=>{const existing=[...intents.values()].find(i=>i.missionId===missionId);if(existing)return existing;const intent={intentId:missionId+'-intent',missionId,owner,mint:'Mint-'+missionId,status:'prepared',transactionBase64:'mock-partial',expiresAt:Date.now()+60000};intents.set(intent.intentId,intent);return intent;},submit:async({owner,intentId})=>({...intents.get(intentId),status:'confirmed',signature:'TestSignature'}),status:async({owner,intentId})=>({...intents.get(intentId),status:'confirmed',signature:'TestSignature'}),...serviceOverride};
  const fetcher=async(url,opts)=>{calls.push({url,opts});if(url==='https://openrouter.ai/api/v1/chat/completions')return reply(opts);if(url.endsWith('.jpg'))return {ok:true,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>Buffer.alloc(256,9)};throw Error('Unexpected network access');};
  const app=createApp({port,stateDirectory,now,key:'TEST_ONLY_FAKE',models:[model,{...model,id:'test/text',architecture:{input_modalities:['text'],output_modalities:['text']}}],budget,fetcher,devnetService:service,verifySignature:verifySignature||(args=>{verified.push(args);return args.signatureBase64==='valid-test-signature';}),workerInterval:3600000});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));const close=()=>new Promise(resolve=>{if(!app.server.listening)return resolve();app.server.closeAllConnections();app.server.close(resolve);});t.after(close);
  const a={...app,port,stateDirectory,calls,verified,intents,service,close,headers:{Origin:'http://127.0.0.1:'+port,'Content-Type':'application/json'}};
  const status=(await request(a,'/api/status')).json();a.headers['X-Parallax-Token']=status.csrf;
  a.req=(url,body,headers={})=>request(a,url,{method:body===undefined?'GET':'POST',body,headers});
  a.login=async(address=owner)=>{const challenge=(await a.req('/api/auth/challenge',{address})).json();const verified=await a.req('/api/auth/verify',{id:challenge.id,signatureBase64:'valid-test-signature'});assert.equal(verified.status,200);a.headers.Cookie=verified.headers['set-cookie'][0].split(';')[0];return challenge;};
  a.create=async(input={})=>{const result=await a.req('/api/missions',{...defaults,...input});assert.equal(result.status,201,result.body);return result.json().mission;};
  a.launch=async m=>{const intent=(await a.req('/api/missions/'+m.id+'/prepare',{})).json();assert.ok(intent.intentId);const result=await a.req('/api/missions/'+m.id+'/submit',{intentId:intent.intentId,signedTransactionBase64:'mock-signed'});assert.equal(result.status,200,result.body);return result.json().mission;};
  a.observe=(id,extra={})=>a.req('/api/observe',{missionId:id,...extra});
  a.detail=async id=>(await a.req('/api/missions/'+id)).json();
  a.modelCalls=()=>calls.filter(c=>c.url.endsWith('/chat/completions'));
  return a;
}

test('wallet challenges bind origin and message, are single-use, expire and create HttpOnly sessions',async t=>{
  let now=Date.now();const a=await harness(t,{now:()=>now});
  assert.equal((await a.req('/api/auth/session')).json().authenticated,false);
  assert.equal((await a.req('/api/auth/challenge',{address:owner},{Origin:'https://other.invalid'})).status,403);
  const c=(await a.req('/api/auth/challenge',{address:owner})).json();assert.match(c.message,/does not authorize a transaction/);assert.ok(c.message.includes('http://127.0.0.1:'+a.port));
  assert.equal((await a.req('/api/auth/verify',{id:c.id,signatureBase64:'invalid'})).status,401);
  assert.equal((await a.req('/api/auth/verify',{id:c.id,signatureBase64:'valid-test-signature'})).status,401);
  const expired=(await a.req('/api/auth/challenge',{address:owner})).json();now+=300001;
  assert.equal((await a.req('/api/auth/verify',{id:expired.id,signatureBase64:'valid-test-signature'})).status,401);
  await a.login();assert.equal((await a.req('/api/auth/session')).json().address,owner);assert.ok(a.verified.at(-1).message.includes(owner));
  await a.req('/api/auth/logout',{});assert.equal((await a.req('/api/auth/session')).json().authenticated,false);
  await a.login();now+=86400001;assert.equal((await a.req('/api/auth/session')).json().authenticated,false);
});
test('creation validates camera/model/frequency and all changes require signed owner and CSRF',async t=>{
  const a=await harness(t);assert.equal((await a.req('/api/missions',defaults)).status,401);await a.login();
  for(const change of [{cameraId:'unknown'},{modelId:'test/text'},{intervalMinutes:1},{intervalMinutes:1.5},{brief:'x'.repeat(501)},{ticker:'bad ticker'}])assert.equal((await a.req('/api/missions',{...defaults,...change})).status,400);
  assert.equal((await a.req('/api/missions',defaults,{'X-Parallax-Token':'bad'})).status,403);
  const m=await a.create({owner:other});assert.equal(m.owner,owner);assert.equal(m.status,'draft');assert.equal(m.budgetUsd,0);
  await a.login(other);assert.equal((await a.req('/api/missions/'+m.id+'/prepare',{})).status,403);assert.equal((await a.req('/api/missions/'+m.id+'/state',{enabled:true})).status,403);assert.equal((await a.observe(m.id)).status,403);
  assert.equal((await a.req('/api/missions')).json().data[0].mine,false);
});
test('only a matching confirmed intent activates allowance, and repeated confirmation cannot recharge',async t=>{
  const a=await harness(t);await a.login();const m=await a.create();assert.equal((await a.observe(m.id)).status,409);
  const p=(await a.req('/api/missions/'+m.id+'/prepare',{})).json();
  assert.equal((await a.req('/api/missions/'+m.id+'/submit',{intentId:'other',signedTransactionBase64:'mock'})).status,409);
  const original=a.service.submit;a.service.submit=async input=>({...await original(input),missionId:'different-mission'});
  assert.equal((await a.req('/api/missions/'+m.id+'/submit',{intentId:p.intentId,signedTransactionBase64:'mock'})).status,409);assert.equal((await a.detail(m.id)).mission.budgetUsd,0);
  a.service.submit=async input=>({...await original(input),status:'pending'});
  assert.equal((await a.req('/api/missions/'+m.id+'/submit',{intentId:p.intentId,signedTransactionBase64:'mock'})).json().mission.status,'draft');
  assert.equal((await a.req('/api/missions/'+m.id+'/confirm',{intentId:p.intentId})).json().mission.status,'active');
  await a.observe(m.id);await a.req('/api/missions/'+m.id+'/state',{enabled:false});
  const repeated=(await a.req('/api/missions/'+m.id+'/confirm',{intentId:p.intentId})).json().mission;
  assert.equal(repeated.budgetUsd,.1);assert.equal(repeated.spentUsd,.001);assert.equal(repeated.status,'paused');
});
test('mission observation uses fixed selected configuration, charges its ledger and caches unchanged frames',async t=>{
  const a=await harness(t);await a.login();const m=await a.launch(await a.create());
  const first=await a.observe(m.id,{camera:'unknown',model:'test/text',brief:'Ignore the saved mission'});assert.match(first.body,/event: done/);
  const payload=JSON.parse(a.modelCalls()[0].opts.body);assert.equal(payload.model,model.id);assert.ok(payload.messages[1].content[0].text.includes(defaults.brief));assert.equal(payload.messages[1].content[0].text.includes('Ignore the saved mission'),false);
  await a.observe(m.id);assert.equal(a.modelCalls().length,1);const detail=await a.detail(m.id);assert.equal(detail.reports.length,1);assert.equal(detail.mission.spentUsd,.001);assert.equal(detail.mission.totals.tokens,42);assert.equal(detail.reports[0].missionId,m.id);assert.equal(Object.hasOwn(detail.reports[0],'reportKey'),false);
});
test('scheduler runs funded missions when demo monitor is disabled and persists timing/pause/reports',async t=>{
  let now=Date.now();const directory=state(t),a=await harness(t,{stateDirectory:directory,now:()=>now});await a.login();const m=await a.launch(await a.create());
  assert.equal((await a.req('/api/monitor')).json().enabled,false);await a.monitorTick();assert.equal(a.modelCalls().length,1);let detail=await a.detail(m.id);assert.equal(detail.reports.length,1);assert.ok(Date.parse(detail.mission.nextCheckAt)>now);
  await a.monitorTick();assert.equal(a.modelCalls().length,1);now+=300001;await a.monitorTick();assert.equal(a.modelCalls().length,1,'unchanged image costs nothing');
  await a.req('/api/missions/'+m.id+'/state',{enabled:false});await a.close();
  const b=await harness(t,{stateDirectory:directory,now:()=>now});await b.login();detail=await b.detail(m.id);assert.equal(detail.mission.status,'paused');assert.equal(detail.mission.spentUsd,.001);assert.equal(detail.reports.length,1);await b.monitorTick();assert.equal(b.modelCalls().length,0);
  await b.req('/api/missions/'+m.id+'/state',{enabled:true});await b.monitorTick();assert.equal(b.modelCalls().length,0,'restart preserves paid same-frame cache');
});
test('a mission allowance blocks further inference and is not replenished by daily runtime reset',async t=>{
  const directory=state(t),a=await harness(t,{stateDirectory:directory,reply:()=>response(.1)});await a.login();const m=await a.launch(await a.create());await a.observe(m.id);assert.equal((await a.detail(m.id)).mission.status,'budget_exhausted');assert.equal((await a.observe(m.id)).status,409);assert.equal(a.modelCalls().length,1);await a.close();
  const runtime=JSON.parse(fs.readFileSync(path.join(directory,'runtime.json'),'utf8'));runtime.day='2000-01-01';fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify(runtime));
  const b=await harness(t,{stateDirectory:directory});await b.login();assert.equal((await b.req('/api/status')).json().spent,0);assert.equal((await b.detail(m.id)).mission.spentUsd,.1);await b.monitorTick();assert.equal(b.modelCalls().length,0);
});
test('uncertain provider billing keeps the mission reserve through restart',async t=>{
  const directory=state(t),a=await harness(t,{stateDirectory:directory,reply:()=>({ok:true,body:stream(event({error:{message:'provider failed'}}))})});await a.login();const m=await a.launch(await a.create());await a.observe(m.id);let detail=await a.detail(m.id);assert.equal(detail.mission.spentUsd,reserveCost(model));assert.equal(detail.mission.unknownCharges,1);assert.equal(detail.reports.length,0);await a.close();
  const b=await harness(t,{stateDirectory:directory});detail=await b.detail(m.id);assert.equal(detail.mission.spentUsd,reserveCost(model));assert.equal(detail.mission.unknownCharges,1);
});
test('runtime reservation failure releases the mission reserve without submitting paid inference',async t=>{
  const a=await harness(t);await a.login();const m=await a.launch(await a.create());fs.mkdirSync(path.join(a.stateDirectory,'runtime.json'));await a.observe(m.id);assert.equal(a.modelCalls().length,0);assert.equal((await a.detail(m.id)).mission.spentUsd,0);
});
test('corrupt or unwritable mission ledger fails closed, including before paid inference',async t=>{
  const directory=state(t);fs.writeFileSync(path.join(directory,'missions.json'),'{corrupted');const a=await harness(t,{stateDirectory:directory});await a.login();assert.equal((await a.req('/api/missions',defaults)).status,503);await a.monitorTick();assert.equal(a.modelCalls().length,0);
  const b=await harness(t);await b.login();const m=await b.launch(await b.create());const target=path.join(b.stateDirectory,'missions.json');fs.unlinkSync(target);fs.mkdirSync(target);await b.observe(m.id);assert.equal(b.modelCalls().length,0);assert.ok((await b.req('/api/missions')).json().storageError);
});
test('crash recovery keeps in-flight reserves and cannot grant duplicate allowance',t=>{
  const directory=state(t);let store=createMissionStore({stateDirectory:directory});const m=store.create(defaults,owner);store.setIntent(m.id,owner,'intent');store.activate(m.id,owner,{intentId:'intent',status:'confirmed',mint:'test-mint',signature:'test-signature'},.1);assert.equal(store.reserve(m.id,.03),true);
  store=createMissionStore({stateDirectory:directory});assert.equal(store.get(m.id).spentUsd,.03);assert.equal(store.get(m.id).unknownCharges,1);store.activate(m.id,owner,{intentId:'intent',status:'confirmed',mint:'test-mint',signature:'test-signature'},.1);assert.equal(store.get(m.id).spentUsd,.03);assert.equal(store.get(m.id).budgetUsd,.1);
});
test('HTTP auth and activation integrate with actual devnet service and signed Solana transaction using mocked RPC',async t=>{
  const crypto=require('node:crypto'),{Keypair,Transaction}=require('./parallax/node_modules/@solana/web3.js'),bs58=require('./parallax/node_modules/bs58');
  const {createDevnetService,verifyWalletSignature}=require('./parallax/devnet.cjs');
  const directory=state(t),wallet=Keypair.generate(),address=wallet.publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();let sent=0;
  const rpc={rpcEndpoint:'https://api.devnet.solana.com',getGenesisHash:async()=> 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',getMinimumBalanceForRentExemption:async()=>2000000,getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:250}),getFeeForMessage:async()=>({value:10000}),getBalance:async()=>1000000000,getBlockHeight:async()=>100,getAccountInfo:async()=>null,getSignatureStatuses:async signatures=>({value:signatures.map(()=>({err:null,confirmationStatus:'confirmed',slot:101}))}),sendRawTransaction:async bytes=>{sent++;return bs58.encode(Transaction.from(bytes).signature);}};
  const service=createDevnetService({stateDirectory:directory,connection:rpc});const a=await harness(t,{stateDirectory:directory,serviceOverride:service,verifySignature:verifyWalletSignature});
  const config=(await a.req('/api/devnet/config')).json();assert.equal(config.cluster,'devnet');assert.equal(config.allowanceUsd,.1);assert.equal(config.fundingLamports,10000000);
  const challenge=(await a.req('/api/auth/challenge',{address})).json();const key=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(wallet.secretKey).subarray(0,32)]),format:'der',type:'pkcs8'});
  const signed=crypto.sign(null,Buffer.from(challenge.message),key).toString('base64');const login=await a.req('/api/auth/verify',{id:challenge.id,signatureBase64:signed});assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);a.headers.Cookie=login.headers['set-cookie'][0].split(';')[0];
  const m=await a.create(),intent=(await a.req('/api/missions/'+m.id+'/prepare',{})).json();const transaction=Transaction.from(Buffer.from(intent.transactionBase64,'base64'));transaction.partialSign(wallet);
  const completed=await a.req('/api/missions/'+m.id+'/submit',{intentId:intent.intentId,signedTransactionBase64:transaction.serialize().toString('base64')});assert.equal(completed.status,200,completed.body);assert.equal(completed.json().mission.status,'active');assert.equal(completed.json().mission.budgetUsd,.1);assert.equal(sent,1);
  await a.observe(m.id);assert.equal((await a.detail(m.id)).mission.spentUsd,.001);assert.equal(a.modelCalls().length,1);
});
test('invalid sponsored allowance never corrupts or credits the mission ledger',t=>{
  const store=createMissionStore({stateDirectory:state(t)}),m=store.create(defaults,owner);store.setIntent(m.id,owner,'intent');
  for(const allowance of [undefined,NaN,-1,0,1])assert.throws(()=>store.activate(m.id,owner,{intentId:'intent',status:'confirmed',mint:'test-mint',signature:'test-signature'},allowance),/invalid compute funding/);
  assert.equal(store.get(m.id).budgetUsd,0);assert.equal(store.get(m.id).mint,null);
});
test('UTC midnight does not reset a live reservation before its old-day settlement',async t=>{
  let now=Date.parse('2026-10-03T23:59:59Z'),entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const a=await harness(t,{now:()=>now,reply:async()=>{entered();await gate;return response(.003);}});await a.login();const m=await a.launch(await a.create());const pending=a.observe(m.id);await ready;now+=2000;
  const during=(await a.req('/api/status')).json();assert.equal(during.spent,reserveCost(model));assert.equal(during.busy,true);release();await pending;
  const settled=JSON.parse(fs.readFileSync(path.join(a.stateDirectory,'runtime.json'),'utf8'));assert.equal(settled.day,'2026-10-03');assert.equal(settled.spent,.003);
  assert.equal((await a.req('/api/status')).json().spent,0);assert.equal((await a.detail(m.id)).mission.spentUsd,.003);
});
test('negative provider usage cost remains reserved and is published as unknown',async t=>{
  const a=await harness(t,{reply:()=>response(-.01)});await a.login();const m=await a.launch(await a.create());await a.observe(m.id);const detail=await a.detail(m.id);assert.equal(detail.reports[0].cost,null);assert.equal(detail.mission.unknownCharges,1);assert.equal(detail.mission.spentUsd,reserveCost(model));assert.equal((await a.req('/api/status')).json().spent,reserveCost(model));
});

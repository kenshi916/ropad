'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {privateKeyToAccount}=require('./parallax/node_modules/viem/accounts');
const {createEvmAuth}=require('./parallax/evm-auth.cjs');
const {createInferenceProvider}=require('./parallax/inference-provider.cjs');
const {createApp}=require('./parallax/server.cjs');
// Fixed test-only keys have no funding and are never used against a network.
const alice=privateKeyToAccount('0x'+'11'.repeat(32)),bob=privateKeyToAccount('0x'+'22'.repeat(32));
const origin='http://127.0.0.1:61281';
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;}};}
test('EVM sign-in verifies the real signature, binds domain/chain, and consumes the nonce',async()=>{
  const auth=createEvmAuth(),c=auth.challenge(alice.address,origin),res=response();
  assert.match(c.message,/Chain ID: 4663/);assert.ok(c.message.includes('127.0.0.1:61281 wants you to sign in'));
  assert.match(c.message,/does not authorize a transaction/);
  const signature=await alice.signMessage({message:c.message});
  assert.equal((await auth.authenticate({id:c.id,signature},origin,res)).address,alice.address.toLowerCase());
  assert.match(res.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);
  const req={headers:{cookie:res.headers['Set-Cookie'].split(';')[0]}};
  assert.equal(auth.owner(req),alice.address.toLowerCase());
  await assert.rejects(auth.authenticate({id:c.id,signature},origin,response()),{status:401});
  auth.logout(req,response());assert.equal(auth.session(req),null);
});
test('EVM sign-in rejects another signer, changed message, origin, expiration and Solana address',async()=>{
  let clock=Date.now();const auth=createEvmAuth({now:()=>clock});
  assert.throws(()=>auth.challenge('11111111111111111111111111111111',origin),{status:400});
  for(const kind of ['signer','message','origin','expiry']){
    const c=auth.challenge(alice.address,origin);
    const signature=await (kind==='signer'?bob:alice).signMessage({message:c.message+(kind==='message'?' changed':'')});
    if(kind==='expiry')clock+=300001;
    await assert.rejects(auth.authenticate({id:c.id,signature},kind==='origin'?'http://localhost:61281':origin,response()),{status:401});
  }
});
test('gateway selection cannot send an OpenRouter key to Orbio or arbitrary hosts',()=>{
  assert.equal(createInferenceProvider({provider:'orbio',key:'FAKE_OPENROUTER_ONLY'}).key,'');
  const orbio=createInferenceProvider({provider:'orbio',orbioKey:'FAKE_ORBIO_ONLY',key:'OTHER_FAKE'});
  assert.equal(orbio.key,'FAKE_ORBIO_ONLY');assert.equal(orbio.completionsUrl,'https://api.orbio.so/api/v1/chat/completions');
  assert.throws(()=>createInferenceProvider({provider:'https://bad.invalid'}));
});
const model={id:'test/vision',name:'Vision',architecture:{input_modalities:['image'],output_modalities:['text']},pricing:{prompt:'0.00000001',completion:'0.0000001'}};
const mission={name:'Road Watch',ticker:'ROAD',brief:'Observe visible road obstructions',cameraId:'fremont',modelId:model.id,intervalMinutes:5};
async function harness(t,{provider='openrouter',orbioKey='',key='',fetcher=async()=>{throw Error('Unexpected network')}}={}){
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const calls=[];const launch={list:owner=>[{owner}],prepare:async input=>{calls.push(input);return {intentId:'test-intent',status:'prepared'};},confirm:async input=>{calls.push(input);return {status:'pending'};}};
  const app=createApp({port,provider,key,orbioKey,models:[model],fetcher,orbioService:{status:async()=>({chainId:4663}),models:async()=>({data:[model]}),agents:async()=>({data:[]})},orbioLaunchService:launch});
  await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.closeAllConnections();app.server.close(r);}));
  const base='http://127.0.0.1:'+port;let cookie='';const status=await (await fetch(base+'/api/status')).json();
  const req=async(path,body,headers={})=>{const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json','X-Parallax-Token':status.csrf,Cookie:cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,headers:res.headers,text:await res.text()};};
  return {req,calls,status,base,login:async()=>{const c=JSON.parse((await req('/api/orbio/auth/challenge',{address:alice.address})).text);const signature=await alice.signMessage({message:c.message});const r=await req('/api/orbio/auth/verify',{id:c.id,signature});assert.equal(r.status,200,r.text);cookie=r.headers.get('set-cookie').split(';')[0];}};
}
test('HTTP launch routes require EVM ownership and CSRF, enforce camera/model cadence, ignore forged owner',async t=>{
  const a=await harness(t);assert.equal((await a.req('/api/orbio/launches/prepare',{mission})).status,401);await a.login();
  assert.equal((await a.req('/api/orbio/launches/prepare',{mission},{Origin:'https://other.invalid'})).status,403);
  assert.equal((await a.req('/api/orbio/launches/confirm',{intentId:'fake',hash:'fake'},{'X-Parallax-Token':'bad'})).status,403);
  for(const patch of [{cameraId:'unknown'},{intervalMinutes:1},{modelId:'unlisted'},{ticker:'bad ticker'},{brief:''}])assert.equal((await a.req('/api/orbio/launches/prepare',{mission:{...mission,...patch}})).status,400);
  assert.equal((await a.req('/api/orbio/launches/prepare',{mission,agentWallet:bob.address})).status,400);
  const r=await a.req('/api/orbio/launches/prepare',{mission:{...mission,owner:bob.address},owner:bob.address,agentWallet:alice.address});
  assert.equal(r.status,200,r.text);assert.equal(a.calls[0].owner,alice.address.toLowerCase());assert.equal(a.calls[0].agentWallet,alice.address.toLowerCase());assert.equal(a.calls[0].mission.owner,undefined);
});
test('Orbio inference uses only the chosen gateway and key, reports provider, and keeps hidden reasoning out',async t=>{
  const urls=[];async function* body(){yield Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'OBSERVATION\nVisible roadway',reasoning:'PRIVATE_TEST_REASONING'},finish_reason:'stop'}],usage:{cost:0.0003,total_tokens:30}})+'\n\ndata: [DONE]\n\n');}
  const a=await harness(t,{provider:'orbio',orbioKey:'FAKE_ORBIO_KEY',key:'FAKE_OTHER_KEY',fetcher:async(url,opts)=>{
    urls.push(url);if(url.endsWith('/chat/completions')){assert.equal(url,'https://api.orbio.so/api/v1/chat/completions');assert.equal(opts.headers.Authorization,'Bearer FAKE_ORBIO_KEY');return {ok:true,body:body()};}
    if(url.endsWith('.jpg'))return {ok:true,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>Buffer.alloc(128,9)};
    throw Error('Unexpected URL');
  }});
  assert.equal(a.status.provider,'orbio');assert.equal(JSON.stringify(a.status).includes('FAKE_'),false);
  const r=await a.req('/api/observe',{model:model.id,camera:'fremont',brief:mission.brief});assert.equal(r.status,200,r.text);assert.match(r.text,/"provider":"orbio"/);assert.doesNotMatch(r.text,/PRIVATE_TEST_REASONING|FAKE_ORBIO_KEY/);assert.equal(urls.filter(v=>v.endsWith('/chat/completions')).length,1);
});
test('Orbio without its own key fails before inference even when OpenRouter has a key',async t=>{
  const a=await harness(t,{provider:'orbio',key:'FAKE_OTHER_KEY'});assert.equal(a.status.configured,false);assert.equal((await a.req('/api/observe',{model:model.id,camera:'fremont',brief:mission.brief})).status,503);
});


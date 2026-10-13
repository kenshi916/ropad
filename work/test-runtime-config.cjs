'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Keypair}=require('./parallax/node_modules/@solana/web3.js');
const {readRuntimeConfig,publicOrigin}=require('./parallax/runtime-config.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-runtime-config-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
test('runtime defaults remain local Devnet and cannot silently enable real SOL',()=>{const r=readRuntimeConfig({env:{}});assert.equal(r.mainnetEnabled,false);assert.equal(r.defaultCluster,'devnet');assert.equal(r.bindHost,'127.0.0.1');assert.equal(r.publicOrigin,null);assert.deepEqual(r.operatorWallets,[]);for(const flag of ['true','yes','false','enabled'])assert.throws(()=>readRuntimeConfig({env:{ROPAD_SOLANA_MAINNET_ENABLED:flag}}),/0 or 1/);});
test('public binding requires a plain HTTPS public origin and rejects local/address/credential targets',()=>{
  assert.equal(publicOrigin('https://ropad.com/'),'https://ropad.com');
  for(const input of ['http://ropad.com','https://localhost','https://127.0.0.1','https://[::1]','https://app.local','https://app.internal','https://app.test','https://ropad.com/path','https://name:SECRET@ropad.com','https://ropad.com?key=SECRET']){assert.throws(()=>publicOrigin(input),error=>error.status===503&&!error.message.includes('SECRET'));}
  assert.throws(()=>readRuntimeConfig({env:{ROPAD_BIND_HOST:'0.0.0.0'}}),/TLS reverse proxy/);
  const r=readRuntimeConfig({env:{ROPAD_BIND_HOST:'0.0.0.0',ROPAD_PUBLIC_ORIGIN:'https://ropad.com',ROPAD_SOLANA_MAINNET_ENABLED:'1'}});assert.equal(r.bindHost,'0.0.0.0');assert.equal(r.defaultCluster,'mainnet-beta');
});
test('stored config is preserved, explicit environment values take precedence, and invalid operator addresses fail closed',t=>{
  const directory=fixture(t),wallet=Keypair.generate().publicKey.toBase58(),file=path.join(directory,'ropad-config.json'),bytes=JSON.stringify({publicOrigin:'https://ropad.com',mainnetEnabled:true,operatorWallets:[wallet],providerAccountId:'test-provider'});fs.writeFileSync(file,bytes);
  const r=readRuntimeConfig({stateDirectory:directory,env:{ROPAD_SOLANA_MAINNET_ENABLED:'0',ROPAD_SOLANA_RPC_URL:'https://rpc.ropad.com/?api-key=FAKE_TEST_SECRET'}});assert.equal(r.mainnetEnabled,false);assert.equal(r.solanaRpcUrl,'https://rpc.ropad.com/?api-key=FAKE_TEST_SECRET');assert.deepEqual(r.operatorWallets,[wallet]);assert.equal(fs.readFileSync(file,'utf8'),bytes);
  assert.throws(()=>readRuntimeConfig({env:{ROPAD_OPERATOR_WALLETS:'not-a-wallet'}}),/valid Solana signing addresses/);
  assert.throws(()=>readRuntimeConfig({env:{ROPAD_SOLANA_RPC_URL:'https://a:FAKE_TEST_SECRET@rpc.ropad.com'}}),error=>!error.message.includes('FAKE_TEST_SECRET'));
  fs.writeFileSync(file,'{damaged');assert.throws(()=>readRuntimeConfig({stateDirectory:directory,env:{}}),/saved data has not been changed/);assert.equal(fs.readFileSync(file,'utf8'),'{damaged');
});
test('public HTTP routes bind wallet auth to HTTPS, hide credentials, disable legacy paid paths, and require verified creators',async t=>{
  const http=require('node:http'),{createApp}=require('./parallax/server.cjs'),directory=fixture(t),wallet=Keypair.generate().publicKey.toBase58(),model={id:'anthropic/claude-opus-5.5',name:'Opus',architecture:{output_modalities:['text']},pricing:{prompt:'0.000001',completion:'0.000002'}};let networkCalls=0;
  const runtimeConfig=readRuntimeConfig({env:{ROPAD_PUBLIC_ORIGIN:'https://ropad.com',ROPAD_SOLANA_RPC_URL:'https://rpc.ropad.com/?key=FAKE_RPC_SECRET'}});
  const app=createApp({port:0,stateDirectory:directory,key:'FAKE_PROVIDER_SECRET',runtimeConfig,models:[model],cameraWorkers:false,autonomousWorkers:false,verifySignature:async({signatureBase64})=>signatureBase64==='fixture-valid',fetcher:async()=>{networkCalls++;throw Error('Unexpected external call');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});const port=app.server.address().port;
  let cookie='',csrf='';
  async function request(endpoint,body,extra={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:endpoint,method:body===undefined?'GET':'POST',headers:{Host:'ropad.com',Origin:'https://ropad.com',Cookie:cookie,'X-Parallax-Token':csrf,'Content-Type':'application/json',Connection:'close',...extra}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,data,text});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
  const state=await request('/api/status');assert.equal(state.status,200);assert.doesNotMatch(state.text,/FAKE_PROVIDER_SECRET|FAKE_RPC_SECRET/);csrf=state.data.csrf;
  assert.equal((await request('/api/health',undefined,{Host:'attacker.com'})).status,403);
  assert.equal((await request('/api/auth/challenge',{address:wallet},{Origin:'http://ropad.com'})).status,403);
  for(const endpoint of ['/api/monitor','/api/observe','/api/missions','/api/devnet/config','/api/orbio/auth/challenge'])assert.equal((await request(endpoint,{enabled:false})).status,403,endpoint);
  const prompt={gameName:'Public Skyline',brief:'A polished rooftop race with clear checkpoints and a finish',modelId:model.id};assert.equal((await request('/api/builds',prompt)).status,401);
  // A spoofed loopback Host must not restore anonymous production privileges.
  assert.equal((await request('/api/builds',prompt,{Host:'localhost:0',Origin:'http://localhost:0'})).status,401);
  assert.equal((await request('/api/solana/metadata',{name:'Skyline',symbol:'SKY',imageUrl:'https://images.ropad.com/game.png'})).status,401);
  const challenge=await request('/api/auth/challenge',{address:wallet});assert.equal(challenge.status,200);assert.match(challenge.data.message,/https:\/\/ropad\.com/);
  const auth=await request('/api/auth/verify',{id:challenge.data.id,signatureBase64:'fixture-valid'});assert.equal(auth.status,200);assert.match(auth.headers['set-cookie'][0],/; Secure/);cookie=auth.headers['set-cookie'][0].split(';')[0];
  const created=await request('/api/builds',prompt);assert.equal(created.status,201,created.text);assert.equal(created.data.build.canManage,true);
  const info=await request('/api/solana/launches/config');assert.equal(info.status,200,info.text);assert.equal(info.data.mainnetAvailable,false);assert.doesNotMatch(info.text,/FAKE_RPC_SECRET|FAKE_PROVIDER_SECRET/);
  const metadata=await request('/api/solana/metadata',{name:'Skyline',symbol:'SKY',imageUrl:'https://images.ropad.com/game.png'});assert.equal(metadata.status,201,metadata.text);cookie='';
  const publicAsset=await request(new URL(metadata.data.metadataUri).pathname,undefined,{'Sec-Fetch-Site':'cross-site',Origin:'https://unrelated.com'});assert.equal(publicAsset.status,200);assert.equal(publicAsset.headers['access-control-allow-origin'],'*');assert.match(publicAsset.headers['cache-control'],/immutable/);assert.equal(publicAsset.data.name,'Skyline');
  assert.equal((await request('/api/auth/session',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);assert.equal(networkCalls,0);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Keypair,PublicKey,SystemProgram}=require('./parallax/node_modules/@solana/web3.js');
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

test('daily compute cap has a bounded one-dollar default and accepts explicit zero and decimal limits',t=>{
  assert.equal(readRuntimeConfig({env:{}}).dailyComputeBudgetUsd,1);
  for(const value of ['0','0.01','2.75','1000'])assert.equal(readRuntimeConfig({env:{ROPAD_DAILY_COMPUTE_BUDGET_USD:value}}).dailyComputeBudgetUsd,Number(value));
  const directory=fixture(t),file=path.join(directory,'ropad-config.json'),bytes=JSON.stringify({dailyComputeBudgetUsd:2.75});fs.writeFileSync(file,bytes);
  assert.equal(readRuntimeConfig({stateDirectory:directory,env:{}}).dailyComputeBudgetUsd,2.75);
  assert.equal(readRuntimeConfig({stateDirectory:directory,env:{ROPAD_DAILY_COMPUTE_BUDGET_USD:'0'}}).dailyComputeBudgetUsd,0);
  assert.equal(readRuntimeConfig({stateDirectory:directory,env:{ROPAD_DAILY_COMPUTE_BUDGET_USD:'7.5'}}).dailyComputeBudgetUsd,7.5);
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
});

test('daily compute cap rejects invalid values without echoing supplied data or rewriting stored config',t=>{
  const directory=fixture(t),file=path.join(directory,'ropad-config.json');
  for(const value of [-1,1000.01,'Infinity','NaN','', ' ',true,false,{},[], 'FAKE_PRIVATE_VALUE']){
    const bytes=JSON.stringify({dailyComputeBudgetUsd:value});fs.writeFileSync(file,bytes);
    for(const options of [{stateDirectory:directory,env:{}},{env:{ROPAD_DAILY_COMPUTE_BUDGET_USD:value}}])assert.throws(()=>readRuntimeConfig(options),error=>error.status===503&&error.message==='ROPAD_DAILY_COMPUTE_BUDGET_USD is outside its supported allowance');
    assert.equal(fs.readFileSync(file,'utf8'),bytes);
  }
});

test('Pump lookup table configuration accepts canonical off-curve addresses with environment precedence',t=>{
  assert.equal(readRuntimeConfig({env:{}}).pumpLookupTableAddress,'');
  const directory=fixture(t),file=path.join(directory,'ropad-config.json'),storedAddress=Keypair.generate().publicKey.toBase58(),[lookupAddress]=PublicKey.findProgramAddressSync([Buffer.from('ropad-alt-test')],SystemProgram.programId),bytes=JSON.stringify({pumpLookupTableAddress:storedAddress});fs.writeFileSync(file,bytes);
  assert.equal(PublicKey.isOnCurve(lookupAddress.toBytes()),false);
  assert.equal(readRuntimeConfig({stateDirectory:directory,env:{}}).pumpLookupTableAddress,storedAddress);
  assert.equal(readRuntimeConfig({stateDirectory:directory,env:{ROPAD_PUMP_LOOKUP_TABLE_ADDRESS:lookupAddress.toBase58()}}).pumpLookupTableAddress,lookupAddress.toBase58());
  assert.equal(readRuntimeConfig({stateDirectory:directory,env:{ROPAD_PUMP_LOOKUP_TABLE_ADDRESS:''}}).pumpLookupTableAddress,'');
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
});

test('invalid Pump lookup table addresses fail without echoing input or changing saved files',t=>{
  const directory=fixture(t),file=path.join(directory,'ropad-config.json');
  for(const value of ['FAKE_PRIVATE_VALUE','not-an-address',{},123,' '+Keypair.generate().publicKey.toBase58()]){
    const bytes=JSON.stringify({pumpLookupTableAddress:value});fs.writeFileSync(file,bytes);
    for(const options of [{stateDirectory:directory,env:{}},{env:{ROPAD_PUMP_LOOKUP_TABLE_ADDRESS:value}}])assert.throws(()=>readRuntimeConfig(options),error=>error.status===503&&error.message==='Configure a valid Solana Pump lookup table address');
    assert.equal(fs.readFileSync(file,'utf8'),bytes);
  }
});

test('normal server entrypoint applies the configured daily cap without supplying provider credentials',async t=>{
  const net=require('node:net'),{spawn}=require('node:child_process'),directory=fixture(t),probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={...process.env,PORT:String(port),PARALLAX_STATE_DIR:directory,ROPAD_BIND_HOST:'127.0.0.1',ROPAD_PUBLIC_ORIGIN:'',ROPAD_SOLANA_MAINNET_ENABLED:'0',ROPAD_OPERATOR_WALLETS:'',ROPAD_PUMP_LOOKUP_TABLE_ADDRESS:'',ROPAD_DAILY_COMPUTE_BUDGET_USD:'0',OPENROUTER_API_KEY:'',ORBIO_API_KEY:'',OPENROUTER_MANAGEMENT_KEY:'',PARALLAX_AI_PROVIDER:'openrouter'};
  const child=spawn(process.execPath,[path.join(__dirname,'parallax/server.cjs')],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(async()=>{if(child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Isolated test server did not become ready')),10000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('Ropad listening on')){clearTimeout(timer);resolve();}});child.once('error',()=>{clearTimeout(timer);reject(Error('Isolated test server could not start'));});child.once('exit',()=>{clearTimeout(timer);reject(Error('Isolated test server stopped before readiness'));});});
  const response=await fetch('http://127.0.0.1:'+port+'/api/status'),status=await response.json();assert.equal(response.status,200);assert.equal(status.budget,0);assert.equal(status.configured,false);assert.equal(status.spent,0);assert.equal(status.budgetPeriod,'UTC day');
});
test('public HTTP routes bind wallet auth to HTTPS, hide credentials, disable legacy paid paths, and require verified creators',async t=>{
  const http=require('node:http'),{createApp}=require('./parallax/server.cjs'),directory=fixture(t),wallet=Keypair.generate().publicKey.toBase58(),model={id:'anthropic/claude-opus-5.5',name:'Opus',architecture:{output_modalities:['text']},pricing:{prompt:'0.000001',completion:'0.000002'}};let networkCalls=0;
  const runtimeConfig=readRuntimeConfig({env:{ROPAD_PUBLIC_ORIGIN:'https://ropad.com',ROPAD_SOLANA_RPC_URL:'https://rpc.ropad.com/?key=FAKE_RPC_SECRET',ROPAD_DAILY_COMPUTE_BUDGET_USD:'50'}});
  const app=createApp({port:0,stateDirectory:directory,key:'FAKE_PROVIDER_SECRET',runtimeConfig,budget:runtimeConfig.dailyComputeBudgetUsd,models:[model],cameraWorkers:false,autonomousWorkers:false,verifySignature:async({signatureBase64})=>signatureBase64==='fixture-valid',fetcher:async()=>{networkCalls++;throw Error('Unexpected external call');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});const port=app.server.address().port;
  let cookie='',csrf='';
  async function request(endpoint,body,extra={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:endpoint,method:body===undefined?'GET':'POST',headers:{Host:'ropad.com',Origin:'https://ropad.com',Cookie:cookie,'X-Parallax-Token':csrf,'Content-Type':'application/json',Connection:'close',...extra}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,data,text});});});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
  const state=await request('/api/status');assert.equal(state.status,200);assert.equal(state.data.budget,50);assert.doesNotMatch(state.text,/FAKE_PROVIDER_SECRET|FAKE_RPC_SECRET/);csrf=state.data.csrf;
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
  const compute=await request('/api/builds/'+created.data.build.id+'/compute');assert.equal(compute.status,200,compute.text);assert.equal(Number(compute.data.compute.sponsorDailyUsd),0);assert.equal(Number(compute.data.compute.totalGrantedUsd),0);
  const unfunded=await request('/api/builds/'+created.data.build.id+'/generate',{});assert.equal(unfunded.status,402,unfunded.text);assert.equal(networkCalls,0);
  const info=await request('/api/solana/launches/config');assert.equal(info.status,200,info.text);assert.equal(info.data.mainnetAvailable,false);assert.doesNotMatch(info.text,/FAKE_RPC_SECRET|FAKE_PROVIDER_SECRET/);
  const metadata=await request('/api/solana/metadata',{name:'Skyline',symbol:'SKY',imageUrl:'https://images.ropad.com/game.png'});assert.equal(metadata.status,201,metadata.text);cookie='';
  const publicAsset=await request(new URL(metadata.data.metadataUri).pathname,undefined,{'Sec-Fetch-Site':'cross-site',Origin:'https://unrelated.com'});assert.equal(publicAsset.status,200);assert.equal(publicAsset.headers['access-control-allow-origin'],'*');assert.match(publicAsset.headers['cache-control'],/immutable/);assert.equal(publicAsset.data.name,'Skyline');
  assert.equal((await request('/api/auth/session',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);assert.equal(networkCalls,0);
});

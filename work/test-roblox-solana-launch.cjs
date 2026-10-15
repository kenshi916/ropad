'use strict';
// Offline Ed25519 signing and mocked Solana RPC: no real network transactions.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {Keypair,Transaction,PublicKey}=require('./parallax/node_modules/@solana/web3.js');
const bs58=require('./parallax/node_modules/bs58');
const {createDevnetService}=require('./parallax/devnet.cjs');
const {createRobloxBuildService}=require('./parallax/roblox-builds.cjs');
const {createRobloxSolanaLaunchService}=require('./parallax/roblox-solana-launch.cjs');
const {createApp}=require('./parallax/server.cjs');
const MODEL={id:'anthropic/claude-opus-5.5',name:'Opus',architecture:{output_modalities:['text']},pricing:{prompt:'0.0000001',completion:'0.0000001'}};
const PROMPT={name:'Skyline Sprint',ticker:'SKY',brief:'An original city rooftop footrace with checkpoints and a finish',modelId:MODEL.id,inspiration:'Clear checkpoints and a visible completion goal'};
class FakeRpc {
  constructor(){this.rpcEndpoint='https://api.devnet.solana.com';this.genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';this.blockhash=Keypair.generate().publicKey.toBase58();this.statuses=new Map();this.sent=[];this.autoConfirm=true;}
  async getGenesisHash(){return this.genesis;}async getMinimumBalanceForRentExemption(){return 2_000_000;}async getLatestBlockhash(){return {blockhash:this.blockhash,lastValidBlockHeight:250};}async getFeeForMessage(){return {value:10000};}async getBalance(){return 1_000_000_000;}async getBlockHeight(){return 100;}async getAccountInfo(){return null;}
  async getSignatureStatuses(signatures){return {value:signatures.map(signature=>this.statuses.get(signature)||null)};}
  async sendRawTransaction(bytes){const tx=Transaction.from(bytes);assert.equal(tx.verifySignatures(true),true);const signature=bs58.encode(tx.signature);this.sent.push(signature);if(this.autoConfirm)this.statuses.set(signature,{slot:101,err:null,confirmationStatus:'confirmed'});return signature;}
}
function sign(intent,key){const tx=Transaction.from(Buffer.from(intent.transactionBase64,'base64'));tx.partialSign(key);return tx.serialize().toString('base64');}
function signedMessage(key,message){const privateKey=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(key.secretKey).subarray(0,32)]),format:'der',type:'pkcs8'});return crypto.sign(null,Buffer.from(message),privateKey).toString('base64');}
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-solana-launch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const rpc=new FakeRpc(),key=Keypair.generate(),owner=key.publicKey.toBase58(),other=Keypair.generate().publicKey.toBase58(),devnet=createDevnetService({stateDirectory:directory,connection:rpc}),builds=createRobloxBuildService({stateDirectory:directory});
  const config={stateDirectory:directory,devnet,getBuilds:()=>builds};return {directory,rpc,key,owner,other,devnet,builds,config,service:createRobloxSolanaLaunchService(config)};
}
test('prompt launches prepare the exact devnet SPL transaction and create one Solana-owned game only after confirmation',async t=>{
  const h=fixture(t),cfg=h.service.config();assert.equal(cfg.chain,'solana');assert.equal(cfg.cluster,'devnet');assert.equal(cfg.mainnetAvailable,false);assert.equal(cfg.tradingAvailable,false);assert.equal(cfg.metadataOnchain,false);assert.equal(cfg.allowanceUsd,undefined);
  const prepared=await h.service.prepare({owner:h.owner,...PROMPT});assert.equal(prepared.status,'prepared');assert.ok(prepared.transactionBase64);assert.equal(h.builds.list().length,0);assert.equal(h.rpc.sent.length,0);
  const retry=await h.service.prepare({owner:h.owner,...PROMPT});assert.equal(retry.intentId,prepared.intentId);assert.equal(retry.launchId,prepared.launchId);assert.equal(retry.mint,prepared.mint);
  const confirmed=await h.service.submit({owner:h.owner,intentId:prepared.intentId,signedTransactionBase64:sign(prepared,h.key)});assert.equal(confirmed.status,'confirmed');assert.ok(confirmed.buildSession.id);
  const b=confirmed.buildSession;assert.equal(b.canManage,true);assert.equal(b.token.chain,'solana');assert.equal(b.token.cluster,'devnet');assert.equal(b.token.chainId,null);assert.equal(b.token.address,confirmed.mint);assert.equal(b.token.signature,confirmed.signature);assert.equal(b.token.verified,true);assert.equal(b.token.marketCapUsd,null);assert.equal(b.modelId,MODEL.id);assert.equal(b.template,'auto');assert.equal(b.plan,null);
  assert.equal(fs.existsSync(path.join(h.directory,'missions.json')),false);assert.doesNotMatch(JSON.stringify(confirmed),/SecretKey|signedTransactionBase64/);
  const again=await h.service.status({owner:h.owner,intentId:prepared.intentId});assert.equal(again.buildId,b.id);assert.equal(h.builds.list().length,1);assert.equal(h.rpc.sent.length,1);
  const revision=h.builds.revise({id:b.id,owner:h.owner,brief:'Extend the full rooftop race with additional safe checkpoints'});assert.deepEqual(revision.token,b.token);assert.equal(revision.lineage.projectId,b.id);
});
test('another owner, altered signed messages, and unsupported builder models cannot launch or attach a token',async t=>{
  const h=fixture(t);await assert.rejects(h.service.prepare({owner:h.owner,...PROMPT,modelId:'google/gemini-2.5-flash'}),/Opus 5.5 or GPT-6 Astra/);
  const p=await h.service.prepare({owner:h.owner,...PROMPT});
  await assert.rejects(h.service.submit({owner:h.other,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)}),/another Solana wallet/);
  await assert.rejects(h.service.status({owner:h.other,intentId:p.intentId}),/another Solana wallet/);
  await assert.rejects(h.service.prepare({owner:h.other,launchId:p.launchId}),/another Solana wallet/);
  await assert.rejects(h.service.status({owner:h.owner}),/Choose a saved/);
  const modified=Transaction.from(Buffer.from(p.transactionBase64,'base64'));modified.recentBlockhash=Keypair.generate().publicKey.toBase58();modified.partialSign(h.key);
  await assert.rejects(h.service.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:modified.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')}),/differs from the prepared launch/);
  assert.equal(h.rpc.sent.length,0);assert.equal(h.builds.list().length,0);assert.equal(h.service.list(h.other).length,0);
});
test('pending confirmations survive restart and are recovered without another mint or camera activation',async t=>{
  const h=fixture(t);h.rpc.autoConfirm=false;const p=await h.service.prepare({owner:h.owner,...PROMPT});
  const pending=await h.service.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)});assert.equal(pending.status,'pending');assert.equal(h.builds.list().length,0);
  const restartedDevnet=createDevnetService({stateDirectory:h.directory,connection:h.rpc}),restartedBuilds=createRobloxBuildService({stateDirectory:h.directory}),restarted=createRobloxSolanaLaunchService({stateDirectory:h.directory,devnet:restartedDevnet,getBuilds:()=>restartedBuilds});
  assert.equal(restarted.list(h.owner)[0].intentId,p.intentId);h.rpc.statuses.set(pending.signature,{slot:105,err:null,confirmationStatus:'confirmed'});
  const result=await restarted.status({owner:h.owner,intentId:p.intentId});assert.equal(result.status,'confirmed');assert.equal(result.mint,p.mint);assert.equal(restartedBuilds.list().length,1);assert.equal(h.rpc.sent.length,1);
  assert.equal((await restarted.prepare({owner:h.owner,...PROMPT})).buildId,result.buildId);assert.equal(restartedBuilds.list().length,1);
});
test('confirmed token survives a workspace setup failure and status recovery creates it exactly once',async t=>{
  const h=fixture(t);let unavailable=true;
  const service=createRobloxSolanaLaunchService({...h.config,getBuilds:()=>{if(unavailable)throw Error('Workspace temporarily unavailable');return h.builds;}}),p=await service.prepare({owner:h.owner,...PROMPT});
  const confirmed=await service.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)});assert.equal(confirmed.status,'confirmed');assert.match(confirmed.buildError,/without paying again/);assert.equal(confirmed.buildSession,undefined);
  unavailable=false;const recovered=await service.status({owner:h.owner,intentId:p.intentId});assert.ok(recovered.buildSession.id);assert.equal(recovered.buildError,undefined);assert.equal(h.builds.list().length,1);assert.equal(h.rpc.sent.length,1);
});
test('RPC network mismatch stops preparation and leaves a recoverable draft, while corrupt launch history fails closed',async t=>{
  const h=fixture(t);h.rpc.genesis='not-devnet';await assert.rejects(h.service.prepare({owner:h.owner,...PROMPT}),/only Solana Devnet/);const saved=h.service.list(h.owner);assert.equal(saved.length,1);assert.equal(saved[0].status,'draft');assert.equal(saved[0].intentId,null);assert.equal(h.rpc.sent.length,0);
  h.rpc.genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';assert.equal((await h.service.prepare({owner:h.owner,launchId:saved[0].launchId})).status,'prepared');
  fs.writeFileSync(path.join(h.directory,'roblox-solana-launches.json'),'invalid');assert.throws(()=>createRobloxSolanaLaunchService(h.config),/unreadable/);assert.equal(fs.readFileSync(path.join(h.directory,'roblox-solana-launches.json'),'utf8'),'invalid');
});
test('failed on-chain attempts remain recoverable and external index damage is never overwritten',async t=>{
  const h=fixture(t);h.rpc.autoConfirm=false;const p=await h.service.prepare({owner:h.owner,...PROMPT}),pending=await h.service.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)});
  h.rpc.statuses.set(pending.signature,{slot:104,err:{InstructionError:[0,'Custom']},confirmationStatus:'confirmed'});
  await assert.rejects(h.service.status({owner:h.owner,intentId:p.intentId}),/failed on chain/);assert.equal(h.service.list(h.owner)[0].status,'failed');assert.equal(h.builds.list().length,0);
  const recovered=await h.service.prepare({owner:h.owner,launchId:p.launchId});assert.equal(recovered.status,'prepared');assert.equal(recovered.mint,p.mint);
  const file=path.join(h.directory,'roblox-solana-launches.json');fs.writeFileSync(file,'damaged saved index');
  await assert.rejects(h.service.prepare({owner:h.owner,...PROMPT,name:'Another skyline game'}),/could not be saved/);assert.equal(fs.readFileSync(file,'utf8'),'damaged saved index');assert.equal(h.rpc.sent.length,1);
});

test('post-preview launch-index corruption, edits, and removal prevent relay and remain recoverable',async t=>{
  for(const change of ['corrupt','valid-change','remove'])await t.test(change,async t=>{
    const h=fixture(t),p=await h.service.prepare({owner:h.owner,...PROMPT}),file=path.join(h.directory,'roblox-solana-launches.json'),original=fs.readFileSync(file);
    const altered=change==='corrupt'?Buffer.from('{damaged'):Buffer.from(JSON.stringify({...JSON.parse(original),externalRevision:1}));
    if(change==='remove')fs.unlinkSync(file);else fs.writeFileSync(file,altered);
    await assert.rejects(h.service.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)}),/history changed on disk/);
    assert.equal(h.rpc.sent.length,0);assert.equal(h.builds.list().length,0);
    if(change==='remove')assert.equal(fs.existsSync(file),false);else assert.deepEqual(fs.readFileSync(file),altered);
    fs.writeFileSync(file,original);
    const restored=createRobloxSolanaLaunchService(h.config),same=await restored.prepare({owner:h.owner,launchId:p.launchId});
    assert.equal(same.intentId,p.intentId);assert.equal(same.mint,p.mint);
    const done=await restored.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)});
    assert.equal(done.status,'confirmed');assert.equal(h.rpc.sent.length,1);assert.equal(h.builds.list().length,1);
  });
});

test('launch-index damage during awaited RPC prevents relay after the lower intent is durable',async t=>{
  const h=fixture(t),p=await h.service.prepare({owner:h.owner,...PROMPT}),file=path.join(h.directory,'roblox-solana-launches.json'),original=fs.readFileSync(file);
  h.rpc.getBlockHeight=async()=>{fs.writeFileSync(file,'damaged during RPC');return 100;};
  await assert.rejects(h.service.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)}),/history changed on disk/);
  assert.equal(h.rpc.sent.length,0);assert.equal(fs.readFileSync(file,'utf8'),'damaged during RPC');
  fs.writeFileSync(file,original);h.rpc.getBlockHeight=async()=>100;
  const restored=createRobloxSolanaLaunchService(h.config),done=await restored.submit({owner:h.owner,intentId:p.intentId,signedTransactionBase64:sign(p,h.key)});
  assert.equal(done.status,'confirmed');assert.equal(done.mint,p.mint);assert.equal(h.rpc.sent.length,1);assert.equal(h.builds.list().length,1);
});
async function httpFixture(t,options={}){
  const h=fixture(t),probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const app=createApp({port,stateDirectory:h.directory,devnetService:h.devnet,models:[MODEL],cameraWorkers:false,key:'',fetcher:async()=>{throw Error('No external requests expected');},...options});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const base='http://127.0.0.1:'+port,csrf=(await(await fetch(base+'/api/status')).json()).csrf;
  function client(){const cookies=new Map();async function request(endpoint,body,headers={}){const response=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{Connection:'close',Origin:base,'X-Parallax-Token':csrf,Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}const data=await response.json();return {status:response.status,data};}async function login(key){const challenge=await request('/api/auth/challenge',{address:key.publicKey.toBase58()});assert.match(challenge.data.message,/Ropad wallet sign-in/);assert.match(challenge.data.message,/creator games/);const verified=await request('/api/auth/verify',{id:challenge.data.id,signatureBase64:signedMessage(key,challenge.data.message)});assert.equal(verified.status,200);return verified;}return {request,login};}
  return {...h,client};
}
test('HTTP launch routes enforce Solana signatures and CSRF, derive ownership, and allow the coin creator to prompt revisions',async t=>{
  const h=await httpFixture(t),owner=h.client(),other=h.client(),otherKey=Keypair.generate();
  assert.equal((await owner.request('/api/solana/launches/prepare',PROMPT)).status,401);assert.deepEqual((await owner.request('/api/solana/launches')).data.data,[]);
  const config=(await owner.request('/api/solana/launches/config')).data;assert.equal(config.cluster,'devnet');assert.equal(config.tradingAvailable,false);
  await owner.login(h.key);await other.login(otherKey);
  assert.equal((await owner.request('/api/solana/launches/prepare',PROMPT,{'X-Parallax-Token':'wrong'})).status,403);
  const prepared=await owner.request('/api/solana/launches/prepare',{...PROMPT,owner:otherKey.publicKey.toBase58(),token:{address:'forged'},buildId:'forged'});assert.equal(prepared.status,200,JSON.stringify(prepared.data));assert.equal(prepared.data.owner,h.owner);
  assert.equal((await other.request('/api/solana/launches/status',{intentId:prepared.data.intentId})).status,403);assert.deepEqual((await other.request('/api/solana/launches')).data.data,[]);
  const signed=sign(prepared.data,h.key),confirmed=await owner.request('/api/solana/launches/submit',{intentId:prepared.data.intentId,signedTransactionBase64:signed,owner:otherKey.publicKey.toBase58()});assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));const b=confirmed.data.buildSession;
  assert.equal((await owner.request('/api/builds/'+b.id)).data.build.canManage,true);assert.equal((await other.request('/api/builds/'+b.id)).data.build.canManage,false);
  assert.equal((await other.request('/api/builds/'+b.id+'/revisions',{brief:'Change the rooftop route'})).status,403);
  const revised=await owner.request('/api/builds/'+b.id+'/revisions',{brief:'A complete rooftop race with five checkpoint gates and a finish'});assert.equal(revised.status,201,JSON.stringify(revised.data));assert.deepEqual(revised.data.build.token,b.token);
  assert.equal((await owner.request('/api/solana/launches/confirm',{intentId:prepared.data.intentId})).data.buildId,b.id);assert.equal((await owner.request('/api/missions')).data.data.length,0);
  const plain=await other.request('/api/builds',{gameName:'Other game',brief:'A compact colorful jumping course',modelId:MODEL.id});assert.equal((await owner.request('/api/builds/'+plain.data.build.id)).data.build.canManage,false);
});
test('mainnet trading routes derive the saved verified mint and reject devnet tokens before contacting the market service',async t=>{
  const calls=[],market={market:async input=>{calls.push({action:'market',...input});return {available:true,cluster:'mainnet-beta'};},prepare:async input=>{calls.push({action:'prepare',...input});return {intentId:'fixture-trade',transactionBase64:'fixture-v0'};},submit:async input=>{calls.push({action:'submit',...input});return {status:'pending'};},status:async input=>{calls.push({action:'status',...input});return {status:'confirmed'};}};
  const h=await httpFixture(t,{solanaMarketService:market}),mint=Keypair.generate().publicKey.toBase58(),signature=bs58.encode(Buffer.alloc(64,9));
  const token={chain:'solana',cluster:'mainnet-beta',address:mint,symbol:'SKY',signature,verified:true};
  const make=token=>h.builds.create({owner:h.other,gameName:PROMPT.name,brief:PROMPT.brief,template:'auto',modelId:MODEL.id,token});
  const mainnet=make(token),devnet=make({...token,cluster:'devnet'}),unverified=make({...token,verified:false}),draft=make(null);
  const buyer=h.client(),anonymous=h.client();for(const build of [devnet,unverified,draft])assert.equal((await buyer.request('/api/solana/trades/market?buildId='+build.id)).status,409);assert.equal(calls.length,0);
  const quote={buildId:mainnet.id,side:'buy',amount:'.01',slippageBps:100,mint:'forged',owner:h.other};
  assert.equal((await anonymous.request('/api/solana/trades/prepare',quote)).status,401);await buyer.login(h.key);
  assert.equal((await buyer.request('/api/solana/trades/prepare',quote,{'X-Parallax-Token':'wrong'})).status,403);
  assert.equal((await buyer.request('/api/solana/trades/prepare',{...quote,buildId:devnet.id})).status,409);
  assert.equal((await buyer.request('/api/solana/trades/market?buildId='+mainnet.id+'&mint=forged')).status,200);assert.deepEqual(calls.at(-1),{action:'market',mint});
  assert.equal((await buyer.request('/api/solana/trades/prepare',quote)).status,200);assert.deepEqual(calls.at(-1),{action:'prepare',owner:h.owner,mint,side:'buy',amount:'.01',slippageBps:100});
  assert.equal((await buyer.request('/api/builds/'+mainnet.id)).data.build.canManage,false);
  assert.equal((await anonymous.request('/api/solana/trades/submit',{intentId:'fixture-trade',signedTransactionBase64:'signed'})).status,401);
  assert.equal((await buyer.request('/api/solana/trades/submit',{owner:h.other,intentId:'fixture-trade',signedTransactionBase64:'signed'})).status,200);assert.deepEqual(calls.at(-1),{action:'submit',owner:h.owner,intentId:'fixture-trade',signedTransactionBase64:'signed'});
  assert.equal((await buyer.request('/api/solana/trades/status',{owner:h.other,intentId:'fixture-trade'})).status,200);assert.deepEqual(calls.at(-1),{action:'status',owner:h.owner,intentId:'fixture-trade'});
});
test('Solana and legacy EVM sessions coexist without losing historical ownership or transferring local projects',async t=>{
  const {privateKeyToAccount}=require('./parallax/node_modules/viem/accounts');
  const h=await httpFixture(t),evm=privateKeyToAccount('0x'+'21'.repeat(32));
  const legacy=h.builds.create({owner:evm.address.toLowerCase(),gameName:'Legacy game',brief:'An older EVM owned obstacle course',modelId:MODEL.id}),sol=h.builds.create({owner:h.owner,gameName:'Solana game',brief:'A Solana owned obstacle course',modelId:MODEL.id});
  const client=h.client(),other=h.client(),local=await other.request('/api/builds',{gameName:'Local game',brief:'An anonymous local obstacle course',modelId:MODEL.id});
  await client.login(h.key);const challenge=await client.request('/api/orbio/auth/challenge',{address:evm.address}),signature=await evm.signMessage({message:challenge.data.message});assert.equal((await client.request('/api/orbio/auth/verify',{id:challenge.data.id,signature})).status,200);
  assert.equal((await client.request('/api/builds/'+legacy.id)).data.build.canManage,true);assert.equal((await client.request('/api/builds/'+sol.id)).data.build.canManage,true);assert.equal((await client.request('/api/builds/'+local.data.build.id)).data.build.canManage,false);
  const created=await client.request('/api/builds',{gameName:'New Solana draft',brief:'An original platform jumping course',modelId:MODEL.id});assert.equal(created.status,201);
  await client.request('/api/auth/logout',{});assert.equal((await client.request('/api/builds/'+created.data.build.id)).data.build.canManage,false);assert.equal((await client.request('/api/builds/'+legacy.id)).data.build.canManage,true);
});

function mainnetFixture(t,{required=true,combined=false}={}){
  const h=fixture(t),mint=Keypair.generate().publicKey.toBase58(),treasury=Keypair.generate().publicKey.toBase58();let saved;
  const shares=combined?[{address:treasury,role:'combined',shareBps:7000,allocationsBps:{platform:1000,compute:6000}},{address:h.owner,role:'creator',shareBps:3000}]:[{address:treasury,role:'platform',shareBps:1000},{address:Keypair.generate().publicKey.toBase58(),role:'compute',shareBps:6000},{address:h.owner,role:'creator',shareBps:3000}];
  const fee=required?{feeSharingRequired:true,feeSharingAtomic:true,permanentShares:true,feePolicyHash:'a'.repeat(64),feeShares:shares,sharingConfig:require('./parallax/node_modules/@pump-fun/pump-sdk').feeSharingConfigPda(new PublicKey(mint)).toBase58(),feeSharingVerified:false}:{};
  const mainnet={config:()=>({cluster:'mainnet-beta',mainnetAvailable:true,feeSharingRequired:true}),prepareLaunch:async({owner,missionId})=>saved??(saved={cluster:'mainnet-beta',owner,missionId,mint,intentId:crypto.randomUUID(),status:'prepared',...fee}),status:async()=>structuredClone(saved),submit:async()=>structuredClone(saved)};
  const options={...h.config,mainnet,defaultCluster:'mainnet-beta'},service=createRobloxSolanaLaunchService(options);
  return {...h,service,options,shares,change:fields=>Object.assign(saved,fields),confirmed:()=>Object.assign(saved,{status:'confirmed',signature:bs58.encode(Buffer.alloc(64,8)),verified:true,finalized:true,metadataVerified:true,bondingCurveCreated:true,feeSharingVerified:true})};
}
test('required permanent fee snapshots survive restart and only verified routing creates the game',async t=>{
  for(const combined of [false,true])await t.test(combined?'shared treasury':'separate treasuries',async t=>{
    const h=mainnetFixture(t,{combined}),p=await h.service.prepare({owner:h.owner,...PROMPT});assert.deepEqual(p.feeShares,h.shares);assert.equal(p.feeSharingRequired,true);assert.equal(p.permanentShares,true);assert.equal(h.builds.list().length,0);
    h.confirmed();h.change({feeSharingVerified:false});await assert.rejects(h.service.status({owner:h.owner,intentId:p.intentId}),/routing verification/);assert.equal(h.builds.list().length,0);assert.equal(h.service.list(h.owner)[0].status,'prepared');
    h.change({feeSharingVerified:true});const restarted=createRobloxSolanaLaunchService(h.options),done=await restarted.status({owner:h.owner,intentId:p.intentId});assert.equal(done.feeSharingVerified,true);assert.equal(done.feePolicyHash,p.feePolicyHash);assert.deepEqual(done.feeShares,h.shares);assert.ok(done.buildId);assert.equal(h.builds.list().length,1);
    assert.equal((await restarted.status({owner:h.owner,intentId:p.intentId})).buildId,done.buildId);assert.equal(h.builds.list().length,1);
  });
});
test('fee downgrade, recipient replacement, policy changes and malformed combined allocations block game activation',async t=>{
  for(const change of [()=>({feeSharingRequired:false}),()=>({feePolicyHash:'b'.repeat(64)}),()=>({sharingConfig:Keypair.generate().publicKey.toBase58()}),()=>({permanentShares:false}),h=>({feeShares:h.shares.map((r,i)=>i?{...r}:{...r,allocationsBps:{platform:1000,compute:5000}})}),h=>({feeShares:h.shares.map((r,i)=>i?{...r}:{...r,address:Keypair.generate().publicKey.toBase58()})})])await t.test('reject altered policy',async t=>{
    const h=mainnetFixture(t,{combined:true}),p=await h.service.prepare({owner:h.owner,...PROMPT});h.confirmed();h.change(change(h));await assert.rejects(h.service.status({owner:h.owner,intentId:p.intentId}),/fee|routing/);assert.equal(h.builds.list().length,0);assert.equal(h.service.list(h.owner)[0].status,'prepared');
  });
});
test('legacy confirmed mainnet launches remain recoverable without inheriting new fee verification claims',async t=>{
  const h=mainnetFixture(t,{required:false}),p=await h.service.prepare({owner:h.owner,...PROMPT});assert.equal(p.feeSharingRequired,false);assert.equal(p.feeSharingAtomic,false);h.confirmed();h.change({feeSharingVerified:undefined});
  const done=await h.service.status({owner:h.owner,intentId:p.intentId});assert.ok(done.buildId);assert.equal(done.feeSharingRequired,false);assert.equal(done.feeSharingVerified,false);assert.equal(done.permanentShares,false);
});

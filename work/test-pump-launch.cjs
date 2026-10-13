'use strict';
// Every chain response is a fixture. No network request, wallet funding or live
// transaction is performed; instructions are built by the real installed SDK.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Keypair,PublicKey,VersionedTransaction,SystemProgram}=require('./parallax/node_modules/@solana/web3.js');
const {MintLayout,AccountType,ExtensionType,TOKEN_2022_PROGRAM_ID}=require('./parallax/node_modules/@solana/spl-token');
const {pack}=require('./parallax/node_modules/@solana/spl-token-metadata');
const pump=require('./parallax/node_modules/@pump-fun/pump-sdk'),bs58=require('./parallax/node_modules/bs58');
const {createPumpLaunchService,GENESIS_HASH}=require('./parallax/pump-launch.cjs');
const {validatePumpMetadata,publicHttps,publicIp}=require('./parallax/pump-metadata.cjs');
const {createRobloxSolanaLaunchService}=require('./parallax/roblox-solana-launch.cjs');
const {createDevnetService}=require('./parallax/devnet.cjs');
const {createRobloxBuildService}=require('./parallax/roblox-builds.cjs');
const URI='https://assets.example.com/game.json',IMAGE='https://assets.example.com/game.png',NAME='Skyline Circuit',SYMBOL='SKY';
const MODEL='anthropic/claude-opus-5.5';
function imageBytes(){const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);return b;}
function metadataBytes(){return Buffer.from(JSON.stringify({name:NAME,symbol:SYMBOL,image:IMAGE}));}
function mintBytes(mint,options={}){
  const metadata=pack({mint,updateAuthority:PublicKey.default,name:NAME,symbol:SYMBOL,uri:options.badMetadata?'https://assets.example.com/other.json':URI,additionalMetadata:[]});
  const b=Buffer.alloc(166+4+metadata.length);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},b);b[165]=AccountType.Mint;b.writeUInt16LE(ExtensionType.TokenMetadata,166);b.writeUInt16LE(metadata.length,168);Buffer.from(metadata).copy(b,170);return b;
}
function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-pump-launch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const wallet=Keypair.generate(),owner=wallet.publicKey.toBase58();let clock=1000,height=100,sends=0,sent=null,signature=null,quotedMint=null;
  const sdk=Object.create(pump.PUMP_SDK);sdk.decodeGlobal=()=>({createV2Enabled:options.disabledCreate!==true});sdk.decodeBondingCurve=()=>({creator:options.wrongCreator?Keypair.generate().publicKey:wallet.publicKey,tokenTotalSupply:1000000000000000n,quoteMint:PublicKey.default,isMayhemMode:false,isCashbackCoin:false,isHolderReward:false});
  const connection={
    getGenesisHash:async()=>options.genesis||GENESIS_HASH,
    getAccountInfo:async()=>options.existingMint?{data:Buffer.alloc(1)}:null,
    getMultipleAccountsInfoAndContext:async keys=>keys.length===3?{context:{slot:100},value:[{owner:pump.PUMP_PROGRAM_ID,data:Buffer.from([1])},{owner:SystemProgram.programId,executable:true},{owner:SystemProgram.programId,lamports:1000000000}]}:{context:{slot:110},value:[{owner:TOKEN_2022_PROGRAM_ID,data:mintBytes(quotedMint,options)},{owner:options.wrongCurve?SystemProgram.programId:pump.PUMP_PROGRAM_ID,data:Buffer.from([3])}]},
    getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:150}),
    getFeeForMessage:async()=>({value:14000}),
    simulateTransaction:async(tx,settings)=>{quotedMint=tx.message.staticAccountKeys[1];assert.equal(settings.sigVerify,false);assert.equal(settings.replaceRecentBlockhash,false);assert.equal(tx.message.header.numRequiredSignatures,2);return {value:{err:options.simError??null,unitsConsumed:180000,accounts:[{lamports:options.simBalance??994000000}]}};},
    getBlockHeight:async()=>height,
    sendRawTransaction:async bytes=>{sends++;sent=VersionedTransaction.deserialize(bytes);signature=bs58.encode(sent.signatures[0]);const saved=JSON.parse(fs.readFileSync(path.join(directory,'pump-mainnet-intents.json'))).intents[0];assert.equal(saved.status,'pending');assert.equal(saved.signature,signature);if(options.sendError)throw Error('uncertain transport');return signature;},
    getSignatureStatuses:async()=>({context:{slot:options.staleHistory?90:120},value:[sent&&!options.absent?{slot:110,confirmationStatus:options.pending?'confirmed':'finalized',err:options.reverted?{InstructionError:[2,'Custom']}:null}:null]}),
    getTransaction:async()=>sent&&!options.absent?{slot:options.wrongSlot?111:110,transaction:{signatures:[signature],message:options.wrongMessage?VersionedTransaction.deserialize(options.wrongMessage).message:sent.message},meta:{fee:14000,err:options.reverted?{InstructionError:[2,'Custom']}:null}}:null,
    isBlockhashValid:async()=>({context:{slot:115},value:options.blockhashStillValid===true})
  };
  const fetchBytes=async(url,limit)=>{assert.ok(limit>0);return {bytes:url===URI?metadataBytes():imageBytes()};};
  const config={stateDirectory:directory,enabled:options.enabled!==false,connection,sdk,fetchBytes,now:()=>clock};
  const service=createPumpLaunchService(config),args={owner,missionId:'roblox_'+cryptoId(),name:NAME,symbol:SYMBOL,metadataUri:URI};
  const prepare=(extra={})=>service.prepareLaunch({...args,...extra});
  const sign=q=>{const tx=VersionedTransaction.deserialize(Buffer.from(q.transactionBase64,'base64'));tx.sign([wallet]);return Buffer.from(tx.serialize()).toString('base64');};
  return {service,config,args,prepare,sign,options,connection,owner,wallet,directory,expire:()=>{clock+=120000;height=151;},get sends(){return sends;}};
}
function cryptoId(){return require('node:crypto').randomUUID();}
test('public metadata rejects unsafe hosts, redirects by contract, altered names and unsupported image bytes',async()=>{
  for(const url of ['http://example.com/a','https://127.0.0.1/a','https://10.0.0.2/a','https://localhost/a','https://test.local/a','https://user:password@example.com/a','https://example.com:444/a'])assert.throws(()=>publicHttps(url));
  for(const ip of ['127.0.0.1','169.254.1.1','192.168.1.1','172.31.1.1','100.64.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicIp(ip),false);
  const common={uri:URI,name:NAME,symbol:SYMBOL};
  await assert.rejects(validatePumpMetadata({...common,fetchBytes:async()=>({bytes:Buffer.from('{}')})}),/name and symbol/);
  await assert.rejects(validatePumpMetadata({...common,fetchBytes:async url=>({bytes:url===URI?metadataBytes():Buffer.from('<svg/>')})}),/PNG, JPEG or WebP/);
  const valid=await validatePumpMetadata({...common,fetchBytes:async url=>({bytes:url===URI?metadataBytes():imageBytes()})});assert.match(valid.metadataHash,/^[a-f0-9]{64}$/);assert.equal(valid.uri,URI);
});
test('mainnet create uses official Pump create_v2, partial mint signature, exact simulated fee quote, and no automatic broadcast',async t=>{
  const f=fixture(t),p=await f.prepare(),tx=VersionedTransaction.deserialize(Buffer.from(p.transactionBase64,'base64'));
  assert.equal(p.cluster,'mainnet-beta');assert.equal(p.transactionVersion,'v0');assert.equal(p.realFunds,true);assert.equal(p.simulation,'passed');assert.equal(p.fundingLamports,0);assert.equal(p.totalRequiredLamports,p.rentLamports+p.estimatedNetworkFeeLamports);assert.equal(p.totalRequiredLamports,6000000);assert.equal(f.sends,0);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(),f.owner);assert.equal(tx.message.staticAccountKeys[1].toBase58(),p.mint);assert.ok(tx.signatures[0].every(x=>x===0));assert.ok(tx.signatures[1].some(x=>x!==0));
  const ix=tx.message.compiledInstructions[2];assert.equal(tx.message.staticAccountKeys[ix.programIdIndex].toBase58(),pump.PUMP_PROGRAM_ID.toBase58());
  const coder=pump.PUMP_SDK.offlinePumpProgram.coder.instruction,decoded=coder.decode(Buffer.from(ix.data));assert.equal(decoded.name,'createV2');assert.equal(decoded.data.name,NAME);assert.equal(decoded.data.uri,URI);assert.equal(decoded.data.creator.toBase58(),f.owner);assert.equal(decoded.data.isMayhemMode,false);
  assert.doesNotMatch(JSON.stringify(p),/mintSecretKey|messageBase64|signedTransactionBase64/);const same=await f.prepare();assert.equal(same.intentId,p.intentId);assert.equal(same.mint,p.mint);
});
test('mainnet finalized receipt verifies mint, creator, curve and onchain metadata before confirmation',async t=>{
  const f=fixture(t),p=await f.prepare(),done=await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});
  assert.equal(done.status,'confirmed');assert.equal(done.finalized,true);assert.equal(done.metadataVerified,true);assert.equal(done.bondingCurveCreated,true);assert.equal(done.verified,true);assert.equal(f.sends,1);
  const again=await f.service.status({owner:f.owner,intentId:p.intentId});assert.equal(again.signature,done.signature);assert.equal(f.sends,1);
  const record=JSON.parse(fs.readFileSync(path.join(f.directory,'pump-mainnet-intents.json'))).intents[0];assert.equal(record.mintSecretKey,undefined);
  const restart=createPumpLaunchService({...f.config,enabled:false});assert.equal((await restart.status({owner:f.owner,intentId:p.intentId})).status,'confirmed');
});
test('wrong network, disabled creation, failed simulation, excessive cost and pre-existing mint never request or relay a transaction',async t=>{
  for(const options of [{genesis:'devnet'},{enabled:false},{disabledCreate:true},{simError:{InstructionError:[2,'failure']}},{simBalance:1},{existingMint:true}])await t.test(JSON.stringify(options),async t=>{const f=fixture(t,options);await assert.rejects(f.prepare());assert.equal(f.sends,0);});
});
test('tampered message, invalid wallet/mint signatures and another wallet cannot launch',async t=>{
  const f=fixture(t),p=await f.prepare();
  const changed=VersionedTransaction.deserialize(Buffer.from(p.transactionBase64,'base64'));changed.message.recentBlockhash=Keypair.generate().publicKey.toBase58();changed.sign([f.wallet]);
  await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:Buffer.from(changed.serialize()).toString('base64')}),/differs/);
  await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:p.transactionBase64}),/signatures/);
  const corrupt=VersionedTransaction.deserialize(Buffer.from(f.sign(p),'base64'));corrupt.signatures[1][0]^=1;
  await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:Buffer.from(corrupt.serialize()).toString('base64')}),/signatures/);
  await assert.rejects(f.service.submit({owner:Keypair.generate().publicKey.toBase58(),intentId:p.intentId,signedTransactionBase64:f.sign(p)}),/different wallet/);assert.equal(f.sends,0);
});
test('mismatched finalized receipt or mint settings never create verified coins',async t=>{
  for(const options of [{wrongSlot:true},{wrongCreator:true},{wrongCurve:true},{badMetadata:true}])await t.test(JSON.stringify(options),async t=>{const f=fixture(t,options),p=await f.prepare();await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)}));assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'pump-mainnet-intents.json'))).intents[0].status,'pending');});
});
test('a finalized receipt with another transaction message never confirms a mainnet launch',async t=>{
  const f=fixture(t),p=await f.prepare(),other=VersionedTransaction.deserialize(Buffer.from(p.transactionBase64,'base64'));other.message.recentBlockhash=Keypair.generate().publicKey.toBase58();f.options.wrongMessage=other.serialize();
  await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)}),/finalized receipt differs/);assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'pump-mainnet-intents.json'))).intents[0].verified,undefined);
});
test('saved mission identity cannot change its creator, name, symbol or metadata',async t=>{
  const f=fixture(t);await f.prepare();for(const change of [{owner:Keypair.generate().publicKey.toBase58()},{name:'Another Game'},{symbol:'NEW'},{metadataUri:'https://assets.example.com/other.json'}])await assert.rejects(f.prepare(change),/Saved launch details differ/);assert.equal(f.sends,0);
});
test('RPC timeout keeps exact durable pending signature; restart recovers one launch and one mint',async t=>{
  const f=fixture(t,{sendError:true,pending:true}),p=await f.prepare(),pending=await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});assert.equal(pending.status,'pending');assert.equal(pending.submissionUncertain,true);
  f.options.sendError=false;f.options.pending=false;const restarted=createPumpLaunchService(f.config),done=await restarted.status({owner:f.owner,intentId:p.intentId});assert.equal(done.status,'confirmed');assert.equal(done.mint,p.mint);assert.equal(f.sends,1);
});
test('operator disabling creation still permits pending receipt recovery but no new mainnet launch or broadcast',async t=>{
  const f=fixture(t,{pending:true}),p=await f.prepare();await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});const disabled=createPumpLaunchService({...f.config,enabled:false});assert.equal(disabled.config().mainnetAvailable,false);
  await assert.rejects(disabled.prepareLaunch(f.args),/not enabled/);await assert.rejects(disabled.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)}),/not enabled/);
  f.options.pending=false;const recovered=await disabled.status({owner:f.owner,intentId:p.intentId});assert.equal(recovered.status,'confirmed');assert.equal(recovered.mint,p.mint);assert.equal(f.sends,1);
});
test('expiry requires finalized blockhash and fresh absent signature evidence; refresh reuses mint',async t=>{
  const f=fixture(t,{absent:true}),p=await f.prepare();await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});f.expire();f.options.staleHistory=true;
  assert.equal((await f.service.status({owner:f.owner,intentId:p.intentId})).status,'pending');f.options.staleHistory=false;f.options.existingMint=true;assert.equal((await f.service.status({owner:f.owner,intentId:p.intentId})).status,'pending');f.options.existingMint=false;
  assert.equal((await f.service.status({owner:f.owner,intentId:p.intentId})).status,'expired');const refreshed=await f.prepare();assert.equal(refreshed.mint,p.mint);assert.equal(refreshed.intentId,p.intentId);assert.equal(refreshed.status,'prepared');assert.notEqual(refreshed.transactionBase64,p.transactionBase64);assert.equal(f.sends,1);
});
test('failed finalized creation permits same-mint retry, without claiming success',async t=>{
  const f=fixture(t,{reverted:true}),p=await f.prepare(),failed=await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});assert.equal(failed.status,'failed');assert.equal(failed.verified,undefined);
  f.options.reverted=false;const again=await f.prepare();assert.equal(again.mint,p.mint);assert.equal(again.attempts.length,1);
});
test('changed launch history and parent index failure prevent relay and preserve bytes',async t=>{
  const f=fixture(t),p=await f.prepare(),file=path.join(f.directory,'pump-mainnet-intents.json'),bytes=fs.readFileSync(file);
  fs.writeFileSync(file,'damaged');await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)}),/changed on disk/);assert.equal(f.sends,0);assert.equal(fs.readFileSync(file,'utf8'),'damaged');
  fs.writeFileSync(file,bytes);const restart=createPumpLaunchService(f.config);await assert.rejects(restart.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p),beforeBroadcast:()=>{throw Error('parent index changed');}}),/parent index/);assert.equal(f.sends,0);
});
test('orchestration preserves Devnet defaults and links one mainnet workspace only after verified finalization',async t=>{
  const f=fixture(t,{pending:true}),devnet=createDevnetService({stateDirectory:f.directory}),builds=createRobloxBuildService({stateDirectory:f.directory});
  const options={stateDirectory:f.directory,devnet,mainnet:f.service,getBuilds:()=>builds},launch=createRobloxSolanaLaunchService(options);
  assert.equal(launch.config().cluster,'devnet');assert.deepEqual(launch.config().supportedClusters,['devnet','mainnet-beta']);
  const args={owner:f.owner,cluster:'mainnet-beta',name:NAME,ticker:SYMBOL,brief:'A polished rooftop race with clear checkpoints and a finish',modelId:MODEL,metadataUri:URI};
  const p=await launch.prepare(args);assert.equal(p.cluster,'mainnet-beta');assert.equal(p.transactionVersion,'v0');assert.equal(builds.list().length,0);
  const pending=await launch.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});assert.equal(pending.status,'pending');assert.equal(builds.list().length,0);
  assert.equal(launch.verifiedCreator(crypto.randomUUID(),p.mint),null);
  f.options.pending=false;const restarted=createRobloxSolanaLaunchService({...options,mainnet:createPumpLaunchService(f.config)}),done=await restarted.status({owner:f.owner,intentId:p.intentId});assert.equal(done.status,'confirmed');assert.equal(done.buildSession.token.cluster,'mainnet-beta');assert.equal(done.buildSession.token.verified,true);assert.equal(done.buildSession.canManage,true);assert.equal(builds.list().length,1);
  assert.equal(restarted.verifiedCreator(done.buildId,done.mint),f.owner);assert.equal(restarted.verifiedCreator(done.buildId,Keypair.generate().publicKey.toBase58()),null);assert.equal(restarted.verifiedCreator(crypto.randomUUID(),done.mint),null);
  assert.equal((await restarted.prepare({owner:f.owner,launchId:p.launchId})).buildId,done.buildId);assert.equal(f.sends,1);assert.equal(restarted.list(f.owner).length,1);
});

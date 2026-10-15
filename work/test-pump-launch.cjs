'use strict';
// Every chain response is a fixture. No network request, wallet funding or live
// transaction is performed; instructions are built by the real installed SDK.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Keypair,PublicKey,VersionedTransaction,SystemProgram,AddressLookupTableProgram}=require('./parallax/node_modules/@solana/web3.js');
const {MintLayout,AccountType,ExtensionType,TOKEN_2022_PROGRAM_ID}=require('./parallax/node_modules/@solana/spl-token');
const {pack}=require('./parallax/node_modules/@solana/spl-token-metadata');
const pump=require('./parallax/node_modules/@pump-fun/pump-sdk'),bs58=require('./parallax/node_modules/bs58');
const {createPumpLaunchService,GENESIS_HASH,TTL}=require('./parallax/pump-launch.cjs');
const {FEE_LAUNCH_LOOKUP_ADDRESSES,lookupAddresses}=require('./parallax/pump-launch-lookup.cjs');
const {feeRecipients}=require('./parallax/solana-fee-accounting.cjs');
const {validatePumpMetadata,publicHttps,publicIp}=require('./parallax/pump-metadata.cjs');
const {createRobloxSolanaLaunchService}=require('./parallax/roblox-solana-launch.cjs');
const {createDevnetService}=require('./parallax/devnet.cjs');
const {createRobloxBuildService}=require('./parallax/roblox-builds.cjs');
const URI='https://assets.example.com/game.json',IMAGE='https://assets.example.com/game.png',NAME='Skyline Circuit',SYMBOL='SKY';
const MODEL='anthropic/claude-opus-5.5';
function imageBytes(){const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);return b;}
function metadataBytes(name=NAME,symbol=SYMBOL){return Buffer.from(JSON.stringify({name,symbol,image:IMAGE}));}
function lookupBytes(options={}){
  const addresses=FEE_LAUNCH_LOOKUP_ADDRESSES.map(address=>new PublicKey(address));if(options.lookupWrongAddresses)addresses[0]=Keypair.generate().publicKey;if(options.lookupReordered)[addresses[0],addresses[1]]=[addresses[1],addresses[0]];
  const bytes=Buffer.alloc(56+32*addresses.length);bytes.writeUInt32LE(1,0);bytes.writeBigUInt64LE(options.lookupDeactivated?99n:0xffffffffffffffffn,4);bytes.writeBigUInt64LE(options.lookupNotMature?100n:90n,12);bytes[20]=0;bytes[21]=options.lookupMutable?1:0;if(options.lookupMutable)Keypair.generate().publicKey.toBuffer().copy(bytes,22);addresses.forEach((address,index)=>address.toBuffer().copy(bytes,56+32*index));return bytes;
}
function mintBytes(mint,options={}){
  const metadata=pack({mint,updateAuthority:PublicKey.default,name:options.name||NAME,symbol:SYMBOL,uri:options.badMetadata?'https://assets.example.com/other.json':options.uri||URI,additionalMetadata:[]});
  const b=Buffer.alloc(166+4+metadata.length);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},b);b[165]=AccountType.Mint;b.writeUInt16LE(ExtensionType.TokenMetadata,166);b.writeUInt16LE(metadata.length,168);Buffer.from(metadata).copy(b,170);return b;
}
function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-pump-launch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const wallet=Keypair.generate(),owner=wallet.publicKey.toBase58();let clock=1000,height=100,sends=0,sent=null,signature=null,quotedMint=null;
  const feeConfig=options.atomic?{platformMint:Keypair.generate().publicKey.toBase58(),platformTreasury:Keypair.generate().publicKey.toBase58(),computeTreasury:Keypair.generate().publicKey.toBase58(),splitBps:{platform:1250,compute:3750,creator:5000},projects:[]}:null,lookupTableAddress=options.atomic?Keypair.generate().publicKey.toBase58():null;
  if(options.sharedTreasury){feeConfig.computeTreasury=feeConfig.platformTreasury;feeConfig.splitBps={platform:1000,compute:6000,creator:3000};feeConfig.platformMint=null;}
  const sdk=Object.create(pump.PUMP_SDK);sdk.decodeGlobal=()=>({createV2Enabled:options.disabledCreate!==true});sdk.decodeBondingCurve=()=>({creator:options.wrongCreator?Keypair.generate().publicKey:options.atomic?pump.feeSharingConfigPda(quotedMint):wallet.publicKey,tokenTotalSupply:1000000000000000n,quoteMint:PublicKey.default,isMayhemMode:false,isCashbackCoin:false,isHolderReward:false});
  sdk.decodeSharingConfig=()=>({mint:options.wrongSharingMint?Keypair.generate().publicKey:quotedMint,adminRevoked:!options.sharingMutable,shareholders:feeRecipients(feeConfig,owner).map(share=>({address:options.wrongSharingCreator&&share.role==='creator'?Keypair.generate().publicKey:new PublicKey(share.address),shareBps:share.shareBps-(options.wrongShares&&share.role==='creator'?1:0)}))});
  const connection={
    getGenesisHash:async()=>options.genesis||GENESIS_HASH,
    getAccountInfo:async()=>options.existingMint?{data:Buffer.alloc(1)}:null,
    getMultipleAccountsInfoAndContext:async keys=>keys[0].equals(pump.GLOBAL_PDA)?{context:{slot:100},value:[{owner:pump.PUMP_PROGRAM_ID,data:Buffer.from([1])},{owner:SystemProgram.programId,executable:true},{owner:SystemProgram.programId,lamports:1000000000}]}:{context:{slot:110},value:[{owner:TOKEN_2022_PROGRAM_ID,data:mintBytes(quotedMint,options)},{owner:options.wrongCurve?SystemProgram.programId:pump.PUMP_PROGRAM_ID,data:Buffer.from([3])},...(options.atomic?[options.sharingMissing?null:{owner:options.wrongSharingOwner?SystemProgram.programId:pump.PUMP_FEE_PROGRAM_ID,data:Buffer.alloc(0)}]:[])]},
    getAccountInfoAndContext:async(address,settings)=>{assert.equal(address.toBase58(),lookupTableAddress);assert.equal(settings.commitment,'finalized');return {context:{slot:100},value:options.lookupMissing?null:{owner:options.lookupWrongOwner?SystemProgram.programId:AddressLookupTableProgram.programId,executable:false,data:lookupBytes(options)}};},
    getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:150}),
    getFeeForMessage:async()=>({value:14000}),
    simulateTransaction:async(tx,settings)=>{quotedMint=tx.message.staticAccountKeys[1];assert.equal(settings.sigVerify,false);assert.equal(settings.replaceRecentBlockhash,false);assert.equal(tx.message.header.numRequiredSignatures,2);return {value:{err:options.simError??null,unitsConsumed:180000,accounts:[{lamports:options.simBalance??994000000}]}};},
    getBlockHeight:async()=>height,
    sendRawTransaction:async bytes=>{sends++;sent=VersionedTransaction.deserialize(bytes);signature=bs58.encode(sent.signatures[0]);const saved=JSON.parse(fs.readFileSync(path.join(directory,'pump-mainnet-intents.json'))).intents[0];assert.equal(saved.status,'pending');assert.equal(saved.signature,signature);if(options.sendError)throw Error('uncertain transport');return signature;},
    getSignatureStatuses:async()=>({context:{slot:options.staleHistory?90:120},value:[sent&&!options.absent?{slot:110,confirmationStatus:options.pending?'confirmed':'finalized',err:options.reverted?{InstructionError:[2,'Custom']}:null}:null]}),
    getTransaction:async()=>{if(!sent||options.absent)return null;const snapshot=options.atomic?JSON.parse(fs.readFileSync(path.join(directory,'pump-mainnet-intents.json'))).intents[0].lookupTable:null,loaded=snapshot?lookupAddresses(sent.message,snapshot):null;if(loaded&&options.wrongReceiptLookup)loaded.readonly[0]=Keypair.generate().publicKey;return {slot:options.wrongSlot?111:110,transaction:{signatures:[signature],message:options.wrongMessage?VersionedTransaction.deserialize(options.wrongMessage).message:sent.message},meta:{fee:14000,err:options.reverted?{InstructionError:[2,'Custom']}:null,...(loaded?{loadedAddresses:loaded}:{})}};},
    isBlockhashValid:async()=>({context:{slot:115},value:options.blockhashStillValid===true})
  };
  const fetchBytes=async(url,limit)=>{assert.ok(limit>0);return {bytes:url===(options.uri||URI)?metadataBytes(options.name||NAME):imageBytes()};};
  const config={stateDirectory:directory,enabled:options.enabled!==false,connection,sdk,fetchBytes,now:()=>clock,...(options.atomic?{feeConfig,requireFeeSharing:true,lookupTableAddress}:{})};
  const service=createPumpLaunchService(config),args={owner,missionId:'roblox_'+cryptoId(),name:options.name||NAME,symbol:SYMBOL,metadataUri:options.uri||URI};
  const prepare=(extra={})=>service.prepareLaunch({...args,...extra});
  const sign=q=>{const tx=VersionedTransaction.deserialize(Buffer.from(q.transactionBase64,'base64'));tx.sign([wallet]);return Buffer.from(tx.serialize()).toString('base64');};
  return {service,config,args,prepare,sign,options,connection,owner,wallet,directory,sdk,feeConfig,lookupTableAddress,advanceClock:milliseconds=>{clock+=milliseconds;},expire:()=>{clock+=120000;height=151;},get sends(){return sends;}};
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
test('a prepared quote cannot relay at or after its deadline even while its blockhash remains valid',async t=>{
  for(const elapsed of [TTL,TTL+1])await t.test(String(elapsed),async t=>{
    const f=fixture(t,{atomic:true}),p=await f.prepare(),signed=f.sign(p),file=path.join(f.directory,'pump-mainnet-intents.json'),bytes=fs.readFileSync(file);let beforeBroadcastCalls=0;
    f.advanceClock(elapsed);assert.ok(await f.connection.getBlockHeight('confirmed')<=p.lastValidBlockHeight);
    await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:signed,beforeBroadcast:()=>{beforeBroadcastCalls++;}}),{status:409,code:'LAUNCH_QUOTE_EXPIRED'});
    assert.equal(f.sends,0);assert.equal(beforeBroadcastCalls,0);assert.deepEqual(fs.readFileSync(file),bytes);
    const saved=JSON.parse(bytes).intents[0];assert.equal(saved.status,'prepared');assert.equal(saved.signature,undefined);assert.equal(saved.signedTransactionBase64,undefined);
    const refreshed=await f.prepare();assert.equal(refreshed.intentId,p.intentId);assert.equal(refreshed.mint,p.mint);assert.ok(refreshed.expiresAt>p.expiresAt);assert.notEqual(refreshed.transactionBase64,p.transactionBase64);
    await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:signed}),{code:'TRANSACTION_MISMATCH'});assert.equal(f.sends,0);
    assert.equal((await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(refreshed)})).status,'confirmed');assert.equal(f.sends,1);
  });
});
test('the quote deadline does not prevent retrying or recovering an already pending signed launch',async t=>{
  const f=fixture(t,{atomic:true,sendError:true,pending:true}),p=await f.prepare(),signed=f.sign(p);
  assert.equal((await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:signed})).status,'pending');f.advanceClock(TTL+1);f.options.sendError=false;
  assert.equal((await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:signed})).status,'pending');assert.equal(f.sends,2);
  f.options.pending=false;const restored=createPumpLaunchService(f.config),done=await restored.status({owner:f.owner,intentId:p.intentId});assert.equal(done.status,'confirmed');assert.equal(done.feeSharingVerified,true);assert.equal(done.mint,p.mint);assert.equal(f.sends,2);
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

test('atomic creation uses the frozen approved lookup and permanently assigns exact creator fee shares in one packet',async t=>{
  const f=fixture(t,{atomic:true,uri:'https://ropad.fun/public/tokens/'+'a'.repeat(64)+'.json'}),p=await f.prepare(),tx=VersionedTransaction.deserialize(Buffer.from(p.transactionBase64,'base64'));
  assert.equal(tx.serialize().length,1171);assert.equal(tx.message.compiledInstructions.length,5);assert.equal(tx.message.addressTableLookups.length,1);assert.equal(tx.message.addressTableLookups[0].accountKey.toBase58(),f.lookupTableAddress);
  assert.equal(p.feeSharingRequired,true);assert.equal(p.feeSharingAtomic,true);assert.equal(p.permanentShares,true);assert.equal(p.feeSharingVerified,false);assert.match(p.feePolicyHash,/^[a-f0-9]{64}$/);assert.equal(p.sharingConfig,pump.feeSharingConfigPda(new PublicKey(p.mint)).toBase58());
  assert.deepEqual(p.feeShares,[{address:f.feeConfig.platformTreasury,shareBps:1250,role:'platform'},{address:f.feeConfig.computeTreasury,shareBps:3750,role:'compute'},{address:f.owner,shareBps:5000,role:'creator'}]);
  const coder=pump.PUMP_SDK.offlinePumpFeeProgram.coder.instruction,create=coder.decode(Buffer.from(tx.message.compiledInstructions[3].data)),update=coder.decode(Buffer.from(tx.message.compiledInstructions[4].data));assert.equal(create.name,'createFeeSharingConfig');assert.equal(update.name,'updateFeeSharesV2');
  assert.deepEqual(update.data.shareholders.map(share=>({address:share.address.toBase58(),shareBps:share.shareBps})),p.feeShares.map(({address,shareBps})=>({address,shareBps})));
  assert.equal(f.sends,0);assert.doesNotMatch(JSON.stringify(p),/mintSecretKey|messageBase64|signedTransactionBase64|lastExtendedSlot/);
  const done=await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});assert.equal(done.status,'confirmed');assert.equal(done.feeSharingVerified,true);assert.equal(done.feeSharingAtomic,true);assert.equal(done.permanentShares,true);assert.equal(f.sends,1);
  const restored=createPumpLaunchService(f.config);assert.equal((await restored.status({owner:f.owner,intentId:p.intentId})).feeSharingVerified,true);
});
test('required fee policy and lookup configuration fail closed before a mainnet transaction can be prepared',async t=>{
  const f=fixture(t,{atomic:true});for(const overrides of [{feeConfig:null},{lookupTableAddress:null},{lookupTableAddress:'not-a-key'}]){
    const service=createPumpLaunchService({...f.config,...overrides});assert.equal(service.config().mainnetAvailable,false);assert.equal(service.config().feeSharingAtomicAvailable,false);await assert.rejects(service.prepareLaunch(f.args),error=>['FEE_CONFIG_INACTIVE','FEE_LOOKUP_UNAVAILABLE'].includes(error.code));
  }assert.equal(f.sends,0);
});
test('mainnet lookup rejects missing, mutable, inactive, unfinalized-content and non-approved tables',async t=>{
  for(const options of [{lookupMissing:true},{lookupWrongOwner:true},{lookupMutable:true},{lookupDeactivated:true},{lookupNotMature:true},{lookupWrongAddresses:true},{lookupReordered:true}])await t.test(JSON.stringify(options),async t=>{const f=fixture(t,{atomic:true,...options});await assert.rejects(f.prepare(),{code:'FEE_LOOKUP_UNAVAILABLE'});assert.equal(f.sends,0);assert.equal(fs.existsSync(path.join(f.directory,'pump-mainnet-intents.json')),false);});
  const f=fixture(t,{atomic:true});f.connection.getAccountInfoAndContext=async()=>({context:{slot:100},value:{owner:AddressLookupTableProgram.programId,data:Buffer.alloc(10)}});await assert.rejects(f.prepare(),{code:'FEE_LOOKUP_UNAVAILABLE'});
});
test('atomic launches reject oversized names and metadata URLs instead of splitting the transaction',async t=>{
  const f=fixture(t,{atomic:true,name:'A'.repeat(33)});await assert.rejects(f.prepare(),/name exceeds/);assert.equal(f.sends,0);
  const g=fixture(t,{atomic:true,uri:'https://assets.example.com/'+'a'.repeat(160)+'.json'});await assert.rejects(g.prepare(),{code:'LAUNCH_TRANSACTION_TOO_LARGE'});assert.equal(g.sends,0);assert.equal(fs.existsSync(path.join(g.directory,'pump-mainnet-intents.json')),false);
});
test('altered atomic instructions or lookup indexes never reach broadcast',async t=>{
  for(const kind of ['shares','lookup']){const f=fixture(t,{atomic:true}),p=await f.prepare(),tx=VersionedTransaction.deserialize(Buffer.from(p.transactionBase64,'base64'));if(kind==='shares')tx.message.compiledInstructions[4].data[20]^=1;else tx.message.addressTableLookups[0].readonlyIndexes[0]=1;tx.sign([f.wallet]);await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')}),{code:'TRANSACTION_MISMATCH'});assert.equal(f.sends,0);}
});
test('fee policy or trusted lookup changes cannot silently replace a prepared permanent assignment',async t=>{
  const f=fixture(t,{atomic:true}),p=await f.prepare();for(const overrides of [{feeConfig:{...f.feeConfig,splitBps:{platform:1500,compute:3500,creator:5000}}},{lookupTableAddress:Keypair.generate().publicKey.toBase58()},{feeConfig:null}]){
    const service=createPumpLaunchService({...f.config,...overrides});await assert.rejects(service.prepareLaunch(f.args),error=>['FEE_POLICY_CHANGED','FEE_CONFIG_INACTIVE'].includes(error.code));await assert.rejects(service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)}),error=>['FEE_POLICY_CHANGED','FEE_CONFIG_INACTIVE'].includes(error.code));
  }assert.equal(f.sends,0);assert.equal((await f.service.status({owner:f.owner,intentId:p.intentId})).feePolicyHash,p.feePolicyHash);
});
test('atomic confirmation requires resolved lookup addresses and exact permanent on-chain recipients',async t=>{
  for(const options of [{wrongReceiptLookup:true},{sharingMissing:true},{wrongSharingOwner:true},{wrongSharingMint:true},{sharingMutable:true},{wrongSharingCreator:true},{wrongShares:true},{wrongCreator:true}])await t.test(JSON.stringify(options),async t=>{
    const f=fixture(t,{atomic:true,...options}),p=await f.prepare();await assert.rejects(f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)}));const saved=JSON.parse(fs.readFileSync(path.join(f.directory,'pump-mainnet-intents.json'))).intents[0];assert.equal(saved.status,'pending');assert.equal(saved.feeSharingVerified,false);
  });
});
test('pending atomic recovery uses its signed policy snapshot after current configuration is removed',async t=>{
  const f=fixture(t,{atomic:true,pending:true}),p=await f.prepare();await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});f.options.pending=false;
  const service=createPumpLaunchService({...f.config,feeConfig:null,lookupTableAddress:null,enabled:false}),done=await service.status({owner:f.owner,intentId:p.intentId});assert.equal(done.status,'confirmed');assert.equal(done.feePolicyHash,p.feePolicyHash);assert.deepEqual(done.feeShares,p.feeShares);assert.equal(done.feeSharingVerified,true);assert.equal(f.sends,1);
});
test('legacy prepared launches are gated but existing pending and confirmed receipts remain recoverable',async t=>{
  const f=fixture(t),p=await f.prepare(),enforced=createPumpLaunchService({...f.config,requireFeeSharing:true});await assert.rejects(enforced.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)}),{code:'FEE_CONFIG_INACTIVE'});assert.equal(f.sends,0);
  const g=fixture(t,{pending:true}),q=await g.prepare();await g.service.submit({owner:g.owner,intentId:q.intentId,signedTransactionBase64:g.sign(q)});g.options.pending=false;const restored=createPumpLaunchService({...g.config,requireFeeSharing:true}),done=await restored.status({owner:g.owner,intentId:q.intentId});assert.equal(done.status,'confirmed');assert.equal(done.feeSharingAtomic,false);assert.equal(done.feeSharingVerified,undefined);assert.equal(done.feePolicyHash,null);assert.equal(done.feeShares,undefined);assert.equal(g.sends,1);
  assert.equal((await createPumpLaunchService({...g.config,requireFeeSharing:true}).status({owner:g.owner,intentId:q.intentId})).status,'confirmed');
});
test('saved atomic policy or lookup snapshot corruption fails closed on restart',async t=>{
  for(const kind of ['shares','policyHash','lookup','permanent']){const f=fixture(t,{atomic:true});await f.prepare();const file=path.join(f.directory,'pump-mainnet-intents.json'),state=JSON.parse(fs.readFileSync(file)),row=state.intents[0];if(kind==='shares')row.feeShares[0].address=Keypair.generate().publicKey.toBase58();if(kind==='policyHash')row.feePolicyHash='0'.repeat(64);if(kind==='lookup')row.lookupTable.addresses.reverse();if(kind==='permanent')row.permanentShares=false;fs.writeFileSync(file,JSON.stringify(state));assert.throws(()=>createPumpLaunchService(f.config),{code:'LAUNCH_STORAGE_UNAVAILABLE'});assert.equal(f.sends,0);}
});
test('atomic launch supports the approved shared 70 percent treasury and 30 percent creator route',async t=>{
 const f=fixture(t,{atomic:true,sharedTreasury:true}),p=await f.prepare();assert.equal(p.feePolicy.platformMint,null);assert.equal(p.feeShares.length,2);assert.deepEqual(p.feeShares[0],{address:f.feeConfig.platformTreasury,shareBps:7000,role:'combined',allocationsBps:{platform:1000,compute:6000}});assert.deepEqual(p.feeShares[1],{address:f.owner,shareBps:3000,role:'creator'});assert.ok(Buffer.from(p.transactionBase64,'base64').length<=1232);
 const done=await f.service.submit({owner:f.owner,intentId:p.intentId,signedTransactionBase64:f.sign(p)});assert.equal(done.feeSharingVerified,true);assert.equal(done.status,'confirmed');const restored=createPumpLaunchService(f.config);assert.deepEqual((await restored.status({owner:f.owner,intentId:p.intentId})).feeShares,p.feeShares);assert.equal(f.sends,1);
});

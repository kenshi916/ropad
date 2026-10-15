'use strict';
// Offline fixtures use the installed official SDK's instruction and event coder.
// No mainnet calls, signing keys belonging to users, or transaction sends occur.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Keypair,PublicKey,SystemProgram,Transaction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram}=require('./parallax/node_modules/@solana/web3.js');
const {NATIVE_MINT,TOKEN_PROGRAM_ID}=require('./parallax/node_modules/@solana/spl-token');
const pump=require('./parallax/node_modules/@pump-fun/pump-sdk'),BN=require('./parallax/node_modules/bn.js'),bs58=require('./parallax/node_modules/bs58');
const {createSolanaFeeAccountingService,normalizeConfig,feeRecipients,FILE_NAME,GENESIS_HASH}=require('./parallax/solana-fee-accounting.cjs');
const EVENT_DISCRIMINATOR=Buffer.from(pump.pumpIdl.events.find(e=>e.name==='DistributeCreatorFeesEvent').discriminator);
async function fixture(t,{v2=true,legacy=false,total=1000000003n,...options}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-fees-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const payer=Keypair.generate(),mint=Keypair.generate().publicKey,platform=options.creatorTreasury==='platform'?payer.publicKey:Keypair.generate().publicKey,compute=options.sharedTreasury?platform:options.creatorTreasury==='compute'?payer.publicKey:Keypair.generate().publicKey,projectId=crypto.randomUUID(),owner=payer.publicKey.toBase58();
  // These proportions are arbitrary test inputs, never product defaults.
  const config={platformMint:Keypair.generate().publicKey.toBase58(),platformTreasury:platform.toBase58(),computeTreasury:compute.toBase58(),splitBps:options.splitBps||(options.creatorShare?{creator:5000,platform:3000,compute:2000}:{platform:3000,compute:7000}),projects:[{projectId,sourceMint:mint.toBase58()}]};
  const sharingConfigAddress=pump.feeSharingConfigPda(mint),vault=pump.creatorVaultPda(sharingConfigAddress),curve=pump.bondingCurvePda(mint);
  const individualShares=[{address:platform,shareBps:config.splitBps.platform},{address:compute,shareBps:config.splitBps.compute},...(options.creatorShare?[{address:payer.publicKey,shareBps:config.splitBps.creator}]:[])],uniqueShares=new Map();
  for(const share of individualShares){const address=share.address.toBase58();uniqueShares.set(address,{address:share.address,shareBps:(uniqueShares.get(address)?.shareBps||0)+share.shareBps});}
  const shareholders=[...uniqueShares.values()];
  const args={mint,sharingConfig:{shareholders},sharingConfigAddress};
  const ix=v2?await pump.PUMP_SDK.distributeCreatorFeesV2({...args,quoteMint:NATIVE_MINT,payer:payer.publicKey,shouldInitializeAta:false,quoteTokenProgram:TOKEN_PROGRAM_ID}):await pump.PUMP_SDK.distributeCreatorFees(args);
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ix],blockhash=Keypair.generate().publicKey.toBase58();let message,signature;
  if(legacy){const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:blockhash}).add(...instructions);tx.sign(payer);message=tx.compileMessage();signature=bs58.encode(tx.signature);}
  else {const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:blockhash,instructions}).compileToV0Message());tx.sign([payer]);message=tx.message;signature=bs58.encode(tx.signatures[0]);}
  const accountKeys=message.getAccountKeys(),keyIndex=key=>Array.from({length:accountKeys.length},(_,i)=>i).find(i=>accountKeys.get(i).equals(key));
  const asInner=(instruction,stackHeight=2)=>({programIdIndex:keyIndex(instruction.programId),accounts:instruction.keys.map(k=>keyIndex(k.pubkey)),data:bs58.encode(instruction.data),stackHeight});
  const payments=new Map(shareholders.map(share=>[share.address.toBase58(),total*BigInt(share.shareBps)/10000n]));
  payments.set(compute.toBase58(),payments.get(compute.toBase58())+total-[...payments.values()].reduce((sum,value)=>sum+value,0n));
  function encodedEvent(overrides={}) {return pump.PUMP_SDK.offlinePumpProgram.coder.types.encode('distributeCreatorFeesEvent',{timestamp:new BN(1800000000),mint,bondingCurve:curve,sharingConfig:sharingConfigAddress,admin:payer.publicKey,shareholders,distributed:new BN(total.toString()),quoteMint:PublicKey.default,...overrides});}
  const eventIx={programIdIndex:keyIndex(pump.PUMP_PROGRAM_ID),accounts:[keyIndex(pump.PUMP_EVENT_AUTHORITY_PDA)],data:bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),EVENT_DISCRIMINATOR,encodedEvent()])),stackHeight:2};
  const receipt={slot:300,transaction:{signatures:[signature],message},meta:{err:null,loadedAddresses:{writable:[],readonly:[]},innerInstructions:[{index:1,instructions:[...shareholders.map(share=>asInner(SystemProgram.transfer({fromPubkey:vault,toPubkey:share.address,lamports:payments.get(share.address.toBase58())}))),eventIx]}]}};
  let reads=0;
  const connection={getGenesisHash:async()=>{reads++;return options.genesis??GENESIS_HASH;},getSignatureStatuses:async()=>{reads++;return {value:[options.status===null?null:{confirmationStatus:options.confirmationStatus??'finalized',slot:options.statusSlot??300,err:options.statusError??null}]};},getTransaction:async(sig,settings)=>{reads++;assert.equal(sig,signature);assert.equal(settings.commitment,'finalized');assert.equal(settings.maxSupportedTransactionVersion,0);return receipt;}};
  const resolveProjectCreator=async(id,sourceMint)=>id===projectId&&sourceMint===mint.toBase58()?owner:null;
  const service=createSolanaFeeAccountingService({stateDirectory:directory,config,connection,resolveProjectCreator,now:()=>1800000000000});
  const input={owner,projectId,mint:mint.toBase58(),signature,instructionIndex:1};
  return {service,connection,config,directory,input,receipt,options,payments,mint,vault,platform,compute,shareholders,payer,eventIx,encodedEvent,keyIndex,resolveProjectCreator,get reads(){return reads;},reconcile:args=>service.reconcile({...input,...args}),setEvent:overrides=>{eventIx.data=bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),EVENT_DISCRIMINATOR,encodedEvent(overrides)]));}};
}

test('unconfigured fee service remains inactive with exact zero balances and no RPC calls',async t=>{
  const f=await fixture(t),inactive=createSolanaFeeAccountingService({stateDirectory:f.directory,connection:f.connection});
  assert.equal(inactive.config().status,'inactive');assert.equal(inactive.config().splitBps,null);
  const fees=inactive.summary({projectId:f.input.projectId});assert.equal(fees.receivedLamports,'0');assert.equal(fees.computeSol,'0');assert.equal(fees.providerCreditsUsd,0);
  await assert.rejects(inactive.reconcile(f.input),{code:'FEE_CONFIG_INACTIVE'});assert.equal(f.reads,0);
});

test('configuration requires explicit recipient addresses and shares without product defaults',async t=>{
  const f=await fixture(t);
  for(const config of [{}, {...f.config,splitBps:{platform:3000,compute:6000}}, {...f.config,platformMint:'invalid-mint'}, {...f.config,splitBps:{platform:0,compute:10000}}, {...f.config,projects:[...f.config.projects,...f.config.projects]}, {...f.config,autoClaim:true}])assert.throws(()=>createSolanaFeeAccountingService({stateDirectory:f.directory,config}),{code:'INVALID_FEE_CONFIG'});
  assert.equal(f.service.config().readOnly,true);assert.equal(f.service.config().onChainConfigurationVerified,false);assert.equal(f.service.config().providerCreditsUsd,0);
});

test('official v1 and v2 SOL distribution receipts verify exact inner lamports and persist once',async t=>{
  for(const options of [{v2:true},{v2:false},{v2:true,legacy:true}]){
    const f=await fixture(t,options),result=await f.reconcile();assert.equal(result.duplicate,false);assert.equal(result.receipt.receivedLamports,'1000000003');assert.equal(result.receipt.platformLamports,'300000000');assert.equal(result.receipt.computeLamports,'700000003');assert.equal(result.fees.receivedSol,'1.000000003');assert.equal(result.fees.computeSol,'0.700000003');assert.equal(result.fees.providerCreditsUsd,0);assert.equal(result.receipt.finalized,true);
    const reads=f.reads,again=await f.reconcile();assert.equal(again.duplicate,true);assert.equal(f.reads,reads);assert.equal(again.fees.receiptCount,1);
    const restored=createSolanaFeeAccountingService({stateDirectory:f.directory,config:f.config,connection:f.connection});assert.equal((await restored.reconcile(f.input)).duplicate,true);assert.equal(restored.summary({projectId:f.input.projectId}).receipts.length,0);assert.equal(restored.summary({projectId:f.input.projectId,owner:'other'}).receipts.length,0);assert.equal(restored.summary({projectId:f.input.projectId,owner:f.input.owner}).receipts.length,1);assert.equal(result.receipt.owner,undefined);
  }
});

test('a receipt is globally bound to one project and owner even with concurrent reconciliation',async t=>{
  const f=await fixture(t),[a,b]=await Promise.all([f.reconcile(),f.reconcile()]);assert.deepEqual([a.duplicate,b.duplicate].sort(),[false,true]);assert.equal(f.service.summary({projectId:f.input.projectId}).receiptCount,1);
  await assert.rejects(f.reconcile({projectId:crypto.randomUUID()}),{code:'FEE_RECEIPT_ALREADY_ATTRIBUTED'});await assert.rejects(f.reconcile({owner:Keypair.generate().publicKey.toBase58()}),{code:'FEE_RECEIPT_ALREADY_ATTRIBUTED'});
});

test('platform mint and arbitrary project tokens never receive implicit fee source authorization',async t=>{
  const f=await fixture(t),config={...f.config,platformMint:f.input.mint,projects:[]};
  const service=createSolanaFeeAccountingService({stateDirectory:f.directory,config,connection:f.connection});
  await assert.rejects(service.reconcile(f.input),{code:'FEE_SOURCE_UNCONFIGURED'});assert.equal(f.reads,0);assert.match(service.summary({projectId:f.input.projectId}).reason,/No operator-approved/);
});

test('wrong chain, unfinalized, failed and mismatched signatures or slots cannot credit fees',async t=>{
  for(const options of [{genesis:'devnet'},{status:null},{confirmationStatus:'confirmed'},{statusError:{InstructionError:[0,'failure']}},{statusSlot:301}]){const f=await fixture(t,options);await assert.rejects(f.reconcile());assert.equal(f.service.summary({projectId:f.input.projectId}).receivedLamports,'0');}
  for(const mutate of [f=>{f.receipt.meta.err={InstructionError:[1,'failure']};},f=>{f.receipt.transaction.signatures[0]=bs58.encode(crypto.randomBytes(64));}]){const f=await fixture(t);mutate(f);await assert.rejects(f.reconcile());}
});

test('unrelated transfers, missing events, wrong CPI authority and nested distributions are unsupported',async t=>{
  for(const mutate of [f=>{f.input.instructionIndex=0;},f=>{f.receipt.meta.innerInstructions=[];},f=>{f.receipt.meta.innerInstructions[0].instructions.pop();},f=>{f.eventIx.accounts=[f.keyIndex(f.platform)];},f=>{f.eventIx.stackHeight=3;},f=>{f.receipt.meta.innerInstructions[0].instructions[0].accounts[0]=f.keyIndex(f.payer.publicKey);},f=>{f.receipt.meta.innerInstructions[0].instructions.push({...f.eventIx});}]){
    const f=await fixture(t);mutate(f);await assert.rejects(f.reconcile(),{code:'FEE_RECEIPT_UNSUPPORTED'});assert.equal(f.service.summary({projectId:f.input.projectId}).receivedLamports,'0');
  }
});

test('historical event mint, quote asset, recipients and shares must match the trusted project config',async t=>{
  for(const kind of ['mint','quote','shares','recipient','source']){
    const f=await fixture(t);const overrides=kind==='mint'?{mint:Keypair.generate().publicKey}:kind==='quote'?{quoteMint:Keypair.generate().publicKey}:kind==='shares'?{shareholders:[{...f.shareholders[0],shareBps:3001},{...f.shareholders[1],shareBps:6999}]}:kind==='recipient'?{shareholders:[{...f.shareholders[0],address:f.payer.publicKey},f.shareholders[1]]}:{sharingConfig:Keypair.generate().publicKey};
    f.setEvent(overrides);await assert.rejects(f.reconcile(),{code:'FEE_RECEIPT_UNSUPPORTED'});
  }
});

test('event amount and exact transfers must agree and reject disproportionate or duplicate payouts',async t=>{
  for(const kind of ['sum','split','duplicate']){
    const f=await fixture(t),transfers=f.receipt.meta.innerInstructions[0].instructions;
    if(kind==='sum')f.setEvent({distributed:new BN('1000000004')});
    if(kind==='duplicate')transfers[1].accounts[1]=f.keyIndex(f.platform);
    if(kind==='split'){const first=bs58.decode(transfers[0].data),second=bs58.decode(transfers[1].data);first.writeBigUInt64LE(300000002n,4);second.writeBigUInt64LE(700000001n,4);transfers[0].data=bs58.encode(first);transfers[1].data=bs58.encode(second);}
    await assert.rejects(f.reconcile(),{code:'FEE_RECEIPT_UNSUPPORTED'});
  }
});

test('lamports above Number safe integer remain exact strings without floating point credits',async t=>{
  const total=90071992547409930n,f=await fixture(t,{total}),result=await f.reconcile();assert.equal(result.fees.receivedLamports,total.toString());assert.equal(result.fees.receivedSol,'90071992.54740993');assert.equal(BigInt(result.fees.platformLamports)+BigInt(result.fees.computeLamports),total);assert.equal(result.fees.providerCreditsUsd,0);
});

test('corrupt or externally changed accounting history is preserved before any new verification',async t=>{
  const f=await fixture(t);await f.reconcile();const file=path.join(f.directory,FILE_NAME),reads=f.reads;fs.writeFileSync(file,'corrupt receipts');
  await assert.rejects(f.reconcile(),{code:'FEE_STORAGE_UNAVAILABLE'});assert.equal(f.reads,reads);assert.equal(fs.readFileSync(file,'utf8'),'corrupt receipts');assert.throws(()=>createSolanaFeeAccountingService({stateDirectory:f.directory,config:f.config}),{code:'FEE_STORAGE_UNAVAILABLE'});
});

test('three-way receipts verify exact creator, platform and compute transfers and persist creator earnings',async t=>{
 for(const options of [{v2:true},{v2:false},{v2:true,legacy:true}]){const f=await fixture(t,{...options,creatorShare:true}),result=await f.reconcile();assert.equal(result.receipt.creatorWallet,f.input.owner);assert.equal(result.receipt.creatorLamports,'500000001');assert.equal(result.fees.creatorSol,'0.500000001');assert.equal(result.fees.platformSol,'0.3');assert.equal(result.fees.computeSol,'0.200000002');assert.equal(result.fees.providerCreditsUsd,0);const restored=createSolanaFeeAccountingService({stateDirectory:f.directory,config:f.config,connection:f.connection,resolveProjectCreator:f.resolveProjectCreator});assert.equal((await restored.reconcile(f.input)).duplicate,true);assert.equal(restored.summary({projectId:f.input.projectId}).creatorLamports,'500000001');}
});
test('creator fee receipts require a trusted owner and reject counterfeit third-recipient evidence',async t=>{
 const f=await fixture(t,{creatorShare:true}),unresolved=createSolanaFeeAccountingService({stateDirectory:f.directory,config:f.config,connection:f.connection});await assert.rejects(unresolved.reconcile({...f.input,creatorWallet:f.input.owner}),{code:'FEE_CREATOR_UNVERIFIED'});assert.equal(f.reads,0);
 for(const kind of ['wrong-wallet','missing-transfer','wrong-proportion']){const g=await fixture(t,{creatorShare:true});if(kind==='wrong-wallet')g.setEvent({shareholders:[...g.shareholders.slice(0,2),{address:Keypair.generate().publicKey,shareBps:5000}]});else if(kind==='missing-transfer')g.receipt.meta.innerInstructions[0].instructions.splice(2,1);else{const raw=bs58.decode(g.receipt.meta.innerInstructions[0].instructions[2].data);raw.writeBigUInt64LE(500000101n,4);g.receipt.meta.innerInstructions[0].instructions[2].data=bs58.encode(raw);}await assert.rejects(g.reconcile(),{code:'FEE_RECEIPT_UNSUPPORTED'});assert.equal(g.service.summary({projectId:g.input.projectId}).creatorLamports,'0');}
});
test('legacy receipts without creator or allocation fields remain readable after enabling future creator shares',async t=>{
 const f=await fixture(t);await f.reconcile();const file=path.join(f.directory,FILE_NAME),old=JSON.parse(fs.readFileSync(file));delete old.receipts[0].creatorWallet;delete old.receipts[0].creatorLamports;delete old.receipts[0].allocationMethod;delete old.receipts[0].onChainTransfers;fs.writeFileSync(file,JSON.stringify(old));const service=createSolanaFeeAccountingService({stateDirectory:f.directory,config:{...f.config,splitBps:{creator:5000,platform:3000,compute:2000}},connection:f.connection,resolveProjectCreator:f.resolveProjectCreator});assert.equal(service.summary({projectId:f.input.projectId}).creatorLamports,'0');assert.equal(service.summary({projectId:f.input.projectId}).receivedLamports,'1000000003');assert.equal((await service.reconcile(f.input)).duplicate,true);
});

test('platform token mint is optional and shared recipients merge without changing distinct historical policy shapes',async t=>{
 const f=await fixture(t,{creatorShare:true}),distinct=feeRecipients(f.config,f.input.owner);
 assert.deepEqual(distinct,[{address:f.config.platformTreasury,shareBps:3000,role:'platform'},{address:f.config.computeTreasury,shareBps:2000,role:'compute'},{address:f.input.owner,shareBps:5000,role:'creator'}]);
 for(const platformMint of [undefined,null,'']){const config=normalizeConfig({...f.config,platformMint,computeTreasury:f.config.platformTreasury,splitBps:{platform:1000,compute:6000,creator:3000}});assert.equal(config.platformMint,null);assert.deepEqual(feeRecipients(config,f.input.owner),[{address:f.config.platformTreasury,shareBps:7000,role:'combined',allocationsBps:{platform:1000,compute:6000}},{address:f.input.owner,shareBps:3000,role:'creator'}]);}
 assert.throws(()=>normalizeConfig({...f.config,platformMint:123}),{code:'INVALID_FEE_CONFIG'});
});

test('shared compute/platform transfers allocate once, expose actual payments and persist idempotently',async t=>{
 for(const v2 of [true,false]){const f=await fixture(t,{v2,sharedTreasury:true,creatorShare:true,splitBps:{platform:1000,compute:6000,creator:3000}}),result=await f.reconcile();
  assert.equal(result.receipt.allocationMethod,'proportional_internal_largest_remainder_v1');assert.deepEqual(result.receipt.onChainTransfers,[{address:f.config.platformTreasury,shareBps:7000,lamports:'700000003'},{address:f.input.owner,shareBps:3000,lamports:'300000000'}]);
  assert.equal(result.receipt.platformLamports,'100000000');assert.equal(result.receipt.computeLamports,'600000003');assert.equal(result.receipt.creatorLamports,'300000000');assert.equal(result.fees.receivedLamports,'1000000003');assert.equal(result.fees.includesInternalAllocations,true);assert.equal(result.fees.providerCreditsUsd,0);assert.match(result.fees.allocationMeaning,/internal allocations/);
  const reads=f.reads;assert.equal((await f.reconcile()).duplicate,true);assert.equal(f.reads,reads);
  const restored=createSolanaFeeAccountingService({stateDirectory:f.directory,config:f.config,connection:f.connection,resolveProjectCreator:f.resolveProjectCreator});assert.equal((await restored.reconcile(f.input)).duplicate,true);assert.equal(restored.summary({projectId:f.input.projectId}).receivedLamports,'1000000003');
 }
});

test('creator collisions produce one transfer per address and keep all role totals exact',async t=>{
 for(const options of [{creatorTreasury:'platform'},{creatorTreasury:'compute'},{creatorTreasury:'platform',sharedTreasury:true}]){
  const f=await fixture(t,{...options,creatorShare:true,splitBps:{platform:1000,compute:6000,creator:3000}}),recipients=feeRecipients(f.config,f.input.owner),r=(await f.reconcile()).receipt;
  assert.equal(recipients.length,options.sharedTreasury?1:2);assert.equal(recipients.reduce((sum,row)=>sum+row.shareBps,0),10000);assert.equal(r.onChainTransfers.length,recipients.length);assert.equal(r.creatorWallet,f.input.owner);assert.equal(BigInt(r.platformLamports)+BigInt(r.computeLamports)+BigInt(r.creatorLamports),1000000003n);assert.equal(r.onChainTransfers.reduce((sum,row)=>sum+BigInt(row.lamports),0n),1000000003n);
  if(options.sharedTreasury){assert.deepEqual(recipients,[{address:f.input.owner,shareBps:10000,role:'combined',allocationsBps:{platform:1000,compute:6000,creator:3000}}]);assert.deepEqual([r.platformLamports,r.computeLamports,r.creatorLamports],['100000000','600000002','300000001']);}
 }
});

test('shared wallet dust uses deterministic largest remainders and never duplicates lamports',async t=>{
 for(const [total,expected] of [[11n,['1','7','3']],[13n,['1','9','3']],[20n,['2','12','6']]]){
  const f=await fixture(t,{total,sharedTreasury:true,creatorShare:true,splitBps:{platform:1000,compute:6000,creator:3000}}),r=(await f.reconcile()).receipt;assert.deepEqual([r.platformLamports,r.computeLamports,r.creatorLamports],expected);assert.equal(expected.reduce((sum,value)=>sum+BigInt(value),0n),total);
 }
 const f=await fixture(t,{total:5n,sharedTreasury:true,splitBps:{platform:5000,compute:5000}}),r=(await f.reconcile()).receipt;assert.equal(r.platformLamports,'3');assert.equal(r.computeLamports,'2');
});

test('merged policy rejects duplicate on-chain payouts, changed shareholders and disproportionate transfers',async t=>{
 for(const kind of ['duplicate','split','event-share']){
  const f=await fixture(t,{sharedTreasury:true,creatorShare:true,splitBps:{platform:1000,compute:6000,creator:3000}}),transfers=f.receipt.meta.innerInstructions[0].instructions;
  if(kind==='duplicate')transfers[1].accounts[1]=f.keyIndex(f.platform);
  if(kind==='split'){const a=bs58.decode(transfers[0].data),b=bs58.decode(transfers[1].data);a.writeBigUInt64LE(700000103n,4);b.writeBigUInt64LE(299999900n,4);transfers[0].data=bs58.encode(a);transfers[1].data=bs58.encode(b);}
  if(kind==='event-share')f.setEvent({shareholders:[{...f.shareholders[0],shareBps:6000},{...f.shareholders[1],shareBps:4000}]});
  await assert.rejects(f.reconcile(),{code:'FEE_RECEIPT_UNSUPPORTED'});assert.equal(f.service.summary({projectId:f.input.projectId}).receivedLamports,'0');
 }
});

test('stored shared receipts reject missing, changed or doublecounted allocation evidence and preserve the file',async t=>{
 for(const kind of ['method','transfer','roles','legacy']){
  const f=await fixture(t,{sharedTreasury:true,creatorShare:true,splitBps:{platform:1000,compute:6000,creator:3000}});await f.reconcile();const file=path.join(f.directory,FILE_NAME),state=JSON.parse(fs.readFileSync(file,'utf8')),r=state.receipts[0];
  if(kind==='method')r.allocationMethod='direct_onchain_transfers';
  if(kind==='transfer')r.onChainTransfers[1].address=r.onChainTransfers[0].address;
  if(kind==='roles'){r.platformLamports='100000001';r.computeLamports='600000002';}
  if(kind==='legacy'){delete r.onChainTransfers;delete r.allocationMethod;}
  const bytes=JSON.stringify(state);fs.writeFileSync(file,bytes);assert.throws(()=>createSolanaFeeAccountingService({stateDirectory:f.directory,config:f.config}),{code:'FEE_STORAGE_UNAVAILABLE'});assert.equal(fs.readFileSync(file,'utf8'),bytes);
 }
});

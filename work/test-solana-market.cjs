'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Keypair,PublicKey,VersionedTransaction,SystemProgram}=require('./parallax/node_modules/@solana/web3.js');
const {MintLayout,AccountLayout,TOKEN_PROGRAM_ID,NATIVE_MINT}=require('./parallax/node_modules/@solana/spl-token');
const {BorshInstructionCoder}=require('./parallax/node_modules/@coral-xyz/anchor');
const pump=require('./parallax/node_modules/@pump-fun/pump-sdk'),BN=require('./parallax/node_modules/bn.js'),bs58=require('./parallax/node_modules/bs58');
const {createSolanaMarketService,units,GENESIS_HASH}=require('./parallax/solana-market.cjs');
const zero=PublicKey.default;
function mintBytes(){const b=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:0,mintAuthority:zero,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:zero},b);return b;}
function accountBytes(mint,owner,amount){const b=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:zero,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:zero},b);return b;}
function fixture(t,options={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-market-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const wallet=Keypair.generate(),mint=Keypair.generate().publicKey,creator=Keypair.generate().publicKey,feeRecipient=Keypair.generate().publicKey,curve=pump.bondingCurvePda(mint),owner=wallet.publicKey.toBase58();
 const global={buybackFeeRecipients:[feeRecipient],creatorFeeConfigurable:false,poolMigrationFee:new BN(15000000)};
 const feeConfig={feeTiers:[{marketCapLamportsThreshold:new BN(0),fees:{protocolFeeBps:new BN(95),creatorFeeBps:new BN(30),lpFeeBps:new BN(0)}}]};
 const bondingCurve={virtualTokenReserves:new BN('1073000000000000'),virtualQuoteReserves:new BN('30000000000'),realTokenReserves:new BN('793100000000000'),realQuoteReserves:new BN('30000000000'),tokenTotalSupply:new BN('1000000000000000'),creator,isMayhemMode:false,isCashbackCoin:false,quoteMint:zero,creatorFeeBps:new BN(0),complete:false,...options.curve};
 const sdk=Object.create(pump.PUMP_SDK);Object.assign(sdk,{decodeGlobal:()=>global,decodeFeeConfig:()=>feeConfig,decodeBondingCurve:()=>bondingCurve});
 const mintInfo={owner:TOKEN_PROGRAM_ID,data:mintBytes(),lamports:1000000,executable:false};let clock=1000,blockHeight=100,sendCount=0,sentTx=null,signature=null,simCount=0;
 const connection={
  getGenesisHash:async()=>options.genesis||GENESIS_HASH,
  getAccountInfoAndContext:async()=>({context:{slot:100},value:mintInfo}),
  getMultipleAccountsInfoAndContext:async keys=>keys.length>=8&&keys[0].equals(require('./parallax/node_modules/@pump-fun/pump-swap-sdk').GLOBAL_CONFIG_PDA)?{context:{slot:100},value:keys.map(()=>null)}:({context:{slot:100},value:[
   {owner:pump.PUMP_PROGRAM_ID,data:Buffer.from([1])},
   {owner:pump.PUMP_FEE_PROGRAM_ID,data:Buffer.from([2])},mintInfo,
   {owner:options.badCurveOwner?SystemProgram.programId:pump.PUMP_PROGRAM_ID,data:Buffer.from([3])},
   {owner:TOKEN_PROGRAM_ID,data:accountBytes(mint,curve,1000000000000000n)},
   {owner:SystemProgram.programId,executable:true},
   ...(keys.length>6?[{owner:SystemProgram.programId,lamports:options.solBalance??100000000000,executable:false},options.noTokenAccount?null:{owner:TOKEN_PROGRAM_ID,data:accountBytes(mint,wallet.publicKey,options.tokenBalance??100000000000000n)}]:[])
  ]}),
  getLatestBlockhash:async()=>({blockhash:options.blockhash||Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:150}),
  getFeeForMessage:async()=>({value:9000}),
  simulateTransaction:async(tx,config)=>{simCount++;assert.equal(config.sigVerify,false);assert.equal(config.replaceRecentBlockhash,false);assert.equal(tx.message.staticAccountKeys[0].toBase58(),owner);return {value:{err:options.simulationError??null,unitsConsumed:150000,accounts:[{lamports:99000000000}]}};},
  getBlockHeight:async()=>blockHeight,
  sendRawTransaction:async(bytes,config)=>{sendCount++;assert.equal(config.skipPreflight,false);assert.equal(config.maxRetries,0);const durable=JSON.parse(fs.readFileSync(path.join(directory,'solana-trade-intents.json'),'utf8'));assert.equal(durable.intents.at(-1).status,'pending');sentTx=VersionedTransaction.deserialize(bytes);signature=bs58.encode(sentTx.signatures[0]);assert.equal(durable.intents.at(-1).signature,signature);if(options.sendError)throw Error('uncertain transport');return signature;},
  getSignatureStatuses:async()=>({value:[options.finalized?{confirmationStatus:'finalized',slot:101,err:options.reverted?{InstructionError:[0,'Custom']}:null}:null]}),
  getTransaction:async()=>({slot:101,transaction:{signatures:[signature],message:options.wrongMessage?VersionedTransaction.deserialize(options.wrongMessage).message:sentTx.message},meta:{err:options.reverted?{InstructionError:[0,'Custom']}:null,fee:9000,preBalances:[100000000000],postBalances:[98999991000],preTokenBalances:[],postTokenBalances:[{mint:mint.toBase58(),owner,uiTokenAmount:{amount:'1000000'}}]}})
 };
 const service=createSolanaMarketService({stateDirectory:directory,connection,now:()=>clock,sdk});
 const prepare=(args={})=>service.prepare({owner,mint:mint.toBase58(),side:'buy',amount:'1',...args});
 const sign=q=>{const tx=VersionedTransaction.deserialize(Buffer.from(q.transactionBase64,'base64'));tx.sign([wallet]);return Buffer.from(tx.serialize()).toString('base64');};
 return {service,connection,sdk,options,prepare,sign,owner,wallet,mint,directory,advance:n=>clock+=n,expireBlock:()=>blockHeight=151,get sends(){return sendCount;},get simulations(){return simCount;}};
}

test('amount parsing rejects rounding, exponents, zero and u64 overflow',()=>{for(const value of ['0','01','-1','1e9','1.0000001','18446744073709551616'])assert.throws(()=>units(value,6));assert.equal(units('1.234567',6),1234567n);});

test('live market derives price and fees from a verified SOL curve and distinguishes completion',async t=>{
 const f=fixture(t),m=await f.service.market({mint:f.mint.toBase58()});assert.equal(m.available,true);assert.equal(m.cluster,'mainnet-beta');assert.equal(m.feePct,'1.25');assert.equal(m.supply,'1000000000');assert.match(m.priceSol,/^0\./);assert.equal(f.sends,0);
 f.options.curve={}; // Existing decoded state is intentionally immutable in this fixture
 const closed=fixture(t,{curve:{complete:true}});assert.equal((await closed.service.market({mint:closed.mint.toBase58()})).available,false);
});

test('buy uses the actual official SDK with exact SOL input and a bounded token minimum',async t=>{
 const f=fixture(t,{noTokenAccount:true}),q=await f.prepare();const tx=VersionedTransaction.deserialize(Buffer.from(q.transactionBase64,'base64'));
 assert.equal(q.transactionVersion,'v0');assert.equal(q.amountIn,'1');assert.equal(q.simulation,'passed');assert.equal(q.estimatedNetworkFeeLamports,'9000');assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.message.addressTableLookups.length,0);
 const ix=tx.message.compiledInstructions.find(i=>tx.message.staticAccountKeys[i.programIdIndex].equals(pump.PUMP_PROGRAM_ID));const decoded=new BorshInstructionCoder(pump.pumpIdl).decode(Buffer.from(ix.data));
 assert.equal(decoded.name,'buy_exact_quote_in_v3');assert.equal(decoded.data.spendable_quote_in.toString(),'1000000000');assert.equal(decoded.data.min_tokens_out.toString(),units(q.minimumOut,6).toString());
 assert.ok(tx.signatures[0].every(n=>n===0));assert.equal(f.sends,0);assert.equal(f.simulations,1);
});

test('sell encodes exact token units and net SOL minimum instead of spending SOL',async t=>{
 const f=fixture(t),q=await f.prepare({side:'sell',amount:'123.456789'}),tx=VersionedTransaction.deserialize(Buffer.from(q.transactionBase64,'base64'));
 const ix=tx.message.compiledInstructions.find(i=>tx.message.staticAccountKeys[i.programIdIndex].equals(pump.PUMP_PROGRAM_ID)),decoded=new BorshInstructionCoder(pump.pumpIdl).decode(Buffer.from(ix.data));
 assert.equal(decoded.name,'sell_v3');assert.equal(decoded.data.amount.toString(),'123456789');assert.equal(decoded.data.min_sol_output.toString(),units(q.minimumOut,9).toString());assert.equal(q.outputSymbol,'SOL');assert.equal(f.sends,0);
});

test('wrong chain, fake curve, unsupported modes, precision, balances and simulation fail before relay',async t=>{
 for(const options of [{genesis:'devnet'},{badCurveOwner:true},{curve:{complete:true}},{curve:{isMayhemMode:true}},{curve:{isCashbackCoin:true}},{curve:{quoteMint:Keypair.generate().publicKey}},{solBalance:1000000000},{simulationError:{InstructionError:[0,'Fixture']}}]){const f=fixture(t,options);await assert.rejects(f.prepare());assert.equal(f.sends,0);}
 const f=fixture(t,{tokenBalance:0n});await assert.rejects(f.prepare({side:'sell',amount:'1'}),/Insufficient/);await assert.rejects(f.prepare({slippageBps:501}),/Slippage/);await assert.rejects(f.prepare({amount:'0.0000000001'}),/precision/);
});

test('unsigned, tampered, wrong-owner and expired transactions cannot be relayed',async t=>{
 const f=fixture(t),q=await f.prepare();await assert.rejects(f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64:q.transactionBase64}),/signature/);
 const changed=VersionedTransaction.deserialize(Buffer.from(q.transactionBase64,'base64'));changed.message.recentBlockhash=Keypair.generate().publicKey.toBase58();changed.sign([f.wallet]);await assert.rejects(f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64:Buffer.from(changed.serialize()).toString('base64')}),/differs/);
 await assert.rejects(f.service.submit({owner:Keypair.generate().publicKey.toBase58(),intentId:q.intentId,signedTransactionBase64:f.sign(q)}),/unavailable/);
 f.advance(60001);await assert.rejects(f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64:f.sign(q)}),/expired/);assert.equal(f.sends,0);
 const block=fixture(t),bq=await block.prepare();block.expireBlock();await assert.rejects(block.service.submit({owner:block.owner,intentId:bq.intentId,signedTransactionBase64:block.sign(bq)}),/blockhash expired/);assert.equal(block.sends,0);
});

test('a signed absent transaction expires only after finalized blockhash and history checks, then survives restart',async t=>{
 const f=fixture(t,{sendError:true}),q=await f.prepare(),signedTransactionBase64=f.sign(q);
 const pending=await f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64});assert.equal(pending.status,'pending');assert.equal(f.sends,1);
 f.expireBlock();let validityChecks=0,receiptChecks=0;
 f.connection.getBlockHeight=async commitment=>{assert.equal(commitment,'finalized');return 151;};
 f.connection.isBlockhashValid=async(blockhash,config)=>{validityChecks++;assert.equal(blockhash,q.blockhash);assert.deepEqual(config,{commitment:'finalized',minContextSlot:q.quoteSlot});return {context:{slot:160},value:false};};
 f.connection.getSignatureStatuses=async(signatures,config)=>{assert.deepEqual(signatures,[pending.signature]);assert.equal(config.searchTransactionHistory,true);return {context:{slot:161},value:[null]};};
 f.connection.getTransaction=async(signature,config)=>{receiptChecks++;assert.equal(signature,pending.signature);assert.deepEqual(config,{commitment:'finalized',maxSupportedTransactionVersion:0});return null;};
 const expired=await f.service.status({owner:f.owner,intentId:q.intentId});assert.equal(expired.status,'expired');assert.equal(expired.expired,true);assert.equal(expired.expiryEvidence.finalizedBlockHeight,151);assert.equal(expired.expiryEvidence.signatureAbsentAtSlot,161);assert.equal(validityChecks,1);assert.equal(receiptChecks,1);
 const recovered=createSolanaMarketService({stateDirectory:f.directory,connection:f.connection,sdk:f.sdk}),again=await recovered.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64});assert.equal(again.status,'expired');assert.equal(again.signature,pending.signature);assert.equal(f.sends,1);
});

test('incomplete, stale, known, or unavailable expiry evidence preserves pending signed trades',async t=>{
 for(const scenario of ['height-valid','blockhash-valid','blockhash-stale','history-stale','history-missing','signature-known','receipt-exists','rpc-error'])await t.test(scenario,async t=>{
  const f=fixture(t),q=await f.prepare();await f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64:f.sign(q)});
  let searches=0;f.connection.getBlockHeight=async()=>scenario==='height-valid'?150:151;
  f.connection.isBlockhashValid=async()=>{if(scenario==='rpc-error')throw Error('offline');return {context:{slot:scenario==='blockhash-stale'?99:160},value:scenario==='blockhash-valid'};};
  f.connection.getSignatureStatuses=async()=>{searches++;return {context:scenario==='history-missing'?undefined:{slot:scenario==='history-stale'?159:161},value:[scenario==='signature-known'&&searches>1?{confirmationStatus:'confirmed'}:null]};};
  f.connection.getTransaction=async()=>scenario==='receipt-exists'?{slot:160}:null;
  assert.equal((await f.service.status({owner:f.owner,intentId:q.intentId})).status,'pending');assert.equal(f.sends,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'solana-trade-intents.json'))).intents[0].status,'pending');
 });
});

test('pending intent is durable before relay and a repeated submit cannot send twice',async t=>{
 const f=fixture(t),q=await f.prepare(),signed=f.sign(q),args={owner:f.owner,intentId:q.intentId,signedTransactionBase64:signed};const [first,second]=await Promise.all([f.service.submit(args),f.service.submit(args)]);assert.equal(first.status,'pending');assert.equal(second.status,'pending');assert.equal(f.sends,1);
 const recovered=createSolanaMarketService({stateDirectory:f.directory,connection:f.connection,now:()=>1000,sdk:f.sdk});assert.equal((await recovered.status({owner:f.owner,intentId:q.intentId})).status,'pending');assert.equal(f.sends,1);
});

test('identical trades in one block carry different wallet-signed intent memos',async t=>{
 const f=fixture(t,{blockhash:Keypair.generate().publicKey.toBase58()}),first=await f.prepare(),second=await f.prepare();
 const messages=[];
 for(const q of [first,second]){
  const tx=VersionedTransaction.deserialize(Buffer.from(q.transactionBase64,'base64'));
  const memo=tx.message.compiledInstructions.find(ix=>tx.message.staticAccountKeys[ix.programIdIndex].toBase58()==='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  assert.ok(memo);assert.equal(Buffer.from(memo.data).toString('utf8'),'Ropad trade '+q.intentId);assert.deepEqual([...memo.accountKeyIndexes],[0]);
  messages.push(Buffer.from(tx.message.serialize()).toString('base64'));assert.ok(tx.serialize().length<=1232);
 }
 assert.notEqual(first.intentId,second.intentId);assert.notEqual(messages[0],messages[1]);
 assert.notEqual(f.sign(first),f.sign(second));assert.equal(f.sends,0);
});

test('a recovered duplicate signature cannot be submitted under another intent',async t=>{
 const f=fixture(t),q=await f.prepare(),signed=f.sign(q),file=path.join(f.directory,'solana-trade-intents.json');
 const saved=JSON.parse(fs.readFileSync(file,'utf8')),copy={...saved.intents[0],intentId:crypto.randomUUID()};
 Object.assign(saved.intents[0],{status:'pending',signature:bs58.encode(VersionedTransaction.deserialize(Buffer.from(signed,'base64')).signatures[0])});
 saved.intents.push(copy);fs.writeFileSync(file,JSON.stringify(saved));
 const recovered=createSolanaMarketService({stateDirectory:f.directory,connection:f.connection,now:()=>1000,sdk:f.sdk});
 await assert.rejects(recovered.submit({owner:f.owner,intentId:copy.intentId,signedTransactionBase64:signed}),{code:'DUPLICATE_TRANSACTION'});
 assert.equal(f.sends,0);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).intents[1].status,'prepared');
});

test('uncertain network submission remains pending and is never blindly retried',async t=>{
 const f=fixture(t,{sendError:true}),q=await f.prepare(),args={owner:f.owner,intentId:q.intentId,signedTransactionBase64:f.sign(q)};const result=await f.service.submit(args);assert.equal(result.submissionUncertain,true);assert.equal(result.status,'pending');await f.service.submit(args);assert.equal(f.sends,1);
});

test('a failed durable pending write prevents broadcasting a signed wallet transaction',async t=>{
 const f=fixture(t),q=await f.prepare(),file=path.join(f.directory,'solana-trade-intents.json');fs.renameSync(file,file+'.preserved');fs.mkdirSync(file);
 await assert.rejects(f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64:f.sign(q)}),/could not be saved/);assert.equal(f.sends,0);
 assert.equal(JSON.parse(fs.readFileSync(file+'.preserved','utf8')).intents[0].status,'prepared');
});

test('trade history changed or removed after preview is preserved and prevents broadcast',async t=>{
 for(const damage of ['corrupt','valid-change','removed']){
  const f=fixture(t),q=await f.prepare(),file=path.join(f.directory,'solana-trade-intents.json');
  const altered=damage==='corrupt'?'damaged trade history':JSON.stringify({version:1,intents:[]});
  if(damage==='removed')fs.unlinkSync(file);else fs.writeFileSync(file,altered);
  await assert.rejects(f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64:f.sign(q)}),{code:'TRADE_STORAGE_UNAVAILABLE'});
  assert.equal(f.sends,0);
  if(damage==='removed')assert.equal(fs.existsSync(file),false);else assert.equal(fs.readFileSync(file,'utf8'),altered);
  await assert.rejects(f.prepare(),{code:'TRADE_STORAGE_UNAVAILABLE'});assert.equal(f.sends,0);
 }
});

test('only a finalized exact-message receipt confirms a trade and reports actual balance changes',async t=>{
 const f=fixture(t,{finalized:true}),q=await f.prepare();await f.service.submit({owner:f.owner,intentId:q.intentId,signedTransactionBase64:f.sign(q)});const result=await f.service.status({owner:f.owner,intentId:q.intentId});assert.equal(result.status,'confirmed');assert.equal(result.finalized,true);assert.equal(result.balanceChanges.tokens,'1');assert.equal(result.actualNetworkFeeLamports,'9000');
 const bad=fixture(t,{finalized:true}),bq=await bad.prepare();await bad.service.submit({owner:bad.owner,intentId:bq.intentId,signedTransactionBase64:bad.sign(bq)});bad.options.wrongMessage=(await bad.prepare({amount:'2'})).transactionBase64;await assert.rejects(bad.service.status({owner:bad.owner,intentId:bq.intentId}),/does not match/);
 const reverted=fixture(t,{finalized:true,reverted:true}),rq=await reverted.prepare();await reverted.service.submit({owner:reverted.owner,intentId:rq.intentId,signedTransactionBase64:reverted.sign(rq)});assert.equal((await reverted.service.status({owner:reverted.owner,intentId:rq.intentId})).status,'reverted');
});

test('corrupt durable trade history fails closed without sending or replacing it',t=>{const f=fixture(t),file=path.join(f.directory,'solana-trade-intents.json');fs.writeFileSync(file,'not json');assert.throws(()=>createSolanaMarketService({stateDirectory:f.directory,connection:f.connection}),/unreadable/);assert.equal(fs.readFileSync(file,'utf8'),'not json');assert.equal(f.sends,0);});

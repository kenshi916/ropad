'use strict';

// Official Pump SDK constructs every instruction locally. This service never
// holds wallet keys or signs; it only relays an exact, reviewed wallet signature.
// https://github.com/pump-fun/pump-public-docs
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Connection,PublicKey,VersionedTransaction,TransactionMessage,TransactionInstruction,ComputeBudgetProgram,SystemProgram}=require('@solana/web3.js');
const {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,NATIVE_MINT,unpackMint,unpackAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction}=require('@solana/spl-token');
const pump=require('@pump-fun/pump-sdk');
const BN=require('bn.js');
const RPC_URL='https://api.mainnet-beta.solana.com';
const GENESIS_HASH='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MEMO_PROGRAM_ID=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const TTL=60_000,MAX_INTENTS=1000,CU_LIMIT=400000,CU_PRICE=10000,MAX_U64=(1n<<64n)-1n;
const fail=(message,status=400,code='INVALID_TRADE')=>Object.assign(new Error(message),{status,code});
function key(value,signer=false){try{const k=new PublicKey(value);if(typeof value!=='string'||k.toBase58()!==value||signer&&!PublicKey.isOnCurve(k.toBytes()))throw Error();return k;}catch{throw fail(signer?'A valid Solana signing wallet is required':'A valid Solana mint is required');}}
function units(value,decimals){if(typeof value!=='string'||value.length>40||! /^(0|[1-9]\d*)(?:\.\d+)?$/.test(value))throw fail('Enter a positive decimal amount');const [whole,fraction='']=value.split('.');if(fraction.length>decimals)throw fail('Amount exceeds the asset decimal precision');const n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||0);if(n<=0n||n>MAX_U64)throw fail('Amount exceeds the supported token range');return n;}
function decimal(n,places){n=BigInt(n);const sign=n<0n?'-':'';if(n<0n)n=-n;const scale=10n**BigInt(places),fraction=(n%scale).toString().padStart(places,'0').replace(/0+$/,'');return sign+(n/scale).toString()+(fraction?'.'+fraction:'');}
function base58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),result='',alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(n){result=alphabet[Number(n%58n)]+result;n/=58n;}for(const byte of bytes){if(byte!==0)break;result='1'+result;}return result;}
function fromBase64(value){if(typeof value!=='string'||!value.length||value.length>1800||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw fail('Invalid transaction encoding');const bytes=Buffer.from(value,'base64');if(bytes.length>1232||bytes.toString('base64')!==value)throw fail('Invalid transaction encoding');return bytes;}
function decodeTransaction(value){try{return VersionedTransaction.deserialize(fromBase64(value));}catch(e){if(e.status)throw e;throw fail('Invalid Solana transaction');}}
function verifyTransactionSignature(tx,owner){
 if(tx.message.version!==0||tx.message.addressTableLookups.length||tx.message.header.numRequiredSignatures!==1||tx.signatures.length!==1||!tx.message.staticAccountKeys[0].equals(key(owner,true)))throw fail('The transaction signer differs from the reviewed wallet',422,'TRANSACTION_MISMATCH');
 const publicKey=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key(owner,true).toBuffer()]),format:'der',type:'spki'});
 if(!crypto.verify(null,Buffer.from(tx.message.serialize()),publicKey,tx.signatures[0]))throw fail('The wallet signature is invalid',422,'INVALID_SIGNATURE');
}
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function write(file,state){const temporary=file+'.'+crypto.randomUUID()+'.tmp',bytes=JSON.stringify(state);let fd;try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);return digest(bytes);}catch{throw fail('Trade history could not be saved — no new transaction was sent',503,'TRADE_STORAGE_UNAVAILABLE');}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}

function createSolanaMarketService({stateDirectory,connection,now=Date.now,sdk=pump.PUMP_SDK,ammSdk}={}){
 if(typeof stateDirectory!=='string'||!stateDirectory)throw fail('A private trade history directory is required',500);
 fs.mkdirSync(stateDirectory,{recursive:true,mode:0o700});const file=path.join(stateDirectory,'solana-trade-intents.json');let state={version:1,intents:[]},storageFault=false,diskDigest=null;
  if(fs.existsSync(file)){try{const bytes=fs.readFileSync(file);diskDigest=digest(bytes);state=JSON.parse(bytes.toString('utf8'));if(state.version!==1||!Array.isArray(state.intents)||state.intents.length>MAX_INTENTS)throw Error();const ids=new Set();for(const item of state.intents){if(!/^[a-f0-9-]{36}$/.test(item.intentId)||ids.has(item.intentId)||item.cluster!=='mainnet-beta'||!['prepared','pending','confirmed','reverted','expired'].includes(item.status)||!Number.isSafeInteger(item.lastValidBlockHeight)||!Number.isFinite(item.expiresAt))throw Error();ids.add(item.intentId);key(item.owner,true);key(item.mint);const tx=decodeTransaction(item.transactionBase64);if(tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==item.owner||Buffer.from(tx.message.serialize()).toString('base64')!==item.messageBase64)throw Error();if(item.status!=='prepared'&&!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(item.signature))throw Error();if(item.status==='expired'&&(!Number.isSafeInteger(item.expiryEvidence?.finalizedBlockHeight)||item.expiryEvidence.finalizedBlockHeight<=item.lastValidBlockHeight||item.expiryEvidence.blockhashValid!==false||!Number.isSafeInteger(item.expiryEvidence.blockhashSlot)||item.expiryEvidence.blockhashSlot<item.quoteSlot||!Number.isSafeInteger(item.expiryEvidence.signatureAbsentAtSlot)||item.expiryEvidence.signatureAbsentAtSlot<item.expiryEvidence.blockhashSlot))throw Error();}}catch{throw fail('Saved Solana trade history is unreadable; trades are paused',503,'TRADE_STORAGE_UNAVAILABLE');}}
 const rpc=connection||new Connection(RPC_URL,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})});
 const poolAdapter=require('./solana-pumpswap.cjs').createPumpSwapAdapter({connection:rpc,sdk:ammSdk});
 const save=()=>{
  if(storageFault)throw fail('Trade history is unavailable; trades are paused',503,'TRADE_STORAGE_UNAVAILABLE');
  try{
   // Never overwrite damage or a different process's history using stale memory.
   const currentDigest=fs.existsSync(file)?digest(fs.readFileSync(file)):null;
   if(currentDigest!==diskDigest)throw fail('Trade history changed on disk; trades are paused',503,'TRADE_STORAGE_UNAVAILABLE');
   diskDigest=write(file,state);
  }catch(e){storageFault=true;throw e.status?e:fail('Trade history could not be saved — no new transaction was sent',503,'TRADE_STORAGE_UNAVAILABLE');}
 };
 const view=item=>{const {messageBase64,...publicItem}=item;return structuredClone(publicItem);};
 const own=({owner,intentId})=>{key(owner,true);const item=state.intents.find(x=>x.intentId===intentId);if(!item||item.owner!==owner)throw fail('This trade preview is unavailable for this wallet',404,'TRADE_NOT_FOUND');return item;};
 async function mainnet(){if(await rpc.getGenesisHash()!==GENESIS_HASH)throw fail('The RPC is not Solana mainnet; no transaction was sent',503,'WRONG_CLUSTER');}
 async function readState(mintText,ownerText){
  await mainnet();const mint=key(mintText),owner=ownerText?key(ownerText,true):null;
  const first=await rpc.getAccountInfoAndContext(mint,{commitment:'confirmed'}),mintAccount=first.value;
  if(!mintAccount||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(mintAccount.owner)))throw fail('This mint has no supported Solana token account',404);
  const tokenProgram=mintAccount.owner,curve=pump.bondingCurvePda(mint),curveAta=getAssociatedTokenAddressSync(mint,curve,true,tokenProgram),userAta=owner?getAssociatedTokenAddressSync(mint,owner,false,tokenProgram):null;
  const addresses=[pump.GLOBAL_PDA,pump.PUMP_FEE_CONFIG_PDA,mint,curve,curveAta,pump.PUMP_PROGRAM_ID,...(owner?[owner,userAta]:[])];
  const snapshot=await rpc.getMultipleAccountsInfoAndContext(addresses,{commitment:'confirmed',minContextSlot:first.context.slot});const [globalInfo,feeInfo,currentMint,curveInfo,curveTokens,programInfo,ownerInfo,userInfo]=snapshot.value;
  if(!globalInfo?.owner.equals(pump.PUMP_PROGRAM_ID)||!feeInfo?.owner.equals(pump.PUMP_FEE_PROGRAM_ID)||!curveInfo?.owner.equals(pump.PUMP_PROGRAM_ID)||!programInfo?.executable||!currentMint?.owner.equals(tokenProgram))throw fail('This mint is not a verified Pump bonding curve',422,'UNVERIFIED_CURVE');
  let global,feeConfig,bondingCurve,mintInfo,curveTokenInfo,userTokenInfo;
  try{global=sdk.decodeGlobal(globalInfo);feeConfig=sdk.decodeFeeConfig(feeInfo);bondingCurve=sdk.decodeBondingCurve(curveInfo);mintInfo=unpackMint(mint,currentMint,tokenProgram);if(!bondingCurve.complete)curveTokenInfo=unpackAccount(curveAta,curveTokens,tokenProgram);if(userInfo)userTokenInfo=unpackAccount(userAta,userInfo,tokenProgram);}catch{throw fail('The on-chain token or curve data could not be decoded',422,'INVALID_CURVE_DATA');}
  if(!mintInfo.isInitialized||mintInfo.decimals!==6||mintInfo.freezeAuthority!==null||mintInfo.supply<=0n||(!bondingCurve.complete&&mintInfo.supply!==BigInt(bondingCurve.tokenTotalSupply.toString()))||curveTokenInfo&&(!curveTokenInfo.mint.equals(mint)||!curveTokenInfo.owner.equals(curve)||curveTokenInfo.isFrozen)||!pump.normalizeQuoteMint(bondingCurve.quoteMint).equals(NATIVE_MINT))throw fail('Only standard SOL-paired Pump tokens are supported here',422,'UNSUPPORTED_CURVE');
  if(userTokenInfo&&(!userTokenInfo.mint.equals(mint)||!userTokenInfo.owner.equals(owner)||userTokenInfo.isFrozen))throw fail('The wallet token account is not usable',422);
  if(owner&&(!ownerInfo||!ownerInfo.owner.equals(SystemProgram.programId)||ownerInfo.executable||!Number.isSafeInteger(ownerInfo.lamports)))throw fail('This wallet needs a funded Solana system account',400,'INSUFFICIENT_BALANCE');
  const unsupported=bondingCurve.isMayhemMode||bondingCurve.isCashbackCoin;
  if(bondingCurve.complete){const amm=await poolAdapter.read({mint,owner,tokenProgram,minContextSlot:snapshot.context.slot});return {mint,owner,tokenProgram,curve,userAta,global,feeConfig,bondingCurve,mintInfo:amm.mintInfo??mintInfo,userTokenInfo:amm.userBaseInfo,ownerInfo:amm.ownerInfo??ownerInfo,userInfo:amm.swapState?.userBaseAccountInfo,slot:amm.slot,feeBps:amm.feeBps??0n,unsupported,amm};}
  const fees=pump.computeFeesBps({global,feeConfig,mintSupply:new BN(mintInfo.supply.toString()),virtualQuoteReserves:bondingCurve.virtualQuoteReserves,virtualTokenReserves:bondingCurve.virtualTokenReserves,quoteMint:bondingCurve.quoteMint,creatorFeeBps:bondingCurve.creatorFeeBps});
  const feeBps=BigInt(fees.protocolFeeBps.toString())+BigInt(fees.creatorFeeBps.toString());
  if(feeBps<0n||feeBps>=10000n||!bondingCurve.virtualTokenReserves.gtn(0)||!bondingCurve.virtualQuoteReserves.gtn(0))throw fail('Current curve reserves or fees are invalid',503);
  return {mint,owner,tokenProgram,curve,userAta,global,feeConfig,bondingCurve,mintInfo,curveTokenInfo,userTokenInfo,ownerInfo,userInfo,slot:snapshot.context.slot,feeBps,unsupported};
 }
 async function market({mint}){
  const s=await readState(mint);
  if(s.amm){const p=s.amm;return {cluster:'mainnet-beta',mint,curve:s.curve.toBase58(),pool:p.poolKey.toBase58(),venue:'PumpSwap',available:p.available&&!s.unsupported,complete:true,reason:p.reason,priceSol:p.pricedQuote?decimal(p.pricedQuote*1000000n*1000000000n/p.baseReserve,18):null,marketCapSol:p.pricedQuote?decimal(p.pricedQuote*s.mintInfo.supply/p.baseReserve,9):null,supply:decimal(s.mintInfo.supply,s.mintInfo.decimals),decimals:s.mintInfo.decimals,realTokenReserves:p.baseReserve?.toString()??'0',feePct:p.feeBps===undefined?null:decimal(p.feeBps,2),slot:p.slot,checkedAt:now(),externalUrl:'https://pump.fun/coin/'+mint};}
  const q=BigInt(s.bondingCurve.virtualQuoteReserves.toString()),t=BigInt(s.bondingCurve.virtualTokenReserves.toString());
  return {cluster:'mainnet-beta',mint,curve:s.curve.toBase58(),venue:'Pump bonding curve',available:!s.bondingCurve.complete&&!s.unsupported,complete:!!s.bondingCurve.complete,reason:s.bondingCurve.complete?'Bonding curve completed; migration or PumpSwap trading is handled on Pump':s.unsupported?'This curve mode is not supported in the embedded trader':null,priceSol:decimal(q*1000000n*1000000000n/t,18),marketCapSol:decimal(q*s.mintInfo.supply/t,9),supply:decimal(s.mintInfo.supply,s.mintInfo.decimals),decimals:s.mintInfo.decimals,realTokenReserves:s.bondingCurve.realTokenReserves.toString(),feePct:decimal(s.feeBps,2),slot:s.slot,checkedAt:now(),externalUrl:'https://pump.fun/coin/'+mint};
 }
 async function prepare({owner,mint,side,amount,slippageBps=100}){
  if(storageFault)save();if(!['buy','sell'].includes(side))throw fail('Choose buy or sell');if(!Number.isInteger(slippageBps)||slippageBps<10||slippageBps>500)throw fail('Slippage must be between 0.1% and 5%');
  const s=await readState(mint,owner);if(s.unsupported||s.amm&&!s.amm.available)throw fail(s.amm?.reason||'This curve cannot be traded here; open its verified Pump page',409,'CURVE_UNAVAILABLE');
  const input=units(amount,side==='buy'?9:s.mintInfo.decimals);
  if(side==='buy'&&BigInt(s.ownerInfo.lamports)<=input||side==='sell'&&(!s.userTokenInfo||s.userTokenInfo.amount<input))throw fail('Insufficient '+(side==='buy'?'SOL':'token')+' balance',400,'INSUFFICIENT_BALANCE');
  const quoteArgs=s.amm?null:{global:s.global,feeConfig:s.feeConfig,mintSupply:new BN(s.mintInfo.supply.toString()),bondingCurve:s.bondingCurve,amount:new BN(input.toString()),curveBaseTokenBalance:new BN(s.curveTokenInfo.amount.toString())};
  const quoted=s.amm?poolAdapter.quote(s.amm,side,input):side==='buy'?pump.getBuyV3TokenAmountFromQuoteAmount(quoteArgs):pump.getSellSolAmountFromTokenAmount(quoteArgs),output=BigInt(quoted.toString()),minimum=output*BigInt(10000-slippageBps)/10000n;
  if(output<=0n||output>MAX_U64||minimum<=0n)throw fail('The amount is too small or exceeds curve capacity');
  const recipient=s.global.buybackFeeRecipients?.find(k=>!k.equals(PublicKey.default));if(!s.amm&&!recipient)throw fail('The Pump fee configuration is unavailable',503);
  const args={user:s.owner,mint:s.mint,tokenProgram:s.tokenProgram,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,buybackFeeRecipient:recipient};
  const tradeInstruction=s.amm?null:side==='buy'?await sdk.getBuyExactQuoteInV3InstructionRaw({...args,spendableQuoteIn:new BN(input.toString()),minTokensOut:new BN(minimum.toString()),partialFill:false}):await sdk.getSellV3InstructionRaw({...args,amount:new BN(input.toString()),quoteAmount:new BN(minimum.toString())});
  if(tradeInstruction&&(!tradeInstruction.programId.equals(pump.PUMP_PROGRAM_ID)||tradeInstruction.keys.some(k=>k.isSigner&&!k.pubkey.equals(s.owner))))throw fail('The SDK produced an unexpected trade instruction',503);
  const intentId=crypto.randomUUID();
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:CU_LIMIT}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:CU_PRICE})];
  if(s.amm)instructions.push(...await poolAdapter.instructions(s.amm,side,input,minimum));
  else {if(side==='buy'&&!s.userInfo)instructions.push(createAssociatedTokenAccountIdempotentInstruction(s.owner,s.userAta,s.owner,s.mint,s.tokenProgram));instructions.push(tradeInstruction);}
  // Bind the reviewed message to one intent, even for equal trades in one block.
  instructions.push(new TransactionInstruction({programId:MEMO_PROGRAM_ID,keys:[{pubkey:s.owner,isSigner:true,isWritable:false}],data:Buffer.from('Ropad trade '+intentId,'utf8')}));
  const latest=await rpc.getLatestBlockhash('confirmed');const tx=new VersionedTransaction(new TransactionMessage({payerKey:s.owner,recentBlockhash:latest.blockhash,instructions}).compileToV0Message());const raw=Buffer.from(tx.serialize());if(raw.length>1232||tx.message.header.numRequiredSignatures!==1)throw fail('The reviewed trade does not fit one wallet transaction',503);
  const [fee,simulation]=await Promise.all([rpc.getFeeForMessage(tx.message,'confirmed'),rpc.simulateTransaction(tx,{commitment:'confirmed',sigVerify:false,replaceRecentBlockhash:false,minContextSlot:s.slot,accounts:{encoding:'base64',addresses:[owner]}})]);
  if(!Number.isSafeInteger(fee.value)||fee.value<=0||fee.value>250000)throw fail('A bounded network fee could not be estimated',503);
  if(BigInt(s.ownerInfo.lamports)<(side==='buy'?input:0n)+BigInt(fee.value))throw fail('Insufficient SOL for the trade and network fee',400,'INSUFFICIENT_BALANCE');
  if(simulation.value.err!==null||!Number.isSafeInteger(simulation.value.accounts?.[0]?.lamports)||simulation.value.accounts[0].lamports<0||simulation.value.unitsConsumed>CU_LIMIT)throw fail('Trade simulation failed; balances or curve conditions may have changed',422,'SIMULATION_FAILED');
  const createdAt=now(),intent={intentId,status:'prepared',cluster:'mainnet-beta',mint,owner,side,transactionBase64:raw.toString('base64'),transactionVersion:'v0',messageBase64:Buffer.from(tx.message.serialize()).toString('base64'),createdAt,expiresAt:createdAt+TTL,lastValidBlockHeight:latest.lastValidBlockHeight,blockhash:latest.blockhash,quoteSlot:s.slot,amountIn:decimal(input,side==='buy'?9:s.mintInfo.decimals),expectedOut:decimal(output,side==='buy'?s.mintInfo.decimals:9),minimumOut:decimal(minimum,side==='buy'?s.mintInfo.decimals:9),inputSymbol:side==='buy'?'SOL':'TOKEN',outputSymbol:side==='buy'?'TOKEN':'SOL',slippageBps,feePct:decimal(s.feeBps,2),estimatedNetworkFeeLamports:String(fee.value),simulation:'passed',realFunds:true,tokenDecimals:s.mintInfo.decimals,curve:s.curve.toBase58()};
  intent.estimatedWalletSolChangeLamports=(BigInt(simulation.value.accounts[0].lamports)-BigInt(s.ownerInfo.lamports)).toString();
  intent.venue=s.amm?'PumpSwap':'Pump bonding curve';intent.pool=s.amm?.poolKey.toBase58()??null;intent.unwrapExistingWsol=s.amm?.userQuoteInfo?.amount>0n;
  intent.accountRentMayApply=!!s.amm||side==='buy'&&!s.userInfo;
  state.intents=state.intents.filter(x=>x.status==='pending'||now()-x.createdAt<7*24*3600000);if(state.intents.length>=MAX_INTENTS)throw fail('Trade preview history is full',429);state.intents.push(intent);save();return view(intent);
 }
 async function submit({owner,intentId,signedTransactionBase64}){
  const intent=own({owner,intentId});if(intent.status!=='prepared')return status({owner,intentId});
  if(now()>intent.expiresAt)throw fail('This trade preview expired; request a fresh quote',409,'QUOTE_EXPIRED');
  const tx=decodeTransaction(signedTransactionBase64);if(Buffer.from(tx.message.serialize()).toString('base64')!==intent.messageBase64)throw fail('The signed transaction differs from the reviewed trade',422,'TRANSACTION_MISMATCH');verifyTransactionSignature(tx,owner);
  await mainnet();if(await rpc.getBlockHeight('confirmed')>intent.lastValidBlockHeight)throw fail('The transaction blockhash expired; request a fresh quote',409,'QUOTE_EXPIRED');
  // Check after asynchronous reads as a concurrent submission may have claimed it.
  if(intent.status!=='prepared')return status({owner,intentId});
  if(now()>intent.expiresAt)throw fail('This trade preview expired; request a fresh quote',409,'QUOTE_EXPIRED');
  const signature=base58(tx.signatures[0]);
  if(state.intents.some(item=>item.intentId!==intentId&&item.signature===signature))throw fail('This signed transaction already belongs to another trade preview',409,'DUPLICATE_TRANSACTION');
  Object.assign(intent,{status:'pending',signature,submittedAt:now()});save();
  try{const returned=await rpc.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed',minContextSlot:intent.quoteSlot});if(returned!==signature)throw Error();}catch{intent.submissionUncertain=true;save();return {...view(intent),message:'Submission outcome is pending; check this transaction before starting another trade'};}
  return view(intent);
 }
  async function absentExpiry(intent){
   let evidence;
   try{
    const finalizedBlockHeight=await rpc.getBlockHeight('finalized');
    if(!Number.isSafeInteger(finalizedBlockHeight)||finalizedBlockHeight<=intent.lastValidBlockHeight)return view(intent);
    const blockhash=await rpc.isBlockhashValid(intent.blockhash,{commitment:'finalized',minContextSlot:intent.quoteSlot});
    if(blockhash?.value!==false||!Number.isSafeInteger(blockhash.context?.slot)||blockhash.context.slot<intent.quoteSlot)return view(intent);
    // Recheck history after finalized expiry. A stale/missing context, any known
    // signature, or any receipt leaves the signed trade pending for recovery.
    const searched=await rpc.getSignatureStatuses([intent.signature],{searchTransactionHistory:true});
    if(!Array.isArray(searched?.value)||searched.value.length!==1||searched.value[0]!==null||!Number.isSafeInteger(searched.context?.slot)||searched.context.slot<blockhash.context.slot)return view(intent);
    const receipt=await rpc.getTransaction(intent.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    if(receipt!==null)return view(intent);
    evidence={finalizedBlockHeight,blockhashValid:false,blockhashSlot:blockhash.context.slot,signatureAbsentAtSlot:searched.context.slot,checkedAt:now()};
   }catch{return {...view(intent),message:'Expiry could not be verified; this signed transaction remains pending for recovery'};}
   if(intent.status==='pending'){Object.assign(intent,{status:'expired',expired:true,expiredAt:now(),expiryEvidence:evidence});save();}
   return view(intent);
  }
  async function status({owner,intentId}){
   const intent=own({owner,intentId});if(intent.status==='prepared')return {...view(intent),expired:now()>intent.expiresAt};if(['confirmed','reverted','expired'].includes(intent.status))return view(intent);
   await mainnet();const result=await rpc.getSignatureStatuses([intent.signature],{searchTransactionHistory:true}),found=result.value?.[0];if(found===null)return absentExpiry(intent);if(!found||found.confirmationStatus!=='finalized')return view(intent);
  const transaction=await rpc.getTransaction(intent.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  if(!transaction||transaction.transaction.signatures[0]!==intent.signature||Buffer.from(transaction.transaction.message.serialize()).toString('base64')!==intent.messageBase64||transaction.slot<intent.quoteSlot||transaction.slot!==found.slot||!transaction.meta||JSON.stringify(transaction.meta.err)!==JSON.stringify(found.err))throw fail('The finalized transaction does not match this trade; inspect it before retrying',422,'RECEIPT_MISMATCH');
  const balanceChanges={};const meta=transaction.meta;
  if(Number.isSafeInteger(meta.preBalances?.[0])&&Number.isSafeInteger(meta.postBalances?.[0]))balanceChanges.solLamports=(BigInt(meta.postBalances[0])-BigInt(meta.preBalances[0])).toString();
  const tokenBalance=rows=>(rows||[]).filter(r=>r.mint===intent.mint&&r.owner===owner).reduce((sum,r)=>sum+BigInt(r.uiTokenAmount.amount),0n);
  balanceChanges.tokens=decimal(tokenBalance(meta.postTokenBalances)-tokenBalance(meta.preTokenBalances),intent.tokenDecimals);
  Object.assign(intent,{status:meta.err?'reverted':'confirmed',finalized:true,finalizedAt:now(),slot:transaction.slot,balanceChanges,actualNetworkFeeLamports:String(meta.fee),explorerUrl:'https://solscan.io/tx/'+intent.signature});save();return view(intent);
 }
 return {market,prepare,submit,status};
}
module.exports={createSolanaMarketService,units,decimal,verifyTransactionSignature,RPC_URL,GENESIS_HASH,TTL};

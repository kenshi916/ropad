'use strict';
// Official Pump SDK instructions, exact wallet signatures and finalized receipt
// verification. No platform private key, implicit recipient or automatic claim.
const crypto=require('node:crypto');
const {Connection,PublicKey,VersionedTransaction,TransactionMessage,TransactionInstruction,ComputeBudgetProgram}=require('@solana/web3.js');
const {NATIVE_MINT,TOKEN_PROGRAM_ID}=require('@solana/spl-token');
const pump=require('@pump-fun/pump-sdk'),{PUMP_AMM_SDK}=require('@pump-fun/pump-swap-sdk');
const {normalizeConfig,feeRecipients,GENESIS_HASH,RPC_URL}=require('./solana-fee-accounting.cjs');
const {verifyTransactionSignature}=require('./solana-market.cjs');
const {createFundingStore,hash}=require('./funding-store.cjs');
const FILE_NAME='solana-fee-sharing.json',TTL=90000,MAX_INTENTS=5000,CU_LIMIT=600000;
const MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const fail=(message,status=400,code='FEE_SHARING_INVALID')=>Object.assign(new Error(message),{status,code});
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
function key(value,signer=false){try{const k=new PublicKey(value);if(typeof value!=='string'||k.toBase58()!==value||signer&&!PublicKey.isOnCurve(k.toBytes()))throw Error();return k;}catch{throw fail('A canonical Solana '+(signer?'wallet':'public key')+' is required');}}
function decode(value){try{if(typeof value!=='string'||value.length>1800||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error();const bytes=Buffer.from(value,'base64');if(bytes.length>1232||bytes.toString('base64')!==value)throw Error();return VersionedTransaction.deserialize(bytes);}catch{throw fail('Invalid fee transaction encoding');}}
function base58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='',alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b)break;s='1'+s;}return s;}
function validate(s){if(s?.version!==1||!Array.isArray(s.intents)||s.intents.length>MAX_INTENTS)throw Error();const ids=new Set();for(const r of s.intents){
  if(!uuid(r.intentId)||ids.has(r.intentId)||!uuid(r.projectId)||!['configure','distribute'].includes(r.action)||!['prepared','pending','confirmed','reverted','expired'].includes(r.status)||r.cluster!=='mainnet-beta'||!Number.isFinite(r.createdAt)||!Number.isFinite(r.expiresAt)||!Number.isSafeInteger(r.quoteSlot)||!Number.isSafeInteger(r.lastValidBlockHeight)||!/^[a-f0-9]{64}$/.test(r.configHash))throw Error();
  key(r.owner,true);key(r.mint);const tx=decode(r.transactionBase64);if(tx.message.version!==0||tx.message.addressTableLookups.length||tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==r.owner||Buffer.from(tx.message.serialize()).toString('base64')!==r.messageBase64)throw Error();
  if(r.status!=='prepared'){const signed=decode(r.signedTransactionBase64);verifyTransactionSignature(signed,r.owner);if(Buffer.from(signed.message.serialize()).toString('base64')!==r.messageBase64||base58(signed.signatures[0])!==r.signature)throw Error();}
  if(['confirmed','reverted'].includes(r.status)&&(!Number.isSafeInteger(r.slot)||r.slot<r.quoteSlot||r.finalized!==true||!Number.isFinite(r.finalizedAt)))throw Error();
  if(r.status==='confirmed'&&r.onChainConfigurationVerified!==true)throw Error();
  if(r.status==='expired'&&(!Number.isSafeInteger(r.expiryEvidence?.height)||r.expiryEvidence.height<=r.lastValidBlockHeight||!Number.isSafeInteger(r.expiryEvidence.blockhashSlot)||r.expiryEvidence.blockhashSlot<r.quoteSlot||!Number.isSafeInteger(r.expiryEvidence.absentAtSlot)||r.expiryEvidence.absentAtSlot<r.expiryEvidence.blockhashSlot))throw Error();
  ids.add(r.intentId);
}}
function createSolanaFeeSharingService({stateDirectory,config=null,connection,now=Date.now,sdk=pump.PUMP_SDK,ammSdk=PUMP_AMM_SDK,resolveProjectMint,resolveProjectCreator}={}){
  const operator=normalizeConfig(config),configHash=operator?hash(JSON.stringify(operator)):null,store=createFundingStore({directory:stateDirectory,name:FILE_NAME,initial:{version:1,intents:[]},validate});
  const rpc=connection||new Connection(RPC_URL,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})});
  const configView=()=>({status:operator?'configured':'inactive',cluster:'mainnet-beta',platformMint:operator?.platformMint??null,platformTreasury:operator?.platformTreasury??null,computeTreasury:operator?.computeTreasury??null,splitBps:operator?.splitBps??null,creatorShareBps:operator?.splitBps.creator??0,creatorRecipientSource:'verified_project_owner',onChainConfigurationVerified:false,requiresWalletSignature:true,permanentShares:true,automaticProviderFunding:false,reason:operator?'Each coin needs its own creator-signed on-chain fee configuration':'Explicit platform mint, treasury wallets and fee split are required'});
  const view=r=>{const {messageBase64,signedTransactionBase64,configHash,...safe}=r;return structuredClone(safe);};
  const own=({owner,intentId})=>{key(owner,true);const row=store.read().intents.find(r=>r.intentId===intentId&&r.owner===owner);if(!row)throw fail('Fee transaction not found for this wallet',404,'FEE_INTENT_NOT_FOUND');return row;};
  function update(intentId,fields){const s=store.read(),r=s.intents.find(r=>r.intentId===intentId);if(!r)throw fail('Fee transaction not found',404);Object.assign(r,fields);store.write(s);return r;}
  async function mainnet(){if(await rpc.getGenesisHash()!==GENESIS_HASH)throw fail('Fee sharing requires verified Solana mainnet',503,'WRONG_CLUSTER');}
  async function mapped(projectId,mint){if(!operator)throw fail(configView().reason,409,'FEE_CONFIG_INACTIVE');if(!uuid(projectId))throw fail('Choose a saved project');key(mint);if(!operator.projects.some(p=>p.projectId===projectId&&p.sourceMint===mint)&&await resolveProjectMint?.(projectId)!==mint)throw fail('No verified project mint matches this fee source',409,'FEE_SOURCE_UNCONFIGURED');}
  function matched(sharing,recipients){const expected=new Map(recipients.map(r=>[r.address,r.shareBps]));return !!sharing&&sharing.shareholders?.length===expected.size&&sharing.shareholders.every(s=>expected.get(s.address.toBase58())===s.shareBps)&&new Set(sharing.shareholders.map(s=>s.address.toBase58())).size===expected.size;}
  async function projectRecipients(projectId,mint){return feeRecipients(operator,operator.splitBps.creator?await resolveProjectCreator?.(projectId,mint):null);}
  async function chainState(mintText,{commitment='confirmed',minContextSlot}={}){
    await mainnet();const mint=key(mintText),sharingAddress=pump.feeSharingConfigPda(mint),curveAddress=pump.bondingCurvePda(mint),poolAddress=pump.canonicalPumpPoolPda(mint);
    const response=await rpc.getMultipleAccountsInfoAndContext([curveAddress,sharingAddress,poolAddress],{commitment,...(minContextSlot===undefined?{}:{minContextSlot})});
    if(!Number.isSafeInteger(response.context?.slot)||response.context.slot<(minContextSlot??0)||!Array.isArray(response.value)||response.value.length!==3)throw fail('Current fee account evidence is unavailable',503);
    const [curveInfo,sharingInfo,poolInfo]=response.value;if(!curveInfo?.owner.equals(pump.PUMP_PROGRAM_ID))throw fail('This mint is not a Pump bonding curve',422,'UNVERIFIED_CURVE');
    let curve,sharing,pool;try{curve=sdk.decodeBondingCurve(curveInfo);if(sharingInfo){if(!sharingInfo.owner.equals(pump.PUMP_FEE_PROGRAM_ID))throw Error();sharing=sdk.decodeSharingConfig(sharingInfo);if(!sharing.mint.equals(mint))throw Error();}if(poolInfo){if(!poolInfo.owner.equals(pump.PUMP_AMM_PROGRAM_ID))throw Error();pool=ammSdk.decodePool(poolInfo);if(!pool.baseMint.equals(mint)||!pool.quoteMint.equals(NATIVE_MINT))throw Error();}}catch{throw fail('Pump fee accounts could not be verified',422,'INVALID_FEE_ACCOUNTS');}
    if(!pump.normalizeQuoteMint(curve.quoteMint).equals(NATIVE_MINT)||curve.isMayhemMode||curve.isCashbackCoin||curve.isHolderReward)throw fail('Only standard SOL-paired creator-fee coins are supported',422,'UNSUPPORTED_FEE_COIN');
    if(sharing&&!curve.creator.equals(sharingAddress)||pool&&sharing&&!pool.coinCreator.equals(sharingAddress))throw fail('Curve or pool creator does not match fee sharing',422,'INVALID_FEE_ACCOUNTS');
    return {mint,curve,sharing,pool,sharingAddress,poolAddress,slot:response.context.slot};
  }
  async function inspect({projectId,mint}){await mapped(projectId,mint);const recipients=await projectRecipients(projectId,mint),s=await chainState(mint);return {projectId,mint,sharingConfig:s.sharingAddress.toBase58(),onChainConfigurationVerified:matched(s.sharing,recipients)&&s.sharing.adminRevoked===true,shares:s.sharing?.shareholders.map(s=>({address:s.address.toBase58(),shareBps:s.shareBps}))??[],proposedShares:recipients,creatorWallet:recipients.find(r=>r.role==='creator')?.address??null,adminRevoked:s.sharing?.adminRevoked??false,slot:s.slot,checkedAt:now(),providerCreditsUsd:0};}
  async function prepare({owner,projectId,mint,action='configure'}={}){
    const wallet=key(owner,true);if(!['configure','distribute'].includes(action))throw fail('Choose configure or distribute');await mapped(projectId,mint);
    let state=store.read();if(state.intents.some(r=>r.mint===mint&&r.status==='pending'))throw fail('A signed fee transaction is unresolved; recover it before preparing another',409,'FEE_TRANSACTION_PENDING');
    const recipients=await projectRecipients(projectId,mint),s=await chainState(mint),instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:CU_LIMIT}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000})],newShareholders=recipients.map(r=>({address:key(r.address),shareBps:r.shareBps}));
    const common={payer:wallet,mint:s.mint,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID};
    let distributionInstructionIndex=null;
    if(action==='configure'){
      if(s.sharing?.adminRevoked)throw fail(matched(s.sharing,recipients)?'This coin already has the finalized fee split':'This coin has a different permanent fee split',409,'FEE_SHARES_FINALIZED');
      if(s.sharing?s.sharing.version===1||!s.sharing.admin.equals(wallet):!s.curve.creator.equals(wallet))throw fail('Only the current coin creator or sharing admin can configure fees',403,'FEE_CREATOR_REQUIRED');
      if(s.pool&&!s.sharing&&!s.pool.coinCreator.equals(wallet))throw fail('The pool creator differs from this wallet',403,'FEE_CREATOR_REQUIRED');
      instructions.push(await sdk.sweepCreatorFeeInstruction({...common,creator:s.curve.creator}));
      if(s.pool)instructions.push(await sdk.sweepPoolCreatorFeeInstruction({...common,coinCreator:s.pool.coinCreator}));
      if(!s.sharing)instructions.push(await sdk.createFeeSharingConfig({creator:wallet,mint:s.mint,pool:s.pool?s.poolAddress:null}));
      instructions.push(await sdk.updateFeeSharesV2({authority:wallet,mint:s.mint,currentShareholders:s.sharing?s.sharing.shareholders.map(x=>x.address):[wallet],newShareholders,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,bondingCurveComplete:!!s.curve.complete}));
    }else{
      if(!matched(s.sharing,recipients)||!s.sharing.adminRevoked)throw fail('Configure and finalize the exact recipient fee split before distributing',409,'FEE_SHARES_UNVERIFIED');
      instructions.push(await sdk.sweepCreatorFeeInstruction({...common,creator:s.sharingAddress}));
      if(s.pool){instructions.push(await sdk.sweepPoolCreatorFeeInstruction({...common,coinCreator:s.pool.coinCreator}));instructions.push(await sdk.transferCreatorFeesToPumpV2(common));}
      distributionInstructionIndex=instructions.length;
      instructions.push(await sdk.distributeCreatorFeesV2({...common,sharingConfig:s.sharing,sharingConfigAddress:s.sharingAddress,shouldInitializeAta:false}));
    }
    if(instructions.some(ix=>![ComputeBudgetProgram.programId,pump.PUMP_PROGRAM_ID,pump.PUMP_FEE_PROGRAM_ID,pump.PUMP_AMM_PROGRAM_ID].some(p=>ix.programId.equals(p))||ix.keys.some(k=>k.isSigner&&!k.pubkey.equals(wallet))))throw fail('The SDK returned an unexpected fee instruction',503);
    const intentId=crypto.randomUUID();
    // A distribution can happen repeatedly, so bind it to a unique intent.
    // Configuration is a one-time state change; omitting its memo keeps the
    // graduated pool's two sweeps + create + final-share update atomic and
    // below Solana's packet size. Equal configuration messages are reused below.
    if(action==='distribute')instructions.push(new TransactionInstruction({programId:MEMO,keys:[{pubkey:wallet,isSigner:true,isWritable:false}],data:Buffer.from('Ropad fees '+intentId)}));
    const latest=await rpc.getLatestBlockhash('confirmed'),tx=new VersionedTransaction(new TransactionMessage({payerKey:wallet,recentBlockhash:latest.blockhash,instructions}).compileToV0Message());let raw;try{raw=Buffer.from(tx.serialize());}catch{throw fail('The fee transaction exceeds the wallet message limit',422,'FEE_TRANSACTION_TOO_LARGE');}
    if(raw.length>1232||tx.message.header.numRequiredSignatures!==1)throw fail('The fee transaction exceeds the wallet message limit ('+raw.length+' bytes)',422,'FEE_TRANSACTION_TOO_LARGE');
    const [simulation,fee]=await Promise.all([rpc.simulateTransaction(tx,{commitment:'confirmed',sigVerify:false,replaceRecentBlockhash:false,minContextSlot:s.slot,accounts:{encoding:'base64',addresses:[owner]}}),rpc.getFeeForMessage(tx.message,'confirmed')]);
    if(simulation.value?.err!==null||!Number.isSafeInteger(simulation.value?.accounts?.[0]?.lamports)||simulation.value.accounts[0].lamports<0||simulation.value.unitsConsumed>CU_LIMIT)throw fail('Fee transaction simulation failed; no wallet signature requested',422,'SIMULATION_FAILED');
    if(!Number.isSafeInteger(fee.value)||fee.value<=0||fee.value>250000)throw fail('A bounded network fee could not be estimated',503);
    const row={intentId,owner,projectId,mint,action,status:'prepared',cluster:'mainnet-beta',transactionVersion:'v0',transactionBase64:raw.toString('base64'),messageBase64:Buffer.from(tx.message.serialize()).toString('base64'),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,quoteSlot:s.slot,createdAt:now(),expiresAt:now()+TTL,configHash,simulation:'passed',estimatedNetworkFeeLamports:String(fee.value),distributionInstructionIndex,sharingConfig:s.sharingAddress.toBase58(),shares:recipients,creatorWallet:recipients.find(r=>r.role==='creator')?.address??null,platformMint:operator.platformMint,permanentShares:action==='configure',rentMayApply:action==='configure'&&!s.sharing,realFunds:true,review:action==='configure'?'This permanently assigns all creator fees to the listed recipients and revokes future share updates; the signing wallet pays network fees and account rent':'This sends accrued creator fees to the configured recipients; it does not purchase OpenRouter credits'};
    state=store.read();if(state.intents.some(r=>r.mint===mint&&r.status==='pending'))throw fail('A fee transaction became pending; recover it first',409,'FEE_TRANSACTION_PENDING');const duplicate=state.intents.find(r=>r.messageBase64===row.messageBase64);if(duplicate){if(duplicate.owner!==owner||duplicate.projectId!==projectId||duplicate.configHash!==configHash)throw fail('This exact fee transaction belongs to another preview',409,'FEE_PREVIEW_CONFLICT');return view(duplicate);}if(state.intents.length>=MAX_INTENTS)throw fail('Fee transaction history is full',429);state.intents.push(row);store.write(state);return view(row);
  }
  async function submit({owner,intentId,signedTransactionBase64}={}){
    let r=own({owner,intentId});if(r.status!=='prepared')return status({owner,intentId});if(r.configHash!==configHash)throw fail('Fee configuration changed; review a new transaction',409,'FEE_CONFIG_CHANGED');if(now()>r.expiresAt)throw fail('Fee preview expired; request a new one',409,'FEE_PREVIEW_EXPIRED');
    const tx=decode(signedTransactionBase64);if(Buffer.from(tx.message.serialize()).toString('base64')!==r.messageBase64)throw fail('Signed fee recipients or instructions differ from the reviewed transaction',422,'TRANSACTION_MISMATCH');verifyTransactionSignature(tx,owner);
    await mainnet();if(await rpc.getBlockHeight('confirmed')>r.lastValidBlockHeight)throw fail('Fee preview blockhash expired',409,'FEE_PREVIEW_EXPIRED');r=own({owner,intentId});if(r.status!=='prepared')return status({owner,intentId});
    const other=store.read().intents.find(x=>x.intentId!==intentId&&x.mint===r.mint&&x.status==='pending');if(other)throw fail('Another fee transaction for this mint is unresolved',409,'FEE_TRANSACTION_PENDING');
    const signature=base58(tx.signatures[0]);r=update(intentId,{status:'pending',signature,signedTransactionBase64,submittedAt:now()});
    try{const sent=await rpc.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed',minContextSlot:r.quoteSlot});if(sent!==signature)throw Error();}catch{r=update(intentId,{submissionUncertain:true});}
    return view(r);
  }
  async function status({owner,intentId}={}){
    const r=own({owner,intentId});if(r.status==='prepared')return {...view(r),expired:now()>r.expiresAt};if(r.status!=='pending')return view(r);await mainnet();
    const searched=await rpc.getSignatureStatuses([r.signature],{searchTransactionHistory:true}),found=searched.value?.[0];
    if(found===null){
      // Never infer failure from a timeout: prove finalized blockhash expiry and
      // an absent history entry from a node at least as new as that evidence.
      const height=await rpc.getBlockHeight('finalized');if(!Number.isSafeInteger(height)||height<=r.lastValidBlockHeight)return view(r);
      const valid=await rpc.isBlockhashValid(r.blockhash,{commitment:'finalized',minContextSlot:r.quoteSlot});if(valid.value!==false||!Number.isSafeInteger(valid.context?.slot)||valid.context.slot<r.quoteSlot)return view(r);
      const again=await rpc.getSignatureStatuses([r.signature],{searchTransactionHistory:true});if(again.value?.[0]!==null||!Number.isSafeInteger(again.context?.slot)||again.context.slot<valid.context.slot||await rpc.getTransaction(r.signature,{commitment:'finalized',maxSupportedTransactionVersion:0})!==null)return view(r);
      return view(update(intentId,{status:'expired',expiryEvidence:{height,blockhashSlot:valid.context.slot,absentAtSlot:again.context.slot},expiredAt:now()}));
    }
    if(!found||found.confirmationStatus!=='finalized')return view(r);
    const receipt=await rpc.getTransaction(r.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!receipt||receipt.slot!==found.slot||receipt.slot<r.quoteSlot||receipt.transaction?.signatures?.[0]!==r.signature||Buffer.from(receipt.transaction.message.serialize()).toString('base64')!==r.messageBase64||!receipt.meta||JSON.stringify(receipt.meta.err)!==JSON.stringify(found.err))throw fail('Finalized fee receipt does not match this signed transaction',422,'FEE_RECEIPT_MISMATCH');
    if(receipt.meta.err!==null)return view(update(intentId,{status:'reverted',finalized:true,slot:receipt.slot,finalizedAt:now()}));
    // The receipt proves execution; current final state must prove the exact
    // permanent recipients before the UI can say configured.
    const s=await chainState(r.mint,{commitment:'finalized',minContextSlot:receipt.slot});if(!matched(s.sharing,r.shares)||s.sharing.adminRevoked!==true)throw fail('The finalized fee recipient configuration does not match',422,'FEE_SHARES_UNVERIFIED');
    return view(update(intentId,{status:'confirmed',finalized:true,slot:receipt.slot,finalizedAt:now(),onChainConfigurationVerified:true,explorerUrl:'https://solscan.io/tx/'+r.signature}));
  }
  function list({owner,projectId}={}){key(owner,true);return store.read().intents.filter(r=>r.owner===owner&&(!projectId||r.projectId===projectId)).map(view);}
  return {config:configView,prepare,submit,status,confirm:status,list,inspect};
}
module.exports={createSolanaFeeSharingService,FILE_NAME,TTL};

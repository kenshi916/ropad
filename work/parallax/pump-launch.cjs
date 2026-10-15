'use strict';
// Regular SOL-quoted Pump create_v2. Never holds a user's private key. A generated
// mint signs only its creation; the creator must review and sign the exact message.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Connection,PublicKey,Keypair,VersionedTransaction,TransactionMessage,ComputeBudgetProgram,SystemProgram}=require('@solana/web3.js');
const {TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,NATIVE_MINT,unpackMint,getExtensionData,ExtensionType}=require('@solana/spl-token');
const {unpack:unpackMetadata}=require('@solana/spl-token-metadata');
const pump=require('@pump-fun/pump-sdk');
const {validatePumpMetadata,publicHttps}=require('./pump-metadata.cjs');
const {normalizeConfig,feeRecipients}=require('./solana-fee-accounting.cjs');
const {loadFeeLaunchLookup,validateLookupSnapshot,lookupAddresses,verifyReceiptLookup}=require('./pump-launch-lookup.cjs');
const RPC_URL='https://api.mainnet-beta.solana.com',GENESIS_HASH='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const CLUSTER='mainnet-beta',TTL=60000,CU_LIMIT=400000,FEE_CU_LIMIT=800000,CU_PRICE=10000,MAX_INTENTS=1000;
const fail=(message,status=400,code='PUMP_LAUNCH_INVALID')=>Object.assign(new Error(message),{status,code});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function key(value,signer=false){try{if(typeof value!=='string')throw Error();const k=new PublicKey(value);if(k.toBase58()!==value||signer&&!PublicKey.isOnCurve(k.toBytes()))throw Error();return k;}catch{throw fail('A valid Solana '+(signer?'signing wallet':'address')+' is required');}}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||/[\x00-\x1f\x7f]/.test(value))throw fail(`${label} exceeds the Pump limit of ${max} UTF-8 bytes`);return value.trim();}
function fromBase64(value){if(typeof value!=='string'||value.length>1800||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw fail('Invalid transaction encoding');const bytes=Buffer.from(value,'base64');if(bytes.length>1232||bytes.toString('base64')!==value)throw fail('Invalid transaction encoding');return bytes;}
function decode(value){try{return VersionedTransaction.deserialize(fromBase64(value));}catch(e){throw e.status?e:fail('Invalid versioned Solana transaction');}}
function base58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='',a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(n){s=a[Number(n%58n)]+s;n/=58n;}for(const byte of bytes){if(byte)break;s='1'+s;}return s;}
function feePolicy(config){return {platformMint:config.platformMint,platformTreasury:config.platformTreasury,computeTreasury:config.computeTreasury,splitBps:{platform:config.splitBps.platform,compute:config.splitBps.compute,...(config.splitBps.creator?{creator:config.splitBps.creator}:{})}};}
function verifySignatures(tx,owner,mint,lookup=null){
  const keys=tx.message.staticAccountKeys;
  if(tx.message.version!==0||(!lookup&&tx.message.addressTableLookups.length)||tx.message.header.numRequiredSignatures!==2||tx.signatures.length!==2||keys[0].toBase58()!==owner||keys[1].toBase58()!==mint)throw fail('The creator or mint signer differs from the reviewed launch',422,'TRANSACTION_MISMATCH');
  if(lookup)lookupAddresses(tx.message,lookup);
  for(let i=0;i<2;i++){const pk=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),keys[i].toBuffer()]),format:'der',type:'spki'});if(!crypto.verify(null,Buffer.from(tx.message.serialize()),pk,tx.signatures[i]))throw fail('Both the creator and mint signatures must be valid',422,'INVALID_SIGNATURE');}
}
function createPumpLaunchService({stateDirectory,enabled=false,connection,rpcUrl=RPC_URL,now=Date.now,sdk=pump.PUMP_SDK,metadataProvider,fetchBytes,maxLaunchLamports=250000000,feeConfig=null,requireFeeSharing=false,lookupTableAddress=null}={}){
  if(!stateDirectory)throw fail('Persistent mainnet launch storage is required',503);
  if(!Number.isSafeInteger(maxLaunchLamports)||maxLaunchLamports<=0||maxLaunchLamports>1000000000)throw fail('A bounded mainnet launch cost limit is required',503);
  if(typeof requireFeeSharing!=='boolean')throw fail('Fee sharing enforcement must be an explicit boolean',503);
  const operator=normalizeConfig(feeConfig),policy=operator?feePolicy(operator):null,policyHash=policy?hash(JSON.stringify(policy)):null,atomicRequested=requireFeeSharing||operator!==null;
  const routingReady=!!operator&&typeof lookupTableAddress==='string'&&(()=>{try{return key(lookupTableAddress).toBase58()===lookupTableAddress;}catch{return false;}})();
  function checkFeePolicy(i){
    if(!atomicRequested&&!i?.feeSharingAtomic)return;
    if(!operator)throw fail('Configure the platform, compute and creator fee policy before a mainnet launch',503,'FEE_CONFIG_INACTIVE');
    if(!routingReady)throw fail('Configure the frozen mainnet fee lookup table before launching a coin',503,'FEE_LOOKUP_UNAVAILABLE');
    if(i&&(!i.feeSharingAtomic||i.feePolicyHash!==policyHash||i.lookupTable?.address!==lookupTableAddress))throw fail('This saved launch has a different fee policy; preserve it and review the operator configuration before signing',409,'FEE_POLICY_CHANGED');
  }
  fs.mkdirSync(stateDirectory,{recursive:true,mode:0o700});const file=path.join(stateDirectory,'pump-mainnet-intents.json');let state={version:1,cluster:CLUSTER,intents:[]},digest=null,fault=false;
  const rpc=connection||new Connection(publicHttps(rpcUrl,2048),{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})});
  if(fs.existsSync(file)){try{
    const bytes=fs.readFileSync(file);digest=hash(bytes);state=JSON.parse(bytes);
    if(state.version!==1||state.cluster!==CLUSTER||!Array.isArray(state.intents)||state.intents.length>MAX_INTENTS)throw Error();const ids=new Set(),missions=new Set();
    for(const i of state.intents){
      if(!/^[a-f0-9-]{36}$/.test(i.intentId)||ids.has(i.intentId)||missions.has(i.missionId)||!['prepared','pending','confirmed','failed','expired'].includes(i.status)||!Number.isFinite(i.createdAt)||!Number.isSafeInteger(i.lastValidBlockHeight))throw Error();ids.add(i.intentId);missions.add(i.missionId);key(i.owner,true);key(i.mint);publicHttps(i.metadataUri);
      const tx=decode(i.transactionBase64);if(Buffer.from(tx.message.serialize()).toString('base64')!==i.messageBase64||tx.message.staticAccountKeys[0].toBase58()!==i.owner||tx.message.staticAccountKeys[1].toBase58()!==i.mint||tx.message.header.numRequiredSignatures!==2||!i.feeSharingAtomic&&tx.message.addressTableLookups.length)throw Error();
      if(i.feeSharingAtomic){
        if(i.feeSharingAtomic!==true||i.permanentShares!==true||typeof i.feeSharingRequired!=='boolean'||i.sharingConfig!==pump.feeSharingConfigPda(key(i.mint)).toBase58())throw Error();
        const savedPolicy=feePolicy(normalizeConfig(i.feePolicy));if(hash(JSON.stringify(savedPolicy))!==i.feePolicyHash||JSON.stringify(feeRecipients(savedPolicy,i.owner))!==JSON.stringify(i.feeShares))throw Error();
        validateLookupSnapshot(i.lookupTable);lookupAddresses(tx.message,i.lookupTable);if(i.quoteSlot<i.lookupTable.verificationSlot||i.status==='confirmed'&&i.feeSharingVerified!==true)throw Error();
      }else if(i.feePolicyHash||i.feeShares||i.sharingConfig||i.lookupTable||i.feeSharingVerified)throw Error();
      if(i.status!=='confirmed'&&Keypair.fromSecretKey(Buffer.from(i.mintSecretKey,'base64')).publicKey.toBase58()!==i.mint)throw Error();
      if(i.signature&&!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(i.signature)||['pending','confirmed','failed'].includes(i.status)&&!i.signature)throw Error();
      if(i.status==='confirmed'&&(!i.verified||!Number.isSafeInteger(i.slot)))throw Error();
    }
  }catch{throw fail('Saved mainnet launches are unreadable; preserve them and recover before another launch',503,'LAUNCH_STORAGE_UNAVAILABLE');}}
  function assertStorage(){if(fault)throw fail('Mainnet launch storage is unavailable',503,'LAUNCH_STORAGE_UNAVAILABLE');try{if((fs.existsSync(file)?hash(fs.readFileSync(file)):null)!==digest)throw Error();}catch{fault=true;throw fail('Mainnet launch history changed on disk; no transaction was sent',503,'LAUNCH_STORAGE_UNAVAILABLE');}}
  function save(){assertStorage();const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{const bytes=JSON.stringify(state);fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);digest=hash(bytes);}catch{fault=true;throw fail('Mainnet launch history could not be saved; no new transaction was sent',503,'LAUNCH_STORAGE_UNAVAILABLE');}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
  let queue=Promise.resolve();const exclusive=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  const own=(owner,intentId)=>{key(owner,true);const i=state.intents.find(i=>i.intentId===intentId);if(!i||i.owner!==owner)throw fail('This mainnet launch belongs to a different wallet or is unavailable',404);return i;};
  function config(){const available=enabled===true&&(!atomicRequested||routingReady);return {chain:'solana',cluster:CLUSTER,networkName:'Solana mainnet',enabled:enabled===true,mainnetAvailable:available,tradingAvailable:available,liquidityCreated:false,bondingCurveCreation:true,metadataOnchain:true,requiresMetadataUri:!metadataProvider,metadataHosting:'Public HTTPS metadata and image, verified before signing; durability is managed by its host',supply:1000000000,decimals:6,fundingLamports:0,realFunds:true,initialBuySupported:false,feeSharingRequired:requireFeeSharing,feeSharingAtomicAvailable:atomicRequested&&routingReady,feePolicyHash:policyHash,feePolicy:policy?structuredClone(policy):null,feeLookupTableAddress:lookupTableAddress,feeRouting:atomicRequested?'Coin creation must atomically finalize the displayed permanent creator-fee recipients':'Pump creator fees accrue to the launching wallet; platform sharing requires separate configuration',reason:atomicRequested&&!routingReady?(!operator?'Creator-fee policy is not configured':'Frozen mainnet fee lookup table is not configured'):null,computeFunding:'Token creation does not purchase AI credits',transactionVersion:'v0',maxLaunchLamports};}
  function view(i){const {mintSecretKey,messageBase64,signedTransactionBase64,lookupTable,...safe}=i;return {...config(),feeSharingRequired:false,feeSharingAtomic:false,feePolicyHash:null,feePolicy:null,...structuredClone(safe),cluster:CLUSTER,explorerUrl:i.signature?'https://solscan.io/tx/'+i.signature:null,mintExplorerUrl:'https://solscan.io/token/'+i.mint,pumpUrl:'https://pump.fun/coin/'+i.mint};}
  const checkEnabled=()=>{if(enabled!==true)throw fail('Pump mainnet creation is not enabled by the operator',503,'MAINNET_NOT_ENABLED');};
  async function mainnet(){if(await rpc.getGenesisHash()!==GENESIS_HASH)throw fail('RPC is not Solana mainnet; no transaction was sent',503,'WRONG_CLUSTER');}
  async function verifyCreated(i,slot){
    const mint=key(i.mint),curve=pump.bondingCurvePda(mint),sharing=i.feeSharingAtomic?pump.feeSharingConfigPda(mint):null,r=await rpc.getMultipleAccountsInfoAndContext([mint,curve,...(sharing?[sharing]:[])],{commitment:'finalized',minContextSlot:slot});
    if(!Number.isSafeInteger(r.context?.slot)||r.context.slot<slot)throw fail('Finalized mint verification is not yet available',503,'LAUNCH_VERIFICATION_PENDING');
    const [mi,ci]=r.value;if(!mi?.owner.equals(TOKEN_2022_PROGRAM_ID)||!ci?.owner.equals(pump.PUMP_PROGRAM_ID))throw fail('Finalized mint or bonding curve does not match Pump',422,'LAUNCH_RECEIPT_MISMATCH');
    let m,c,metadata;try{m=unpackMint(mint,mi,TOKEN_2022_PROGRAM_ID);c=sdk.decodeBondingCurve(ci);const bytes=getExtensionData(ExtensionType.TokenMetadata,m.tlvData);metadata=bytes?unpackMetadata(bytes):null;}catch{throw fail('Finalized Pump mint data cannot be verified',422,'LAUNCH_RECEIPT_MISMATCH');}
    if(!m.isInitialized||m.decimals!==6||m.supply!==1000000000000000n||m.freezeAuthority!==null||m.mintAuthority!==null||BigInt(c.tokenTotalSupply.toString())!==m.supply||!c.creator.equals(sharing||key(i.owner))||c.isMayhemMode||c.isCashbackCoin||c.isHolderReward||!pump.normalizeQuoteMint(c.quoteMint).equals(NATIVE_MINT)||!metadata?.mint.equals(mint)||metadata.name!==i.name||metadata.symbol!==i.symbol||metadata.uri!==i.metadataUri)throw fail('Finalized Pump token settings do not match this launch',422,'LAUNCH_RECEIPT_MISMATCH');
    if(sharing){
      let state;try{if(!r.value[2]?.owner.equals(pump.PUMP_FEE_PROGRAM_ID))throw Error();state=sdk.decodeSharingConfig(r.value[2]);}catch{throw fail('Finalized creator-fee configuration cannot be verified',422,'FEE_SHARES_UNVERIFIED');}
      const shares=new Map(i.feeShares.map(share=>[share.address,share.shareBps]));
      if(!state?.mint.equals(mint)||state.adminRevoked!==true||!Array.isArray(state.shareholders)||state.shareholders.length!==shares.size||new Set(state.shareholders.map(share=>share.address.toBase58())).size!==shares.size||state.shareholders.some(share=>shares.get(share.address.toBase58())!==share.shareBps))throw fail('Finalized permanent creator-fee recipients differ from the signed launch',422,'FEE_SHARES_UNVERIFIED');
    }
    return {curve:curve.toBase58(),verificationSlot:r.context.slot,metadataVerified:true,bondingCurveCreated:true,...(sharing?{feeSharingVerified:true}:{})};
  }
  async function reconcile(i){
    if(i.status!=='pending')return view(i);await mainnet();const status=await rpc.getSignatureStatuses([i.signature],{searchTransactionHistory:true}),found=status.value?.[0];
    if(found===null){
      const height=await rpc.getBlockHeight('finalized');if(!Number.isSafeInteger(height)||height<=i.lastValidBlockHeight)return view(i);
      const valid=await rpc.isBlockhashValid(i.blockhash,{commitment:'finalized',minContextSlot:i.quoteSlot});
      if(valid?.value!==false||!Number.isSafeInteger(valid.context?.slot)||valid.context.slot<i.quoteSlot)return view(i);
      const fresh=await rpc.getSignatureStatuses([i.signature],{searchTransactionHistory:true});
      if(fresh.value?.[0]!==null||!Number.isSafeInteger(fresh.context?.slot)||fresh.context.slot<valid.context.slot)return view(i);
      if(await rpc.getTransaction(i.signature,{commitment:'finalized',maxSupportedTransactionVersion:0})!==null)return view(i);
      // A separately landed creation must never be replaced merely because one RPC
      // cannot find this receipt. Preserve evidence for operator recovery.
      if(await rpc.getAccountInfo(key(i.mint),{commitment:'finalized',minContextSlot:valid.context.slot})!==null)return view(i);
      Object.assign(i,{status:'expired',expiryEvidence:{finalizedBlockHeight:height,blockhashSlot:valid.context.slot,signatureAbsentAtSlot:fresh.context.slot,checkedAt:now()}});save();return view(i);
    }
    if(!found||found.confirmationStatus!=='finalized')return view(i);
    const receipt=await rpc.getTransaction(i.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    if(!receipt||!receipt.meta||!Number.isSafeInteger(receipt.slot)||receipt.slot!==found.slot||receipt.slot<i.quoteSlot||receipt.transaction.signatures[0]!==i.signature||Buffer.from(receipt.transaction.message.serialize()).toString('base64')!==i.messageBase64||!!receipt.meta.err!==!!found.err)throw fail('The finalized receipt differs from the signed launch; do not launch again',422,'LAUNCH_RECEIPT_MISMATCH');
    if(i.feeSharingAtomic)verifyReceiptLookup(receipt.transaction.message,i.lookupTable,receipt.meta.loadedAddresses);
    if(receipt.meta.err){Object.assign(i,{status:'failed',finalized:true,slot:receipt.slot,lastError:'The creation transaction failed on chain; network fees may have been charged'});save();return view(i);}
    const verified=await verifyCreated(i,receipt.slot);Object.assign(i,verified,{status:'confirmed',verified:true,finalized:true,slot:receipt.slot,confirmedAt:now(),actualNetworkFeeLamports:receipt.meta.fee});delete i.mintSecretKey;delete i.signedTransactionBase64;save();return view(i);
  }
  async function prepareLaunch({owner,missionId,name,symbol,metadataUri}={}){return exclusive(async()=>{
    assertStorage();checkEnabled();const payer=key(owner,true);name=text(name,32,'Coin name');symbol=text(symbol,10,'Coin symbol');if(typeof missionId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(missionId))throw fail('A stable game launch ID is required');
    let i=state.intents.find(i=>i.missionId===missionId);if(i&&(i.owner!==owner||i.name!==name||i.symbol!==symbol||metadataUri&&i.metadataUri!==metadataUri))throw fail('Saved launch details differ; recover the original launch',409);
    if(i?.status==='pending')return reconcile(i);if(i?.status==='confirmed')return view(i);
    checkFeePolicy(i);
    await mainnet();if(i?.status==='prepared'&&now()<i.expiresAt&&await rpc.getBlockHeight('confirmed')<=i.lastValidBlockHeight)return view(i);
    metadataUri=metadataUri||i?.metadataUri||(typeof metadataProvider==='function'?await metadataProvider({owner,missionId,name,symbol}):null);
    const metadata=await validatePumpMetadata({uri:metadataUri,name,symbol,fetchBytes});
    const mint=i?Keypair.fromSecretKey(Buffer.from(i.mintSecretKey,'base64')):Keypair.generate();if(await rpc.getAccountInfo(mint.publicKey,'confirmed'))throw fail('This mint already exists; reconcile its original launch',409,'MINT_ALREADY_EXISTS');
    const snap=await rpc.getMultipleAccountsInfoAndContext([pump.GLOBAL_PDA,pump.PUMP_PROGRAM_ID,payer],{commitment:'confirmed'}),[globalAccount,program,payerAccount]=snap.value;
    if(!Number.isSafeInteger(snap.context?.slot)||!globalAccount?.owner.equals(pump.PUMP_PROGRAM_ID)||!program?.executable||!payerAccount?.owner.equals(SystemProgram.programId)||!Number.isSafeInteger(payerAccount.lamports))throw fail('Pump program and wallet state could not be verified',503);
    const global=sdk.decodeGlobal(globalAccount);if(global.createV2Enabled!==true)throw fail('Pump create_v2 is not currently enabled',503);
    const feeShares=atomicRequested?feeRecipients(operator,owner):null,lookup=atomicRequested?await loadFeeLaunchLookup(rpc,lookupTableAddress):null,units=atomicRequested?FEE_CU_LIMIT:CU_LIMIT;
    const instruction=await sdk.createV2Instruction({mint:mint.publicKey,name,symbol,uri:metadata.uri,creator:payer,user:payer,mayhemMode:false,cashback:false,holderReward:false,quoteMint:NATIVE_MINT});
    const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:CU_PRICE}),instruction];
    if(atomicRequested){
      instructions.push(await sdk.createFeeSharingConfig({creator:payer,mint:mint.publicKey,pool:null}));
      instructions.push(await sdk.updateFeeSharesV2({authority:payer,mint:mint.publicKey,currentShareholders:[payer],newShareholders:feeShares.map(share=>({address:key(share.address),shareBps:share.shareBps})),quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,bondingCurveComplete:false}));
    }
    if(!instruction.programId.equals(pump.PUMP_PROGRAM_ID)||instructions.some(ix=>![ComputeBudgetProgram.programId,pump.PUMP_PROGRAM_ID,pump.PUMP_FEE_PROGRAM_ID].some(program=>program.equals(ix.programId))||ix.keys.some(k=>k.isSigner&&!k.pubkey.equals(payer)&&!k.pubkey.equals(mint.publicKey))))throw fail('Pump SDK returned unexpected creation accounts',503);
    const latest=await rpc.getLatestBlockhash('confirmed');let tx,raw;
    try{tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:latest.blockhash,instructions}).compileToV0Message(lookup?[lookup.account]:[]));tx.sign([mint]);raw=Buffer.from(tx.serialize());if(raw.length>1232||tx.message.header.numRequiredSignatures!==2)throw Error();}catch{throw fail('Creation and fee routing do not fit a supported wallet transaction; shorten the metadata URL or name',422,'LAUNCH_TRANSACTION_TOO_LARGE');}
    if(lookup)lookupAddresses(tx.message,lookup.snapshot);
    const quoteSlot=Math.max(snap.context.slot,lookup?.snapshot.verificationSlot??0);
    const [fee,sim]=await Promise.all([rpc.getFeeForMessage(tx.message,'confirmed'),rpc.simulateTransaction(tx,{commitment:'confirmed',sigVerify:false,replaceRecentBlockhash:false,minContextSlot:quoteSlot,accounts:{encoding:'base64',addresses:[owner]}})]);
    if(!Number.isSafeInteger(fee.value)||fee.value<=0||fee.value>250000||sim.value.err!==null||!Number.isSafeInteger(sim.value.accounts?.[0]?.lamports)||sim.value.accounts[0].lamports<0||!Number.isFinite(sim.value.unitsConsumed)||sim.value.unitsConsumed>units)throw fail('Pump creation simulation failed; no wallet approval was requested',422,'SIMULATION_FAILED');
    const total=payerAccount.lamports-sim.value.accounts[0].lamports,rent=total-fee.value;
    if(!Number.isSafeInteger(total)||rent<0||total>maxLaunchLamports||payerAccount.lamports<total)throw fail('Simulated creation cost exceeds the configured limit or wallet balance',422,'LAUNCH_COST_LIMIT');
    const next={intentId:i?.intentId||crypto.randomUUID(),missionId,owner,name,symbol,mint:mint.publicKey.toBase58(),mintSecretKey:Buffer.from(mint.secretKey).toString('base64'),cluster:CLUSTER,status:'prepared',metadataUri:metadata.uri,metadata,curve:pump.bondingCurvePda(mint.publicKey).toBase58(),transactionVersion:'v0',transactionBase64:raw.toString('base64'),messageBase64:Buffer.from(tx.message.serialize()).toString('base64'),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,quoteSlot,createdAt:i?.createdAt||now(),expiresAt:now()+TTL,estimatedNetworkFeeLamports:fee.value,rentLamports:rent,estimatedAccountCostLamports:rent,totalRequiredLamports:total,fundingLamports:0,simulation:'passed',costIsEstimate:true,initialBuyLamports:0,...(atomicRequested?{feeSharingRequired:requireFeeSharing,feeSharingAtomic:true,permanentShares:true,feePolicyHash:policyHash,feePolicy:policy,feeShares,sharingConfig:pump.feeSharingConfigPda(mint.publicKey).toBase58(),lookupTable:lookup.snapshot,feeSharingVerified:false}:{}),attempts:[...(i?.attempts||[]),...(i?.signature?[{signature:i.signature,status:i.status}]:[])]};
    if(i)Object.assign(i,next);else{if(state.intents.length>=MAX_INTENTS)throw fail('Mainnet launch history is full',429);i=next;state.intents.push(i);}delete i.signature;delete i.signedTransactionBase64;delete i.lastError;delete i.finalized;delete i.expiryEvidence;save();return view(i);
  });}
  async function submit({owner,intentId,signedTransactionBase64,beforeBroadcast}={}){return exclusive(async()=>{
    assertStorage();checkEnabled();const i=own(owner,intentId),tx=decode(signedTransactionBase64);if(Buffer.from(tx.message.serialize()).toString('base64')!==i.messageBase64)throw fail('The signed transaction differs from the prepared launch',422,'TRANSACTION_MISMATCH');verifySignatures(tx,owner,i.mint,i.lookupTable);const signature=base58(tx.signatures[0]);if(i.signature&&i.signature!==signature)throw fail('Another signature is already recorded for this launch',409);
    if(i.status==='confirmed')return view(i);if(['failed','expired'].includes(i.status))return view(i);await mainnet();
    if(i.status==='pending'){await reconcile(i);if(i.status!=='pending')return view(i);}
    if(await rpc.getBlockHeight('confirmed')>i.lastValidBlockHeight){if(i.status==='pending')return view(i);Object.assign(i,{status:'expired'});save();return view(i);}
    if(i.status==='prepared'){if(!Number.isFinite(i.expiresAt)||now()>=i.expiresAt)throw fail('The launch quote expired; refresh it and review the new transaction before signing',409,'LAUNCH_QUOTE_EXPIRED');checkFeePolicy(i);Object.assign(i,{status:'pending',signature,signedTransactionBase64,submittedAt:now()});save();}
    if(beforeBroadcast)beforeBroadcast();assertStorage();
    try{if(await rpc.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed',minContextSlot:i.quoteSlot})!==signature)throw Error();}catch{Object.assign(i,{submissionUncertain:true});save();return view(i);}
    return reconcile(i);
  });}
  async function status({owner,intentId}={}){return exclusive(async()=>{assertStorage();return reconcile(own(owner,intentId));});}
  return {config,prepareLaunch,submit,status};
}
module.exports={createPumpLaunchService,verifySignatures,RPC_URL,GENESIS_HASH,TTL};

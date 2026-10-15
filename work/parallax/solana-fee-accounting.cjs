'use strict';

// Read-only Pump creator-vault distribution accounting. No signing, instruction
// submission, recipient updates, currency conversion or provider funding occurs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Connection,PublicKey,SystemProgram}=require('@solana/web3.js');
const {NATIVE_MINT,TOKEN_PROGRAM_ID}=require('@solana/spl-token');
const pump=require('@pump-fun/pump-sdk');
const RPC_URL='https://api.mainnet-beta.solana.com';
const GENESIS_HASH='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const FILE_NAME='solana-fee-receipts.json',MAX_RECEIPTS=5000;
const EVENT_TAG=Buffer.from('e445a52e51cb9a1d','hex'); // Anchor EVENT_IX_TAG_LE
const EVENT_DISCRIMINATOR=Buffer.from(pump.pumpIdl.events.find(e=>e.name==='DistributeCreatorFeesEvent').discriminator);
const DISTRIBUTIONS=new Map(['distribute_creator_fees','distribute_creator_fees_v2'].map(name=>[Buffer.from(pump.pumpIdl.instructions.find(i=>i.name===name).discriminator).toString('hex'),name]));
const fail=(message,status=422,code='FEE_RECEIPT_UNSUPPORTED')=>Object.assign(new Error(message),{status,code});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const amount=value=>typeof value==='string'&&/^(0|[1-9]\d{0,30})$/.test(value);
function publicKey(value,label='public key') {try{const key=new PublicKey(value);if(typeof value!=='string'||key.toBase58()!==value)throw Error();return key;}catch{throw fail('Invalid '+label,400,'INVALID_FEE_INPUT');}}
function signatureBytes(value) {const bytes=base58Decode(value);if(bytes.length!==64)throw fail('Invalid Solana signature',400,'INVALID_FEE_INPUT');return bytes;}
function base58Decode(value) {
  if(typeof value!=='string'||!value.length||value.length>2000||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value))throw fail('Unsupported receipt encoding');
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;
  for(const c of value)n=n*58n+BigInt(alphabet.indexOf(c));
  let hex=n.toString(16);if(hex.length%2)hex='0'+hex;
  const leading=value.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(leading),n?Buffer.from(hex,'hex'):Buffer.alloc(0)]);
}
function sol(lamports) {const n=BigInt(lamports),fraction=(n%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');return (n/1000000000n).toString()+(fraction?'.'+fraction:'');}
function normalizeConfig(config) {
  if(config==null)return null;
  if(typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!['platformMint','platformTreasury','computeTreasury','splitBps','projects'].includes(k)))throw fail('Invalid operator fee configuration',500,'INVALID_FEE_CONFIG');
  try {
    for(const field of ['platformTreasury','computeTreasury'])publicKey(config[field],field);
    const platformMint=config.platformMint==null||config.platformMint===''?null:publicKey(config.platformMint,'platformMint').toBase58();
    const split=config.splitBps;
    const shareKeys=Object.keys(split||{}).sort().join(',');
    if(!split||typeof split!=='object'||!['compute,platform','compute,creator,platform'].includes(shareKeys)||Object.values(split).some(bps=>!Number.isInteger(bps)||bps<=0)||Object.values(split).reduce((sum,bps)=>sum+bps,0)!==10000)throw Error();
    const projects=config.projects??[];
    if(!Array.isArray(projects)||projects.length>500)throw Error();
    const ids=new Set();
    for(const project of projects){if(!project||Object.keys(project).sort().join(',')!=='projectId,sourceMint'||!uuid(project.projectId)||ids.has(project.projectId))throw Error();publicKey(project.sourceMint,'fee source mint');ids.add(project.projectId);}
    return structuredClone({...config,platformMint,projects});
  }catch{throw fail('Operator fee configuration requires explicit treasury addresses, positive shares totaling 10000 bps, valid optional platform mint, and unique project mappings',500,'INVALID_FEE_CONFIG');}
}
// Creator destinations come only from the saved verified coin owner resolver.
// Existing two-way plans retain their original recipients and proportions.
function feeRecipients(config,creator=null){
  const recipients=[{address:config.platformTreasury,shareBps:config.splitBps.platform,role:'platform'},{address:config.computeTreasury,shareBps:config.splitBps.compute,role:'compute'}];
  if(config.splitBps.creator){
    let wallet;try{wallet=publicKey(creator,'verified project creator');if(!PublicKey.isOnCurve(wallet.toBytes()))throw Error();}catch{throw fail('A verified project creator wallet is required for the creator fee share',409,'FEE_CREATOR_UNVERIFIED');}
    recipients.push({address:wallet.toBase58(),shareBps:config.splitBps.creator,role:'creator'});
  }
  const unique=new Map();
  for(const recipient of recipients){
    const existing=unique.get(recipient.address);
    if(!existing){unique.set(recipient.address,{...recipient});continue;}
    const allocationsBps=existing.allocationsBps||{[existing.role]:existing.shareBps};
    allocationsBps[recipient.role]=recipient.shareBps;
    unique.set(recipient.address,{address:recipient.address,shareBps:existing.shareBps+recipient.shareBps,role:'combined',allocationsBps});
  }
  return [...unique.values()];
}
const ROLE_ORDER=['platform','compute','creator'];
// A shared wallet receives one on-chain transfer. Its role amounts are internal
// accounting allocations, never separate reserves or additional payments.
function allocateTransfers(recipients,received){
  const totals={platform:0n,compute:0n,creator:0n};
  for(const recipient of recipients){
    const value=received.get(recipient.address);
    if(typeof value!=='bigint'||value<0n)throw fail('Missing recipient transfer');
    const shares=recipient.allocationsBps||{[recipient.role]:recipient.shareBps},denominator=BigInt(recipient.shareBps);
    const parts=ROLE_ORDER.filter(role=>shares[role]).map(role=>({role,value:value*BigInt(shares[role])/denominator,remainder:value*BigInt(shares[role])%denominator}));
    let dust=value-parts.reduce((sum,p)=>sum+p.value,0n);
    for(const part of [...parts].sort((a,b)=>a.remainder===b.remainder?ROLE_ORDER.indexOf(a.role)-ROLE_ORDER.indexOf(b.role):a.remainder>b.remainder?-1:1)){if(dust===0n)break;part.value++;dust--;}
    if(dust!==0n)throw fail('Recipient allocation could not be reconciled');
    for(const part of parts)totals[part.role]+=part.value;
  }
  return {totals,allocationMethod:recipients.some(r=>r.role==='combined')?'proportional_internal_largest_remainder_v1':'direct_onchain_transfers'};
}
function readInstructions(message,meta) {
  if(!message||![undefined,'legacy',0].includes(message.version)||typeof message.getAccountKeys!=='function')throw fail('Only legacy and v0 Solana messages are supported');
  let collection;try{collection=message.getAccountKeys({accountKeysFromLookups:meta.loadedAddresses});}catch{throw fail('Address lookup table account keys are missing or inconsistent');}
  if(!Number.isInteger(collection.length)||collection.length<1||collection.length>256)throw fail('Unsupported transaction account count');
  const keys=Array.from({length:collection.length},(_,i)=>collection.get(i));
  if(keys.some(k=>!(k instanceof PublicKey)))throw fail('Unsupported transaction account keys');
  const decode=ix=>{
    const indexes=Array.from(ix?.accountKeyIndexes??ix?.accounts??[]);
    if(!Number.isInteger(ix?.programIdIndex)||!keys[ix.programIdIndex]||indexes.some(i=>!Number.isInteger(i)||!keys[i]))throw fail('Invalid transaction instruction indexes');
    const data=typeof ix.data==='string'?base58Decode(ix.data):Buffer.from(ix.data??[]);
    if(data.length>1232)throw fail('Unsupported instruction size');
    return {programId:keys[ix.programIdIndex],indexes,keys:indexes.map(i=>keys[i]),data,stackHeight:ix.stackHeight};
  };
  const instructions=message.compiledInstructions??message.instructions;
  if(!Array.isArray(instructions)||!instructions.length||instructions.length>64)throw fail('Unsupported transaction instructions');
  return {keys,decode,instructions:instructions.map(decode)};
}
async function verifyDistribution({transaction,signature,instructionIndex,mint,config,creator=null}) {
  const recipients=feeRecipients(config,creator),recipientCount=recipients.length;
  if(transaction?.transaction?.signatures?.[0]!==signature||!transaction.meta||transaction.meta.err!==null||!Number.isSafeInteger(transaction.slot)||transaction.slot<0)throw fail('The finalized transaction is missing, failed, or does not match the signature');
  const {message}=transaction.transaction,meta=transaction.meta,parsed=readInstructions(message,meta),ix=parsed.instructions[instructionIndex];
  if(!ix||!ix.programId.equals(pump.PUMP_PROGRAM_ID))throw fail('The selected instruction is not a Pump creator-fee distribution');
  const name=DISTRIBUTIONS.get(ix.data.subarray(0,8).toString('hex'));
  const v2=name==='distribute_creator_fees_v2';
  if(!name||ix.data.length!==(v2?9:8)||v2&&![0,1].includes(ix.data[8]))throw fail('Only direct SOL distribute_creator_fees or distribute_creator_fees_v2 receipts are supported');
  const groups=meta.innerInstructions;
  if(!Array.isArray(groups)||groups.filter(group=>group.index===instructionIndex).length!==1)throw fail('The distribution CPI evidence is missing or ambiguous');
  const rawInner=groups.find(group=>group.index===instructionIndex).instructions;
  if(!Array.isArray(rawInner)||rawInner.length!==recipientCount+1)throw fail('The distribution must contain exactly one SOL transfer per configured recipient and one event');
  const inner=rawInner.map(parsed.decode);
  if(inner.some(child=>child.stackHeight!==2))throw fail('Nested or unscoped distributions are not supported');
  const events=inner.filter(child=>child.programId.equals(pump.PUMP_PROGRAM_ID)&&child.data.subarray(0,8).equals(EVENT_TAG)&&child.data.subarray(8,16).equals(EVENT_DISCRIMINATOR));
  if(events.length!==1||events[0].keys.length!==1||!events[0].keys[0].equals(pump.PUMP_EVENT_AUTHORITY_PDA))throw fail('A canonical Pump distribution event is required');
  // SDK 4.0.0 event: 180 fixed bytes plus 34 per (pubkey,u16) shareholder.
  const eventBytes=events[0].data.subarray(16);
  if(eventBytes.length!==180+34*recipientCount||eventBytes.readUInt32LE(136)!==recipientCount)throw fail('This historical or extended event layout is not supported');
  let event;try{event=pump.PUMP_SDK.decodeDistributeCreatorFeesEvent(eventBytes);}catch{throw fail('The Pump distribution event could not be decoded');}
  const mintKey=publicKey(mint,'project mint'),sharingConfig=pump.feeSharingConfigPda(mintKey),vault=pump.creatorVaultPda(sharingConfig),curve=pump.bondingCurvePda(mintKey);
  if(!event.mint.equals(mintKey)||!event.bondingCurve?.equals(curve)||!event.sharingConfig.equals(sharingConfig)||![NATIVE_MINT.toBase58(),PublicKey.default.toBase58()].includes(event.quoteMint.toBase58()))throw fail('The event mint, quote asset, or canonical fee source does not match this project');
  const configuredShares=new Map(recipients.map(r=>[r.address,r.shareBps]));
  const addresses=event.shareholders.map(s=>s.address.toBase58());
  if(new Set(addresses).size!==recipientCount||event.shareholders.some(s=>configuredShares.get(s.address.toBase58())!==s.shareBps))throw fail('The event recipients or fee shares do not match the operator configuration');
  const common={mint:mintKey,sharingConfig:{shareholders:event.shareholders},sharingConfigAddress:sharingConfig};
  const expected=v2?await pump.PUMP_SDK.distributeCreatorFeesV2({...common,quoteMint:NATIVE_MINT,payer:ix.keys[0],shouldInitializeAta:ix.data[8]===1,quoteTokenProgram:TOKEN_PROGRAM_ID}):await pump.PUMP_SDK.distributeCreatorFees(common);
  if(expected.keys.length!==ix.keys.length||expected.keys.some((account,i)=>!account.pubkey.equals(ix.keys[i])||account.isWritable&&!message.isAccountWritable(ix.indexes[i])||account.isSigner&&!message.isAccountSigner(ix.indexes[i])))throw fail('The distribution instruction accounts do not match the official SDK and configured fee source');
  const transfers=inner.filter(child=>child.programId.equals(SystemProgram.programId));
  if(transfers.length!==recipientCount)throw fail('Exact SOL transfer evidence is required; balance changes alone are not fee receipts');
  const received=new Map();
  for(const transfer of transfers){
    if(transfer.keys.length!==2||!transfer.keys[0].equals(vault)||transfer.data.length!==12||transfer.data.readUInt32LE(0)!==2)throw fail('The receipt contains an unsupported transfer or fee source');
    const recipient=transfer.keys[1].toBase58(),lamports=transfer.data.readBigUInt64LE(4);
    if(!configuredShares.has(recipient)||received.has(recipient)||lamports<=0n)throw fail('The receipt contains an unexpected, repeated, or empty recipient payment');
    received.set(recipient,lamports);
  }
  const total=BigInt(event.distributed.toString());
  if(total<=0n||[...received.values()].reduce((sum,value)=>sum+value,0n)!==total)throw fail('Transferred lamports do not sum to the Pump event distribution');
  // Splitting integer lamports can leave at most N-1 lamports of dust for a
  // recipient. Exact CPI amounts and their total remain the credited evidence.
  for(const [recipient,bps] of configuredShares){const floor=total*BigInt(bps)/10000n,actual=received.get(recipient);if(actual<floor||actual>floor+BigInt(recipientCount-1))throw fail('Transferred lamports do not match the configured proportional split');}
  const {totals,allocationMethod}=allocateTransfers(recipients,received),onChainTransfers=recipients.map(r=>({address:r.address,shareBps:r.shareBps,lamports:received.get(r.address).toString()}));
  return {signature,instructionIndex,cluster:'mainnet-beta',slot:transaction.slot,finalized:true,mint,source:'pump_creator_fee_distribution',instruction:name,sharingConfig:sharingConfig.toBase58(),creatorVault:vault.toBase58(),platformTreasury:config.platformTreasury,computeTreasury:config.computeTreasury,creatorWallet:config.splitBps.creator?creator:null,splitBps:structuredClone(config.splitBps),receivedLamports:total.toString(),platformLamports:totals.platform.toString(),computeLamports:totals.compute.toString(),creatorLamports:totals.creator.toString(),allocationMethod,onChainTransfers,messageHash:hash(Buffer.from(message.serialize())),explorerUrl:'https://solscan.io/tx/'+signature};
}
function storageError(){return fail('Fee receipt history is unreadable or changed; reconciliation is paused and existing files are preserved',503,'FEE_STORAGE_UNAVAILABLE');}
function decodeState(bytes) {
  const state=JSON.parse(bytes.toString('utf8'));
  if(state?.version!==1||!Array.isArray(state.receipts)||state.receipts.length>MAX_RECEIPTS)throw storageError();
  const ids=new Set();
  for(const receipt of state.receipts){
    if(!receipt||typeof receipt.owner!=='string'||!receipt.owner||receipt.owner.length>200||!uuid(receipt.projectId)||receipt.cluster!=='mainnet-beta'||receipt.finalized!==true||!Number.isInteger(receipt.instructionIndex)||receipt.instructionIndex<0||receipt.instructionIndex>63||!Number.isSafeInteger(receipt.slot)||!Number.isFinite(receipt.verifiedAt)||!amount(receipt.receivedLamports)||!amount(receipt.platformLamports)||!amount(receipt.computeLamports)||!amount(receipt.creatorLamports??'0')||BigInt(receipt.receivedLamports)!==BigInt(receipt.platformLamports)+BigInt(receipt.computeLamports)+BigInt(receipt.creatorLamports??'0')||!/^[a-f0-9]{64}$/.test(receipt.messageHash)||!/^[a-f0-9]{64}$/.test(receipt.configHash))throw storageError();
    signatureBytes(receipt.signature);publicKey(receipt.mint);publicKey(receipt.platformTreasury);publicKey(receipt.computeTreasury);
    if(receipt.splitBps?.creator||BigInt(receipt.creatorLamports??'0')>0n)feeRecipients(receipt,receipt.creatorWallet);
    if(receipt.allocationMethod!==undefined||receipt.onChainTransfers!==undefined){
      const config=normalizeConfig({platformTreasury:receipt.platformTreasury,computeTreasury:receipt.computeTreasury,splitBps:receipt.splitBps}),recipients=feeRecipients(config,receipt.creatorWallet),expected=new Map(recipients.map(r=>[r.address,r.shareBps])),received=new Map();
      if(!Array.isArray(receipt.onChainTransfers)||receipt.onChainTransfers.length!==recipients.length)throw storageError();
      for(const transfer of receipt.onChainTransfers){
        if(!transfer||Object.keys(transfer).sort().join(',')!=='address,lamports,shareBps'||expected.get(transfer.address)!==transfer.shareBps||received.has(transfer.address)||!amount(transfer.lamports)||BigInt(transfer.lamports)<=0n)throw storageError();
        received.set(transfer.address,BigInt(transfer.lamports));
      }
      const total=BigInt(receipt.receivedLamports);
      if([...received.values()].reduce((sum,value)=>sum+value,0n)!==total)throw storageError();
      for(const [address,bps] of expected){const floor=total*BigInt(bps)/10000n,value=received.get(address);if(value<floor||value>floor+BigInt(recipients.length-1))throw storageError();}
      const {totals,allocationMethod}=allocateTransfers(recipients,received);
      if(receipt.allocationMethod!==allocationMethod||ROLE_ORDER.some(role=>totals[role].toString()!==(receipt[role+'Lamports']??'0')))throw storageError();
    }else if(receipt.platformTreasury===receipt.computeTreasury||receipt.splitBps?.creator&&[receipt.platformTreasury,receipt.computeTreasury].includes(receipt.creatorWallet))throw storageError();
    const id=receipt.signature+':'+receipt.instructionIndex;if(ids.has(id))throw storageError();ids.add(id);
  }
  return state;
}
function createSolanaFeeAccountingService({stateDirectory,config=null,connection,now=Date.now,resolveProjectMint,resolveProjectCreator}={}) {
  if(typeof stateDirectory!=='string'||!stateDirectory)throw fail('A durable fee receipt directory is required',500,'INVALID_FEE_CONFIG');
  const operator=normalizeConfig(config);fs.mkdirSync(stateDirectory,{recursive:true,mode:0o700});
  const file=path.join(stateDirectory,FILE_NAME);let state={version:1,receipts:[]},diskHash=null,storageFault=false;
  if(fs.existsSync(file)){try{const bytes=fs.readFileSync(file);state=decodeState(bytes);diskHash=hash(bytes);}catch{throw storageError();}}
  const rpc=connection||new Connection(RPC_URL,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})});
  function assertStorage(){if(storageFault)throw storageError();try{if((fs.existsSync(file)?hash(fs.readFileSync(file)):null)!==diskHash)throw Error();}catch{storageFault=true;throw storageError();}}
  function save(){assertStorage();const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{const bytes=JSON.stringify(state);decodeState(Buffer.from(bytes));fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);diskHash=hash(bytes);}catch{storageFault=true;throw storageError();}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
  const publicReceipt=receipt=>{const {owner,configHash,...rest}=receipt;return structuredClone(rest);};
  function configuration(){return {status:operator?'configured':'inactive',cluster:'mainnet-beta',asset:'SOL',platformMint:operator?.platformMint??null,platformTreasury:operator?.platformTreasury??null,computeTreasury:operator?.computeTreasury??null,sharedTreasury:!!operator&&operator.platformTreasury===operator.computeTreasury,splitBps:operator?.splitBps?structuredClone(operator.splitBps):null,creatorShareBps:operator?.splitBps.creator??0,creatorRecipientSource:'verified_project_owner',readOnly:true,onChainConfigurationVerified:false,providerCreditsUsd:0,allocationMeaning:'Roles sharing a wallet are internal accounting allocations of one on-chain transfer, not separate reserves or provider credit',reason:operator?'Receipt verification configured; this service does not configure or claim on-chain fees':'Operator treasury addresses, shares, and project sources have not been configured'};}
  function summary({projectId,owner}={}) {
    if(!uuid(projectId))throw fail('Choose a saved project',400,'INVALID_FEE_INPUT');assertStorage();
    const rows=state.receipts.filter(r=>r.projectId===projectId),sum=field=>rows.reduce((n,r)=>n+BigInt(r[field]??'0'),0n).toString();
    const receivedLamports=sum('receivedLamports'),platformLamports=sum('platformLamports'),computeLamports=sum('computeLamports'),creatorLamports=sum('creatorLamports');
    const mapped=operator?.projects.some(p=>p.projectId===projectId);
    const includesInternalAllocations=rows.some(r=>r.allocationMethod==='proportional_internal_largest_remainder_v1');
    return {status:operator?'configured':'inactive',asset:'SOL',receivedLamports,receivedSol:sol(receivedLamports),platformLamports,platformSol:sol(platformLamports),computeLamports,computeSol:sol(computeLamports),creatorLamports,creatorSol:sol(creatorLamports),includesInternalAllocations,allocationMeaning:includesInternalAllocations?'Role totals include internal allocations of shared-wallet transfers; no separate AI reserve or provider credit is established':'Role totals follow verified on-chain recipient transfers',providerCreditsUsd:0,receiptCount:rows.length,receipts:owner?rows.filter(r=>r.owner===owner).map(publicReceipt):[],reason:!operator?configuration().reason:!mapped?'No operator-approved fee source is mapped to this project':'Verified lifetime distributions; these are not current wallet balances or spendable provider credits'};
  }
  async function reconcile({owner,projectId,mint,signature,instructionIndex}={}) {
    assertStorage();if(!operator)throw fail(configuration().reason,409,'FEE_CONFIG_INACTIVE');
    if(typeof owner!=='string'||!owner||owner.length>200||!uuid(projectId)||!Number.isInteger(instructionIndex)||instructionIndex<0||instructionIndex>63)throw fail('Owner, saved project, signature and exact instruction index are required',400,'INVALID_FEE_INPUT');
    publicKey(mint,'project mint');signatureBytes(signature);
    const existing=()=>state.receipts.find(r=>r.signature===signature&&r.instructionIndex===instructionIndex);
    const duplicate=()=>{const receipt=existing();if(!receipt)return null;if(receipt.owner!==owner||receipt.projectId!==projectId||receipt.mint!==mint)throw fail('This distribution already belongs to another project or creator',409,'FEE_RECEIPT_ALREADY_ATTRIBUTED');return {receipt:publicReceipt(receipt),duplicate:true,fees:summary({projectId,owner})};};
    const old=duplicate();if(old)return old;
    if(!operator.projects.some(p=>p.projectId===projectId&&p.sourceMint===mint)&&await resolveProjectMint?.(projectId)!==mint)throw fail('No operator-approved fee source matches this project mint',409,'FEE_SOURCE_UNCONFIGURED');
    const creator=operator.splitBps.creator?await resolveProjectCreator?.(projectId,mint):null;
    feeRecipients(operator,creator);
    if(await rpc.getGenesisHash()!==GENESIS_HASH)throw fail('Fee receipts require the verified Solana mainnet genesis',503,'WRONG_CLUSTER');
    const status=(await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true})).value?.[0];
    if(!status||status.confirmationStatus!=='finalized')throw fail('Wait for the distribution transaction to finalize',409,'FEE_RECEIPT_NOT_FINALIZED');
    if(status.err!==null)throw fail('A failed transaction cannot be reconciled as fees');
    const transaction=await rpc.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    if(!transaction||transaction.slot!==status.slot)throw fail('The finalized transaction and signature status do not match');
    const verified=await verifyDistribution({transaction,signature,instructionIndex,mint,config:operator,creator});
    assertStorage();const raced=duplicate();if(raced)return raced;
    if(state.receipts.length>=MAX_RECEIPTS)throw fail('Fee receipt history is full; operator archival is required',429,'FEE_HISTORY_FULL');
    const receipt={...verified,owner,projectId,verifiedAt:now(),configHash:hash(JSON.stringify(operator))};state.receipts.push(receipt);save();
    return {receipt:publicReceipt(receipt),duplicate:false,fees:summary({projectId,owner})};
  }
  return {config:configuration,summary,reconcile};
}
module.exports={createSolanaFeeAccountingService,normalizeConfig,feeRecipients,FILE_NAME,GENESIS_HASH,RPC_URL};

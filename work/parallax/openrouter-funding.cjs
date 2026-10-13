'use strict';
// OpenRouter removed its programmatic Coinbase charge endpoint. Purchases take
// place in its web checkout; this service allocates EXISTING authenticated USD
// credit to projects. It does not convert SOL, accept deposits or prove payment
// by a particular project owner. allocate() is strictly an operator capability.
const crypto=require('node:crypto');
const {createFundingStore,hash}=require('./funding-store.cjs');
const {usdToNano,nanoToUsd}=require('./compute-ledger.cjs');
const CREDITS_URL='https://openrouter.ai/api/v1/credits',CHECKOUT_URL='https://openrouter.ai/settings/credits',FILE_NAME='openrouter-funding.json';
const fail=(message,status=400,code='PROVIDER_FUNDING_INVALID')=>Object.assign(new Error(message),{status,code});
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const project=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const nano=v=>typeof v==='string'&&/^(0|[1-9]\d{0,18})$/.test(v);
function creditNano(value){
  const rounded=usdToNano(value),match=/^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(String(value));
  const fraction=match?.[2]||'',power=9+Number(match?.[3]||0)-fraction.length,digits=BigInt((match?.[1]||'0')+fraction);
  return power<0&&digits%10n**BigInt(-power)!==0n?rounded-1n:rounded;
}
function validate(s){
  if(s?.version!==1||!Array.isArray(s.allocations)||s.allocations.length>10000||!Array.isArray(s.snapshots)||s.snapshots.length>1000)throw Error();
  const ids=new Set(),receipts=new Set(),snapshots=new Set();
  for(const r of s.snapshots){if(!id(r.id)||snapshots.has(r.id)||!id(r.accountId)||!nano(r.totalCreditsNanoUsd)||!nano(r.totalUsageNanoUsd)||!Number.isFinite(r.checkedAt)||!/^[a-f0-9]{64}$/.test(r.evidenceHash))throw Error();snapshots.add(r.id);}
  for(const a of s.allocations){if(!id(a.eventId)||ids.has(a.eventId)||!id(a.receiptRef)||receipts.has(a.receiptRef)||!project(a.projectId)||!id(a.operator)||!id(a.accountId)||!nano(a.amountNanoUsd)||BigInt(a.amountNanoUsd)<=0n||!Number.isFinite(a.createdAt)||!['reserved','credited'].includes(a.status)||!snapshots.has(a.snapshotId))throw Error();ids.add(a.eventId);receipts.add(a.receiptRef);}
}
function createOpenRouterFundingService({stateDirectory,managementKey='',accountId='',getLedger,fetchImpl=fetch,now=Date.now}={}){
  if(accountId&&!id(accountId))throw fail('Configure a stable OpenRouter account identifier',500);
  const store=createFundingStore({directory:stateDirectory,name:FILE_NAME,initial:{version:1,allocations:[],snapshots:[]},validate});let serial=Promise.resolve();
  function lock(fn){const next=serial.then(fn);serial=next.catch(()=>{});return next;}
  function config(){return {provider:'openrouter',status:managementKey&&accountId?'configured':'inactive',accountId:accountId||null,purchaseUrl:CHECKOUT_URL,automaticSolConversion:false,automaticCryptoTopup:false,requiresManagementKey:true,reason:managementKey&&accountId?'Operator allocations are bounded by authenticated existing provider credits':'Configure an OpenRouter management key and stable account identifier for credit reconciliation'};}
  function active(){if(config().status!=='configured')throw fail(config().reason,503,'PROVIDER_FUNDING_INACTIVE');}
  function ledger(){const value=getLedger?.();if(!value?.providerFundingTotals||!value?.addProviderCredit)throw fail('Compute ledger is not connected',503,'PROVIDER_LEDGER_UNAVAILABLE');return value;}
  async function readProvider(){
    active();let response;
    try{response=await fetchImpl(CREDITS_URL,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+managementKey,Accept:'application/json'},signal:AbortSignal.timeout(12000)});}catch{throw fail('OpenRouter credits could not be verified; no credit was allocated',503,'PROVIDER_UNAVAILABLE');}
    if(!response.ok)throw fail(response.status===401||response.status===403?'OpenRouter rejected credit access; a management key is required':'OpenRouter credits could not be verified',503,'PROVIDER_UNAVAILABLE');
    let payload;try{const text=await response.text();if(text.length>32768)throw Error();payload=JSON.parse(text);}catch{throw fail('OpenRouter returned invalid credit evidence',503,'PROVIDER_EVIDENCE_INVALID');}
    // Floor purchased credit, ceil usage: precision never creates spendable money.
    const credits=payload?.data?.total_credits,usage=payload?.data?.total_usage;
    if(!['number','string'].includes(typeof credits)||!['number','string'].includes(typeof usage))throw fail('OpenRouter credit totals are missing',503,'PROVIDER_EVIDENCE_INVALID');
    let c,u;try{c=creditNano(credits);u=usdToNano(usage);}catch{throw fail('OpenRouter credit totals are invalid',503,'PROVIDER_EVIDENCE_INVALID');}
    return {id:crypto.randomUUID(),accountId,totalCreditsNanoUsd:c.toString(),totalUsageNanoUsd:u.toString(),checkedAt:now(),evidenceHash:hash(JSON.stringify({accountId,credits,usage}))};
  }
  function persistSnapshot(s,snapshot){
    // Keep snapshots that back allocations; remove only unreferenced history.
    if(s.snapshots.length>=1000){const linked=new Set(s.allocations.map(a=>a.snapshotId)),index=s.snapshots.findIndex(r=>!linked.has(r.id));if(index<0)throw fail('Provider evidence history is full',429);s.snapshots.splice(index,1);}
    s.snapshots.push(snapshot);store.write(s);
  }
  async function refresh(){return lock(async()=>{const snapshot=await readProvider(),s=store.read();persistSnapshot(s,snapshot);return summary();});}
  function summary(){
    const s=store.read(),snapshot=s.snapshots.filter(x=>x.accountId===accountId).at(-1),rows=s.allocations.filter(a=>a.accountId===accountId),allocated=rows.reduce((n,a)=>n+BigInt(a.amountNanoUsd),0n);
    const totals=getLedger?.()?.providerFundingTotals?.({eventIds:rows.map(a=>a.eventId)})??{spentNanoUsd:'0',grantedNanoUsd:'0',matchedGrantedNanoUsd:'0'},spent=BigInt(totals.spentNanoUsd);
    // Old provider grants not recorded here remain liabilities, not free credit.
    const prior=BigInt(totals.grantedNanoUsd)-BigInt(totals.matchedGrantedNanoUsd),outstanding=allocated+prior>spent?allocated+prior-spent:0n;
    const credits=BigInt(snapshot?.totalCreditsNanoUsd??'0'),usage=BigInt(snapshot?.totalUsageNanoUsd??'0'),remaining=credits>usage?credits-usage:0n;
    const lifetime=credits>allocated+prior?credits-allocated-prior:0n,backed=remaining>outstanding?remaining-outstanding:0n,allocatable=lifetime<backed?lifetime:backed;
    return {...config(),checkedAt:snapshot?.checkedAt??null,stale:!snapshot||now()-snapshot.checkedAt>60000,providerRemainingUsd:nanoToUsd(remaining),providerRemainingNanoUsd:remaining.toString(),allocatedUsd:nanoToUsd(allocated),outstandingUsd:nanoToUsd(outstanding),allocatableUsd:nanoToUsd(allocatable),allocatableNanoUsd:allocatable.toString(),shortfallUsd:nanoToUsd(outstanding>remaining?outstanding-remaining:0n),allocationCount:rows.length,meaning:'Operator allocation of a shared provider balance; not customer payment verification or reserved provider funds'};
  }
  async function verifyProviderFunding({projectId,eventId,receiptRef,amountNanoUsd}={}){
    const s=store.read(),a=s.allocations.find(a=>a.eventId===eventId&&a.projectId===projectId&&a.receiptRef===receiptRef&&a.amountNanoUsd===amountNanoUsd);
    if(!a||a.accountId!==accountId||!s.snapshots.some(r=>r.id===a.snapshotId&&r.accountId===accountId))return {verified:false};
    return {verified:true,projectId,receiptRef,amountNanoUsd};
  }
  async function deliver(a){
    const grant=await ledger().addProviderCredit({projectId:a.projectId,eventId:a.eventId,amountUsd:nanoToUsd(a.amountNanoUsd),receiptRef:a.receiptRef,source:'provider_funding'});
    if(grant.status!=='credited')return {...a,status:'reserved'};
    const s=store.read(),row=s.allocations.find(r=>r.eventId===a.eventId);row.status='credited';row.creditedAt=now();store.write(s);return structuredClone(row);
  }
  async function allocate({projectId,eventId,amountUsd,operator}={}){return lock(async()=>{
    active();if(!project(projectId)||!id(eventId)||!id(operator))throw fail('Operator, project and unique allocation event are required');const amount=usdToNano(amountUsd);if(amount<=0n)throw fail('Allocate a positive USD amount');
    let s=store.read(),previous=s.allocations.find(a=>a.eventId===eventId);
    if(previous){if(previous.accountId!==accountId||previous.projectId!==projectId||previous.amountNanoUsd!==amount.toString()||previous.operator!==operator)throw fail('Allocation event already belongs to different evidence',409,'PROVIDER_ALLOCATION_CONFLICT');return deliver(previous);}
    if(s.allocations.some(a=>a.accountId!==accountId))throw fail('Funding account changed; reconcile the existing account before allocating',409,'PROVIDER_ACCOUNT_CHANGED');
    if(s.allocations.length>=10000)throw fail('Provider allocation history is full',429);
    const snapshot=await readProvider();s=store.read();persistSnapshot(s,snapshot);
    if(amount>BigInt(summary().allocatableNanoUsd))throw fail('The verified provider balance cannot back this allocation',402,'PROVIDER_CREDITS_INSUFFICIENT');
    s=store.read();const a={projectId,eventId,operator,accountId,receiptRef:'openrouter:'+crypto.randomUUID(),amountNanoUsd:amount.toString(),snapshotId:snapshot.id,createdAt:now(),status:'reserved'};s.allocations.push(a);store.write(s);
    // Reserve before delivery: a crash between ledgers is replayed using the
    // same receipt, never by inventing a second allocation.
    return deliver(a);
  });}
  async function recover(){return lock(async()=>{active();const rows=store.read().allocations.filter(a=>a.accountId===accountId&&a.status==='reserved'),results=[];for(const row of rows)results.push(await deliver(row));return results;});}
  function assertBacked({provider='openrouter'}={}){if(provider!=='openrouter')throw fail('OpenRouter credit cannot pay another provider',409,'PROVIDER_BACKING_MISMATCH');const s=summary();if(s.stale)throw fail('Refresh authenticated provider credit evidence before funded compute',503,'PROVIDER_EVIDENCE_STALE');if(usdToNano(s.shortfallUsd)>0n)throw fail('Shared provider credit is below project liabilities; replenish and reconcile before funded compute',402,'PROVIDER_BACKING_SHORTFALL');return true;}
  return {config,refresh,summary,allocate,verifyProviderFunding,recover,assertBacked};
}
module.exports={createOpenRouterFundingService,CREDITS_URL,CHECKOUT_URL,FILE_NAME};

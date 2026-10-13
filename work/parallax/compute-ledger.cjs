'use strict';

// Internal USD compute allowances. SOL receipts and token revenue never enter
// this ledger automatically. All arithmetic is integer nano-USD (one billionth
// of a dollar); sub-nano provider amounts round upward once at the boundary.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SCALE=1000000000n,MAX_NANO=1000000000n*SCALE;
const FILE_NAME='compute-ledger.json';
const LIMITS={projects:500,grants:10000,reservations:20000,events:50000};
const PURPOSES=['planning','concept','thumbnail','visual_review'];
const fail=(message,status=400,code='COMPUTE_LEDGER_INVALID')=>Object.assign(new Error(message),{status,code});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const storageError=()=>fail('Compute accounting is unavailable or changed; paid work is paused and existing records are preserved',503,'COMPUTE_STORAGE_UNAVAILABLE');
const identifier=(value,label)=>{
  if(typeof value!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value))throw fail('A valid '+label+' is required');
  return value;
};
function project(value){if(typeof value!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))throw fail('A valid project ID is required');return value;}
function usdToNano(value) {
  if(typeof value==='number'){if(!Number.isFinite(value)||value<0)throw fail('A nonnegative finite USD amount is required');value=String(value);}
  if(typeof value!=='string'||value.length>100)throw fail('A bounded decimal USD amount is required');
  const match=/^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if(!match)throw fail('A decimal USD amount is required');
  const fraction=match[2]||'',exponent=Number(match[3]||0),digits=BigInt(match[1]+fraction),power=9+exponent-fraction.length;
  if(power>30||power< -200)throw fail('USD amount precision exceeds the supported range');
  const result=power>=0?digits*10n**BigInt(power):(digits+10n**BigInt(-power)-1n)/10n**BigInt(-power);
  if(result>MAX_NANO)throw fail('USD amount exceeds the supported accounting range');
  return result;
}
function nanoToUsd(value) {
  let n=BigInt(value),sign='';if(n<0n){sign='-';n=-n;}
  const fraction=(n%SCALE).toString().padStart(9,'0').replace(/0+$/,'');
  return sign+(n/SCALE).toString()+(fraction?'.'+fraction:'');
}
const nano=value=>typeof value==='string'&&/^(0|[1-9]\d{0,18})$/.test(value)&&BigInt(value)<=MAX_NANO;
const day=at=>new Date(at).toISOString().slice(0,10);

function decode(bytes) {
  const state=JSON.parse(bytes.toString('utf8'));
  if(state?.version!==1||state.scale!=='1000000000'||!Array.isArray(state.grants)||!Array.isArray(state.reservations)||!Array.isArray(state.events)||state.grants.length>LIMITS.grants||state.reservations.length>LIMITS.reservations||state.events.length>LIMITS.events)throw storageError();
  const projects=new Set(),grantIds=new Set(),receipts=new Set(),operationIds=new Set(),eventIds=new Set();
  for(const row of state.grants){
    project(row.projectId);identifier(row.eventId,'grant event ID');projects.add(row.projectId);
    if(grantIds.has(row.eventId)||!['sponsored_development','provider_funding'].includes(row.source)||!['credited','pending'].includes(row.status)||!nano(row.amountNanoUsd)||BigInt(row.amountNanoUsd)<=0n||!Number.isFinite(row.createdAt)||row.status==='credited'&&!Number.isFinite(row.creditedAt))throw storageError();
    grantIds.add(row.eventId);
    if(row.source==='sponsored_development'){
      if(row.status!=='credited'||!/^\d{4}-\d{2}-\d{2}$/.test(row.day)||row.eventId!==`sponsor:${row.projectId}:${row.day}`||row.day!==day(row.createdAt))throw storageError();
    }else{
      identifier(row.receiptRef,'provider receipt reference');if(receipts.has(row.receiptRef))throw storageError();receipts.add(row.receiptRef);
      if(row.status==='credited'&&row.verification!=='authenticated_provider')throw storageError();
    }
  }
  for(const row of state.reservations){
    project(row.projectId);project(row.buildId);identifier(row.operationId,'operation ID');identifier(row.provider,'provider');projects.add(row.projectId);
    if(operationIds.has(row.operationId)||!PURPOSES.includes(row.purpose)||!['reserved','unknown','settled'].includes(row.status)||!nano(row.estimateNanoUsd)||BigInt(row.estimateNanoUsd)<=0n||!Number.isFinite(row.createdAt))throw storageError();
    operationIds.add(row.operationId);
    if(row.status==='settled'){if(!nano(row.actualNanoUsd)||!Number.isFinite(row.settledAt))throw storageError();}
    else if(row.actualNanoUsd!==null)throw storageError();
    if(row.status==='unknown'&&!Number.isFinite(row.unknownAt))throw storageError();
    if(!Array.isArray(row.allocations)||!row.allocations.length||!nano(row.unfundedNanoUsd))throw storageError();
    const allocationIds=new Set();let allocated=0n;
    for(const allocation of row.allocations){
      const grant=state.grants.find(grant=>grant.eventId===allocation.grantEventId);
      if(!grant||grant.projectId!==row.projectId||grant.status!=='credited'||allocationIds.has(grant.eventId)||!nano(allocation.amountNanoUsd))throw storageError();
      allocationIds.add(grant.eventId);allocated+=BigInt(allocation.amountNanoUsd);
    }
    if(allocated+BigInt(row.unfundedNanoUsd)!==BigInt(row.status==='settled'?row.actualNanoUsd:row.estimateNanoUsd))throw storageError();
  }
  for(const grant of state.grants){const used=state.reservations.reduce((sum,row)=>sum+row.allocations.filter(a=>a.grantEventId===grant.eventId).reduce((n,a)=>n+BigInt(a.amountNanoUsd),0n),0n);if(used>BigInt(grant.amountNanoUsd))throw storageError();}
  for(const row of state.events){
    project(row.projectId);identifier(row.eventId,'accounting event ID');
    if(eventIds.has(row.eventId)||!Number.isFinite(row.at)||!['sponsored_credit','funding_pending','provider_credit','reserved','settled','unknown','debt_covered'].includes(row.type)||!nano(row.amountNanoUsd))throw storageError();
    eventIds.add(row.eventId);
  }
  if(projects.size>LIMITS.projects)throw storageError();
  return state;
}

function createComputeLedger({stateDirectory,now=Date.now,sponsorDailyUsd=1,verifyProviderFunding,providerFundingGuard}={}){
  if(typeof stateDirectory!=='string'||!stateDirectory)throw fail('Durable compute storage is required',500);
  const sponsorNano=usdToNano(sponsorDailyUsd);if(sponsorNano>SCALE)throw fail('The development sponsor allowance cannot exceed $1 per project per UTC day');
  fs.mkdirSync(stateDirectory,{recursive:true,mode:0o700});const file=path.join(stateDirectory,FILE_NAME);
  let state={version:1,scale:SCALE.toString(),grants:[],reservations:[],events:[]},diskHash=null,storageFault=false;
  if(fs.existsSync(file)){try{const bytes=fs.readFileSync(file);state=decode(bytes);diskHash=digest(bytes);}catch{throw storageError();}}
  function assertStorage(){
    if(storageFault)throw storageError();
    try{const current=fs.existsSync(file)?digest(fs.readFileSync(file)):null;if(current!==diskHash)throw storageError();}catch{storageFault=true;throw storageError();}
  }
  function save(next){
    assertStorage();const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;
    try{const bytes=JSON.stringify(next);decode(Buffer.from(bytes));fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);diskHash=digest(bytes);state=next;}
    catch{storageFault=true;throw storageError();}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  function addEvent(next,projectId,type,amountNanoUsd,details={}){
    if(next.events.length>=LIMITS.events)throw fail('Compute accounting history is full',429,'COMPUTE_LEDGER_LIMIT');
    next.events.push({eventId:crypto.randomUUID(),projectId,type,amountNanoUsd,at:now(),...details});
  }
  function ensureProjectCapacity(next,projectId){
    const projects=new Set([...next.grants,...next.reservations].map(row=>row.projectId));
    if(!projects.has(projectId)&&projects.size>=LIMITS.projects)throw fail('Compute project accounting is full',429,'COMPUTE_LEDGER_LIMIT');
  }
  function totals(projectId,source=state){
    const result={totalGranted:0n,sponsored:0n,providerFunded:0n,pendingFunding:0n,spent:0n,reserved:0n,unknownCharge:0n,sponsoredToday:0n,expiredSponsored:0n};let unknownChargeCount=0;
    for(const row of source.grants.filter(row=>row.projectId===projectId)){
      const amount=BigInt(row.amountNanoUsd);
      if(row.status==='pending'){result.pendingFunding+=amount;continue;}
      result.totalGranted+=amount;
      if(row.source==='sponsored_development'){
        result.sponsored+=amount;
        if(row.day===day(now()))result.sponsoredToday+=amount;
        else result.expiredSponsored+=amount-usedGrant(row.eventId,source);
      }else result.providerFunded+=amount;
    }
    for(const row of source.reservations.filter(row=>row.projectId===projectId)){
      if(row.status==='settled')result.spent+=BigInt(row.actualNanoUsd);
      else if(row.status==='reserved')result.reserved+=BigInt(row.estimateNanoUsd);
      else {result.unknownCharge+=BigInt(row.estimateNanoUsd);unknownChargeCount++;}
    }
    result.balance=result.totalGranted-result.expiredSponsored-result.spent-result.reserved-result.unknownCharge;
    result.available=result.balance>0n?result.balance:0n;
    result.overdrawn=result.balance<0n?-result.balance:0n;
    return {amounts:result,unknownChargeCount};
  }
  function usedGrant(eventId,source=state){return source.reservations.reduce((sum,row)=>sum+row.allocations.filter(a=>a.grantEventId===eventId).reduce((n,a)=>n+BigInt(a.amountNanoUsd),0n),0n);}
  function allocate(source,projectId,amount,{preferred=[]}={}){
    const rank=row=>{const index=preferred.indexOf(row.eventId);return index>=0?index:preferred.length+(row.source==='sponsored_development'?0:1);};
    const rows=source.grants.filter(row=>row.projectId===projectId&&row.status==='credited'&&(row.source==='provider_funding'||row.day===day(now())||preferred.includes(row.eventId)))
      .sort((a,b)=>rank(a)-rank(b)||a.createdAt-b.createdAt);
    const allocations=[];let remaining=amount;
    for(const row of rows){if(remaining===0n)break;const unused=BigInt(row.amountNanoUsd)-usedGrant(row.eventId,source),take=unused<remaining?unused:remaining;if(take>0n){allocations.push({grantEventId:row.eventId,amountNanoUsd:take.toString()});remaining-=take;}}
    return {allocations,unfundedNanoUsd:remaining.toString()};
  }
  function coverDebt(next,projectId){
    const debts=next.reservations.filter(row=>row.projectId===projectId&&row.status==='settled'&&BigInt(row.unfundedNanoUsd)>0n).sort((a,b)=>a.createdAt-b.createdAt);
    for(const row of debts){
      const owed=BigInt(row.unfundedNanoUsd),result=allocate(next,projectId,owed,{preferred:row.allocations.map(a=>a.grantEventId)}),covered=owed-BigInt(result.unfundedNanoUsd);
      if(covered===0n)continue;
      for(const allocation of result.allocations){
        const previous=row.allocations.find(a=>a.grantEventId===allocation.grantEventId);
        if(previous)previous.amountNanoUsd=(BigInt(previous.amountNanoUsd)+BigInt(allocation.amountNanoUsd)).toString();
        else row.allocations.push(allocation);
      }
      row.unfundedNanoUsd=result.unfundedNanoUsd;
      addEvent(next,projectId,'debt_covered',covered.toString(),{operationId:row.operationId,buildId:row.buildId,purpose:row.purpose,status:'settled',grantEventIds:result.allocations.map(a=>a.grantEventId)});
    }
  }
  function amountsView(amounts){const result={};for(const [name,value] of Object.entries(amounts)){result[name+'NanoUsd']=value.toString();result[name+'Usd']=nanoToUsd(value);}return result;}
  function reservationView(row){return {...structuredClone(row),estimateUsd:nanoToUsd(row.estimateNanoUsd),actualUsd:row.actualNanoUsd===null?null:nanoToUsd(row.actualNanoUsd)};}
  function grantView(row){const {receiptRef,...publicGrant}=row;return {...structuredClone(publicGrant),amountUsd:nanoToUsd(row.amountNanoUsd)};}
  function view(projectId){
    project(projectId);assertStorage();const {amounts,unknownChargeCount}=totals(projectId);
    return {projectId,currency:'USD',scale:1000000000,fundingMode:amounts.providerFunded>0n?'provider_funded':'sponsored_development',creditMeaning:amounts.providerFunded>0n?'Project allowance backed by authenticated provider credit when allocated; shared provider funds are not held in escrow':'Internal compute allowance, not token revenue or a confirmed provider balance',sponsorDailyUsd:nanoToUsd(sponsorNano),sponsorDailyNanoUsd:sponsorNano.toString(),sponsorExpiresAt:amounts.sponsoredToday>0n?Date.parse(day(now())+'T00:00:00Z')+86400000:null,...amountsView(amounts),unknownChargeCount,
      grants:state.grants.filter(row=>row.projectId===projectId).slice(-20).reverse().map(grantView),
      reservations:state.reservations.filter(row=>row.projectId===projectId).slice(-20).reverse().map(reservationView),
      events:state.events.filter(row=>row.projectId===projectId).slice(-30).reverse().map(row=>({...structuredClone(row),amountUsd:nanoToUsd(row.amountNanoUsd)}))};
  }
  function reserve({projectId,buildId,operationId,purpose,estimateUsd,provider}={}){
    project(projectId);project(buildId);identifier(operationId,'operation ID');identifier(provider,'provider');
    if(purpose==='plan')purpose='planning';if(!PURPOSES.includes(purpose))throw fail('Choose planning, concept, thumbnail or visual review compute');
    const estimate=usdToNano(estimateUsd);if(estimate<=0n)throw fail('A positive bounded compute estimate is required');assertStorage();
    const previous=state.reservations.find(row=>row.operationId===operationId);
    if(previous){
      if(previous.projectId!==projectId||previous.buildId!==buildId||previous.purpose!==purpose||previous.provider!==provider||previous.estimateNanoUsd!==estimate.toString())throw fail('This operation ID belongs to different compute work',409,'COMPUTE_OPERATION_CONFLICT');
      throw fail('This compute operation was already reserved; do not repeat the provider request',409,'COMPUTE_OPERATION_REUSED');
    }
    if(state.reservations.length>=LIMITS.reservations)throw fail('Compute reservation history is full',429,'COMPUTE_LEDGER_LIMIT');
    const next=structuredClone(state);ensureProjectCapacity(next,projectId);
    const today=day(now()),eventId=`sponsor:${projectId}:${today}`;
    if(sponsorNano>0n&&!next.grants.some(row=>row.eventId===eventId)){
      if(next.grants.length>=LIMITS.grants)throw fail('Compute credit history is full',429,'COMPUTE_LEDGER_LIMIT');
      next.grants.push({eventId,projectId,source:'sponsored_development',status:'credited',amountNanoUsd:sponsorNano.toString(),day:today,expiresAt:Date.parse(today+'T00:00:00Z')+86400000,createdAt:now(),creditedAt:now()});
      addEvent(next,projectId,'sponsored_credit',sponsorNano.toString(),{source:'sponsored_development',grantEventId:eventId});
    }
    // Repay recorded overages with actual grant allocations before permitting
    // new work. A balance-only deduction would revive debt when credits expire.
    coverDebt(next,projectId);
    if(estimate>totals(projectId,next).amounts.available)throw fail('The project has insufficient compute allowance for this request',402,'COMPUTE_CREDITS_EXHAUSTED');
    const allocation=allocate(next,projectId,estimate);if(allocation.unfundedNanoUsd!=='0')throw fail('The project has insufficient compute allowance for this request',402,'COMPUTE_CREDITS_EXHAUSTED');
    if(typeof providerFundingGuard==='function'&&allocation.allocations.some(a=>next.grants.find(g=>g.eventId===a.grantEventId)?.source==='provider_funding')){
      if(providerFundingGuard({projectId,provider,estimateNanoUsd:estimate.toString()})!==true)throw fail('Authenticated provider backing is not available',503,'PROVIDER_BACKING_UNAVAILABLE');
    }
    const row={projectId,buildId,operationId,purpose,provider,estimateNanoUsd:estimate.toString(),actualNanoUsd:null,status:'reserved',createdAt:now(),...allocation};next.reservations.push(row);
    addEvent(next,projectId,'reserved',estimate.toString(),{operationId,buildId,purpose,provider,status:'reserved'});save(next);return {...reservationView(row),created:true};
  }
  function settle({operationId,actualUsd}={}){
    identifier(operationId,'operation ID');const actual=actualUsd===null?null:usdToNano(actualUsd);assertStorage();
    const previous=state.reservations.find(row=>row.operationId===operationId);if(!previous)throw fail('Compute reservation not found',404,'COMPUTE_OPERATION_NOT_FOUND');
    if(previous.status==='settled'){
      if(actual===null||previous.actualNanoUsd!==actual.toString())throw fail('This operation already has a different recorded cost',409,'COMPUTE_SETTLEMENT_CONFLICT');
      return {...reservationView(previous),idempotent:true};
    }
    if(previous.status==='unknown'&&actual===null)return {...reservationView(previous),idempotent:true};
    const next=structuredClone(state),row=next.reservations.find(item=>item.operationId===operationId);
    if(actual===null){row.status='unknown';row.unknownAt=now();row.unknownReason='provider_cost_unknown';addEvent(next,row.projectId,'unknown',row.estimateNanoUsd,{operationId,buildId:row.buildId,purpose:row.purpose,status:'unknown',reason:row.unknownReason});}
    else {
      const oldAllocations=structuredClone(row.allocations),preferred=oldAllocations.map(a=>a.grantEventId);
      row.allocations=[];row.unfundedNanoUsd='0';
      Object.assign(row,allocate(next,row.projectId,actual,{preferred}));
      row.status='settled';row.actualNanoUsd=actual.toString();row.settledAt=now();
      // Keep a zero allocation for free/declined requests so grant provenance is
      // inspectable even though the entire estimate has been refunded.
      if(!row.allocations.length)row.allocations=[{grantEventId:preferred[0],amountNanoUsd:'0'}];
      addEvent(next,row.projectId,'settled',actual.toString(),{operationId,buildId:row.buildId,purpose:row.purpose,status:'settled',reconciledUnknown:previous.status==='unknown'});
      coverDebt(next,row.projectId);
    }
    save(next);return {...reservationView(row),idempotent:false};
  }
  async function addProviderCredit({projectId,eventId,amountUsd,receiptRef,source}={}){
    project(projectId);identifier(eventId,'funding event ID');identifier(receiptRef,'provider receipt reference');
    if(source!=='provider_funding')throw fail('Only authenticated provider funding can add external compute credits');
    const amount=usdToNano(amountUsd);if(amount<=0n)throw fail('A positive provider funding amount is required');assertStorage();
    let previous=state.grants.find(row=>row.eventId===eventId);
    if(previous){if(previous.projectId!==projectId||previous.source!==source||previous.amountNanoUsd!==amount.toString()||previous.receiptRef!==receiptRef)throw fail('This funding event belongs to different credit evidence',409,'COMPUTE_FUNDING_CONFLICT');}
    else {
      if(state.grants.some(row=>row.receiptRef===receiptRef))throw fail('This provider receipt is already assigned to a credit event',409,'COMPUTE_FUNDING_CONFLICT');
      if(state.grants.length>=LIMITS.grants)throw fail('Compute credit history is full',429,'COMPUTE_LEDGER_LIMIT');
      const next=structuredClone(state);ensureProjectCapacity(next,projectId);
      previous={projectId,eventId,source,status:'pending',amountNanoUsd:amount.toString(),receiptRef,createdAt:now(),verification:'pending'};next.grants.push(previous);
      addEvent(next,projectId,'funding_pending',amount.toString(),{grantEventId:eventId,source,status:'pending'});save(next);
    }
    if(previous.status==='credited'||typeof verifyProviderFunding!=='function')return grantView(previous);
    let verification;try{verification=await verifyProviderFunding({projectId,eventId,amountNanoUsd:amount.toString(),receiptRef,source});}catch{return grantView(state.grants.find(row=>row.eventId===eventId));}
    assertStorage();previous=state.grants.find(row=>row.eventId===eventId);
    if(previous.status==='credited')return grantView(previous);
    if(verification?.verified!==true||verification.projectId!==projectId||verification.receiptRef!==receiptRef||verification.amountNanoUsd!==amount.toString())return grantView(previous);
    const next=structuredClone(state),row=next.grants.find(item=>item.eventId===eventId);row.status='credited';row.creditedAt=now();row.verification='authenticated_provider';
    addEvent(next,projectId,'provider_credit',amount.toString(),{grantEventId:eventId,source,status:'credited'});coverDebt(next,projectId);save(next);return grantView(row);
  }
  // Startup recovery does not grant new allowance. A lost provider response can
  // still have cost money, so no unresolved reservation is silently refunded.
  if(state.reservations.some(row=>row.status==='reserved')){
    const next=structuredClone(state);
    for(const row of next.reservations.filter(item=>item.status==='reserved')){row.status='unknown';row.unknownAt=now();row.unknownReason='server_restart';addEvent(next,row.projectId,'unknown',row.estimateNanoUsd,{operationId:row.operationId,buildId:row.buildId,purpose:row.purpose,status:'unknown',reason:row.unknownReason});}
    save(next);
  }
  function operationsForDay(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||day(Date.parse(value+'T00:00:00Z'))!==value)throw fail('Choose an exact UTC accounting day in YYYY-MM-DD format');
    assertStorage();return state.reservations.filter(row=>day(row.createdAt)===value).map(reservationView);
  }
  function providerFundingTotals({eventIds}={}){
    assertStorage();const grants=state.grants.filter(r=>r.source==='provider_funding'&&r.status==='credited'),ids=new Set(grants.map(r=>r.eventId));
    const granted=grants.reduce((n,r)=>n+BigInt(r.amountNanoUsd),0n),spent=state.reservations.filter(r=>r.status==='settled').reduce((n,r)=>n+r.allocations.filter(a=>ids.has(a.grantEventId)).reduce((sum,a)=>sum+BigInt(a.amountNanoUsd),0n),0n);
    const selected=eventIds?new Set(eventIds):ids,matchedGranted=grants.filter(g=>selected.has(g.eventId)).reduce((n,g)=>n+BigInt(g.amountNanoUsd),0n);
    return {grantedNanoUsd:granted.toString(),spentNanoUsd:spent.toString(),outstandingNanoUsd:(granted-spent).toString(),matchedGrantedNanoUsd:matchedGranted.toString()};
  }
  return {reserve,settle,view,addProviderCredit,operationsForDay,providerFundingTotals};
}
module.exports={createComputeLedger,usdToNano,nanoToUsd,SCALE,FILE_NAME};

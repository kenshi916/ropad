'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createComputeLedger,usdToNano,nanoToUsd,FILE_NAME}=require('./parallax/compute-ledger.cjs');
function fixture(t,options={}){
  const stateDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-compute-'));t.after(()=>fs.rmSync(stateDirectory,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-09T12:00:00Z');const projectId=crypto.randomUUID(),buildId=crypto.randomUUID(),now=()=>clock;
  const config={stateDirectory,now,...options},ledger=createComputeLedger(config);
  const reserve=(args={})=>ledger.reserve({projectId,buildId,operationId:crypto.randomUUID(),purpose:'planning',estimateUsd:'0.5',provider:'openrouter',...args});
  return {ledger,config,stateDirectory,projectId,buildId,reserve,view:()=>ledger.view(projectId),advance:n=>clock+=n};
}
const verified=async input=>({...input,verified:true});

test('nano-USD conversion is exact and conservatively rounds sub-nano values without floating arithmetic',()=>{
  assert.equal(usdToNano('0.123456789'),123456789n);assert.equal(usdToNano('0.1234567891'),123456790n);assert.equal(usdToNano(1e-9),1n);assert.equal(usdToNano('1e-10'),1n);
  assert.equal(nanoToUsd('9007199254740993'),'9007199.254740993');assert.equal(nanoToUsd(-1n),'-0.000000001');assert.equal(nanoToUsd(1000000000n),'1');
  for(const value of [-1,NaN,Infinity,'-0.1','1 USD','01','1e999',{},null])assert.throws(()=>usdToNano(value));
});

test('read-only project inspection never creates a file, project or daily allowance',t=>{
  const f=fixture(t);for(let i=0;i<3;i++)assert.equal(f.view().availableNanoUsd,'0');assert.equal(f.view().grants.length,0);assert.equal(fs.existsSync(path.join(f.stateDirectory,FILE_NAME)),false);
  f.advance(86400000);assert.equal(f.view().sponsoredTodayNanoUsd,'0');assert.equal(fs.existsSync(path.join(f.stateDirectory,FILE_NAME)),false);
});

test('reservation and lazy sponsorship are committed together before provider work',t=>{
  const f=fixture(t),reserved=f.reserve({estimateUsd:'0.250000001'});assert.equal(reserved.created,true);assert.equal(reserved.estimateNanoUsd,'250000001');
  const disk=JSON.parse(fs.readFileSync(path.join(f.stateDirectory,FILE_NAME),'utf8'));assert.equal(disk.grants[0].amountNanoUsd,'1000000000');assert.equal(disk.reservations[0].status,'reserved');assert.equal(disk.reservations[0].allocations[0].amountNanoUsd,'250000001');
  assert.equal(f.view().availableNanoUsd,'749999999');assert.equal(f.view().reservedNanoUsd,'250000001');assert.equal(f.view().sponsoredTodayUsd,'1');assert.equal(f.view().sponsorExpiresAt,Date.parse('2026-10-10T00:00:00Z'));
});

test('insufficient reserve grants nothing and duplicate IDs never authorize another provider call',t=>{
  const f=fixture(t);assert.throws(()=>f.reserve({estimateUsd:'1.1'}),{code:'COMPUTE_CREDITS_EXHAUSTED'});assert.equal(f.view().grants.length,0);assert.equal(fs.existsSync(path.join(f.stateDirectory,FILE_NAME)),false);
  const row=f.reserve({estimateUsd:'0.5'}),bytes=fs.readFileSync(path.join(f.stateDirectory,FILE_NAME),'utf8');
  assert.throws(()=>f.reserve({operationId:row.operationId,estimateUsd:'0.5'}),{code:'COMPUTE_OPERATION_REUSED'});
  assert.throws(()=>f.reserve({operationId:row.operationId,estimateUsd:'0.6'}),{code:'COMPUTE_OPERATION_CONFLICT'});assert.equal(fs.readFileSync(path.join(f.stateDirectory,FILE_NAME),'utf8'),bytes);
});

test('known settlement refunds exact unused credit and cannot be changed or counted twice',t=>{
  const f=fixture(t),row=f.reserve({estimateUsd:'0.5'});f.ledger.settle({operationId:row.operationId,actualUsd:'0.123456789'});
  assert.equal(f.view().spentNanoUsd,'123456789');assert.equal(f.view().availableNanoUsd,'876543211');assert.equal(f.view().reservedNanoUsd,'0');
  const events=f.view().events.length;assert.equal(f.ledger.settle({operationId:row.operationId,actualUsd:'0.123456789'}).idempotent,true);assert.equal(f.view().events.length,events);
  assert.throws(()=>f.ledger.settle({operationId:row.operationId,actualUsd:'0.1'}),{code:'COMPUTE_SETTLEMENT_CONFLICT'});assert.throws(()=>f.ledger.settle({operationId:row.operationId,actualUsd:null}),{code:'COMPUTE_SETTLEMENT_CONFLICT'});
});

test('unknown cost retains the entire estimate and later reconciliation refunds exactly once',t=>{
  const f=fixture(t),row=f.reserve({estimateUsd:'0.5'});f.ledger.settle({operationId:row.operationId,actualUsd:null});
  assert.equal(f.view().unknownChargeNanoUsd,'500000000');assert.equal(f.view().unknownChargeCount,1);assert.equal(f.view().spentNanoUsd,'0');assert.equal(f.view().reservedNanoUsd,'0');assert.equal(f.view().availableUsd,'0.5');
  const events=f.view().events.length;f.ledger.settle({operationId:row.operationId,actualUsd:null});assert.equal(f.view().events.length,events);
  f.ledger.settle({operationId:row.operationId,actualUsd:'0.2'});assert.equal(f.view().availableUsd,'0.8');assert.equal(f.view().unknownChargeCount,0);assert.equal(f.view().spentUsd,'0.2');
});

test('startup turns unresolved reservations into held unknown costs without another grant',t=>{
  const f=fixture(t),row=f.reserve({estimateUsd:'0.4'}),recovered=createComputeLedger(f.config),view=recovered.view(f.projectId);
  assert.equal(view.unknownChargeUsd,'0.4');assert.equal(view.reservedUsd,'0');assert.equal(view.grants.length,1);assert.equal(view.reservations[0].unknownReason,'server_restart');
  assert.throws(()=>recovered.reserve({projectId:f.projectId,buildId:f.buildId,operationId:row.operationId,purpose:'planning',estimateUsd:'0.4',provider:'openrouter'}),{code:'COMPUTE_OPERATION_REUSED'});
  const bytes=fs.readFileSync(path.join(f.stateDirectory,FILE_NAME),'utf8');createComputeLedger(f.config);assert.equal(fs.readFileSync(path.join(f.stateDirectory,FILE_NAME),'utf8'),bytes);
});

test('revisions share one project allowance and independent projects have separate attribution',t=>{
  const f=fixture(t),first=f.reserve({estimateUsd:'0.7'});f.ledger.settle({operationId:first.operationId,actualUsd:'0.7'});
  const revisionId=crypto.randomUUID();assert.throws(()=>f.reserve({buildId:revisionId,estimateUsd:'0.4'}),{code:'COMPUTE_CREDITS_EXHAUSTED'});
  f.reserve({buildId:revisionId,estimateUsd:'0.3'});assert.equal(f.view().grants.length,1);assert.equal(f.view().availableUsd,'0');
  const other=crypto.randomUUID();f.reserve({projectId:other,buildId:crypto.randomUUID(),estimateUsd:'0.5'});assert.equal(f.ledger.view(other).availableUsd,'0.5');assert.equal(f.view().availableUsd,'0');
});

test('unused daily sponsorship expires without granting on GET and old unknown work stays attributed',t=>{
  const f=fixture(t),row=f.reserve({estimateUsd:'0.4'});f.ledger.settle({operationId:row.operationId,actualUsd:null});f.advance(86400000);
  assert.equal(f.view().availableUsd,'0');assert.equal(f.view().expiredSponsoredUsd,'0.6');assert.equal(f.view().unknownChargeUsd,'0.4');assert.equal(f.view().sponsoredTodayUsd,'0');
  f.reserve({estimateUsd:'0.3',purpose:'thumbnail'});assert.equal(f.view().grants.length,2);assert.equal(f.view().availableUsd,'0.7');
  f.ledger.settle({operationId:row.operationId,actualUsd:'0.1'});assert.equal(f.view().expiredSponsoredUsd,'0.9');assert.equal(f.view().availableUsd,'0.7');assert.equal(f.view().spentUsd,'0.1');
});

test('declined requests refund their original day and do not revive expired sponsored credit',t=>{
  const f=fixture(t),row=f.reserve({estimateUsd:'0.5'});f.advance(86400000);f.ledger.settle({operationId:row.operationId,actualUsd:0});
  assert.equal(f.view().expiredSponsoredUsd,'1');assert.equal(f.view().balanceUsd,'0');assert.equal(f.view().spentUsd,'0');assert.equal(f.view().grants.length,1);
});

test('unverified provider funding remains pending, cannot finance requests and is globally deduplicated',async t=>{
  const f=fixture(t,{sponsorDailyUsd:0});const input={projectId:f.projectId,eventId:'funding-1',amountUsd:'2.5',receiptRef:'provider-receipt-1',source:'provider_funding'};
  const record=await f.ledger.addProviderCredit(input);assert.equal(record.status,'pending');assert.equal('receiptRef' in record,false);assert.equal(f.view().pendingFundingUsd,'2.5');assert.equal(f.view().availableUsd,'0');
  assert.throws(()=>f.reserve({estimateUsd:'0.1'}),{code:'COMPUTE_CREDITS_EXHAUSTED'});await f.ledger.addProviderCredit(input);assert.equal(f.view().grants.length,1);
  await assert.rejects(f.ledger.addProviderCredit({...input,projectId:crypto.randomUUID(),eventId:'funding-2'}),{code:'COMPUTE_FUNDING_CONFLICT'});
  await assert.rejects(f.ledger.addProviderCredit({...input,source:'sol_revenue'}));
});

test('only matching authenticated provider proof credits funds, once, and funded credit does not expire',async t=>{
  const f=fixture(t,{sponsorDailyUsd:0,verifyProviderFunding:verified}),input={projectId:f.projectId,eventId:'funding-1',amountUsd:'2.5',receiptRef:'provider-receipt-1',source:'provider_funding'};
  const [first,second]=await Promise.all([f.ledger.addProviderCredit(input),f.ledger.addProviderCredit(input)]);assert.equal(first.status,'credited');assert.equal(second.status,'credited');assert.equal(f.view().providerFundedUsd,'2.5');assert.equal(f.view().events.filter(e=>e.type==='provider_credit').length,1);
  f.reserve({estimateUsd:'0.5'});f.advance(86400000);assert.equal(f.view().availableUsd,'2');assert.equal(f.view().expiredSponsoredUsd,'0');
  const bad=fixture(t,{sponsorDailyUsd:0,verifyProviderFunding:async x=>({...x,verified:true,amountNanoUsd:'999'})});await bad.ledger.addProviderCredit({...input,projectId:bad.projectId});assert.equal(bad.view().providerFundedUsd,'0');assert.equal(bad.view().pendingFundingUsd,'2.5');
});

test('provider overage is recorded as actual cost and blocks further spending instead of inventing credits',t=>{
  const f=fixture(t),row=f.reserve({estimateUsd:'0.5'});f.ledger.settle({operationId:row.operationId,actualUsd:'1.2'});
  assert.equal(f.view().spentUsd,'1.2');assert.equal(f.view().balanceUsd,'-0.2');assert.equal(f.view().overdrawnUsd,'0.2');assert.equal(f.view().availableUsd,'0');assert.throws(()=>f.reserve({estimateUsd:'0.01'}),{code:'COMPUTE_CREDITS_EXHAUSTED'});
});

test('provider debt survives UTC rollover and new allowance must cover that debt first',t=>{
  const f=fixture(t),row=f.reserve({estimateUsd:'0.5'});f.ledger.settle({operationId:row.operationId,actualUsd:'1.2'});f.advance(86400000);
  assert.equal(f.view().balanceUsd,'-0.2');assert.equal(f.view().expiredSponsoredUsd,'0');assert.equal(f.view().grants.length,1);
  assert.throws(()=>f.reserve({estimateUsd:'0.9'}),{code:'COMPUTE_CREDITS_EXHAUSTED'});assert.equal(f.view().grants.length,1);
  f.reserve({estimateUsd:'0.7'});assert.equal(f.view().availableUsd,'0.1');assert.equal(f.view().totalGrantedUsd,'2');assert.equal(f.view().spentUsd,'1.2');
});

test('new sponsored credit durably pays old debt so it cannot reappear on day three or restart',t=>{
  const f=fixture(t),first=f.reserve({estimateUsd:'0.5'});f.ledger.settle({operationId:first.operationId,actualUsd:'1.2'});f.advance(86400000);
  const second=f.reserve({estimateUsd:'0.8'});f.ledger.settle({operationId:second.operationId,actualUsd:'0.8'});
  const original=f.view().reservations.find(row=>row.operationId===first.operationId);assert.equal(original.unfundedNanoUsd,'0');assert.deepEqual(original.allocations.map(a=>a.amountNanoUsd),['1000000000','200000000']);assert.equal(original.actualNanoUsd,'1200000000');
  assert.equal(f.view().balanceUsd,'0');f.advance(86400000);assert.equal(f.view().balanceUsd,'0');assert.equal(f.view().expiredSponsoredUsd,'0');assert.equal(f.view().spentUsd,'2');
  const recovered=createComputeLedger(f.config);assert.equal(recovered.view(f.projectId).balanceUsd,'0');assert.equal(recovered.view(f.projectId).overdrawnUsd,'0');assert.equal(recovered.view(f.projectId).events.filter(e=>e.type==='debt_covered').length,1);
});

test('partial provider funding pays debt before the next sponsorship and neither repayment expires',async t=>{
  const f=fixture(t,{verifyProviderFunding:verified}),first=f.reserve({estimateUsd:'0.5'});f.ledger.settle({operationId:first.operationId,actualUsd:'1.2'});
  const input={projectId:f.projectId,eventId:'partial-funding',amountUsd:'0.1',receiptRef:'provider-partial',source:'provider_funding'};await f.ledger.addProviderCredit(input);
  assert.equal(f.view().balanceUsd,'-0.1');assert.equal(f.view().reservations[0].unfundedNanoUsd,'100000000');await f.ledger.addProviderCredit(input);assert.equal(f.view().balanceUsd,'-0.1');
  f.advance(86400000);const second=f.reserve({estimateUsd:'0.9'});f.ledger.settle({operationId:second.operationId,actualUsd:'0.9'});assert.equal(f.view().balanceUsd,'0');
  f.advance(86400000);const recovered=createComputeLedger(f.config),result=recovered.view(f.projectId);assert.equal(result.overdrawnUsd,'0');assert.equal(result.balanceUsd,'0');assert.equal(result.expiredSponsoredUsd,'0');assert.equal(result.providerFundedUsd,'0.1');assert.equal(result.spentUsd,'2.1');
});

test('an old unknown reservation refund funds prior overage without reviving expired free credit',t=>{
  const f=fixture(t),held=f.reserve({estimateUsd:'0.3'}),actual=f.reserve({estimateUsd:'0.5'});f.ledger.settle({operationId:held.operationId,actualUsd:null});f.ledger.settle({operationId:actual.operationId,actualUsd:'1.2'});assert.equal(f.view().overdrawnUsd,'0.5');
  f.advance(86400000);f.ledger.settle({operationId:held.operationId,actualUsd:0});assert.equal(f.view().overdrawnUsd,'0.2');assert.equal(f.view().expiredSponsoredUsd,'0');assert.equal(f.view().spentUsd,'1.2');assert.equal(f.view().unknownChargeCount,0);
  const recovered=createComputeLedger(f.config);assert.equal(recovered.view(f.projectId).overdrawnUsd,'0.2');
});

test('daily operation inspection is exact, cloned, cross-project and has no grant or write side effects',t=>{
  const f=fixture(t);assert.deepEqual(f.ledger.operationsForDay('2026-10-09'),[]);assert.equal(fs.existsSync(path.join(f.stateDirectory,FILE_NAME)),false);
  const first=f.reserve({estimateUsd:'0.4'});f.ledger.settle({operationId:first.operationId,actualUsd:'0.2'});
  const other=crypto.randomUUID(),second=f.reserve({projectId:other,buildId:crypto.randomUUID(),estimateUsd:'0.3'});f.ledger.settle({operationId:second.operationId,actualUsd:null});f.advance(86400000);const third=f.reserve({estimateUsd:'0.1'});
  const file=path.join(f.stateDirectory,FILE_NAME),before=fs.readFileSync(file,'utf8'),rows=f.ledger.operationsForDay('2026-10-09');assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(r=>r.projectId)),new Set([f.projectId,other]));assert.equal(rows.find(r=>r.operationId===first.operationId).actualNanoUsd,'200000000');
  rows[0].estimateNanoUsd='0';rows[0].allocations[0].amountNanoUsd='0';assert.equal(f.ledger.operationsForDay('2026-10-09')[0].estimateNanoUsd,'400000000');assert.equal(f.ledger.operationsForDay('2026-10-10')[0].operationId,third.operationId);
  assert.equal(fs.readFileSync(file,'utf8'),before);for(const invalid of ['2026-02-30','2026-13-01','2026-1-1','no day'])assert.throws(()=>f.ledger.operationsForDay(invalid));
});

test('mixed funding refunds preserve grant provenance rather than reviving expired sponsorship',async t=>{
  const f=fixture(t,{verifyProviderFunding:verified});await f.ledger.addProviderCredit({projectId:f.projectId,eventId:'funding-mixed',amountUsd:'1',receiptRef:'provider-mixed',source:'provider_funding'});
  f.advance(1000);const row=f.reserve({estimateUsd:'1.5'});assert.deepEqual(row.allocations.map(x=>x.amountNanoUsd),['1000000000','500000000']);
  f.advance(86400000);f.ledger.settle({operationId:row.operationId,actualUsd:'0.4'});
  assert.equal(f.view().expiredSponsoredUsd,'0.6');assert.equal(f.view().availableUsd,'1');assert.equal(f.view().providerFundedUsd,'1');assert.equal(f.view().spentUsd,'0.4');
});

test('corrupt, removed or changed storage cannot be overwritten or authorize a new reservation',t=>{
  for(const mode of ['corrupt','changed','removed']){
    const f=fixture(t);f.reserve({estimateUsd:'0.5'});const file=path.join(f.stateDirectory,FILE_NAME),bytes=mode==='corrupt'?'broken accounting':JSON.stringify({version:1,scale:'1000000000',grants:[],reservations:[],events:[]});
    if(mode==='removed')fs.unlinkSync(file);else fs.writeFileSync(file,bytes);
    assert.throws(()=>f.reserve({estimateUsd:'0.1'}),{code:'COMPUTE_STORAGE_UNAVAILABLE'});
    if(mode==='removed')assert.equal(fs.existsSync(file),false);else assert.equal(fs.readFileSync(file,'utf8'),bytes);
    if(mode==='corrupt')assert.throws(()=>createComputeLedger(f.config),{code:'COMPUTE_STORAGE_UNAVAILABLE'});
  }
});

test('a durable-write failure cannot authorize provider work or overwrite prior records',t=>{
  const f=fixture(t),file=path.join(f.stateDirectory,FILE_NAME);fs.mkdirSync(file);
  assert.throws(()=>f.reserve({estimateUsd:'0.1'}),{code:'COMPUTE_STORAGE_UNAVAILABLE'});assert.equal(fs.statSync(file).isDirectory(),true);
});

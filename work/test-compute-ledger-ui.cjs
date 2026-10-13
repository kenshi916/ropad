'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sourcePath=fs.existsSync(path.join(__dirname,'parallax/dist/builder-shell.js'))?path.join(__dirname,'parallax/dist/builder-shell.js'):path.join(__dirname,'../dist/builder-shell.js');
const source=fs.readFileSync(sourcePath,'utf8');
class Element{
  constructor(){this.innerHTML='';this.textContent='';this.isConnected=true;this.open=false;this.classList={add(){},remove(){},toggle(){}};this.details={open:false};}
  querySelector(selector){return selector==='details'?this.details:null;}querySelectorAll(){return [];}showModal(){this.open=true;}close(){this.open=false;}
}
const compute={projectId:'project-one',currency:'USD',scale:1000000000,fundingMode:'sponsored_development',sponsorDailyUsd:'1',sponsoredTodayUsd:'1',sponsoredUsd:'1',providerFundedUsd:'0',balanceUsd:'0.5',availableUsd:'0.5',spentUsd:'0.1',reservedUsd:'0.15',unknownChargeUsd:'0.25',unknownChargeCount:1,events:[{eventId:'event-one',type:'compute_reserved',purpose:'Owner-only planning note',at:'2026-10-09T12:00:00Z',amountUsd:'0.15'}]};
const fees={status:'inactive',asset:'SOL',receivedLamports:'0',platformLamports:'0',computeLamports:'0',reason:'Fee routing is inactive',receipts:[]};
function fixture({owner=true,responseOwner=owner,enabled=true,computeChanges={},feeChanges={},failure=false,holdRead=false}={}){
  const root=new Element(),requests=[],nodes={'#toast':new Element(),'#info-kicker':new Element(),'#info-body':new Element(),'#info-dialog':new Element()};
  let release;const waiting=new Promise(resolve=>release=resolve);
  let now=Date.now();const TestDate=class extends Date{static now(){return now;}};
  const document={querySelector:selector=>nodes[selector],querySelectorAll:()=>[],visibilityState:'visible'};
  const build={id:'build-one',canManage:owner};
  const window={addEventListener(){},ParallaxBuilders:{refresh(){}}};
  const context={window,document,Date:TestDate,AbortSignal,setTimeout:()=>0,clearTimeout(){},location:{hash:''},fetch:async(url,options={})=>{
    requests.push({url,method:options.method||'GET'});if(failure&&url.endsWith('/compute'))throw Error('Accounting store unavailable');if(holdRead&&url.endsWith('/compute'))await waiting;
    const payload=url==='/api/builds/config'?{computeAccounting:enabled}:{canManage:responseOwner,compute:{...compute,...computeChanges},fees:feeChanges===null?null:{...fees,...feeChanges}};
    return{ok:true,json:async()=>payload};
  }};
  vm.runInNewContext(source,context,{filename:sourcePath});root.innerHTML=window.RopadCompute.panel(build);
  return{root,requests,window,build,release,document,advance:ms=>now+=ms,update:value=>Object.assign(computeChanges,value),load:()=>window.RopadCompute.wire(build,root)};
}
test('viewing compute accounting only reads status and keeps sponsored USD separate from SOL receipts',async()=>{
  const h=fixture();await h.load();assert.deepEqual(h.requests.map(item=>item.url),['/api/builds/config','/api/builds/build-one/compute']);assert.equal(h.requests.some(item=>item.method!=='GET'),false);
  assert.match(h.root.innerHTML,/Sponsored development allowance expires daily/);assert.match(h.root.innerHTML,/Recorded costs since accounting activation Earlier build costs are not included/);assert.match(h.root.innerHTML,/PROJECT ALLOWANCE \/ USD/);assert.match(h.root.innerHTML,/VERIFIED SOL DISTRIBUTIONS/);assert.match(h.root.innerHTML,/historical distributions, not current treasury balances/);assert.match(h.root.innerHTML,/A SOL allocation is not a USD AI credit/);assert.doesNotMatch(h.root.innerHTML,/<button|<form/);
});
test('an older backend shows capability-required status instead of invented balances',async()=>{
  const h=fixture({enabled:false});await h.load();assert.match(h.root.innerHTML,/Restart the local Ropad server to activate compute accounting/);assert.equal(h.requests.length,1);assert.doesNotMatch(h.root.innerHTML,/\$0|0 SOL|Available \$/);
});
test('detailed ledger entries require both current creator access and response authorization',async()=>{
  const owner=fixture();await owner.load();assert.match(owner.root.innerHTML,/Owner-only planning note/);
  for(const options of [{owner:false,responseOwner:true},{owner:true,responseOwner:false}]){const h=fixture(options);await h.load();assert.doesNotMatch(h.root.innerHTML,/Owner-only planning note|RECENT LEDGER ENTRIES/);assert.match(h.root.innerHTML,/Public accounting summary/);assert.match(h.root.innerHTML,/Available \$0.50/);}
});
test('unknown costs are separate from settled costs and active reservations',async()=>{
  const h=fixture();await h.load();assert.match(h.root.innerHTML,/<dt>Known provider cost<\/dt><dd>\$0.10/);assert.match(h.root.innerHTML,/<dt>In-flight reservations<\/dt><dd>\$0.15/);assert.match(h.root.innerHTML,/<dt>Unconfirmed cost estimates<\/dt><dd>\$0.25/);assert.match(h.root.innerHTML,/1 request with unconfirmed charges \$0.25 is held conservatively/);
});
test('large and sub-cent amounts retain exact atomic-unit precision without Number rounding',async()=>{
  const h=fixture({computeChanges:{availableNanoUsd:'9007199254740993123456789',spentNanoUsd:'1',balanceNanoUsd:'-1234567890'},feeChanges:{receivedLamports:'9007199254740993123456789',platformLamports:'1'}});await h.load();
  assert.match(h.root.innerHTML,/\$9,007,199,254,740,993.123456789/);assert.match(h.root.innerHTML,/\$0.000000001/);assert.match(h.root.innerHTML,/9,007,199,254,740,993.123456789 SOL/);assert.match(h.root.innerHTML,/0.000000001 SOL/);assert.match(h.root.innerHTML,/Recorded balance -\$1.23456789/);
});
test('missing or unreadable accounting amounts show unavailable rather than zero',async()=>{
  const missing=fixture({computeChanges:{availableUsd:null,spentUsd:undefined},feeChanges:{receivedLamports:null,receivedSol:undefined}});await missing.load();assert.match(missing.root.innerHTML,/<dt>Known provider cost<\/dt><dd>Unavailable/);assert.match(missing.root.innerHTML,/<dt>Verified receipts<\/dt><dd>Unavailable/);
  const failed=fixture({failure:true});await failed.load();assert.match(failed.root.innerHTML,/Accounting store unavailable/);assert.doesNotMatch(failed.root.innerHTML,/Available \$|Known provider cost/);
});
test('an in-flight owner response cannot reveal private ledger entries after creator access changes',async()=>{
  const h=fixture({holdRead:true}),pending=h.load();await new Promise(resolve=>setImmediate(resolve));
  const publicRead=h.window.RopadCompute.wire({...h.build,canManage:false},h.root);h.release();await Promise.all([pending,publicRead]);
  assert.doesNotMatch(h.root.innerHTML,/Owner-only planning note|RECENT LEDGER ENTRIES/);assert.match(h.root.innerHTML,/Public accounting summary/);
});

test('unchanged builds refresh expiring allowance on a read-only throttle',async()=>{
  const h=fixture();await h.load();assert.match(h.root.innerHTML,/Available \$0.50/);
  h.update({availableUsd:'0',sponsoredTodayUsd:'0'});await h.window.RopadCompute.refresh(h.build);assert.equal(h.requests.length,2);
  h.advance(30001);await h.window.RopadCompute.refresh(h.build);assert.equal(h.requests.length,4);assert.match(h.root.innerHTML,/Available \$0.00/);
  assert.equal(h.requests.some(request=>request.method!=='GET'),false);
  h.advance(30001);h.document.visibilityState='hidden';await h.window.RopadCompute.refresh(h.build);assert.equal(h.requests.length,4);
});

test('wallet invalidation removes owner details immediately and rejects an older in-flight response',async()=>{
  const h=fixture();await h.load();h.root.details.open=true;h.root.details.ontoggle();assert.match(h.root.innerHTML,/Owner-only planning note/);
  h.window.RopadCompute.invalidate();assert.doesNotMatch(h.root.innerHTML,/Owner-only planning note|<details open/);
  const pending=fixture({holdRead:true}),read=pending.load();await new Promise(resolve=>setImmediate(resolve));pending.window.RopadCompute.invalidate();pending.release();await read;
  assert.doesNotMatch(pending.root.innerHTML,/Owner-only planning note|Available \$|RECENT LEDGER ENTRIES/);
});
test('numeric ledger timestamps and ISO dates display and sort newest first',async()=>{
  const at=Date.parse('2026-10-09T12:30:00Z');
  const h=fixture({computeChanges:{events:[{type:'numeric_newest',at},{type:'string_earlier',at:'2026-10-09T11:00:00Z'}]}});await h.load();
  assert.doesNotMatch(h.root.innerHTML,/Time unavailable/);assert.ok(h.root.innerHTML.indexOf('numeric newest')<h.root.innerHTML.indexOf('string earlier'));assert.ok(h.root.innerHTML.includes(new Date(at).toLocaleString()));
});

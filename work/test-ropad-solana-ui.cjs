'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sourcePath=fs.existsSync(path.join(__dirname,'parallax/dist/ropad-solana.js'))?path.join(__dirname,'parallax/dist/ropad-solana.js'):path.join(__dirname,'../dist/ropad-solana.js');
const source=fs.readFileSync(sourcePath,'utf8'),ADDRESS='11111111111111111111111111111111',OTHER='22222222222222222222222222222222';
class Element{
  constructor(){this.innerHTML='';this.nodes=new Map();this.open=false;this.isConnected=true;this.values={};this.classList={add(){},remove(){},toggle(){}};}
  querySelector(selector){if(!this.nodes.has(selector))this.nodes.set(selector,new Element());return this.nodes.get(selector);}
  querySelectorAll(){return [];}
  showModal(){this.open=true;}close(){this.open=false;this.closeHandler?.();}addEventListener(event,handler){if(event==='close')this.closeHandler=handler;else this['on'+event]=handler;}
  insertAdjacentHTML(_,value){this.innerHTML+=value;}
  setCustomValidity(message){this.validationMessage=message;}
  reportValidity(){return !this.validationMessage&&[...this.nodes.values()].every(node=>!node.validationMessage);}
}
function fixture({installed=true,changedDuringSign=false,changedDuringTransaction=false,submissionError=false,preparedCluster='devnet',quoteChanges={},logoutGate=null,logoutError=false,mainnet=false,statusResult=null,responses={}}={}){
  const requests=[],calls=[],listeners={},host=new Element(),launch=new Element(),body=new Element(),nodes={'launch-dialog':launch,'launch-body':body,'info-body':host};
  let current=ADDRESS;
  const provider={isPhantom:true,get publicKey(){return{toString:()=>current};},connect:async()=>{calls.push('connect');return{publicKey:{toString:()=>current}};},on:(event,handler)=>listeners[event]=handler,removeListener:event=>delete listeners[event],signMessage:async()=>{calls.push('signMessage');if(changedDuringSign)current=OTHER;return{signature:new Uint8Array(64)};},signTransaction:async transaction=>{calls.push('signTransaction');if(changedDuringTransaction){current=OTHER;listeners.accountChanged?.({toString:()=>OTHER});}return{serialize:()=>new Uint8Array([1,2,3])};}};
  const events=[];
  const window={location:{hash:"#/"},phantom:installed?{solana:provider}:null,openInfo:(_,html)=>{host.innerHTML=html;},dispatchEvent:event=>events.push(event),ParallaxBuilders:{refresh(){calls.push('refresh');}},solanaWeb3:{Transaction:{from:()=>({feePayer:{toString:()=>ADDRESS}})}}};
  const intent={cluster:preparedCluster,owner:ADDRESS,launchId:'launch-one',intentId:'intent-one',status:'prepared',transactionBase64:'AQID',mint:OTHER,fundingLamports:10000000,rentLamports:3000000,estimatedNetworkFeeLamports:5000,totalRequiredLamports:13005000,...quoteChanges};
  window.solanaWeb3.VersionedTransaction={deserialize:()=>({message:{staticAccountKeys:[{toString:()=>ADDRESS}]}})};
  const context={window,URL,crypto:require("node:crypto"),setTimeout,clearTimeout,document:{getElementById:id=>nodes[id],querySelectorAll:()=>[]},AbortSignal,Uint8Array,TextEncoder,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},btoa:value=>Buffer.from(value,'binary').toString('base64'),atob:value=>Buffer.from(value,'base64').toString('binary'),FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){yield*Object.entries(this.form.values);}},fetch:async(url,options={})=>{
    requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
    if(url==='/api/auth/logout'){if(logoutGate)await logoutGate;if(logoutError)throw Error('Creator logout failed');}
    if(url==='/api/solana/launches/submit'&&submissionError)throw Error('Submission response was interrupted');
    const payload=url==='/api/status'?{csrf:'OFFLINE_CSRF'}:url==='/api/auth/session'?{authenticated:false}:url==='/api/auth/challenge'?{id:'challenge-one',message:'Offline sign-in challenge'}:url==='/api/auth/verify'?{authenticated:true,address:ADDRESS}:url==='/api/solana/launches/config'?{cluster:mainnet?'mainnet-beta':'devnet',mainnetAvailable:mainnet,supply:1000000,fundingLamports:10000000}:url==='/api/builds/config'?{autonomousBuilds:true,maxAgentBudgetUsd:5}:url==='/api/builds/pool'?{workers:[]}:url==='/api/launch-artwork/config'?{available:true,estimateUsd:0.5}:url==='/api/launch-artwork'?{artwork:{id:'artwork-one',status:'ready',thumbnail:{url:'/api/launch-artwork/artwork-one/thumbnail/image'},coinIcon:{url:'/api/launch-artwork/artwork-one/coinIcon/image'}}}:url==='/api/builds/models'?{configured:true,data:[{id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5'},{id:'google/gemini-flash',name:'Cheaper model'}]}:url==='/api/solana/launches/prepare'?intent:url==='/api/solana/launches/status'?statusResult:url==='/api/solana/launches'?{data:statusResult?[statusResult]:[]}:url==='/api/solana/launches/submit'?{...intent,status:'confirmed',buildSession:{id:'game-build'}}:{};
    const override=Object.hasOwn(responses,url)?await (typeof responses[url]==='function'?responses[url](options):responses[url]):payload;
    return{ok:true,json:async()=>override};
  }};
  vm.runInNewContext(source,context,{filename:sourcePath});return{window,requests,calls,listeners,host,body,launch,events,open:async()=>{window.openRobloxLaunch();await window.RopadLaunchPage.mount(body);} };
}
test('Solana picker cannot connect an absent wallet or silently use Ethereum',async()=>{
  const h=fixture({installed:false});await h.window.RopadSolana.connect('phantom');
  assert.equal(h.window.RopadSolana.get(),null);assert.equal(h.calls.length,0);assert.match(h.host.innerHTML,/Phantom is not installed/);assert.match(h.host.innerHTML,/Solflare/);
});
test('Solana connection does not sign messages or transactions',async()=>{
  const h=fixture();await h.window.RopadSolana.connect('phantom');assert.deepEqual(h.calls.filter(value=>value!=='refresh'),['connect']);assert.equal(h.window.RopadSolana.get().address,ADDRESS);
  assert.ok(h.events.some(event=>event.type==='ropad-solana-wallet-change'));assert.equal(h.events.some(event=>event.type==='parallax-evm-wallet-change'),false);
});

test('creator reads can await wallet logout before trusting the new session',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),h=fixture({logoutGate:gate});await h.window.RopadSolana.connect('phantom');
  let settled=false;const invalidated=h.window.RopadSolana.whenInvalidated().then(()=>settled=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  const auth=h.window.RopadSolana.authenticate();assert.equal(h.requests.some(request=>request.url==='/api/auth/session'),false);
  release();await Promise.all([invalidated,auth]);assert.equal(settled,true);assert.ok(h.calls.filter(value=>value==='refresh').length>=2);
});

test('failed logout cannot silently authorize another creator session',async()=>{
  const h=fixture({logoutError:true});await h.window.RopadSolana.connect('phantom');await assert.rejects(h.window.RopadSolana.whenInvalidated(),/Creator logout failed/);
  await assert.rejects(h.window.RopadSolana.authenticate(),/Creator logout failed/);assert.equal(h.calls.includes('signMessage'),false);assert.equal(h.requests.some(request=>request.url==='/api/auth/session'),false);
});
test('Solana creator verification refuses an account change during message signing',async()=>{
  const h=fixture({changedDuringSign:true});await h.window.RopadSolana.connect('phantom');
  await assert.rejects(h.window.RopadSolana.authenticate(),/Wallet account changed/);assert.equal(h.requests.some(item=>item.url==='/api/auth/verify'),false);
});
test('opening Solana launch loads a prompt form without signing and excludes cheaper models',async()=>{
  const h=fixture();await h.open();assert.match(h.body.innerHTML,/Solana devnet · Test/);assert.match(h.body.innerHTML,/Claude Opus 5.5/);assert.doesNotMatch(h.body.innerHTML,/Cheaper model|Game starter|ETH launch/);
  assert.equal(h.calls.length,0);assert.equal(h.requests.some(item=>item.method==='POST'),false);
});
test('reviewing a Solana launch requires separate transaction approval before submission',async()=>{
  const h=fixture();await h.window.RopadSolana.connect('phantom');await h.open();
  const form=h.body.querySelector('form');form.values={name:'Orbital Garden',ticker:'ORBIT',brief:'Build an original orbital garden game',modelId:'anthropic/claude-opus-5.5',inspiration:''};
  await review(h,form);assert.match(h.body.innerHTML,/0.013005 test SOL/);assert.equal(h.calls.includes('signTransaction'),false);
  await h.body.querySelector('[data-solana-approve]').onclick();assert.equal(h.calls.filter(item=>item==='signTransaction').length,1);assert.match(h.body.innerHTML,/Your game coin is confirmed/);
  assert.equal(h.requests.filter(item=>item.url==='/api/solana/launches/submit').length,1);assert.equal(h.requests.some(item=>item.url.includes('/orbio/')),false);
});
test('a non-devnet launch response is rejected before wallet transaction approval',async()=>{
  const h=fixture({preparedCluster:'mainnet-beta'});await h.window.RopadSolana.connect('phantom');await h.open();
  const form=h.body.querySelector('form');form.values={name:'Orbital Garden',ticker:'ORBIT',brief:'Build an original orbital garden game',modelId:'anthropic/claude-opus-5.5'};
  await review(h,form);assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/mainnet launches are disabled/);assert.equal(h.calls.includes('signTransaction'),false);
});
test('an unknown submission outcome requires a status check before another wallet approval',async()=>{
  const h=fixture({submissionError:true});await h.window.RopadSolana.connect('phantom');await h.open();
  const form=h.body.querySelector('form');form.values={name:'Orbit',ticker:'ORBIT',brief:'Build an original orbital garden game',modelId:'anthropic/claude-opus-5.5'};
  await review(h,form);await h.body.querySelector('[data-solana-approve]').onclick();
  assert.doesNotMatch(h.body.innerHTML,/data-solana-approve/);assert.match(h.body.innerHTML,/data-solana-status/);
  assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/Check the saved launch before another wallet approval/);
  assert.equal(h.calls.filter(item=>item==='signTransaction').length,1);
});
test('an account event during transaction signing prevents submitting under the changed account',async()=>{
  const h=fixture({changedDuringTransaction:true});await h.window.RopadSolana.connect('phantom');await h.open();
  const form=h.body.querySelector('form');form.values={name:'Orbit',ticker:'ORBIT',brief:'Build an original orbital garden game',modelId:'anthropic/claude-opus-5.5'};
  await review(h,form);await h.body.querySelector('[data-solana-approve]').onclick();
  assert.equal(h.requests.some(item=>item.url==='/api/solana/launches/submit'),false);
  assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/Wallet changed before submission/);
});
test('incomplete or inconsistent launch fees cannot reach wallet transaction approval',async()=>{
  for(const quoteChanges of [{estimatedNetworkFeeLamports:null},{totalRequiredLamports:0},{rentLamports:-1}]){
    const h=fixture({quoteChanges});await h.window.RopadSolana.connect('phantom');await h.open();
    const form=h.body.querySelector('form');form.values={name:'Orbit',ticker:'ORBIT',brief:'Build an original orbital garden game',modelId:'anthropic/claude-opus-5.5'};
    await review(h,form);assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/quote is incomplete or inconsistent/);
    assert.doesNotMatch(h.body.innerHTML,/data-solana-approve/);assert.equal(h.calls.includes('signTransaction'),false);
  }
});

test('mainnet launch displays real SOL and requires separate v0 wallet approval',async()=>{
 const h=fixture({mainnet:true,preparedCluster:'mainnet-beta',quoteChanges:{realFunds:true,simulation:'passed',transactionVersion:'v0',fundingLamports:0,totalRequiredLamports:3005000}});await h.window.RopadSolana.connect('phantom');await h.open();
 const form=h.body.querySelector('form');form.values={cluster:'mainnet-beta',name:'Orbit',ticker:'ORBIT',brief:'Build an orbital garden game',modelId:'anthropic/claude-opus-5.5',metadataUri:'https://metadata.ropad.fun/orbit.json'};await review(h,form);
 assert.match(h.body.innerHTML,/Solana mainnet · Real SOL/);assert.match(h.body.innerHTML,/0.003005 SOL/);assert.equal(h.calls.includes('signTransaction'),false);
 await h.body.querySelector('[data-solana-approve]').onclick();assert.equal(h.calls.filter(x=>x==='signTransaction').length,1);assert.match(h.body.innerHTML,/Your game coin is confirmed/);assert.doesNotMatch(h.body.innerHTML,/cluster=devnet/);
});
test('mainnet without successful simulation never reaches wallet signing',async()=>{
 const h=fixture({mainnet:true,preparedCluster:'mainnet-beta',quoteChanges:{realFunds:true,simulation:'failed',transactionVersion:'v0'}});await h.window.RopadSolana.connect('phantom');await h.open();
 const form=h.body.querySelector('form');form.values={cluster:'mainnet-beta',name:'Orbit',ticker:'ORBIT',brief:'Build an orbital garden game',modelId:'anthropic/claude-opus-5.5',metadataUri:'https://metadata.ropad.fun/orbit.json'};await review(h,form);assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/simulation and transaction review/);assert.equal(h.calls.includes('signTransaction'),false);assert.doesNotMatch(h.body.innerHTML,/data-solana-approve/);
});

async function review(h,form){
  await h.body.querySelector('[data-launch-generate-art]').onclick();
  await h.body.querySelector('form').onsubmit({preventDefault(){}});
  await h.body.querySelector('form').onsubmit({preventDefault(){}});
}

const brief={name:'Skyline Circuit',ticker:'SKY',brief:'An original rooftop running game with checkpoints',modelId:'anthropic/claude-opus-5.5'};
test('dedicated launch navigation itself makes no requests and mount is read only',async()=>{
  const h=fixture();h.window.openRobloxLaunch(brief);assert.equal(h.window.location.hash,'#/launch');assert.equal(h.requests.length,0);
  await h.window.RopadLaunchPage.mount(h.body);assert.match(h.body.innerHTML,/Skyline Circuit/);assert.equal(h.launch.open,false);assert.equal(h.requests.some(r=>r.method==='POST'),false);
});
test('game and builder steps can be inspected without a wallet or inference charge',async()=>{
  const h=fixture();await h.open();h.body.querySelector('form').values=brief;await h.body.querySelector('form').onsubmit({preventDefault(){}});
  assert.match(h.body.innerHTML,/Choose your builder/);assert.match(h.body.innerHTML,/max="5"/);assert.match(h.body.innerHTML,/No compatible idle Studio worker/);
  assert.equal(h.requests.some(r=>r.method==='POST'),false);assert.equal(h.calls.includes('signMessage'),false);
});
test('connecting from the Roblox account card preserves edited builder budget and options',async()=>{
  const h=fixture();await h.open();h.body.querySelector('form').values=brief;await h.body.querySelector('form').onsubmit({preventDefault(){}});
  h.body.querySelector('form').values={...brief,budgetUsd:'3.50'};h.body.querySelector('form').querySelector('[name="includeConcept"]').checked=true;
  await h.window.RopadSolana.connect('phantom');assert.match(h.body.innerHTML,/value="3\.50"/);assert.match(h.body.innerHTML,/name="includeConcept" checked/);assert.equal(h.requests.some(r=>r.url.includes('/agent/start')),false);
});
test('art generation asks for a wallet before any paid endpoint request',async()=>{
  const h=fixture();await h.open();h.body.querySelector('form').values=brief;await h.body.querySelector('[data-launch-generate-art]').onclick();
  assert.match(h.host.innerHTML,/Connect your creator wallet/);assert.equal(h.requests.some(r=>r.url==='/api/launch-artwork'),false);
});
test('a missing generated pair blocks launch preparation',async()=>{
  const h=fixture();await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values=brief;
  await h.body.querySelector('form').onsubmit({preventDefault(){}});await h.body.querySelector('form').onsubmit({preventDefault(){}});
  assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/Generate your game cover and coin icon/);assert.equal(h.requests.some(r=>r.url==='/api/solana/launches/prepare'),false);
});
test('confirmed generated artwork is linked to prepared launch without a separate metadata write',async()=>{
  const h=fixture({mainnet:true,preparedCluster:'mainnet-beta',quoteChanges:{realFunds:true,simulation:'passed',transactionVersion:'v0'}});await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values={...brief,cluster:'mainnet-beta'};
  await review(h,h.body.querySelector('form'));assert.equal(h.requests.find(r=>r.url==='/api/solana/launches/prepare').body.artworkId,'artwork-one');assert.equal(h.requests.some(r=>r.url==='/api/solana/metadata'),false);
  assert.match(h.body.innerHTML,/AI limit is separate from this SOL transaction/);assert.equal(h.requests.some(r=>/\/agent\/start$/.test(r.url)),false);
});
test('interrupted artwork request retries the same idempotency key',async()=>{
  const h=fixture({responses:{'/api/launch-artwork':()=>{throw Error('Interrupted response');}}});await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values=brief;
  await h.body.querySelector('[data-launch-generate-art]').onclick();await h.body.querySelector('[data-launch-generate-art]').onclick();
  const requests=h.requests.filter(r=>r.url==='/api/launch-artwork');assert.equal(requests.length,2);assert.equal(requests[0].body.idempotencyKey,requests[1].body.idempotencyKey);assert.match(h.body.innerHTML,/Check saved artwork/);
});
test('late artwork response cannot repaint a route that was left',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),h=fixture({responses:{'/api/launch-artwork':async()=>{await gate;return{artwork:{id:'late',status:'ready'}};}}});await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values=brief;
  const generation=h.body.querySelector('[data-launch-generate-art]').onclick();await new Promise(resolve=>setImmediate(resolve));h.window.RopadLaunchPage.unmount();h.body.innerHTML='Next page';release();await generation;assert.equal(h.body.innerHTML,'Next page');
});
test('coin confirmation never starts the builder automatically',async()=>{
  const h=fixture();await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values=brief;await review(h,h.body.querySelector('form'));await h.body.querySelector('[data-solana-approve]').onclick();
  assert.match(h.body.innerHTML,/Start builder/);assert.equal(h.requests.some(r=>/\/agent\/start$/.test(r.url)),false);
});
test('post-confirmation builder start checks creator ownership before charging',async()=>{
  const h=fixture({responses:{'/api/builds/game-build/agent':{build:{canManage:false}}}});await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values=brief;await review(h,h.body.querySelector('form'));await h.body.querySelector('[data-solana-approve]').onclick();await h.body.querySelector('[data-launch-start-builder]').onclick();
  assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/creator wallet/);assert.equal(h.requests.some(r=>/\/agent\/start$/.test(r.url)),false);
});
test('post-confirmation builder start submits only the reviewed bounded run after click',async()=>{
  const h=fixture({responses:{'/api/builds/game-build/agent':{build:{canManage:true}},'/api/builds/game-build/agent/start':{agent:{status:'running'}}}});await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values={...brief,budgetUsd:'2.00'};await review(h,h.body.querySelector('form'));await h.body.querySelector('[data-solana-approve]').onclick();await h.body.querySelector('[data-launch-start-builder]').onclick();
  const request=h.requests.find(r=>/\/agent\/start$/.test(r.url));assert.equal(request.body.budgetUsd,2);assert.equal(h.window.location.hash,'#/workspace/game-build');
});

const atomicFeeQuote={
  realFunds:true,simulation:'passed',transactionVersion:'v0',feeSharingRequired:true,feeSharingAtomic:true,permanentShares:true,
  feePolicyHash:'a'.repeat(64),sharingConfig:'So11111111111111111111111111111111111111112',
  feeShares:[{address:ADDRESS,shareBps:5000,role:'creator'},{address:OTHER,shareBps:3000,role:'compute'},{address:'33333333333333333333333333333333',shareBps:2000,role:'platform'}]
};
async function feeReview(quoteChanges={},responses={}){
  const h=fixture({mainnet:true,preparedCluster:'mainnet-beta',quoteChanges:{...atomicFeeQuote,...quoteChanges},responses});
  await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values={...brief,cluster:'mainnet-beta'};await review(h,h.body.querySelector('form'));return h;
}
const confirmedFees=extra=>({...atomicFeeQuote,cluster:'mainnet-beta',status:'confirmed',owner:ADDRESS,mint:OTHER,intentId:'intent-one',launchId:'launch-one',buildSession:{id:'game-build'},...extra});

test('atomic fee review shows exact shares and full recipients before wallet approval',async()=>{
  const h=await feeReview({mission:{name:'<script>unsafe</script>',ticker:'SKY'}});
  for(const address of atomicFeeQuote.feeShares.map(share=>share.address))assert.ok(h.body.innerHTML.includes('<code>'+address+'</code>'));
  for(const label of ['Creator · 50%','Game AI budget · 30%','Ropad treasury · 20%','Permanent allocation','not trading volume','does not buy AI provider credits'])assert.ok(h.body.innerHTML.includes(label),label);
  assert.ok(h.body.innerHTML.indexOf('Permanent allocation')<h.body.innerHTML.indexOf('data-solana-approve'));
  assert.match(h.body.innerHTML,/&lt;script&gt;unsafe&lt;\/script&gt;/);assert.doesNotMatch(h.body.innerHTML,/<script>unsafe/);
  assert.equal(h.body.querySelector('[data-solana-approve]').disabled,false);assert.equal(h.calls.includes('signTransaction'),false);
});

test('fee review preserves fractional basis-point percentages without rounding them to whole percentages',async()=>{
  const h=await feeReview({feeShares:atomicFeeQuote.feeShares.map((share,index)=>({...share,shareBps:[3333,3333,3334][index]}))});
  assert.match(h.body.innerHTML,/Creator · 33\.33%/);assert.match(h.body.innerHTML,/Ropad treasury · 33\.34%/);
});

test('missing or malformed required fee policies disable approval and cannot invoke wallet signing',async()=>{
  const shares=atomicFeeQuote.feeShares,malicious='<img src=x onerror=alert(1)>';
  for(const changes of [
    {feeShares:undefined},{feeShares:[]},{feeShares:shares.map((share,index)=>({...share,shareBps:index?share.shareBps:4999}))},
    {feeShares:[shares[0],{...shares[1],address:shares[0].address},shares[2]]},
    {feeShares:[{...shares[0],role:undefined},shares[1],shares[2]]},
    {feeShares:[{...shares[0],role:malicious},shares[1],shares[2]]},
    {feeShares:[{...shares[0],address:malicious},shares[1],shares[2]]},
    {feeShares:[{...shares[0],shareBps:'5000'},shares[1],shares[2]]},
    {feeSharingAtomic:undefined},{feeSharingAtomic:false},{permanentShares:false},{feePolicyHash:''},{sharingConfig:''}
  ]){
    const h=await feeReview(changes);assert.equal(h.body.querySelector('[data-solana-approve]').disabled,true,JSON.stringify(changes));
    assert.match(h.body.querySelector('[data-solana-feedback]').textContent,/fee routing|creator fee/i);
    assert.doesNotMatch(h.body.innerHTML,/<img src=x onerror/);
    await h.body.querySelector('[data-solana-approve]').onclick();
    assert.equal(h.calls.includes('signTransaction'),false);assert.equal(h.requests.some(request=>request.url==='/api/solana/launches/submit'),false);
    assert.equal(h.body.querySelector('[data-solana-approve]').disabled,true);
  }
});

test('required fee routing is never shown as verified without explicit chain verification',async()=>{
  const h=await feeReview();await h.body.querySelector('[data-solana-approve]').onclick();
  assert.match(h.body.innerHTML,/Your game coin is confirmed/);assert.match(h.body.innerHTML,/Fee routing unverified/);
  assert.doesNotMatch(h.body.innerHTML,/Creator fee routing verified on chain|data-launch-start-builder/);
  assert.equal(h.requests.some(request=>/\/agent\/start$/.test(request.url)),false);
});

test('confirmation cannot drop a reviewed required fee policy to enable the builder',async()=>{
  const h=await feeReview({}, {'/api/solana/launches/submit':confirmedFees({feeSharingRequired:false,feeSharingVerified:false})});
  await h.body.querySelector('[data-solana-approve]').onclick();assert.match(h.body.innerHTML,/Fee routing unverified/);assert.doesNotMatch(h.body.innerHTML,/data-launch-start-builder/);
});

test('verified fee routing confirmation enables a separate builder action without buying credits or starting it',async()=>{
  const h=await feeReview({}, {'/api/solana/launches/submit':confirmedFees({feeSharingVerified:true})});
  await h.body.querySelector('[data-solana-approve]').onclick();assert.match(h.body.innerHTML,/Creator fee routing verified on chain/);assert.match(h.body.innerHTML,/data-launch-start-builder/);
  assert.equal(h.requests.some(request=>/\/agent\/start$/.test(request.url)),false);
});

test('legacy confirmed launches without fee flags retain builder access but make no verified routing claim',async()=>{
  const h=fixture();await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values=brief;await review(h,h.body.querySelector('form'));await h.body.querySelector('[data-solana-approve]').onclick();
  assert.match(h.body.innerHTML,/data-launch-start-builder/);assert.doesNotMatch(h.body.innerHTML,/Creator fee routing verified on chain|Permanent allocation|Fee routing unverified/);
});

test('a saved launch can recover verified routing without requesting another transaction signature',async()=>{
  const h=await feeReview({}, {'/api/solana/launches/status':confirmedFees({feeSharingVerified:true})});
  await h.body.querySelector('[data-solana-approve]').onclick();await h.body.querySelector('[data-solana-recheck-fees]').onclick();
  assert.match(h.body.innerHTML,/Creator fee routing verified on chain/);assert.match(h.body.innerHTML,/data-launch-start-builder/);assert.equal(h.calls.filter(call=>call==='signTransaction').length,1);
});

const sharedWalletQuote={...atomicFeeQuote,feeShares:[{address:ADDRESS,shareBps:3000,role:'creator'},{address:OTHER,shareBps:7000,role:'combined',allocationsBps:{compute:6000,platform:1000}}]};
test('shared treasury review distinguishes the actual on-chain recipient from internal compute allocation',async()=>{
  const h=await feeReview(sharedWalletQuote);
  for(const text of ['Creator · 30%','Shared wallet · 70%','Internal allocation: Game AI budget 60% · Ropad treasury 10% of creator fees','Pump does not enforce separate balances inside that wallet'])assert.ok(h.body.innerHTML.includes(text),text);
  assert.equal(h.body.innerHTML.split('<code>'+OTHER+'</code>').length-1,2); // Mint and one shared recipient, never separate compute/platform rows.
  assert.doesNotMatch(h.body.innerHTML,/<dt>Game AI budget · 60%|<dt>Ropad treasury · 10%/);assert.equal(h.body.querySelector('[data-solana-approve]').disabled,false);assert.equal(h.calls.includes('signTransaction'),false);
});

test('a shared wallet may include the creator while retaining exact internal allocation disclosure',async()=>{
  const h=await feeReview({feeShares:[{address:OTHER,shareBps:10000,role:'combined',allocationsBps:{compute:6000,creator:3000,platform:1000}}]});
  assert.match(h.body.innerHTML,/Shared wallet · 100%/);assert.match(h.body.innerHTML,/Game AI budget 60% · Creator 30% · Ropad treasury 10%/);assert.equal(h.body.querySelector('[data-solana-approve]').disabled,false);
});

test('shared allocations must be exact, known and unique and cannot mislabel a single recipient',async()=>{
  for(const allocationsBps of [undefined,{},[],{compute:7000},{compute:6000,platform:999},{compute:'6000',platform:1000},{compute:6000,unknown:1000},{compute:7000,platform:0},{creator:1000,compute:6000}]){
    const h=await feeReview({feeShares:[sharedWalletQuote.feeShares[0],{...sharedWalletQuote.feeShares[1],allocationsBps}]});
    assert.equal(h.body.querySelector('[data-solana-approve]').disabled,true);await h.body.querySelector('[data-solana-approve]').onclick();assert.equal(h.calls.includes('signTransaction'),false);
  }
});

test('verified combined routing allows a separate builder action without claiming two on-chain wallets',async()=>{
  const h=await feeReview(sharedWalletQuote,{'/api/solana/launches/submit':confirmedFees({...sharedWalletQuote,feeSharingVerified:true})});await h.body.querySelector('[data-solana-approve]').onclick();
  assert.match(h.body.innerHTML,/Creator fee routing verified on chain/);assert.match(h.body.innerHTML,/data-launch-start-builder/);assert.equal(h.requests.some(request=>/\/agent\/start$/.test(request.url)),false);
});

test('public identity and community links survive builder navigation and reach launch preparation',async()=>{
  const h=fixture();await h.window.RopadSolana.connect('phantom');await h.open();
  assert.match(h.body.innerHTML,/Website & social links/);assert.ok(h.body.innerHTML.indexOf('name="name"')<h.body.innerHTML.indexOf('name="brief"'));
  const links={website:'https://skyline.game/',twitter:'https://x.com/skyline',discord:'https://discord.gg/skyline',telegram:'https://t.me/skyline'};
  h.body.querySelector('form').values={...brief,...links,description:'Race above the clouds'};
  await h.body.querySelector('form').onsubmit({preventDefault(){}});
  await h.body.querySelector('[data-launch-back]').onclick();
  for(const value of Object.values(links))assert.ok(h.body.innerHTML.includes(value));
  assert.match(h.body.innerHTML,/Race above the clouds/);
  await review(h,h.body.querySelector('form'));
  const request=h.requests.find(r=>r.url==='/api/solana/launches/prepare');
  assert.deepEqual(request.body.links,links);assert.equal(request.body.description,'Race above the clouds');assert.equal(request.body.website,undefined);
  assert.match(h.body.innerHTML,/Public project details/);assert.equal(h.calls.includes('signTransaction'),false);
});

test('unsafe community links block progression before wallet verification or artwork generation',async()=>{
  for(const invalid of [{website:'javascript:alert(1)'},{website:'https://127.0.0.1/'},{website:'https://user:secret@site.com/'},{website:'https://private.lan/'},{website:'https://private.home/'},{website:'https://site.com./'},{website:'https://site.com/a\nb'},{twitter:'https://x.com.attacker.com/name'},{telegram:'https://elsewhere.com/a'},{discord:'http://discord.gg/a'}]){
    const h=fixture();await h.open();h.body.querySelector('form').values={...brief,...invalid};
    await h.body.querySelector('form').onsubmit({preventDefault(){}});
    assert.match(h.body.innerHTML,/Make it yours/);assert.equal(h.requests.some(r=>r.method==='POST'),false);assert.equal(h.calls.includes('signMessage'),false);
  }
});

test('review displays the saved mission links and escapes its public description',async()=>{
  const h=fixture({quoteChanges:{mission:{...brief,description:'<b>Saved public summary</b>',links:{website:'https://saved.game/'}}}});
  await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values={...brief,website:'https://draft.game/'};await review(h,h.body.querySelector('form'));
  assert.match(h.body.innerHTML,/href="https:\/\/saved.game\/"/);assert.match(h.body.innerHTML,/&lt;b&gt;Saved public summary&lt;\/b&gt;/);assert.doesNotMatch(h.body.innerHTML,/<b>Saved public summary/);
  assert.doesNotMatch(h.body.innerHTML,/draft.game/);
});

test('legacy saved mission without socials never inherits another draft links or artwork',async()=>{
  const h=fixture({quoteChanges:{mission:brief}});await h.window.RopadSolana.connect('phantom');await h.open();h.body.querySelector('form').values={...brief,website:'https://draft.game/'};await review(h,h.body.querySelector('form'));
  assert.doesNotMatch(h.body.innerHTML,/draft.game|alt="AI-generated game cover"/);
});

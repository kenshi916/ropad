'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {Keypair,VersionedTransaction,TransactionMessage,SystemProgram}=require('./parallax/node_modules/@solana/web3.js');
const sourcePath=fs.existsSync(path.join(__dirname,'parallax/dist/fee-sharing.js'))?path.join(__dirname,'parallax/dist/fee-sharing.js'):path.join(__dirname,'../dist/fee-sharing.js'),source=fs.readFileSync(sourcePath,'utf8');
class Node{
  constructor(){this._html='';this.nodes=new Map();this.handlers={};this.isConnected=true;}
  set innerHTML(value){this._html=value;this.nodes.clear();}get innerHTML(){return this._html;}
  querySelector(selector){const name=/^\[([^\]]+)\]$/.exec(selector)?.[1];if(!name||!this._html.includes(name))return null;if(!this.nodes.has(selector))this.nodes.set(selector,new Node());return this.nodes.get(selector);}
  addEventListener(event,handler){this.handlers[event]=handler;}
}
function fixture(options={}){
  const walletKey=Keypair.generate(),owner=walletKey.publicKey.toBase58(),other=Keypair.generate().publicKey.toBase58(),platform=Keypair.generate().publicKey.toBase58(),compute=Keypair.generate().publicKey.toBase58(),platformMint=Keypair.generate().publicKey.toBase58(),mint=Keypair.generate().publicKey.toBase58(),buildId=crypto.randomUUID(),projectId=crypto.randomUUID(),intentId=crypto.randomUUID();
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:walletKey.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:walletKey.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})]}).compileToV0Message());
  const config={status:'configured',cluster:'mainnet-beta',platformMint,platformTreasury:platform,computeTreasury:compute,splitBps:options.creatorShare?{creator:5000,platform:3000,compute:2000}:{platform:6000,compute:4000},permanentShares:true,...options.configChanges};
  if(options.sharedTreasury)config.computeTreasury=config.platformTreasury;
  if(options.creatorIsTreasury){config.platformTreasury=owner;config.computeTreasury=owner;}
  const grouped=new Map();for(const [address,bps] of [[config.platformTreasury,config.splitBps.platform],[config.computeTreasury,config.splitBps.compute],...(config.splitBps.creator?[[owner,config.splitBps.creator]]:[])])grouped.set(address,(grouped.get(address)||0)+bps);
  const shares=[...grouped].map(([address,shareBps])=>({address,shareBps})),base={intentId,owner,projectId,mint,status:'prepared',cluster:'mainnet-beta',transactionVersion:'v0',transactionBase64:Buffer.from(tx.serialize()).toString('base64'),expiresAt:Date.now()+60000,estimatedNetworkFeeLamports:'5000',simulation:'passed',shares,creatorWallet:config.splitBps.creator?owner:null,platformMint:config.platformMint,permanentShares:true,rentMayApply:true,realFunds:true};
  const dialog=new Node(),body=new Node(),events={},storage=new Map(),requests=[],calls=[];let current=owner,latestQuote=null;const root=()=>body.querySelector('[data-ropad-fees-root]');
  if(options.pending)storage.set('ropad.fee-sharing.pending.v1',JSON.stringify({[buildId+':'+owner]:{intentId,owner,projectId,mint,cluster:'mainnet-beta'}}));
  const wallet={get address(){return current;},provider:{signTransaction:async transaction=>{calls.push('sign');if(options.changeDuringSign){current=other;events['ropad-solana-wallet-change']?.();}if(options.tamperSigned)transaction.message.recentBlockhash=Keypair.generate().publicKey.toBase58();transaction.sign([walletKey]);return transaction;}}};
  const window={openInfo:(_,html)=>{body.innerHTML=html;},addEventListener:(name,fn)=>events[name]=fn,RopadSolana:{get:()=>options.noWallet?null:wallet,authenticate:async()=>{calls.push('authenticate');},check:expected=>{if(current!==expected)throw Error('Wallet account changed');return wallet;}},solanaWeb3:{VersionedTransaction}};
  const context={window,document:{getElementById:id=>id==='info-body'?body:dialog},AbortSignal,Uint8Array,BigInt,Date,atob:v=>Buffer.from(v,'base64').toString('binary'),btoa:v=>Buffer.from(v,'binary').toString('base64'),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{if(options.storageFailure)throw Error('No storage');storage.set(k,v);}},fetch:async(url,init={})=>{
    const input=init.body?JSON.parse(init.body):null;requests.push({url,input});
    if(url==='/api/status')return {ok:true,json:async()=>({csrf:'fixture-csrf'})};
    if(url==='/api/solana/fees/submit'&&options.submitError)throw Error('connection lost');
    let payload;if(url.startsWith('/api/builds/'))payload={build:{id:buildId,lineage:{projectId},gameName:'Skyline Circuit',canManage:options.notOwner!==true,token:{chain:'solana',cluster:options.devnet?'devnet':'mainnet-beta',verified:true,address:mint}}};
    else if(url.endsWith('/config'))payload=config;
    else if(url.endsWith('/list'))payload={data:options.serverPending?[{...base,status:'pending'}]:[]};
    else if(url.endsWith('/inspect'))payload={projectId,mint,onChainConfigurationVerified:options.verified===true,adminRevoked:options.verified===true,shares:options.verified?shares:[]};
    else if(url.endsWith('/prepare')){if(options.prepareGate)await options.prepareGate;payload=latestQuote={...base,action:input.action,permanentShares:input.action==='configure',...options.quoteChanges};}
    else if(url.endsWith('/submit'))payload={...latestQuote,status:'pending',signature:'1'.repeat(88)};
    else if(url.endsWith('/status'))payload={...base,action:'configure',status:'pending',...options.statusChanges};
    else throw Error('Unexpected URL '+url);
    return {ok:true,json:async()=>payload};
  }};
  vm.runInNewContext(source,context,{filename:sourcePath});
  const click=async name=>{const node=root()?.querySelector('[data-fees-'+name+']');assert.ok(node,'Expected '+name+' button');return node.handlers.click();};
  const ack=()=>{const node=root().querySelector('[data-fees-ack]');assert.ok(node);node.handlers.change({target:{checked:true}});};
  return {window,root,dialog,events,storage,requests,calls,buildId,projectId,mint,owner,other,intentId,config,options,open:()=>window.RopadFeeSharing.open(buildId),click,ack,changeWallet:()=>{current=other;events['ropad-solana-wallet-change']?.();}};
}
test('opening creator fees only inspects configuration; no transaction is prepared, signed, or distributed automatically',async()=>{
  const f=fixture();await f.open();assert.match(f.root().innerHTML,/All creator fees go to the platform and compute treasuries/);assert.match(f.root().innerHTML,/does not buy the platform token or automatically purchase OpenRouter credits/);assert.match(f.root().innerHTML,new RegExp(f.config.platformTreasury));assert.match(f.root().innerHTML,/60%/);assert.equal(f.calls.includes('sign'),false);assert.equal(f.requests.some(r=>r.url.endsWith('/prepare')||r.url.endsWith('/submit')),false);
});
test('creator mainnet verification is required and unavailable configuration cannot request a fee transaction',async()=>{
  for(const options of [{notOwner:true},{devnet:true},{noWallet:true},{configChanges:{status:'inactive',reason:'Treasury setup required'}}]){const f=fixture(options);await f.open();assert.equal(f.calls.includes('sign'),false);assert.equal(f.requests.some(r=>r.url.endsWith('/prepare')),false);if(options.configChanges)assert.match(f.root().innerHTML,/Treasury setup required/);else assert.match(f.root().innerHTML,/Only the creator|Connect the launching/);}
});
test('permanent assignment needs separate exact quote review and explicit acknowledgment before signing',async()=>{
  const f=fixture();await f.open();await f.click('configure');assert.equal(f.calls.includes('sign'),false);assert.match(f.root().innerHTML,/permanent fee sharing/);assert.match(f.root().innerHTML,/0\.000005 SOL/);assert.match(f.root().innerHTML,/network fee shown is not the total SOL cost/);await f.click('sign');assert.equal(f.calls.includes('sign'),false);assert.match(f.root().innerHTML,/Acknowledge the exact fee assignment/);
  f.ack();await f.click('sign');assert.equal(f.calls.filter(c=>c==='sign').length,1);assert.equal(f.requests.filter(r=>r.url.endsWith('/submit')).length,1);assert.match(f.root().innerHTML,/awaiting confirmation/);assert.ok(f.storage.has('ropad.fee-sharing.pending.v1'));
});
test('mismatched recipient, split, mint, owner, network, missing fee or expired preview cannot reach the wallet',async()=>{
  for(const quoteChanges of [{shares:[]},{shares:[{address:'1'.repeat(32),shareBps:10000}]},{mint:'1'.repeat(32)},{owner:'1'.repeat(32)},{cluster:'devnet'},{estimatedNetworkFeeLamports:undefined},{expiresAt:1},{permanentShares:false},{transactionVersion:'legacy'}]){const f=fixture({quoteChanges});await f.open();await f.click('configure');assert.match(f.root().innerHTML,/preview does not match/);assert.equal(f.calls.includes('sign'),false);assert.equal(f.requests.some(r=>r.url.endsWith('/submit')),false);}
});
test('wallet changes during approval or delayed preview prevent submission and invalidate the whole review',async()=>{
  const f=fixture({changeDuringSign:true});await f.open();await f.click('configure');f.ack();await f.click('sign');assert.equal(f.requests.some(r=>r.url.endsWith('/submit')),false);assert.match(f.root().innerHTML,/Fee review closed/);
  let release;const gate=new Promise(resolve=>release=resolve),g=fixture({prepareGate:gate});await g.open();const preparing=g.click('configure');await new Promise(resolve=>setImmediate(resolve));g.changeWallet();release();await preparing;assert.equal(g.calls.includes('sign'),false);assert.match(g.root().innerHTML,/Fee review closed/);
});
test('changed wallet transaction message and unavailable durable browser recovery stop broadcast',async()=>{
  for(const options of [{tamperSigned:true},{storageFailure:true}]){const f=fixture(options);await f.open();await f.click('configure');f.ack();await f.click('sign');assert.equal(f.calls.filter(c=>c==='sign').length,1);assert.equal(f.requests.some(r=>r.url.endsWith('/submit')),false);assert.match(f.root().innerHTML,/changed or expired|recovery storage is unavailable/);}
});
test('unknown submission preserves original recovery and does not permit another wallet approval',async()=>{
  const f=fixture({submitError:true});await f.open();await f.click('configure');f.ack();await f.click('sign');assert.match(f.root().innerHTML,/Submission outcome is unknown/);assert.match(f.root().innerHTML,/Check saved transaction/);assert.equal(f.root().querySelector('[data-fees-sign]'),null);await f.click('status');assert.equal(f.calls.filter(c=>c==='sign').length,1);assert.equal(f.requests.filter(r=>r.url.endsWith('/submit')).length,1);
});
test('only a matching finalized receipt and verified on-chain split clear a pending fee transaction',async()=>{
  for(const statusChanges of [{status:'confirmed',finalized:false,onChainConfigurationVerified:true},{status:'confirmed',finalized:true,onChainConfigurationVerified:false},{status:'confirmed',owner:'1'.repeat(32),finalized:true,onChainConfigurationVerified:true}]){const f=fixture({pending:true,statusChanges});await f.open();await f.click('status');assert.match(f.root().innerHTML,/awaiting confirmation/);assert.equal(f.calls.includes('sign'),false);}
  const done=fixture({pending:true,verified:true,statusChanges:{status:'confirmed',finalized:true,onChainConfigurationVerified:true}});await done.open();await done.click('status');assert.doesNotMatch(done.root().innerHTML,/transaction awaiting confirmation/);assert.match(done.root().innerHTML,/exact permanent split is verified/);assert.deepEqual(JSON.parse(done.storage.get('ropad.fee-sharing.pending.v1')),{});
});
test('distribution is a separate reviewed action with the same explicit recipient approval',async()=>{
  const f=fixture({verified:true});await f.open();await f.click('distribute');assert.equal(f.requests.find(r=>r.url.endsWith('/prepare')).input.action,'distribute');assert.match(f.root().innerHTML,/Review fee distribution/);assert.match(f.root().innerHTML,/approve distributing accrued fees/);assert.equal(f.calls.includes('sign'),false);f.ack();await f.click('sign');assert.equal(f.calls.filter(c=>c==='sign').length,1);
});

test('three-way policy displays creator wallet and only approves the exact verified owner share',async()=>{
 const f=fixture({creatorShare:true});await f.open();assert.match(f.root().innerHTML,/Game creator · 50%/);assert.match(f.root().innerHTML,new RegExp(f.owner));assert.match(f.root().innerHTML,/shared between the game creator, platform and compute/);assert.doesNotMatch(f.root().innerHTML,/signing creator keeps no share/);await f.click('configure');assert.equal(f.calls.includes('sign'),false);assert.match(f.root().innerHTML,/exact recipients above/);f.ack();await f.click('sign');assert.equal(f.calls.filter(c=>c==='sign').length,1);
});
test('creator-share quote cannot substitute or omit the verified creator wallet',async()=>{
 for(const quoteChanges of [{creatorWallet:undefined},{creatorWallet:'1'.repeat(32)},{shares:[]}]){const f=fixture({creatorShare:true,quoteChanges});await f.open();await f.click('configure');assert.match(f.root().innerHTML,/preview does not match/);assert.equal(f.calls.includes('sign'),false);assert.equal(f.requests.some(r=>r.url.endsWith('/submit')),false);}
});

test('a shared AI and platform wallet shows the combined on-chain payment and internal reserve before approval',async()=>{
 const f=fixture({creatorShare:true,sharedTreasury:true,configChanges:{platformMint:null,splitBps:{compute:6000,creator:3000,platform:1000}}});await f.open();assert.match(f.root().innerHTML,/Shared treasury · 70%/);assert.match(f.root().innerHTML,/Game creator · 30%/);assert.match(f.root().innerHTML,/Platform treasury 10% \+ AI compute 60%/);assert.match(f.root().innerHTML,/not separate on-chain reserves/);await f.click('configure');f.ack();await f.click('sign');assert.equal(f.calls.filter(c=>c==='sign').length,1);assert.equal(f.requests.filter(r=>r.url.endsWith('/submit')).length,1);
});
test('creator and treasury collisions combine into one actual recipient without requiring a platform token',async()=>{
 const f=fixture({creatorShare:true,creatorIsTreasury:true,configChanges:{platformMint:null}});await f.open();assert.match(f.root().innerHTML,/Shared treasury · 100%/);await f.click('configure');f.ack();await f.click('sign');assert.equal(f.calls.filter(c=>c==='sign').length,1);
});
test('shared-wallet quotes cannot hide duplicated recipients or a wrong combined percentage',async()=>{
 for(const shares of [[{address:'1'.repeat(32),shareBps:7000},{address:'1'.repeat(32),shareBps:3000}],[]]){const f=fixture({creatorShare:true,sharedTreasury:true,quoteChanges:{shares}});await f.open();await f.click('configure');assert.match(f.root().innerHTML,/preview does not match/);assert.equal(f.calls.includes('sign'),false);}
});

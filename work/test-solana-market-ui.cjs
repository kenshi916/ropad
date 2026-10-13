'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sourcePath=fs.existsSync(path.join(__dirname,'parallax/dist/solana-market-ui.js'))?path.join(__dirname,'parallax/dist/solana-market-ui.js'):path.join(__dirname,'../dist/solana-market-ui.js');
const source=fs.readFileSync(sourcePath,'utf8'),OWNER='11111111111111111111111111111111',OTHER='22222222222222222222222222222222';
class Element{
  constructor(){this.innerHTML='';this.textContent='';this.nodes=new Map();this.isConnected=true;}
  querySelector(selector){if(!this.nodes.has(selector))this.nodes.set(selector,new Element());return this.nodes.get(selector);}
  querySelectorAll(selector){const key=selector==='[data-sol-preset]'?'sol-preset':selector==='[data-sol-side]'?'sol-side':null;if(!key)return [];return [...this.innerHTML.matchAll(new RegExp('data-'+key+'="([^"]+)"','g'))].map(match=>{const node=this.querySelector('[data-'+key+'="'+match[1]+'"]');node.dataset=key==='sol-preset'?{solPreset:match[1]}:{solSide:match[1]};return node;});}
  addEventListener(event,handler){this['on'+event]=handler;}
  remove(){}
}
function fixture({quoteChanges={},marketChanges={},marketError=false,marketGate=null,changeWhileSigning=false,submissionError=false,pendingRecord=null,tradeStatus={status:'pending'},token={address:OTHER,symbol:'GAME',chain:'solana',cluster:'mainnet-beta',verified:true}}={}){
  const requests=[],calls=[],root=new Element(),storage=new Map(),events={},dispatched=[];
  let now=Date.now();const TestDate=class extends Date{static now(){return now;}};
  const document={visibilityState:'visible',activeElement:null};root.contains=node=>[...root.nodes.values()].includes(node);
  const build={id:'game-one',gameName:'Orbital Garden',token};
  if(pendingRecord)storage.set('ropad.solana.trade.v1',JSON.stringify({[build.id]:pendingRecord}));
  const wallet={address:OWNER,provider:{signTransaction:async()=>{calls.push('signTransaction');if(changeWhileSigning){wallet.address=OTHER;events['ropad-solana-wallet-change']?.();}return{serialize:()=>new Uint8Array([1,2,3])};}}};
  const window={ParallaxOrbio:{buildTradePanel:()=>'<div>LEGACY_ETH_PANEL</div>',wireBuildTradePanel(){}},ParallaxBuilders:{refresh(){}},addEventListener:(name,handler)=>events[name]=handler,dispatchEvent:event=>dispatched.push(event),RopadSolana:{get:()=>wallet,authenticate:async()=>{calls.push('authenticate');},check:async expected=>{if(expected&&wallet.address!==expected)throw Error('Wallet account changed');return wallet;},connect(){}},solanaWeb3:{VersionedTransaction:{deserialize:()=>({})}}};
  const quote={intentId:'trade-one',owner:OWNER,mint:OTHER,cluster:'mainnet-beta',transactionVersion:'v0',simulation:'passed',transactionBase64:'AQID',expiresAt:Date.now()+60000,estimatedNetworkFeeLamports:5000,estimatedWalletSolChangeLamports:-10005000,amountIn:'0.01',side:'buy',slippageBps:100,expectedOut:'100',minimumOut:'99',inputSymbol:'SOL',outputSymbol:'GAME',feePct:1};
  const context={window,document,AbortSignal,Uint8Array,Date:TestDate,CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},atob:value=>Buffer.from(value,'base64').toString('binary'),btoa:value=>Buffer.from(value,'binary').toString('base64'),fetch:async(url,options={})=>{
    requests.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
    if(url.includes('/market?')&&marketGate)await marketGate;
    if(url==='/api/solana/trades/submit'&&submissionError)throw Error('The submission response was interrupted');
    if(url.includes('/market?')&&marketError)throw Error('Market lookup failed');
    const input=options.body?JSON.parse(options.body):{};
    const payload=url==='/api/status'?{csrf:'OFFLINE_CSRF'}:url==='/api/solana/trades/prepare'?{...quote,amountIn:input.amount,side:input.side,slippageBps:input.slippageBps,...quoteChanges}:url==='/api/solana/trades/submit'?{status:'pending',signature:'test-signature'}:url==='/api/solana/trades/status'?tradeStatus:{mint:OTHER,cluster:'mainnet-beta',priceSol:'0.00000012',marketCapSol:'120',supply:'1000000000',available:true,slot:123,checkedAt:now,...marketChanges};
    return{ok:true,json:async()=>payload};
  }};
  vm.runInNewContext(source,context,{filename:sourcePath});root.innerHTML=window.ParallaxOrbio.buildTradePanel(build);window.ParallaxOrbio.wireBuildTradePanel(build,root,true);
  const ready=new Promise(resolve=>setImmediate(()=>{root.querySelector('[name="solAmount"]').oninput?.({target:{value:'0.01'}});resolve();}));
  return{window,root,wallet,build,requests,calls,storage,dispatched,document,ready,advance:ms=>{now+=ms;},click:async()=>{await ready;return root.querySelector('[data-sol-trade]').onclick();}};
}
test('switching wallet accounts during trade signing prevents submission',async()=>{
  const h=fixture({changeWhileSigning:true});await h.click();assert.match(h.root.innerHTML,/SIMULATED SWAP PREVIEW/);assert.equal(h.calls.includes('signTransaction'),false);
  await h.click();assert.equal(h.calls.filter(value=>value==='signTransaction').length,1);assert.match(h.root.innerHTML,/Wallet account changed/);
  assert.equal(h.requests.some(item=>item.url==='/api/solana/trades/submit'),false);assert.equal(h.storage.has('ropad.solana.trade.v1'),false);
});
test('missing network fee or expiry prevents a malformed trade quote from reaching the wallet',async()=>{
  for(const quoteChanges of [{estimatedNetworkFeeLamports:undefined},{expiresAt:undefined},{expiresAt:Date.now()-1},{cluster:'devnet'}]){
    const h=fixture({quoteChanges});await h.click();await h.click();assert.match(h.root.innerHTML,/complete valid trade preview is unavailable/);
    assert.equal(h.calls.includes('signTransaction'),false);assert.equal(h.requests.some(item=>item.url==='/api/solana/trades/submit'),false);
  }
});
test('a pending trade requires its original owner before querying status',async()=>{
  const h=fixture({pendingRecord:{intentId:'trade-one',owner:OTHER}});await h.root.querySelector('[data-sol-status]').onclick();
  assert.match(h.root.innerHTML,/Wallet account changed/);assert.equal(h.requests.some(item=>item.url==='/api/solana/trades/status'),false);assert.equal(h.calls.includes('signTransaction'),false);
});
test('an interrupted trade submission preserves recovery and prevents a duplicate wallet approval',async()=>{
  const h=fixture({submissionError:true});await h.click();await h.click();
  assert.match(h.root.innerHTML,/Trade awaiting confirmation/);assert.equal(JSON.parse(h.storage.get('ropad.solana.trade.v1'))['game-one'].intentId,'trade-one');
  await h.click();assert.match(h.root.innerHTML,/Check the pending transaction first/);assert.equal(h.calls.filter(value=>value==='signTransaction').length,1);
  assert.equal(h.requests.filter(item=>item.url==='/api/solana/trades/submit').length,1);
});
test('unminted workspaces use Solana while existing Ethereum records keep their legacy panel',()=>{
  for(const token of [null,{}]){const h=fixture({token});assert.match(h.root.innerHTML,/GAME COIN · SOLANA/);assert.doesNotMatch(h.root.innerHTML,/LEGACY_ETH_PANEL/);assert.equal(h.requests.length,0);}
  const legacy=fixture({token:{address:'0x0123456789abcdef',chainId:4663}});assert.match(legacy.root.innerHTML,/LEGACY_ETH_PANEL/);
});

test('Devnet and unverified mints keep a disabled trade scaffold without activating real funds',async()=>{
  const mint='11111111111111111111111111111111';
  const dev=fixture({token:{chain:'solana',cluster:'devnet',verified:true,address:mint,symbol:'GAME'}});
  assert.match(dev.root.innerHTML,/no real market cap or trading pool/);assert.match(dev.root.innerHTML,/cluster=devnet/);
  assert.match(dev.root.innerHTML,/name="solAmount"[^>]*disabled/);assert.match(dev.root.innerHTML,/data-sol-trade disabled/);assert.doesNotMatch(dev.root.innerHTML,/Uses real SOL/);
  const unverified=fixture({token:{chain:'solana',cluster:'mainnet-beta',verified:false,address:mint}});
  assert.match(unverified.root.innerHTML,/data-sol-trade disabled/);assert.doesNotMatch(unverified.root.innerHTML,/Uses real SOL/);
  for(const h of [dev,unverified]){await h.click();assert.equal(h.calls.length,0);assert.equal(h.requests.some(item=>item.method==='POST'),false);}
});

test('mainnet trade previews distinguish simulation, curve fees and account rent',async()=>{
  const h=fixture({quoteChanges:{feePct:'1',estimatedWalletSolChangeLamports:'-10300000',accountRentMayApply:true}});await h.click();
  assert.match(h.root.innerHTML,/Curve fee rate/);assert.match(h.root.innerHTML,/-0.0103 SOL/);
  assert.match(h.root.innerHTML,/refundable token-account rent/);assert.match(h.root.innerHTML,/Simulation estimate/);
});

test('buy presets invalidate the reviewed quote and require a new amount-specific preview',async()=>{
  const h=fixture();await h.click();assert.match(h.root.innerHTML,/SIMULATED SWAP PREVIEW/);
  h.root.querySelector('[data-sol-preset="0.5"]').onclick();
  assert.doesNotMatch(h.root.innerHTML,/SIMULATED SWAP PREVIEW/);assert.match(h.root.innerHTML,/data-sol-receive>—/);assert.match(h.root.innerHTML,/value="0.5"/);
  assert.equal(h.calls.includes('signTransaction'),false);await h.click();
  const requests=h.requests.filter(item=>item.url==='/api/solana/trades/prepare');assert.equal(requests.length,2);assert.equal(requests[1].body.amount,'0.5');
  assert.equal(h.calls.includes('signTransaction'),false);assert.match(h.root.innerHTML,/SIMULATED SWAP PREVIEW/);
  h.root.querySelector('[data-sol-side="sell"]').onclick();assert.doesNotMatch(h.root.innerHTML,/data-sol-preset=/);assert.match(h.root.innerHTML,/data-sol-receive>—/);
});

test('unavailable, failed and mismatched market snapshots cannot authenticate or prepare trades',async()=>{
  for(const options of [{marketChanges:{available:false,reason:'The curve has completed'}},{marketError:true},{marketChanges:{mint:OWNER}},{marketChanges:{cluster:'devnet'}},{marketChanges:{marketCapSol:'not-a-number'}}]){
    const h=fixture(options);await h.ready;assert.match(h.root.innerHTML,/data-sol-trade disabled/);await h.click();
    assert.equal(h.calls.length,0);assert.equal(h.requests.some(item=>item.method==='POST'),false);assert.match(h.root.innerHTML,/Market cap <strong>—/);
  }
});

test('market loading remains read-only and refresh coalesces without wallet access',async()=>{
  let resolveMarket;const gate=new Promise(resolve=>{resolveMarket=resolve;}),h=fixture({marketGate:gate});
  const first=h.window.RopadSolanaMarket.refresh(h.build),second=h.window.RopadSolanaMarket.refresh(h.build);
  assert.equal(first,second);assert.equal(h.requests.filter(item=>item.url.includes('/market?')).length,1);
  assert.equal(h.window.RopadSolanaMarket.snapshot(h.build).loading,true);await h.click();assert.equal(h.calls.length,0);assert.equal(h.requests.some(item=>item.method==='POST'),false);
  resolveMarket();await first;assert.equal(h.window.RopadSolanaMarket.snapshot(h.build).loading,false);assert.equal(h.calls.length,0);
});

test('quotes for another mint, side, input or slippage never reach wallet signing',async()=>{
  for(const quoteChanges of [{mint:OWNER},{side:'sell'},{amountIn:'0.1'},{slippageBps:500}]){
    const h=fixture({quoteChanges});await h.click();await h.click();assert.match(h.root.innerHTML,/complete valid trade preview is unavailable/);
    assert.equal(h.calls.includes('signTransaction'),false);assert.equal(h.requests.some(item=>item.url==='/api/solana/trades/submit'),false);
  }
});

test('snapshot is copied, validated and announced without inventing USD market values',async()=>{
  const h=fixture({marketChanges:{marketCapSol:'27958.993476234'}});await h.ready;
  const snapshot=h.window.RopadSolanaMarket.snapshot(h.build);assert.equal(snapshot.market.mint,OTHER);assert.equal(snapshot.market.cluster,'mainnet-beta');assert.ok(snapshot.marketAt>0);
  assert.match(h.root.innerHTML,/27,958\.993476234 SOL/);assert.doesNotMatch(h.root.innerHTML,/27,958\.993,476,234/);assert.doesNotMatch(h.root.innerHTML,/USD/);
  snapshot.market.mint=OWNER;assert.equal(h.window.RopadSolanaMarket.snapshot(h.build).market.mint,OTHER);
  assert.equal(h.dispatched.length,1);assert.equal(h.dispatched[0].type,'ropad-market-update');assert.equal(h.dispatched[0].detail.buildId,h.build.id);
  const wrong=fixture({marketChanges:{mint:OWNER}});await wrong.ready;assert.equal(wrong.window.RopadSolanaMarket.snapshot(wrong.build).market,null);assert.match(wrong.window.RopadSolanaMarket.snapshot(wrong.build).error,/verified market snapshot/);
});

test('read-only refresh throttles, pauses when hidden and preserves focused input selection',async()=>{
  const h=fixture();await h.ready;const marketRequests=()=>h.requests.filter(item=>item.url.includes('/market?')).length;
  await h.window.RopadSolanaMarket.refresh(h.build);assert.equal(marketRequests(),1);
  h.advance(30001);h.document.visibilityState='hidden';await h.window.RopadSolanaMarket.refresh(h.build);assert.equal(marketRequests(),1);
  h.document.visibilityState='visible';h.root.isConnected=false;await h.window.RopadSolanaMarket.refresh(h.build);assert.equal(marketRequests(),1);
  h.root.isConnected=true;const input=h.root.querySelector('[name="solAmount"]');input.getAttribute=name=>name==='name'?'solAmount':null;input.selectionStart=1;input.selectionEnd=3;
  input.focus=()=>h.calls.push('focus');input.setSelectionRange=(start,end)=>h.calls.push(['selection',start,end]);h.document.activeElement=input;
  await h.window.RopadSolanaMarket.refresh(h.build);assert.equal(marketRequests(),2);assert.ok(h.calls.includes('focus'));assert.deepEqual(h.calls.find(item=>Array.isArray(item)),['selection',1,3]);
  assert.equal(h.calls.includes('authenticate'),false);assert.equal(h.dispatched.length,2);
});

test('expired quotes hide receive estimates and require a fresh review instead of signing',async()=>{
  const h=fixture();await h.click();h.advance(60001);h.root.innerHTML=h.window.ParallaxOrbio.buildTradePanel(h.build);
  assert.doesNotMatch(h.root.innerHTML,/SIMULATED SWAP PREVIEW/);assert.match(h.root.innerHTML,/data-sol-receive>—/);assert.match(h.root.innerHTML,/The quote expired/);
  await h.click();assert.equal(h.calls.includes('signTransaction'),false);assert.equal(h.requests.filter(item=>item.url==='/api/solana/trades/prepare').length,2);
});

test('finalized transaction expiry clears pending recovery without calling a signed transaction unsigned',async()=>{
  const h=fixture({pendingRecord:{intentId:'trade-one',owner:OWNER,signature:'known-signature'},tradeStatus:{status:'expired'}});await h.ready;await h.root.querySelector('[data-sol-status]').onclick();
  assert.match(h.root.innerHTML,/transaction expired without a confirmed trade/);assert.doesNotMatch(h.root.innerHTML,/unsigned trade expired|Trade finalized on Solana/);
  assert.equal(JSON.parse(h.storage.get('ropad.solana.trade.v1'))['game-one'],undefined);assert.equal(h.calls.includes('signTransaction'),false);
});

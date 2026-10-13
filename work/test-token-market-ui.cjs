'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const file=fs.existsSync(path.join(__dirname,'parallax/dist/token-market.js'))?path.join(__dirname,'parallax/dist/token-market.js'):path.join(__dirname,'../dist/token-market.js');
const source=fs.readFileSync(file,'utf8'), MINT='11111111111111111111111111111111', OTHER='22222222222222222222222222222222';
function fixture(){
  let now=1802000000000, snapshot={};
  const listeners={},calls=[],copies=[];
  class Clock extends Date {static now(){return now;}}
  const window={navigator:{clipboard:{writeText:async text=>copies.push(text)}},addEventListener:(name,fn)=>{(listeners[name]||=[]).push(fn);},RopadSolanaMarket:{snapshot:build=>{calls.push(build.id);return snapshot;}}};
  vm.runInNewContext(source,{window,Date:Clock},{filename:file});
  const build={id:'game-a',token:{chain:'solana',cluster:'mainnet-beta',address:MINT,verified:true,symbol:'GAME'}};
  const root=()=>({innerHTML:'',isConnected:true,writes:0,status:{isConnected:true,textContent:''},contains:()=>true,querySelector(){return this.status;}});
  const set=(changes={})=>{snapshot={market:{cluster:'mainnet-beta',mint:MINT,priceSol:'0.00000003',marketCapSol:'30',supply:'1000000000',available:true,slot:100,checkedAt:now,...changes},marketAt:now,loading:false,error:''};return snapshot;};
  const click=(node,data)=>node.onclick({target:{closest:()=>({dataset:data,disabled:false,hasAttribute:name=>name==='data-market-copy'&&data.copy})}});
  return {window,build,root,set,calls,copies,listeners,click,render:b=>window.RopadTokenMarket.panel(b||build),wire:(b,r)=>window.RopadTokenMarket.wire(b,r),advance:ms=>now+=ms,replace:value=>snapshot=value,emit:id=>listeners['ropad-market-update'].forEach(fn=>fn({detail:{buildId:id}}))};
}

test('prelaunch, Devnet and unverified tokens never imply a real market or fetch a snapshot',()=>{
  const h=fixture();h.set();
  for(const [token,message] of [[null,/Market opens after launch/],[{...h.build.token,cluster:'devnet'},/Devnet test token \/ no market/],[{...h.build.token,verified:false},/Coin verification required/]]){
    const html=h.render({...h.build,token});assert.match(html,message);assert.doesNotMatch(html,/r-market-line|data-market-samples|>30</);assert.match(html,/No historical data/);
  }
  assert.equal(h.calls.length,0);
});

test('one actual snapshot shows values without drawing fake history; two distinct slots form a session line',()=>{
  const h=fixture();h.set();let html=h.render();
  assert.match(html,/Collecting observations/);assert.match(html,/title="30 SOL"/);assert.match(html,/0\.00000003 SOL/);assert.doesNotMatch(html,/polyline/);
  for(let i=0;i<5;i++)h.render();
  h.advance(30000);h.set({slot:101,marketCapSol:'31.25',priceSol:'0.00000003125'});html=h.render();
  assert.match(html,/data-market-samples="2"/);assert.match(html,/Observed this session · 2 snapshots/);assert.match(html,/title="31.25 SOL"/);
  assert.doesNotMatch(html,/24h|volume|holders|liquidity|candle|USD|NaN|Infinity/);
});

test('wrong identity, numeric values, stale or future timestamps and missing provenance do not enter the chart',()=>{
  for(const bad of [{mint:OTHER},{cluster:'devnet'},{marketCapSol:99},{priceSol:'NaN'},{supply:'-4'},{slot:-1},{slot:undefined},{checkedAt:1802000000000-300001},{checkedAt:1802000000000+60001},{checkedAt:undefined},{available:undefined}]){
    const h=fixture();h.set(bad);const html=h.render();assert.match(html,/Market source unavailable/);assert.doesNotMatch(html,/data-market-samples|polyline|title="30 SOL"/);
  }
});

test('repeated slots and backward snapshots cannot manufacture history or regress the headline',()=>{
  const h=fixture();h.set();h.render();h.advance(30000);h.set({slot:101,marketCapSol:'35'});h.render();
  for(const changes of [{slot:101,marketCapSol:'900'},{slot:99,marketCapSol:'900'},{slot:102,checkedAt:1802000000000,marketCapSol:'900'}]){
    h.advance(30000);h.set(changes);const html=h.render();assert.match(html,/data-market-samples="2"/);assert.match(html,/title="35 SOL"/);assert.doesNotMatch(html,/title="900 SOL"/);
  }
});

test('completed curves hide their old reserve prices and failures label retained observations',()=>{
  const h=fixture();h.set();h.render();h.advance(30000);h.set({slot:101});h.render();
  h.set({available:false,complete:true,marketCapSol:'9999',reason:'Curve completed; migrated trading is separate'});
  let html=h.render();assert.match(html,/Market source unavailable/);assert.match(html,/Curve completed/);assert.doesNotMatch(html,/polyline|title="30 SOL"|title="9999 SOL"/);
  h.replace({market:null,error:'RPC unreachable',loading:false});html=h.render();assert.match(html,/Last observed market cap/);assert.match(html,/Showing the last verified observations/);assert.match(html,/data-market-samples="2"/);
});

test('build and mint changes and a new page session isolate observations without localStorage',()=>{
  const h=fixture();h.set();h.render();h.advance(30000);h.set({slot:101});h.render();
  assert.doesNotMatch(h.render({...h.build,id:'game-b'}),/polyline/);
  h.set({mint:OTHER,slot:102});assert.doesNotMatch(h.render({...h.build,token:{...h.build.token,address:OTHER}}),/polyline/);
  assert.doesNotMatch(fixture().render(),/polyline/);assert.doesNotMatch(source,/localStorage|sessionStorage|\bfetch\s*\(|setInterval/);
});

test('metric and gathered-range choices survive rerenders; small flat prices keep valid axis labels',async()=>{
  const h=fixture(),r=h.root();h.set();h.render();h.advance(300000);h.set({slot:102});r.innerHTML=h.render();h.wire(h.build,r);
  await h.click(r,{marketMetric:'priceSol'});assert.match(r.innerHTML,/Token price in SOL from 2/);assert.match(r.innerHTML,/3\.30e-8/);assert.doesNotMatch(r.innerHTML,/>—<\/text>|NaN|Infinity/);
  await h.click(r,{marketRange:'5m'});const html=h.render();assert.match(html,/data-market-metric="priceSol" aria-pressed="true"/);assert.match(html,/data-market-range="5m" aria-pressed="true"/);assert.match(html,/data-market-range="1h" aria-pressed="false" disabled/);
});

test('one update listener redraws only current connected matching mounts and preserves chosen metrics',async()=>{
  const h=fixture(),old=h.root(),current=h.root();h.set();old.innerHTML=h.render();h.wire(h.build,old);old.isConnected=false;
  current.innerHTML=h.render();for(let i=0;i<10;i++)h.wire(h.build,current);await h.click(current,{marketMetric:'priceSol'});
  assert.equal(h.listeners['ropad-market-update'].length,1);const before=current.innerHTML;
  h.advance(30000);h.set({slot:101,priceSol:'0.00000004',marketCapSol:'40'});h.emit('other-build');assert.equal(current.innerHTML,before);
  const count=h.calls.length;h.emit(h.build.id);assert.equal(h.calls.length,count+1);assert.match(current.innerHTML,/title="0.00000004 SOL"/);assert.match(current.innerHTML,/data-market-samples="2"/);assert.doesNotMatch(old.innerHTML,/data-market-samples/);
});

test('full mint copying and explorer links use actual network; legacy EVM never receives Solana metrics',async()=>{
  const h=fixture(),r=h.root();r.innerHTML=h.render();h.wire(h.build,r);await h.click(r,{copy:true});assert.deepEqual(h.copies,[MINT]);assert.equal(r.status.textContent,'Copied');
  assert.match(r.innerHTML,new RegExp('https://explorer.solana.com/address/'+MINT+'"'));
  assert.match(h.render({...h.build,token:{...h.build.token,cluster:'devnet'}}),/\?cluster=devnet/);
  const evm={...h.build,token:{chain:'ethereum',chainId:4663,address:'0x'+ 'a'.repeat(40),verified:true}};const html=h.render(evm);
  assert.match(html,/Legacy token market/);assert.match(html,/Robinhood Chain · legacy/);assert.match(html,/https:\/\/robin.etherscan.io\/token\//);assert.doesNotMatch(html,/explorer.solana|<small>SOL|polyline/);
});

test('source and token labels are escaped rather than interpreted as markup',()=>{
  const h=fixture();h.replace({market:null,error:'<img src=x onerror=alert(1)>'});let html=h.render();assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
  h.set();html=h.render({...h.build,token:{...h.build.token,symbol:'<script>bad</script>'}});assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script/);
});

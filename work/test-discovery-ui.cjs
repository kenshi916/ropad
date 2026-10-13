'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.join(__dirname,'parallax/dist/builders.js'),source=fs.readFileSync(file,'utf8');
const NOW=1802500000000,MINT='11111111111111111111111111111111';
const game=(id,name,patch={})=>({id,gameName:name,brief:'An original Roblox game',createdAt:'2026-10-01T00:00:00Z',status:'ready',modelId:'anthropic/claude-opus-5.5',events:[],...patch});
class Element{
  constructor(){this.innerHTML='';this.textContent='';this.value='';this.dataset={};this.isConnected=true;this.classList={add(){},remove(){},toggle(){}};}
  querySelector(){return null;}querySelectorAll(){return [];}addEventListener(){}contains(){return false;}insertAdjacentHTML(_,value){this.innerHTML+=value;}close(){this.open=false;}
}
function fixture({hash='#/',builds=[],snapshot={}}={}){
  const nodes=new Map(),events={},requests=[],rendered=[],trend={mounts:0,destroys:0},location={hash,origin:'http://localhost'};
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const filters=['all','connected','coins'].map(value=>Object.assign(new Element(),{dataset:{buildFilter:value}}));
  const providers=['all','openai','anthropic'].map(value=>Object.assign(new Element(),{dataset:{modelProvider:value}}));
  const document={hidden:false,activeElement:null,getElementById:node,addEventListener(){},createElement:()=>new Element(),querySelector(selector){
    if(selector==='.rp-token-page'&&node('builder-app').innerHTML.includes('rp-token-page'))return node('token-root');
    return null;
  },querySelectorAll(selector){
    if(selector==='[data-build-filter]')return filters;
    if(selector==='[data-model-provider]')return providers;
    return [];
  }};
  const window={addEventListener:(name,fn)=>events[name]=fn,scrollTo(){},RopadSolana:{whenInvalidated:()=>Promise.resolve()},RopadSolanaMarket:{snapshot:()=>snapshot,refresh(){}},
    RopadTrending:{mount(root){trend.mounts++;root.innerHTML='Trending results';},destroy(){trend.destroys++;}},
    RopadTokenPage:{render(build){rendered.push(['render',build.id,build.canManage]);return '<main class="rp-token-page">Token page</main>';},wire(){},refresh(build){rendered.push(['refresh',build.id,build.canManage]);}}};
  class Clock extends Date{static now(){return NOW;}}
  let fetchGate=null;
  const context={window,document,location,navigator:{},Date:Clock,URL,AbortSignal,setInterval(){},setTimeout(){},clearTimeout(){},fetch:async(url,options={})=>{
    requests.push({url,method:options.method||'GET'});if(fetchGate)await fetchGate;
    const payload=url==='/api/builds'?{builds}:url==='/api/builds/pool'?{capacity:0,workers:[],active:0,queued:0}:url==='/api/builds/config'?{}:{build:builds.find(build=>url==='/api/builds/'+build.id)};
    return {ok:true,json:async()=>payload};
  }};
  vm.runInNewContext(source,context,{filename:file});
  const refresh=()=>window.ParallaxBuilders.refresh(),flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {node,window,events,requests,rendered,trend,location,refresh,flush,setSnapshot:value=>snapshot=value,setGate:value=>fetchGate=value,
    list:()=>node('b-build-list').innerHTML,
    search(value){node('b-search').value=value;node('b-search').oninput({target:{value}});},
    filter(value){filters.find(item=>item.dataset.buildFilter===value).onclick();},
    provider(value){providers.find(item=>item.dataset.modelProvider===value).onclick();},
    sort(value){node('s-sort').onchange({target:{value}});},
    async navigate(value){location.hash=value;await refresh();}};
}

test('homepage keeps only the latest project version and counts actual projects',async()=>{
  const h=fixture({builds:[game('old','Skyline old',{lineage:{projectId:'sky',version:1}}),game('harbor','Harbor',{studio:{connected:true},modelId:'openai/gpt-6-astra'}),game('new','Skyline current',{lineage:{projectId:'sky',version:2},token:{address:MINT}})]});
  await h.flush();assert.match(h.list(),/Skyline current/);assert.doesNotMatch(h.list(),/Skyline old/);assert.match(h.list(),/href="#\/token\/new"/);
  assert.equal(h.node('s-count-all').textContent,2);assert.equal(h.node('s-count-connected').textContent,1);assert.equal(h.node('s-count-coins').textContent,1);
  assert.doesNotMatch(h.node('builder-app').innerHTML,/rp-recent-list|rp-trending-callout/);assert.ok(h.requests.every(row=>row.method==='GET'));
});

test('search, provider and connection or coin filters combine and can recover from no matches',async()=>{
  const h=fixture({builds:[game('sky','Skyline Circuit',{studio:{connected:true},token:{address:MINT,symbol:'ROOFTOP'}}),game('harbor','Neon Harbor',{modelId:'openai/gpt-6-astra',studio:{connected:true}}),game('canyon','Crystal Canyon',{modelId:'google/gemini-2.5-flash'})]});
  await h.flush();h.search('sKyLiNe');assert.match(h.list(),/Skyline Circuit/);assert.doesNotMatch(h.list(),/Neon Harbor|Crystal Canyon/);
  h.provider('openai');assert.match(h.list(),/No matching agents/);
  h.search('');assert.match(h.list(),/Neon Harbor/);assert.doesNotMatch(h.list(),/Skyline Circuit|Crystal Canyon/);
  h.filter('coins');assert.match(h.list(),/No matching agents/);
  h.provider('all');assert.match(h.list(),/Skyline Circuit/);assert.doesNotMatch(h.list(),/Neon Harbor|Crystal Canyon/);
  h.filter('connected');assert.match(h.list(),/Skyline Circuit/);assert.match(h.list(),/Neon Harbor/);assert.doesNotMatch(h.list(),/Crystal Canyon/);
  h.filter('all');assert.match(h.list(),/gemini-2.5-flash/);assert.equal(h.node('s-count-all').textContent,3);
  h.sort('name');assert.ok(h.list().indexOf('Crystal Canyon')<h.list().indexOf('Neon Harbor'));assert.ok(h.list().indexOf('Neon Harbor')<h.list().indexOf('Skyline Circuit'));
  h.search('rOoFtOp');assert.match(h.list(),/Skyline Circuit/);assert.doesNotMatch(h.list(),/Neon Harbor|Crystal Canyon/);
});

test('homepage market caps require a fresh matching verified mainnet observation',async()=>{
  const token={chain:'solana',cluster:'mainnet-beta',verified:true,address:MINT,marketCapUsd:999999};
  const valid={market:{available:true,cluster:'mainnet-beta',mint:MINT,checkedAt:NOW,slot:123,marketCapSol:'42.5'}};
  const h=fixture({builds:[game('coin','Market Game',{token})],snapshot:valid});await h.flush();assert.match(h.list(),/42.5 SOL/);assert.doesNotMatch(h.list(),/999,999/);
  for(const patch of [{available:false},{mint:'mismatched'},{cluster:'devnet'},{slot:undefined},{slot:-1},{slot:1.5},{slot:Number.MAX_SAFE_INTEGER+1},{checkedAt:NOW-300001},{checkedAt:NOW+60001},{checkedAt:'now'},{marketCapSol:42.5},{marketCapSol:'NaN'},{marketCapSol:'-5'},{marketCapSol:'0'}]){
    h.setSnapshot({market:{...valid.market,...patch}});await h.refresh();assert.doesNotMatch(h.list(),/42.5 SOL/);assert.match(h.list(),/<span>MCAP<\/span><strong>—<\/strong>/);
  }
  h.setSnapshot({...valid,error:'RPC unavailable'});await h.refresh();assert.doesNotMatch(h.list(),/42.5 SOL/);
  for(const invalid of [{...token,verified:false},{...token,cluster:'devnet'},{...token,chain:'ethereum'},{}]){
    const other=fixture({builds:[game('coin','Market Game',{token:invalid})],snapshot:valid});await other.flush();assert.doesNotMatch(other.list(),/42.5 SOL|999,999/);
  }
  const malformed=fixture({builds:[game('coin','Market Game',{token:{...token,address:'not-a-mint'}})],snapshot:{market:{...valid.market,mint:'not-a-mint'}}});await malformed.flush();assert.doesNotMatch(malformed.list(),/42.5 SOL|999,999/);
});

test('Trending mounts once and routine polling leaves its results intact without build requests',async()=>{
  const h=fixture({hash:'#/trending'});await h.flush();const html=h.node('builder-app').innerHTML;
  h.node('rp-trending-page').innerHTML='User searched results';await h.refresh();await h.refresh();
  assert.equal(h.trend.mounts,1);assert.equal(h.trend.destroys,0);assert.equal(h.node('rp-trending-page').innerHTML,'User searched results');assert.equal(h.node('builder-app').innerHTML,html);assert.equal(h.requests.length,0);
});

test('Trending clears the previous creator build before wallet invalidation and tears down on departure',async()=>{
  const h=fixture({hash:'#/token/sky',builds:[game('sky','Skyline',{canManage:true})]});await h.flush();assert.equal(h.rendered.length,1);
  await h.navigate('#/trending');const renders=h.rendered.length;h.events['ropad-solana-wallet-change']();await h.flush();
  assert.equal(h.rendered.length,renders);assert.equal(h.trend.mounts,1);assert.match(h.node('builder-app').innerHTML,/id="rp-trending-page"/);
  await h.navigate('#/');assert.equal(h.trend.destroys,1);await h.refresh();assert.equal(h.trend.destroys,1);await h.navigate('#/trending');assert.equal(h.trend.mounts,2);
});

test('navigating to Trending discards a pending token response',async()=>{
  const h=fixture({hash:'#/token/sky',builds:[game('sky','Skyline')]});await h.flush();let release;h.setGate(new Promise(resolve=>release=resolve));
  const pending=h.refresh();await h.flush();await h.navigate('#/trending');const renders=h.rendered.length;release();await pending;
  assert.equal(h.rendered.length,renders);assert.match(h.node('builder-app').innerHTML,/id="rp-trending-page"/);assert.equal(h.trend.mounts,1);
});

test('malformed game navigation tears down Trending before rendering the route error',async()=>{
  const h=fixture({hash:'#/trending'});await h.flush();await h.navigate('#/token/%zz');
  assert.equal(h.trend.destroys,1);assert.match(h.node('builder-app').innerHTML,/link is incomplete/);assert.equal(h.requests.length,0);
});

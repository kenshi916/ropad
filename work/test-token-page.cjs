'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const file = fs.existsSync(path.join(__dirname,'parallax/dist/token-page.js')) ? path.join(__dirname,'parallax/dist/token-page.js') : path.join(__dirname,'../dist/token-page.js');
const source = fs.readFileSync(file,'utf8'), MINT = '11111111111111111111111111111111';
function fixture() {
  let snapshot = {}, now = 1802000000000;
  const listeners = {}, calls = {market:0,tradeRender:0,tradeWire:0,marketWire:0};
  class Clock extends Date { static now() { return now; } }
  const window = {location:{origin:'http://localhost'},addEventListener:(event,handler) => { (listeners[event] ||= []).push(handler); },
    RopadSolanaMarket:{snapshot:() => { calls.market++; return snapshot; }},
    RopadTokenMarket:{panel:() => '<section>Verified chart component</section>',wire:() => calls.marketWire++},
    ParallaxOrbio:{buildTradePanel:() => { calls.tradeRender++; return '<section>Original trade component</section>'; },wireBuildTradePanel:() => calls.tradeWire++}};
  vm.runInNewContext(source,{window,Date:Clock,URL},{filename:file});
  const build = {id:'game-a',gameName:'Skyline Circuit',brief:'Race across a rooftop city',modelId:'anthropic/claude-opus-5.5',status:'waiting_for_studio',token:{chain:'solana',cluster:'mainnet-beta',verified:true,address:MINT,symbol:'SKY'}};
  function root() {
    const nodes = {}, selectors = ['heading','banner','game','agent','activity','details','market','trade','price'];
    for (const name of selectors) { let html = ''; nodes['[data-rp-'+name+']'] = {writes:0,get innerHTML(){return html;},set innerHTML(value){this.writes++;html=value;}}; }
    return {isConnected:true,nodes,querySelector:selector => nodes[selector] || null};
  }
  const set = (patch = {}) => snapshot = {market:{cluster:'mainnet-beta',mint:MINT,available:true,priceSol:'0.00000003',marketCapSol:'30',supply:'1000000000',checkedAt:now,slot:100,...patch}};
  return {window,build,calls,listeners,root,set,api:window.RopadTokenPage,advance:ms=>now+=ms,replace:value=>snapshot=value,emit:id=>(listeners['ropad-market-update']||[]).forEach(fn=>fn({detail:{buildId:id}}))};
}

test('token page separates a public coin market, game page and creator workspace', () => {
  const h=fixture(), html=h.api.render(h.build);
  assert.match(html,/<h1>Skyline Circuit<\/h1>/); assert.match(html,/\$SKY/);
  assert.match(html,/data-rp-market/); assert.match(html,/Verified chart component/); assert.match(html,/Original trade component/);
  assert.match(html,/href="#\/play\/game-a"/); assert.match(html,/> Play game<\/a>/); assert.match(html,/href="#\/workspace\/game-a"/);
  assert.match(html,/Latest activity/); assert.match(html,/Token details/); assert.match(html,/Claude Opus 5.5/);
  assert.doesNotMatch(html,/data-builder-action="(?:enqueue|concept|thumbnail|design)"|data-build-compute-slot|data-build-agent-slot/);
});

test('prelaunch and devnet headers do not claim market values or invent trading data', () => {
  const h=fixture();h.set();
  for (const token of [undefined,{...h.build.token,cluster:'devnet'},{...h.build.token,verified:false}]) {
    const html=h.api.render({...h.build,token});
    assert.doesNotMatch(html,/>30 SOL|0\.00000003|>1,000,000,000<|holders|24h|volume|USD/);
    assert.match(html,/Market cap <b>—<\/b>/);
  }
  assert.equal(h.calls.market,0);
  assert.match(h.api.render({...h.build,token:{...h.build.token,cluster:'devnet'}}),/Test coin · No real market/);
});

test('headline uses fresh matching onchain observations only and preserves tiny SOL prices', () => {
  const h=fixture();h.set();const html=h.api.render(h.build);
  assert.match(html,/0\.00000003/); assert.match(html,/Market cap <b>30 SOL<\/b>/); assert.match(html,/>1,000,000,000<\/dd>/);
  for (const bad of [{mint:'22222222222222222222222222222222'},{cluster:'devnet'},{available:false},{priceSol:3},{marketCapSol:'NaN'},{supply:'-1'},{slot:-1},{slot:undefined},{checkedAt:1802000000000-300001},{checkedAt:1802000000000+60001}]) {
    h.set(bad); const invalid=h.api.render(h.build); assert.match(invalid,/Market cap <b>—<\/b>/); assert.doesNotMatch(invalid,/>30 SOL|0\.00000003/);
  }
  h.set();h.replace({market:null,error:'Disconnected'});assert.match(h.api.render(h.build),/Verified market unavailable/);
});

test('poll refresh leaves active trade inputs, quote DOM and event handlers intact', () => {
  const h=fixture(), root=h.root(); h.api.wire(h.build,root);
  const trade=root.nodes['[data-rp-trade]']; trade.innerHTML='<input value="0.583"><section>A reviewed quote</section>'; const writes=trade.writes;
  for (let i=0;i<8;i++)h.api.refresh({...h.build,events:[{message:'Applied '+i+' objects'}]},root);
  assert.equal(trade.writes,writes); assert.match(trade.innerHTML,/value="0.583"/); assert.equal(h.calls.tradeWire,1); assert.equal(h.calls.tradeRender,0);
  assert.match(root.nodes['[data-rp-activity]'].innerHTML,/Applied 7 objects/);
});

test('a changed token identity remounts the trade panel exactly once', () => {
  const h=fixture(), root=h.root(); h.api.wire(h.build,root); const changed={...h.build,token:{...h.build.token,address:'22222222222222222222222222222222'}};
  h.api.refresh(changed,root);h.api.refresh(changed,root);
  assert.equal(h.calls.tradeWire,2);assert.equal(h.calls.tradeRender,1);
});

test('wallet changes clear a visible obsolete quote immediately while polling keeps inputs stable', () => {
  const h=fixture(),root=h.root();let wallet={id:'phantom',address:'FirstWallet'};
  h.window.RopadSolana={get:()=>wallet};h.api.wire(h.build,root);
  const trade=root.nodes['[data-rp-trade]'];trade.innerHTML='<button>Confirm buy in wallet</button>';
  wallet={id:'phantom',address:'SecondWallet'};h.listeners['ropad-solana-wallet-change'][0]();
  assert.doesNotMatch(trade.innerHTML,/Confirm buy in wallet/);assert.equal(h.calls.tradeRender,1);assert.equal(h.calls.tradeWire,2);
  h.api.refresh(h.build,root);assert.equal(h.calls.tradeRender,1);
  wallet=null;h.listeners['ropad-solana-wallet-change'][0]();assert.equal(h.calls.tradeRender,2);
  h.listeners['ropad-solana-wallet-change'][0]();assert.equal(h.calls.tradeRender,3);
});

test('public game card prioritizes game summary over build instructions', () => {
  const h=fixture(), html=h.api.render({...h.build,plan:{summary:'A bright rooftop race with timed checkpoints'},brief:'Build this with 24 to 30 parts'});
  assert.match(html,/A bright rooftop race with timed checkpoints/);assert.doesNotMatch(html,/24 to 30 parts/);assert.doesNotMatch(html,/href="#rp-token-game"/);
});

test('one market listener updates only the matching mounted token header', () => {
  const h=fixture(), root=h.root(), closed=h.root();h.set();h.api.wire(h.build,root);h.api.wire({...h.build,id:'closed'},closed);closed.isConnected=false;
  assert.equal(h.listeners['ropad-market-update'].length,1);h.emit('someone-else');assert.equal(root.nodes['[data-rp-price]'].writes,0);
  h.emit(h.build.id);assert.match(root.nodes['[data-rp-price]'].innerHTML,/30 SOL/);assert.equal(closed.nodes['[data-rp-price]'].writes,0);assert.equal(h.calls.tradeWire,2);
});

test('only matching saved image endpoints or actual shared captures become game imagery', () => {
  const h=fixture();let html=h.api.render(h.build);assert.match(html,/A new world starts here/);assert.doesNotMatch(html,/\/screen\?v=|<iframe|<canvas/);
  html=h.api.render({...h.build,thumbnail:{imageUrl:'https://evil.test/picture.png'}});assert.doesNotMatch(html,/evil\.test/);assert.match(html,/A new world starts here/);
  html=h.api.render({...h.build,thumbnail:{imageUrl:'/api/builds/other/thumbnail/image'}});assert.doesNotMatch(html,/\/api\/builds\/other/);
  html=h.api.render({...h.build,thumbnail:{imageUrl:'/api/builds/game-a/thumbnail/image?v=1'}});assert.match(html,/AI generated game artwork/);assert.match(html,/src="\/api\/builds\/game-a\/thumbnail\/image\?v=1"/);assert.doesNotMatch(html,/Last shared Studio capture/);
  html=h.api.render({...h.build,screenshot:{capturedAt:'2026-10-10T01:00:00Z'}});assert.match(html,/Last shared Studio capture/);assert.match(html,/\/screen\?v=2026-10-10T01%3A00%3A00Z/);
});

test('verified local playtest snapshot replaces old worker cover without implying live video',()=>{
  const h=fixture();h.window.RopadLivePlaytest={cachedPreview:()=>({url:'/runtime-playtest/game-a/frame.jpg?v=current-frame',label:'Last Studio playtest frame',kind:'playtest'})};
  const html=h.api.render({...h.build,screenshot:{capturedAt:'2026-10-01T00:00:00Z'}});
  assert.match(html,/runtime-playtest\/game-a\/frame\.jpg\?v=current-frame/);assert.match(html,/Last Studio playtest frame/);assert.doesNotMatch(html,/Last shared Studio capture|<video|LIVE PLAYTEST/);
});

test('owner update control is available only to the authorized creator; text and paths are escaped', () => {
  const h=fixture();assert.doesNotMatch(h.api.render(h.build),/data-builder-action="update"/);assert.match(h.api.render({...h.build,canManage:true}),/data-builder-action="update"/);
  const html=h.api.render({...h.build,id:'bad"id',gameName:'<img onerror=alert(1)>',brief:'<script>attack()</script>',events:[{message:'<svg/onload=attack()>',at:'not-a-date'}],token:{...h.build.token,symbol:'"<unsafe>'}});
  assert.doesNotMatch(html,/<img onerror|<script>|<svg\/onload|datetime="Invalid|href="#\/play\/bad"id/);assert.match(html,/&lt;script&gt;attack/);assert.match(html,/bad%22id/);
});

test('missing modules show truthful placeholders and late loading mounts trade without repeated wiring', () => {
  const h=fixture(),original=h.window.ParallaxOrbio,root=h.root();delete h.window.ParallaxOrbio;delete h.window.RopadTokenMarket;
  const html=h.api.render(h.build);assert.match(html,/Trading tools are loading/);assert.match(html,/Market observations will appear here/);
  h.api.wire(h.build,root);h.window.ParallaxOrbio=original;h.api.refresh(h.build,root);h.api.refresh(h.build,root);
  assert.equal(h.calls.tradeWire,1);assert.equal(h.calls.tradeRender,1);
});


test('saved launch artwork keeps its cover and separate square coin identity when playtest frames arrive',()=>{
 const h=fixture();h.window.RopadLivePlaytest={cachedPreview:()=>({url:'/runtime-playtest/game-a/frame.jpg',kind:'playtest',label:'Last playtest'})};
 const build={...h.build,thumbnail:{imageUrl:'/api/builds/game-a/thumbnail/image?v=cover'},coinIcon:{imageUrl:'/api/builds/game-a/coinIcon/image?v=icon'}};
 const html=h.api.render(build);assert.match(html,/src="\/api\/builds\/game-a\/coinIcon\/image\?v=icon"/);assert.match(html,/src="\/api\/builds\/game-a\/thumbnail\/image\?v=cover"/);assert.doesNotMatch(html,/runtime-playtest/);
 for(const imageUrl of ['https://elsewhere.test/icon.png','/api/builds/another-game/coinIcon/image'])assert.doesNotMatch(h.api.render({...build,coinIcon:{imageUrl}}),/elsewhere|another-game/);
});

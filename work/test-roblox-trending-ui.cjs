'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.join(__dirname,'parallax/dist/roblox-trending.js');
const source=fs.readFileSync(file,'utf8');
const game=(id,playing,visits,rank,name=`Game ${id}`)=>({universeId:id,placeId:id+100,name,creatorName:`Creator ${id}`,playing,visits,rank,thumbnailUrl:`https://tr.rbxcdn.com/${id}/420/420/Image/Png`,earnings:{status:'not_disclosed',amount:null}});
const payload=(games=[game(1,15,300,1),game(2,900,400,2),game(3,50,2000,3)],extra={})=>({source:{name:'Roblox · Top Playing Now',url:'https://www.roblox.com/charts'},fetchedAt:'2026-10-13T20:00:00.000Z',stale:false,games,...extra});
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
class Node {
  constructor(){this.innerHTML='';this.textContent='';this.nodes=new Map();this.isConnected=true;this.attributes={};}
  querySelector(selector){if(!this.nodes.has(selector))this.nodes.set(selector,new Node());return this.nodes.get(selector);}
  querySelectorAll(){return [];}
  contains(){return true;}
  setAttribute(name,value){this.attributes[name]=value;}
}
function fixture(responses=[response(payload())]){
  const calls=[],window={},document={visibilityState:'visible'},intervals=new Map();let intervalId=0;
  vm.runInNewContext(source,{window,document,URL,Intl,Date,AbortController,setTimeout,clearTimeout,setInterval:(callback,delay)=>{intervals.set(++intervalId,{callback,delay});return intervalId;},clearInterval:id=>intervals.delete(id),fetch:async(url,options)=>{calls.push({url,options});const item=responses.shift();if(item instanceof Error)throw item;return typeof item==='function'?item():item;}},{filename:file});
  const root=new Node();
  const results=()=>root.querySelector('[data-rt-results]').innerHTML;
  const input=value=>root.oninput({target:{matches:selector=>selector==='[data-rt-search]',value}});
  const sort=value=>root.onchange({target:{matches:selector=>selector==='[data-rt-sort]',value}});
  return {window,document,intervals,tick:()=>Promise.all([...intervals.values()].map(timer=>timer.callback())),root,calls,responses,results,input,sort,mount:()=>window.RopadTrending.mount(root)};
}
test('renders the official source, timestamp, ranks and actual concurrent-player order',async()=>{
  const h=fixture();await h.mount().ready;
  assert.ok(h.results().indexOf('Game 2')<h.results().indexOf('Game 3'));
  assert.ok(h.results().indexOf('Game 3')<h.results().indexOf('Game 1'));
  assert.match(h.results(),/Position in the source chart">2</);
  assert.match(h.root.querySelector('[data-rt-source]').innerHTML,/2026-10-13T20:00:00.000Z/);
  assert.match(h.root.querySelector('[data-rt-source]').innerHTML,/https:\/\/www.roblox.com\/charts/);
  assert.match(h.results(),/Not disclosed/);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/roblox/trending');
});
test('search and sorting preserve the source rank and never fetch on each keystroke',async()=>{
  const h=fixture();await h.mount().ready;h.sort('visits');assert.ok(h.results().indexOf('Game 3')<h.results().indexOf('Game 2'));
  h.sort('rank');assert.ok(h.results().indexOf('Game 1')<h.results().indexOf('Game 2'));
  h.input('creator 3');assert.match(h.results(),/Game 3/);assert.doesNotMatch(h.results(),/Game 1|Game 2/);assert.equal(h.calls.length,1);
  h.input('unmatched');assert.match(h.results(),/No matching games/);
});
test('untrusted names are escaped, links are constructed and unsupported money is never claimed',async()=>{
  const bad=game(1,12,150,1,'<img src=x onerror=alert(1)>');
  bad.creatorName='"><script>alert(1)</script>';bad.url='javascript:alert(1)';bad.thumbnailUrl='https://attacker.example/tracker';bad.earnings={status:'estimated',amount:9000000};
  const h=fixture([response(payload([bad],{source:{name:'<script>oops</script>',url:'javascript:alert(1)'}}))]);await h.mount().ready;
  assert.match(h.results(),/&lt;img/);assert.match(h.results(),/&lt;script&gt;/);assert.match(h.results(),/https:\/\/www.roblox.com\/games\/101/);
  assert.doesNotMatch(h.results(),/<script>|src="https:\/\/attacker|javascript:|9000000/);assert.match(h.results(),/Not disclosed/);
  assert.doesNotMatch(h.root.querySelector('[data-rt-source]').innerHTML,/<script>|javascript:/);
});
test('missing counts are unavailable, not zero, and broken entries cannot become made-up games',async()=>{
  const unknown=game(1,null,-3,1);const h=fixture([response(payload([unknown,unknown,{universeId:'oops',placeId:'2',name:'Bad id'}]))]);await h.mount().ready;
  assert.match(h.results(),/Unavailable concurrent players/);assert.doesNotMatch(h.results(),/Bad id/);
  assert.equal((h.results().match(/class="rt-game"/g)||[]).length,1);
});
test('API 404 uses a dated saved snapshot and a subsequent live success replaces its label',async()=>{
  const h=fixture([response({},404),response(payload([],{})),response(payload())]);const handle=h.mount();await handle.ready;
  assert.deepEqual(h.calls.map(call=>call.url),['/api/roblox/trending','/data/roblox-trending.json']);
  assert.match(h.root.querySelector('[data-rt-message]').innerHTML,/Saved snapshot/);
  assert.match(h.root.querySelector('[data-rt-source]').innerHTML,/Saved <time/);
  await handle.refresh();assert.equal(h.calls[2].url,'/api/roblox/trending');assert.doesNotMatch(h.root.querySelector('[data-rt-message]').innerHTML,/Saved snapshot/);
});
test('other API failures show retry and do not quietly switch to archived data',async()=>{
  const h=fixture([response({},503)]);await h.mount().ready;
  assert.match(h.root.querySelector('[data-rt-message]').innerHTML,/Try again/);assert.match(h.results(),/couldn’t load/);assert.equal(h.calls.length,1);
});
test('refresh failure retains and labels the last snapshot while stale data is visible',async()=>{
  const h=fixture([response(payload(undefined,{stale:true})),new Error('offline')]);const handle=h.mount();await handle.ready;
  assert.match(h.root.querySelector('[data-rt-message]').innerHTML,/last available snapshot/);
  await handle.refresh();assert.match(h.results(),/Game 2/);assert.match(h.root.querySelector('[data-rt-message]').innerHTML,/previous snapshot/);
});
test('navigation destroys pending work and late responses cannot replace the next page',async()=>{
  let resolve;const pending=new Promise(done=>resolve=done);const h=fixture([()=>pending]);const handle=h.mount();
  h.window.RopadTrending.destroy(h.root);h.root.innerHTML='Next page';resolve(response(payload()));await handle.ready;
  assert.equal(h.root.innerHTML,'Next page');assert.equal(h.calls[0].options.signal.aborted,true);assert.equal(h.root.onclick,null);
});
test('visible API data refreshes every two minutes without remounting or losing filters',async()=>{
  const h=fixture([response(payload()),response(payload([game(4,1500,9999,1,'New Game 4')]))]);await h.mount().ready;
  const shell=h.root.innerHTML;h.input('game');h.sort('visits');assert.equal(h.intervals.size,1);assert.equal([...h.intervals.values()][0].delay,120000);
  await h.tick();assert.equal(h.calls.length,2);assert.match(h.results(),/New Game 4/);assert.equal(h.root.innerHTML,shell);assert.equal(h.intervals.size,1);
  h.window.RopadTrending.destroy();assert.equal(h.intervals.size,0);await h.tick();assert.equal(h.calls.length,2);
});
test('hidden tabs and saved snapshots do not poll, and replacing a mount removes its timer',async()=>{
  const h=fixture([response(payload()),response({},404),response(payload())]);await h.mount().ready;
  h.document.visibilityState='hidden';await h.tick();assert.equal(h.calls.length,1);
  h.document.visibilityState='visible';await h.mount().ready;assert.equal(h.intervals.size,1);assert.equal(h.calls.length,3);
  await h.tick();assert.equal(h.calls.length,3);h.window.RopadTrending.destroy();assert.equal(h.intervals.size,0);
});

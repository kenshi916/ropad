'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createRobloxTrendsService, CACHE_MS, MAX_STALE_MS} = require('./parallax/roblox-trends.cjs');
const {createApp} = require('./parallax/server.cjs');
const initialTime = Date.parse('2026-10-13T20:00:00Z');
const chart = () => ({sortId:'top-playing-now', subtitle:'Results for all devices and locations', games:[
  {universeId:11,rootPlaceId:111,name:'Game A',playerCount:12000,isSponsored:false,genreL1:'Simulation'},
  {universeId:22,rootPlaceId:222,name:'Game B',playerCount:9500,isSponsored:false,genreL1:'Action'}
]});
const details = () => ({data:[
  {id:22,name:'Game B',playing:99999,visits:2400000,creator:{name:'Creator B',type:'User'}},
  {id:11,name:'Game A',playing:13000,visits:9200000,favoritedCount:80,creator:{name:'Creator A',type:'Group'}}
]});
const images = () => ({data:[
  {universeId:22,thumbnails:[{state:'Pending',imageUrl:'https://tr.rbxcdn.com/pending.png'}]},
  {universeId:11,thumbnails:[{state:'Completed',imageUrl:'https://tr.rbxcdn.com/example.png'}]}
]});
function harness(overrides={}) {
  let time=initialTime, fail=false;
  const calls=[];
  const fetcher=async (url, options)=>{
    calls.push({url,options});
    if(fail)throw Error('upstream-secret-diagnostic');
    const parsed=new URL(url);
    const key=parsed.hostname==='apis.roblox.com'?'chart':parsed.hostname==='games.roblox.com'?'details':parsed.hostname==='thumbnails.roblox.com'?'images':null;
    assert.ok(key,'Only expected public Roblox endpoints may be called');
    const value=overrides[key];
    if(value instanceof Error)throw value;
    return {ok:true,json:async()=>value===undefined?({chart,details,images}[key])():value};
  };
  return {service:createRobloxTrendsService({fetcher,now:()=>time}),fetcher,calls,advance(ms){time+=ms;},fail(){fail=true;}};
}

test('returns authentic chart order and paired player sample, joins unordered details by universe',async()=>{
  const h=harness(); const data=await h.service.trending();
  assert.equal(data.source.name,'Roblox · Top Playing Now');assert.match(data.source.scope,/all devices/);
  assert.deepEqual(data.games.map(g=>[g.universeId,g.rank,g.playing]),[[11,1,12000],[22,2,9500]]);
  assert.equal(data.games[0].creatorName,'Creator A');assert.equal(data.games[1].visits,2400000);
  assert.equal(data.games[0].thumbnailUrl,'https://tr.rbxcdn.com/example.png');assert.equal(data.games[1].thumbnailUrl,null);
  assert.equal(data.games[0].url,'https://www.roblox.com/games/111');
  assert.equal(data.fetchedAt,'2026-10-13T20:00:00.000Z');assert.equal(data.stale,false);
  assert.ok(h.calls.every(call=>!call.options.headers.Authorization&&!call.options.headers.Cookie));
  assert.ok(h.calls.every(call=>call.options.signal instanceof AbortSignal&&call.options.redirect==='error'));
});
test('no game revenue is inferred from popularity or upstream unexpected revenue fields',async()=>{
  const source=details();source.data[0].revenue=800000;const h=harness({details:source});const data=await h.service.trending();
  for(const game of data.games)assert.deepEqual(game.earnings,{status:'not_disclosed',amount:null,currency:null,period:null,sourceUrl:null});
  assert.match(data.earningsNote,/creator access/);assert.match(data.earningsSourceUrl,/create\.roblox\.com/);
});
test('cache deduplicates concurrent loads and protects cached rows from callers',async()=>{
  const h=harness();const [first,second]=await Promise.all([h.service.trending(),h.service.trending()]);assert.equal(h.calls.length,3);
  first.games[0].name='mutated by caller';const fresh=await h.service.trending();assert.equal(fresh.games[0].name,'Game A');assert.equal(h.calls.length,3);
  assert.equal(second.stale,false);h.advance(CACHE_MS);await h.service.trending();assert.equal(h.calls.length,6);
});
test('bounded stale fallback preserves original timestamp and throttles repeated upstream errors',async()=>{
  const h=harness();const original=await h.service.trending();h.advance(CACHE_MS+1);h.fail();
  const stale=await h.service.trending();assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,original.fetchedAt);assert.match(stale.warning,/last successful snapshot/);
  const count=h.calls.length;await h.service.trending();assert.equal(h.calls.length,count);
  h.advance(MAX_STALE_MS);await assert.rejects(h.service.trending(),{status:503});
});
test('cold upstream failure is sanitized and retried only after cooldown',async()=>{
  const h=harness();h.fail();await assert.rejects(h.service.trending(),error=>error.status===503&&!error.message.includes('secret'));
  const n=h.calls.length;await assert.rejects(h.service.trending(),{status:503});assert.equal(h.calls.length,n);
  h.advance(15000);await assert.rejects(h.service.trending(),{status:503});assert.equal(h.calls.length,n+1);
});
test('does not replace official chart with fabricated or saved-game candidates',async()=>{
  for(const value of [{}, {sortId:'recommended',games:chart().games}, {sortId:'top-playing-now',games:[]}]){
    const h=harness({chart:value});await assert.rejects(h.service.trending(),{status:503});assert.equal(h.calls.length,1);
  }
});
test('filters malformed, sponsored and duplicate entries while preserving chart ranks',async()=>{
  const value=chart();value.games=[value.games[0],{...value.games[0]},null,{universeId:true,rootPlaceId:333,name:'invalid',playerCount:2},{universeId:33,rootPlaceId:333,name:'ad',playerCount:2,isSponsored:true},value.games[1]];
  const h=harness({chart:value});const data=await h.service.trending();assert.deepEqual(data.games.map(g=>[g.universeId,g.rank]),[[11,1],[22,6]]);
});
test('details failure retains real chart counts but leaves unknown values null',async()=>{
  const h=harness({details:new Error('unavailable')});const data=await h.service.trending();
  assert.equal(data.games[0].playing,12000);assert.equal(data.games[0].creatorName,null);assert.equal(data.games[0].visits,null);
  assert.equal(data.games[0].thumbnailUrl,'https://tr.rbxcdn.com/example.png');assert.match(data.diagnostics[0],/details/);
});
test('missing and untrusted image URLs cannot become executable or tracking thumbnails',async()=>{
  for(const url of ['javascript:alert(1)','https://rbxcdn.com.attacker.invalid/asset','https://attacker.invalid/asset','http://tr.rbxcdn.com/asset','https://user:pass@tr.rbxcdn.com/asset']){
    const h=harness({images:{data:[{universeId:11,thumbnails:[{state:'Completed',imageUrl:url}]}]}});const data=await h.service.trending();assert.equal(data.games[0].thumbnailUrl,null);
  }
  const h=harness({images:new Error('unavailable')});const data=await h.service.trending();assert.equal(data.games.length,2);assert.match(data.diagnostics[0],/thumbnails/);
});
test('bounds data aggregation to fifty public chart games',async()=>{
  const value=chart();value.games=Array.from({length:200},(_,n)=>({universeId:n+1,rootPlaceId:1000+n,name:'Test '+n,playerCount:200-n}));
  const h=harness({chart:value});const data=await h.service.trending();assert.equal(data.games.length,50);
  assert.equal(new URL(h.calls[1].url).searchParams.get('universeIds').split(',').length,50);
});
test('server exposes read-only trending route without model, wallet or saved-state access',async t=>{
  const h=harness();const app=createApp({fetcher:h.fetcher,port:0,key:'',cameraWorkers:false,autonomousWorkers:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  async function request(method='GET'){
    return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:'/api/roblox/trending',method,headers:{Host:'127.0.0.1:0'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end();});
  }
  const result=await request();assert.equal(result.status,200);assert.equal(result.body.games.length,2);
  assert.equal((await request('POST')).status,405);assert.equal(h.calls.length,3);
});

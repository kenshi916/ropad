'use strict';
// Offline provider fixtures only: no credentials or paid image requests.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createConceptGenerator,DEFAULT_CONCEPT_MODEL_ID}=require('./parallax/builder-concepts.cjs');
const {createApp}=require('./parallax/server.cjs');
const {createRobloxBuildService}=require('./parallax/roblox-builds.cjs');
const {privateKeyToAccount}=require('./parallax/node_modules/viem/accounts');
const PARAMS={resolution:{type:'enum',values:['1K','2K']},aspect_ratio:{type:'enum',values:['16:9','1:1']},input_references:{type:'range',min:0,max:10}};
const MODEL={id:DEFAULT_CONCEPT_MODEL_ID,name:'FLUX.3 Image',architecture:{input_modalities:['text'],output_modalities:['image']},supported_parameters:PARAMS};
const ENDPOINT={supported_parameters:PARAMS,pricing:[{billable:'output_image',unit:'image',cost_usd:.048,variant:'1k'},{billable:'output_image',unit:'image',cost_usd:.607,variant:'4k'}]};
const BUILDER={id:'anthropic/claude-opus-5.5',name:'Opus',architecture:{output_modalities:['text']},pricing:{prompt:'0.0000001',completion:'0.0000001'}};
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const IMAGE=()=>Response.json({data:[{b64_json:PNG.toString('base64')}],usage:{cost:.048}});
const BUILD={gameName:'Skyline Sprint',brief:'A rooftop on-foot race through city gates',inspiration:'Original block city'};
function upstream({model=MODEL,endpoint=ENDPOINT,image=IMAGE}={}){
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/images/models'))return Response.json({data:[model]});
    if(url.endsWith('/endpoints'))return Response.json({id:MODEL.id,endpoints:[endpoint]});
    if(url.endsWith('/images'))return image(options);
    throw Error('Unexpected fixture network request');
  };
  return {calls,fetcher};
}
function generator(options={}){
  const up=upstream(options),settled=[],reserved=[];let releases=0;
  const service=createConceptGenerator({inference:{id:'openrouter',name:'OpenRouter',key:options.key??'OFFLINE_IMAGE_FIXTURE'},fetcher:up.fetcher,now:()=>123000,reserve:amount=>{reserved.push(amount);return()=>releases++;},settle:(reservation,actual)=>settled.push({reservation,actual})});
  return {...up,service,settled,reserved,get releases(){return releases;}};
}
test('image generation verifies the current image catalog and fixed endpoint price before posting one bounded request',async()=>{
  const h=generator();let metadata;
  const config=await h.service.models();assert.equal(config.data[0].estimatedCostUsd,.048);assert.equal(config.maxConceptEstimateUsd,.15);
  const result=await h.service.generate({build:BUILD,artDirection:'Blue hour with warm window lights',onStart:m=>metadata=m});
  assert.deepEqual(result.bytes,PNG);assert.equal(result.contentType,'image/png');assert.equal(result.modelId,MODEL.id);assert.equal(result.costUsd,.048);assert.equal(result.generatedAt,123000);
  const request=JSON.parse(h.calls.find(c=>c.url.endsWith('/images')).options.body);
  assert.equal(request.model,MODEL.id);assert.equal(request.n,1);assert.equal(request.resolution,'1K');assert.equal(request.aspect_ratio,'16:9');assert.equal(request.stream,false);
  assert.match(request.prompt,/visual design target/);assert.match(request.prompt,/Skyline Sprint/);assert.match(request.prompt,/Blue hour/);assert.equal(metadata.prompt,request.prompt);
  assert.equal(h.calls.length,3);assert.deepEqual(h.reserved,[.048]);assert.deepEqual(h.settled,[{reservation:.048,actual:.048}]);assert.equal(h.releases,1);
});
test('unknown models, changed capabilities and unbounded or unaffordable prices fail before any paid request',async()=>{
  const bads=[{model:{...MODEL,architecture:{input_modalities:['text'],output_modalities:['text']}}},{endpoint:{...ENDPOINT,pricing:[{billable:'output_image',unit:'token',cost_usd:.00003}]}},{endpoint:{...ENDPOINT,pricing:[{billable:'output_image',unit:'image',cost_usd:.2,variant:'1k'}]}}];
  for(const config of bads){const h=generator(config);await assert.rejects(h.service.generate({build:BUILD}),e=>[402,503].includes(e.status));assert.equal(h.reserved.length,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/images')).length,0);}
  const h=generator();await assert.rejects(h.service.generate({build:BUILD,modelId:'imaginary/image-model'}),/verified concept/);assert.equal(h.calls.length,0);
  await assert.rejects(h.service.generate({build:BUILD,artDirection:'a'.repeat(1201)}),/1200 bytes/);assert.equal(h.calls.length,0);
});
test('provider rejection releases money while transport uncertainty reserves it, without automatic retries',async()=>{
  const rejected=generator({image:()=>new Response('',{status:401})});await assert.rejects(rejected.service.generate({build:BUILD}),/rejected the configured key/);assert.deepEqual(rejected.settled,[{reservation:.048,actual:0}]);assert.equal(rejected.releases,1);
  const uncertain=generator({image:()=>{throw Error('Network interrupted');}});await assert.rejects(uncertain.service.generate({build:BUILD}),/Network interrupted/);assert.deepEqual(uncertain.settled,[{reservation:.048,actual:null}]);assert.equal(uncertain.releases,1);assert.equal(uncertain.calls.filter(c=>c.url.endsWith('/images')).length,1);
  const unavailable=generator({key:''});await assert.rejects(unavailable.service.generate({build:BUILD}),/Configure OpenRouter/);assert.equal(unavailable.calls.length,0);
});
test('upstream server errors and ambiguous timeouts retain the image reservation exactly once',async()=>{
  for(const status of [500,502,503,408,409,499]){
    const h=generator({image:()=>new Response('',{status})});
    await assert.rejects(h.service.generate({build:BUILD}),/could not generate/);
    assert.deepEqual(h.settled,[{reservation:.048,actual:null}]);assert.equal(h.releases,1);assert.equal(h.calls.filter(c=>c.url.endsWith('/images')).length,1);
  }
});
test('image responses cannot inject SVG, remote fetch URLs or fake raster declarations',async()=>{
  for(const item of [{url:'https://untrusted.invalid/picture.png'},{b64_json:Buffer.from('<svg><script>bad()</script></svg>').toString('base64')},{b64_json:PNG.toString('base64'),media_type:'image/svg+xml'}]){
    const h=generator({image:()=>Response.json({data:[item],usage:{cost:.048}})});await assert.rejects(h.service.generate({build:BUILD}),e=>e.status===502);assert.equal(h.settled[0].actual,.048);assert.equal(h.calls.length,3);
  }
});
async function appFixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-concept-test-')),up=upstream(options);
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  let time=1700000000000,app,csrf;
  const base='http://127.0.0.1:'+port;
  async function start(){app=createApp({port,stateDirectory:directory,key:'OFFLINE_IMAGE_FIXTURE',provider:'openrouter',cameraWorkers:false,monitor:false,models:[BUILDER],fetcher:up.fetcher,now:()=>time,budget:options.budget??1});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));csrf=(await(await fetch(base+'/api/status')).json()).csrf;}
  async function stop(){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
  await start();t.after(async()=>{await stop();fs.rmSync(directory,{recursive:true,force:true});});
  function client(initialCookie=''){
    const cookies=new Map(initialCookie.split(';').map(c=>c.trim()).filter(Boolean).map(c=>c.split('=')));const cookie=()=>[...cookies].map(([k,v])=>k+'='+v).join('; ');
    async function request(url,body,headers={}){const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{Connection:'close',Origin:base,'X-Parallax-Token':csrf,Cookie:cookie(),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}const bytes=Buffer.from(await response.arrayBuffer()),text=bytes.toString();let data;try{data=JSON.parse(text);}catch{}return {status:response.status,bytes,text,data,headers:response.headers};}
    return {request,cookie};
  }
  return {directory,...up,client,tick:ms=>time+=ms,restart:async()=>{await stop();await start();}};
}
test('only workspace owners generate concepts; generated bytes and metadata survive restart separately from Studio evidence',async t=>{
  const h=await appFixture(t),owner=h.client(),other=h.client();
  const capabilities=await owner.request('/api/builds/config');assert.equal(capabilities.data.conceptGeneration,true);assert.equal(capabilities.data.thumbnailGeneration,true);assert.equal(capabilities.data.workerPlanSchema,'scene-v1');
  const created=await owner.request('/api/builds',{...BUILD,modelId:BUILDER.id});assert.equal(created.status,201,created.text);const id=created.data.build.id,url='/api/builds/'+id;
  assert.equal((await other.request(url+'/concept',{})).status,403);assert.equal((await owner.request(url+'/concept',{}, {'X-Parallax-Token':'wrong'})).status,403);assert.equal(h.calls.length,0);
  const generated=await owner.request(url+'/concept',{artDirection:'Neon dusk'});assert.equal(generated.status,200,generated.text);const b=generated.data.build;
  assert.equal(b.concept.status,'ready');assert.equal(b.concept.source,'ai_generated');assert.equal(b.concept.isGameplay,false);assert.match(b.concept.imageUrl,new RegExp('^/api/builds/'+id+'/concept/image\\?v='));assert.equal(b.screenshot,null);assert.equal(b.plan,null);assert.equal(b.published,false);
  const image=await other.request(b.concept.imageUrl);assert.deepEqual(image.bytes,PNG);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-content-type-options'),'nosniff');
  assert.doesNotMatch(generated.text,/OFFLINE_IMAGE_FIXTURE|Bearer/);assert.equal((await owner.request('/api/status')).data.spent,.048);
  const oldCookie=owner.cookie();await h.restart();const recovered=h.client(oldCookie),saved=await recovered.request(url);assert.equal(saved.data.build.concept.status,'ready');assert.equal(saved.data.build.canManage,true);assert.deepEqual((await recovered.request(saved.data.build.concept.imageUrl)).bytes,PNG);
  const tooSoon=await recovered.request(url+'/concept',{});assert.equal(tooSoon.status,429,tooSoon.text);assert.equal((await recovered.request('/api/status')).data.spent,.048);
});
test('shared compute cap and in-flight duplicate protection prevent extra image spend',async t=>{
  const low=await appFixture(t,{budget:.02}),c=low.client(),created=await c.request('/api/builds',{...BUILD,modelId:BUILDER.id});
  assert.equal((await c.request('/api/builds/'+created.data.build.id+'/concept',{})).status,402);assert.equal(low.calls.filter(c=>c.url.endsWith('/images')).length,0);
  let entered,finish;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>finish=resolve);
  const h=await appFixture(t,{image:async()=>{entered();await gate;return IMAGE();}}),owner=h.client(),build=await owner.request('/api/builds',{...BUILD,modelId:BUILDER.id}),url='/api/builds/'+build.data.build.id;
  const first=owner.request(url+'/concept',{});try{await started;assert.equal((await owner.request(url)).data.build.concept.status,'generating');assert.equal((await owner.request(url+'/concept',{})).status,409);assert.equal((await owner.request('/api/status')).data.busy,true);}finally{finish();}
  assert.equal((await first).status,200);assert.equal(h.calls.filter(c=>c.url.endsWith('/images')).length,1);assert.equal((await owner.request('/api/status')).data.busy,false);
});
test('thumbnails have a separate prompt, image and durable record without overwriting the design target',async t=>{
  let attempt=0;
  const h=await appFixture(t,{image:()=>++attempt===3?new Response('',{status:429}):IMAGE()}),owner=h.client(),other=h.client();
  const created=await owner.request('/api/builds',{...BUILD,modelId:BUILDER.id}),id=created.data.build.id,url='/api/builds/'+id;
  const concept=await owner.request(url+'/concept',{artDirection:'Full world layout'});assert.equal(concept.status,200,concept.text);
  assert.equal((await other.request(url+'/thumbnail',{})).status,403);assert.equal((await owner.request(url+'/thumbnail',{}, {'X-Parallax-Token':'wrong'})).status,403);
  const thumbnail=await owner.request(url+'/thumbnail',{artDirection:'One bold skyline landmark'});assert.equal(thumbnail.status,200,thumbnail.text);const b=thumbnail.data.build;
  assert.deepEqual(b.concept,concept.data.build.concept);assert.equal(b.thumbnail.purpose,'thumbnail');assert.equal(b.thumbnail.title,'Game thumbnail');assert.equal(b.thumbnail.isGameplay,false);assert.match(b.thumbnail.prompt,/promotional key art/);assert.match(b.thumbnail.prompt,/small directory-card sizes/);assert.match(b.thumbnail.imageUrl,/\/thumbnail\/image\?v=/);
  assert.deepEqual((await other.request(b.thumbnail.imageUrl)).bytes,PNG);assert.notEqual(b.thumbnail.imageUrl,b.concept.imageUrl);
  assert.ok(Math.abs((await owner.request('/api/status')).data.spent-.096)<1e-10);
  const oldCookie=owner.cookie();await h.restart();const restored=h.client(oldCookie);h.tick(31000);
  const failed=await restored.request(url+'/thumbnail',{artDirection:'Try a brighter sky'});assert.equal(failed.status,429,failed.text);
  const saved=(await restored.request(url)).data.build;assert.deepEqual(saved.concept,b.concept);assert.equal(saved.thumbnail.status,'failed');assert.equal(saved.thumbnail.imageUrl,b.thumbnail.imageUrl);assert.deepEqual((await restored.request(saved.thumbnail.imageUrl)).bytes,PNG);
  assert.ok(Math.abs((await restored.request('/api/status')).data.spent-.096)<1e-10);assert.equal(saved.screenshot,null);
});
test('coin-linked concept generation belongs to the signed launch wallet rather than arbitrary browsers',async t=>{
  const h=await appFixture(t),account=privateKeyToAccount('0x'+'35'.repeat(32));
  const service=createRobloxBuildService({stateDirectory:h.directory}),build=service.create({owner:account.address.toLowerCase(),...BUILD,template:'auto',modelId:BUILDER.id,token:{address:'0x'+'6'.repeat(40),symbol:'SKY',transactionHash:'0x'+'7'.repeat(64),verified:true}});
  const anonymous=h.client();assert.equal((await anonymous.request('/api/builds/'+build.id+'/concept',{})).status,403);
  const owner=h.client(),challenge=await owner.request('/api/orbio/auth/challenge',{address:account.address}),signature=await account.signMessage({message:challenge.data.message});assert.equal((await owner.request('/api/orbio/auth/verify',{id:challenge.data.id,signature})).status,200);
  const result=await owner.request('/api/builds/'+build.id+'/concept',{});assert.equal(result.status,200,result.text);assert.equal(result.data.build.token.address,build.token.address);assert.equal(result.data.build.canManage,true);
});

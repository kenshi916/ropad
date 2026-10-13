'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {createLaunchArtworkGenerator,launchArtworkPrompt,imageOutputTokens,DEFAULT_LAUNCH_ARTWORK_MODEL_ID,MAX_PROMPT_BYTES}=require('./parallax/launch-artwork-generator.cjs');
const PARAMS={aspect_ratio:{type:'enum',values:['16:9','1:1']},quality:{type:'enum',values:['low','medium','high']},background:{type:'enum',values:['opaque']},n:{type:'range',min:1,max:10},input_references:{type:'range',min:0,max:16}};
const MODEL={id:DEFAULT_LAUNCH_ARTWORK_MODEL_ID,name:'OpenAI: GPT Image 2',architecture:{input_modalities:['text','image'],output_modalities:['image']},supported_parameters:PARAMS};
const ENDPOINT={provider_name:'OpenAI',provider_tag:'openai',provider_slug:'openai',supported_parameters:PARAMS,pricing:[{billable:'input_image',unit:'token',cost_usd:.000008},{billable:'input_text',unit:'token',cost_usd:.000005},{billable:'output_image',unit:'token',cost_usd:.00003}]};
const INPUT={name:'Sky Garden',ticker:'SKYG',brief:'Build a cozy floating greenhouse game with gardening, rare flowers and cloud bridges',inspiration:'Friendly social exploration',artDirection:'Mint and coral, glass greenhouses, warm sunrise',purpose:'thumbnail',operationId:'0e36372b-681a-4ca5-a07d-79c1f5d63da9'};
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function png(width,height){
  function chunk(type,bytes){const b=Buffer.alloc(12+bytes.length);b.writeUInt32BE(bytes.length,0);b.write(type,4);bytes.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;}
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.alloc(height*(1+3*width)))),chunk('IEND',Buffer.alloc(0))]);
}
const COVER=png(1536,864),ICON=png(1024,1024);
function fixture(options={}){
  const calls=[],reserved=[],settled=[],events=[];let releases=0,time=1000;
  const inference=options.inference||{id:'openrouter',key:'OFFLINE_TEST_KEY'};
  const fetcher=async(url,request={})=>{
    calls.push({url,request});
    if(url.endsWith('/images/models'))return options.catalog?.()||Response.json({data:[options.model||MODEL]});
    if(url.endsWith('/endpoints'))return Response.json({id:options.endpointId||MODEL.id,endpoints:options.endpoints||[options.endpoint||ENDPOINT]});
    if(url.endsWith('/images')){events.push('paid');if(options.image)return options.image(request);const body=JSON.parse(request.body),bytes=body.aspect_ratio==='1:1'?ICON:COVER;return Response.json({data:[{b64_json:bytes.toString('base64'),media_type:'image/png'}],usage:{cost:.01}});}
    throw Error('Unexpected offline request');
  };
  const reserve=options.reserve||((amount,operationId)=>{events.push('reserve');reserved.push({amount,operationId});return()=>releases++;});
  const settle=options.settle||((amount,actual,operationId)=>{events.push('settle');settled.push({amount,actual,operationId});});
  const service=createLaunchArtworkGenerator({inference,fetcher,reserve,settle,now:()=>time});
  return {service,calls,reserved,settled,events,fetcher,inference,get releases(){return releases;},advance:ms=>time+=ms};
}
test('read-only config gives current OpenAI pricing for both explicit image sizes without credentials or spend',async()=>{
  const h=fixture({inference:{id:'openrouter',key:''}});
  const service=createLaunchArtworkGenerator({inference:h.inference,fetcher:h.fetcher});
  const config=await service.models();assert.equal(config.configured,false);assert.equal(config.modelId,MODEL.id);assert.equal(config.modelName,MODEL.name);
  assert.equal(config.thumbnail.size,'1536x864');assert.equal(config.coinIcon.size,'1024x1024');assert.equal(config.thumbnail.aspectRatio,'16:9');assert.equal(config.coinIcon.aspectRatio,'1:1');
  assert.equal(imageOutputTokens({width:1536,height:864}),4312);assert.equal(imageOutputTokens({width:1024,height:1024}),7024);
  assert.ok(Math.abs(config.thumbnail.estimatedCostUsd-.17936)<2e-9);assert.ok(Math.abs(config.coinIcon.estimatedCostUsd-.26072)<2e-9);assert.ok(Math.abs(config.estimatedCostUsd-.44008)<3e-9);
  assert.equal(h.calls.length,2);assert.equal(h.reserved.length,0);
  config.thumbnail.width=1;assert.equal((await service.models()).thumbnail.width,1536);
});
test('one paid render is reserved, persisted before submission, provider-pinned and settled exactly once',async()=>{
  const h=fixture();let info;
  const result=await h.service.generate({...INPUT,onStart:async value=>{await Promise.resolve();info=value;h.events.push('start');}});
  assert.deepEqual(h.events,['reserve','start','paid','settle']);assert.deepEqual(result.bytes,COVER);assert.equal(result.costUsd,.01);assert.equal(result.contentType,'image/png');assert.equal(result.modelId,MODEL.id);assert.equal(result.generatedAt,1000);assert.equal(result.isGameplay,false);
  const request=h.calls.find(c=>c.url.endsWith('/images')).request,body=JSON.parse(request.body);
  assert.equal(body.size,'1536x864');assert.equal(body.aspect_ratio,'16:9');assert.equal(body.quality,'high');assert.equal(body.n,1);assert.equal(body.stream,false);assert.equal(body.background,'opaque');assert.deepEqual(body.provider,{only:['openai'],allow_fallbacks:false});assert.equal(request.redirect,'error');
  assert.equal(body.input_references,undefined);assert.equal(body.prompt,info.prompt);assert.match(body.prompt,/Sky Garden/);assert.match(body.prompt,/Mint and coral/);assert.match(body.prompt,/not a gameplay screenshot/);
  assert.equal(h.reserved.length,1);assert.deepEqual(h.settled,[{amount:result.estimatedCostUsd,actual:.01,operationId:INPUT.operationId}]);assert.equal(h.reserved[0].operationId,INPUT.operationId);assert.equal(h.releases,1);
});
test('coin icon has its own matching visual direction and square source dimensions',async()=>{
  const h=fixture(),result=await h.service.generate({...INPUT,purpose:'coinIcon'}),request=JSON.parse(h.calls.at(-1).request.body);
  assert.equal(request.size,'1024x1024');assert.equal(request.aspect_ratio,'1:1');assert.match(request.prompt,/32 pixels/);assert.match(request.prompt,/Mint and coral/);assert.deepEqual(result.bytes,ICON);assert.equal(result.width,1024);assert.equal(result.height,1024);
});
test('invalid prompts, unsupported purpose and oversized fields cannot reach the provider',async()=>{
  const bads=[{brief:''},{name:'a'.repeat(41)},{ticker:'$XYZ'},{purpose:'concept'},{brief:'a'.repeat(2401)},{inspiration:'\x00'},{artDirection:{}},{onStart:'not a callback'}];
  for(const bad of bads){const h=fixture();await assert.rejects(h.service.generate({...INPUT,...bad}),e=>e.status===400);assert.equal(h.calls.length,0);assert.equal(h.reserved.length,0);}
  assert.ok(Buffer.byteLength(launchArtworkPrompt(INPUT).prompt)<MAX_PROMPT_BYTES);
});
test('missing key or accounting prevents generation; another provider is not silently substituted',async()=>{
  const missing=fixture({inference:{id:'openrouter',key:''}});await assert.rejects(missing.service.generate(INPUT),/Configure OpenRouter/);assert.equal(missing.calls.length,0);
  const other=fixture({inference:{id:'orbio',key:'fixture'}});await assert.rejects(other.service.generate(INPUT),/requires the existing OpenRouter/);assert.equal(other.calls.length,0);
  const h=fixture(),service=createLaunchArtworkGenerator({inference:h.inference,fetcher:h.fetcher});await assert.rejects(service.generate(INPUT),/accounting/);assert.equal(h.calls.length,0);
});
test('capability drift, unbounded token categories and unaffordable prices reject before reserve',async()=>{
  const cases=[{model:{...MODEL,id:'another/model'}},{model:{...MODEL,supported_parameters:{...PARAMS,aspect_ratio:{values:['1:1']}}}},{endpoint:{...ENDPOINT,provider_tag:null}},{endpoint:{...ENDPOINT,pricing:[...ENDPOINT.pricing,{billable:'request',unit:'request',cost_usd:.01}]}},{endpoint:{...ENDPOINT,pricing:ENDPOINT.pricing.map(p=>p.billable==='output_image'?{...p,variant:'auto'}:p)}},{endpoint:{...ENDPOINT,pricing:ENDPOINT.pricing.map(p=>({...p,cost_usd:1}))}},{endpoint:{...ENDPOINT,pricing:ENDPOINT.pricing.map(p=>({...p,cost_usd:''}))}},{endpointId:'another/model'}];
  for(const config of cases){const h=fixture(config);await assert.rejects(h.service.generate(INPUT),e=>[402,503].includes(e.status));assert.equal(h.reserved.length,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/images')).length,0);}
});
test('route stays pinned even when a cheaper or unknown provider exists; every OpenAI endpoint must be priced',async()=>{
  const h=fixture({endpoints:[ENDPOINT,{...ENDPOINT,provider_tag:'other',provider_slug:'other',pricing:[]}]});await h.service.generate(INPUT);assert.deepEqual(JSON.parse(h.calls.at(-1).request.body).provider.only,['openai']);
  const bad=fixture({endpoints:[ENDPOINT,{...ENDPOINT,pricing:[]}]});await assert.rejects(bad.service.generate(INPUT),/cannot be safely bounded/);assert.equal(bad.reserved.length,0);
});
test('pricing cache expires and changed rates are checked again before submission',async()=>{
  const endpoint=structuredClone(ENDPOINT),h=fixture({endpoint});await h.service.models();assert.equal(h.calls.length,2);await h.service.models();assert.equal(h.calls.length,2);
  endpoint.pricing.find(p=>p.billable==='output_image').cost_usd=1;h.advance(60001);await assert.rejects(h.service.generate(INPUT),/exceeds/);assert.equal(h.calls.length,4);assert.equal(h.reserved.length,0);
});
test('definitive provider rejections release cost and mark retry safe',async()=>{
  for(const status of [400,401,402,403,404,413,422,429]){const h=fixture({image:()=>new Response('',{status})});await assert.rejects(h.service.generate(INPUT),e=>e.safeToRetry===true&&e.status===status);assert.equal(h.settled.length,1);assert.equal(h.settled[0].actual,0);assert.equal(h.releases,1);}
});
test('transport failures and ambiguous responses hold the allowance and never automatically retry',async()=>{
  for(const image of [()=>{throw Error('raw error including SECRET must not escape');},...([408,409,499,500,502,503].map(status=>()=>new Response('',{status})))]){const h=fixture({image});await assert.rejects(h.service.generate(INPUT),e=>e.safeToRetry===false&&!e.message.includes('SECRET'));assert.equal(h.settled.length,1);assert.equal(h.settled[0].actual,null);assert.equal(h.releases,1);assert.equal(h.calls.filter(c=>c.url.endsWith('/images')).length,1);}
});
test('persistence failure before submission releases cost without generating; no untracked paid render',async()=>{
  const h=fixture();await assert.rejects(h.service.generate({...INPUT,onStart:()=>{throw Error('disk unavailable');}}),e=>e.safeToRetry===true);assert.equal(h.settled[0].actual,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/images')).length,0);assert.equal(h.releases,1);
});
test('budget refusal occurs before onStart and provider submission',async()=>{
  let started=false;const h=fixture({reserve:()=>{throw Object.assign(Error('Budget exhausted'),{status:402});}});await assert.rejects(h.service.generate({...INPUT,onStart:()=>{started=true;}}),/Budget exhausted/);assert.equal(started,false);assert.equal(h.calls.filter(c=>c.url.endsWith('/images')).length,0);
});
test('missing usage remains unknown instead of becoming zero; measured overrun blocks another render',async()=>{
  const image=cost=>Response.json({data:[{b64_json:COVER.toString('base64')}],...(cost===undefined?{}:{usage:{cost}})});
  for(const cost of [undefined,null,'',false,'NaN']){const h=fixture({image:()=>image(cost)}),result=await h.service.generate(INPUT);assert.equal(result.costUsd,null);assert.equal(h.settled[0].actual,null);}
  const high=fixture({image:()=>image(.7)});await assert.rejects(high.service.generate(INPUT),/exceeded the reserved estimate/);assert.equal(high.settled[0].actual,.7);assert.equal(high.releases,1);
});
test('settlement failure is surfaced and attempted once while releasing the in-flight lock',async()=>{
  let count=0;const h=fixture({settle:()=>{count++;throw Error('ledger unavailable');}});await assert.rejects(h.service.generate(INPUT),/ledger unavailable/);assert.equal(count,1);assert.equal(h.releases,1);
});
test('remote URLs, SVG, wrong dimensions, media mismatch and multiple images are never successful renders',async()=>{
  const good={b64_json:COVER.toString('base64')};const outputs=[[{url:'https://untrusted.invalid/image.png'}],[{b64_json:Buffer.from('<svg>not a raster</svg>').toString('base64')}],[{b64_json:ICON.toString('base64')}],[{...good,media_type:'image/svg+xml'}],[good,good]];
  for(const data of outputs){const h=fixture({image:()=>Response.json({data,usage:{cost:.01}})});await assert.rejects(h.service.generate(INPUT),e=>e.status===502);assert.equal(h.settled[0].actual,.01);assert.equal(h.calls.length,3);assert.equal(h.releases,1);}
});
test('malformed or oversized provider responses retain uncertain accounting without success',async()=>{
  for(const image of [()=>new Response('not json'),()=>new Response('{}',{headers:{'Content-Length':String(13*1024*1024)}})]){const h=fixture({image});await assert.rejects(h.service.generate(INPUT),e=>e.status===502);assert.equal(h.settled[0].actual,null);assert.equal(h.releases,1);}
});

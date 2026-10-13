'use strict';
// All provider responses and captured pixels here are offline fixtures.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {generateVisualReview,validateVisualReview,validateReference,estimateVisualReview,estimateImageSurcharge,rasterBytes,MAX_REFERENCE_BYTES}=require('./parallax/builder-visual-review.cjs');
const {createTemplatePlan}=require('./parallax/roblox-builds.cjs');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHdsAAAAASUVORK5CYII=','base64');
const HASH=crypto.createHash('sha256').update(PNG).digest('hex');
const MODEL={id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5',architecture:{input_modalities:['text','image'],output_modalities:['text']},pricing:{prompt:'0.000001',completion:'0.000005'},supported_parameters:['response_format']};
const INFERENCE={name:'Fixture provider',key:'OFFLINE_FIXTURE_ONLY',completionsUrl:'https://provider.invalid/completions',reserveMultiplier:1};
const REVIEW={version:1,verdict:'improve',summary:'The finish is difficult to distinguish from the track',issues:[{category:'readability',description:'The finish and track use similarly dark colors'}],revisionBrief:'Preserve the route and turn finish into a contrasting mint destination'};
function harness(options={}){
  const frame={bytes:Buffer.from(PNG),contentType:'image/png',hash:HASH,capturedAt:1000,view:'overview',jobId:'job-fixture',source:'pooled_studio_worker'};
  const build={gameName:'Circuit',brief:'A readable rooftop race',jobId:frame.jobId,plan:createTemplatePlan('racing'),visualFrames:[{...frame,bytes:PNG.length}]};
  const input={build,modelId:MODEL.id,inference:INFERENCE,frames:[frame],...options.input};
  let releases=0;const calls=[],settlements=[],reservations=[];
  const run=()=>generateVisualReview({...input,getModels:async()=>options.models||[MODEL],now:()=>2000,
    reserve:amount=>{reservations.push(amount);if(options.reserveError)throw options.reserveError;return()=>{releases++;};},
    settle:(reserved,actual)=>{settlements.push({reserved,actual});if(options.settleError)throw options.settleError;},
    fetcher:async(url,init)=>{const request={url,...init,body:JSON.parse(init.body)};calls.push(request);return options.respond?options.respond(request):Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(REVIEW),reasoning:'PRIVATE_REASONING'}}],usage:{cost:.001}});}});
  return {input,run,calls,settlements,reservations,get releases(){return releases;}};
}
test('actual Studio frames, creator brief and validated geometry reach a single vision request',async()=>{
  const h=harness(),result=await h.run(),request=h.calls[0].body;
  assert.equal(h.calls.length,1);assert.equal(request.model,MODEL.id);assert.deepEqual(request.reasoning,{exclude:true});assert.equal(request.stream,false);assert.equal(request.max_tokens,1800);assert.deepEqual(request.response_format,{type:'json_object'});
  const content=request.messages[1].content,context=JSON.parse(content[0].text);
  assert.equal(context.creatorBrief,h.input.build.brief);assert.deepEqual(context.plan,h.input.build.plan);
  assert.deepEqual(content[2],{type:'image_url',image_url:{url:'data:image/png;base64,'+PNG.toString('base64'),detail:'low'}});
  assert.deepEqual(result.evidence,[{view:'overview',hash:HASH,capturedAt:1000,jobId:'job-fixture'}]);assert.equal(result.reviewedAt,2000);assert.equal(result.costUsd,.001);assert.equal(result.referenceHash,null);assert.equal(result.verdict,'improve');
  assert.equal(h.settlements.length,1);assert.equal(h.settlements[0].actual,.001);assert.equal(h.releases,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_REASONING|base64/);
  assert.match(request.messages[0].content,/untrusted task data/);assert.match(request.messages[0].content,/never release certification/);
  assert.match(request.messages[0].content,/UI quality is not observable from that capture/);
  assert.match(request.messages[0].content,/Do not infer mobile usability, working buttons, sound or animation from still images/);
  assert.match(request.messages[0].content,/name the affected view or part/);
});
test('a saved concept image is labeled as an art target and checked against its saved hash',async()=>{
  const h=harness();h.input.build.concept={status:'ready',source:'ai_generated',isGameplay:false,contentType:'image/png',bytes:PNG.length,imageHash:HASH,generatedAt:750,artDirection:'Ivory and mint'};
  h.input.reference={bytes:PNG,contentType:'image/png'};
  const result=await h.run();assert.equal(result.referenceHash,HASH);assert.equal(h.calls[0].body.messages[1].content.filter(x=>x.type==='image_url').length,2);
  assert.match(h.calls[0].body.messages[1].content.at(-2).text,/not a gameplay capture/);
  const tampered=harness();tampered.input.build.concept={...h.input.build.concept,imageHash:'0'.repeat(64)};tampered.input.reference=h.input.reference;
  await assert.rejects(tampered.run(),/does not match/);assert.equal(tampered.calls.length,0);assert.equal(tampered.reservations.length,0);
});
test('three named views retain separate provenance without fetching image URLs',async()=>{
  const h=harness();h.input.frames=['overview','spawn','finish'].map((view,i)=>({...h.input.frames[0],view,capturedAt:1000+i}));h.input.build.visualFrames=h.input.frames.map(frame=>({...frame,bytes:PNG.length}));
  const result=await h.run();assert.equal(result.evidence.length,3);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.messages[1].content.filter(x=>x.type==='image_url').length,3);
});
test('non-worker, stale-job, substituted, duplicate and missing frames fail before reserving money',async()=>{
  for(const mutate of [
    h=>{h.input.frames[0].hash='0'.repeat(64);},
    h=>{h.input.frames[0].capturedAt++;},
    h=>{h.input.frames[0].jobId='previous-job';},
    h=>{h.input.frames[0].source='owner_screen_share';},
    h=>{h.input.build.visualFrames[0].source='owner_screen_share';},
    h=>{h.input.build.visualFrames[0].bytes++;},
    h=>{h.input.frames=[...h.input.frames,...h.input.frames];},
    h=>{h.input.frames=[];},
    h=>{h.input.build.visualFrames=[];},
    h=>{h.input.frames[0].view='https://host.invalid/image';},
    h=>{h.input.frames[0].bytes=PNG.toString('base64');},
    h=>{h.input.frames[0].bytes=PNG.subarray(0,32);},
  ]){
    const h=harness();mutate(h);await assert.rejects(h.run());assert.equal(h.reservations.length,0);assert.equal(h.calls.length,0);
  }
});
test('unsupported image formats, mismatched MIME and excessive image dimensions are rejected',()=>{
  assert.throws(()=>rasterBytes(PNG,'image/webp'),/PNG or JPEG/);
  assert.throws(()=>rasterBytes(PNG,'image/jpeg'),/JPEG/);
  assert.throws(()=>rasterBytes(Buffer.alloc(2*1024*1024+1),'image/png'),/bounded/);
  const huge=Buffer.from(PNG);huge.writeUInt32BE(5000,16);assert.throws(()=>rasterBytes(huge,'image/png'),/dimensions/);
});
test('only exact advanced image-capable catalog models are eligible',async()=>{
  for(const [model,error] of [[{...MODEL,id:'openai/gpt-4o-mini'},/Opus 5.5 or GPT-6 Astra/],[{...MODEL,architecture:{output_modalities:['text']}},/image input/],[{...MODEL,architecture:{input_modalities:['image'],output_modalities:['image']}},/unavailable/]]){
    const h=harness({models:[model],input:{modelId:model.id}});await assert.rejects(h.run(),error);assert.equal(h.reservations.length,0);assert.equal(h.calls.length,0);
  }
});
test('JSON response format is sent only for catalog-advertised support',async()=>{
  for(const supported_parameters of [undefined,[],['temperature'],'response_format']){
    const h=harness({models:[{...MODEL,supported_parameters}]});await h.run();assert.equal(Object.hasOwn(h.calls[0].body,'response_format'),false);
  }
});
test('malformed output, extra keys, reasoning-only, truncation and invalid verdicts charge once without retrying',async()=>{
  const outputs=[['not JSON','stop'],['```json\n'+JSON.stringify(REVIEW)+'\n```','stop'],[JSON.stringify({...REVIEW,shipReady:true}),'stop'],[JSON.stringify({...REVIEW,verdict:'approved'}),'stop'],[JSON.stringify({...REVIEW,issues:[]}),'stop'],[JSON.stringify({...REVIEW,verdict:'acceptable'}),'stop'],[JSON.stringify({...REVIEW,revisionBrief:''}),'stop'],[JSON.stringify({...REVIEW,issues:[{category:'lighting',description:'Fix',script:'unsafe'}]}),'stop'],[undefined,'stop'],[JSON.stringify(REVIEW),'length']];
  for(const [content,finish_reason] of outputs){
    const h=harness({respond:()=>Response.json({usage:{cost:.002},choices:[{message:{content,reasoning:'PRIVATE_REASONING'},finish_reason}]})});
    await assert.rejects(h.run());assert.equal(h.calls.length,1);assert.equal(h.settlements.length,1);assert.equal(h.settlements[0].actual,.002);assert.equal(h.releases,1);
  }
});
test('acceptable is only a visual opinion with an empty revision brief',()=>{
  const result=validateVisualReview({version:1,verdict:'acceptable',summary:'The route and finish are legible in the supplied views',issues:[],revisionBrief:''});
  assert.deepEqual(Object.keys(result),['version','verdict','summary','issues','revisionBrief']);assert.equal(result.revisionBrief,'');
});
test('public review text and issue counts remain byte-bounded',()=>{
  for(const patch of [{summary:'x'.repeat(801)},{revisionBrief:'x'.repeat(1801)},{issues:Array.from({length:7},()=>REVIEW.issues[0])},{issues:[{category:'other',description:'x'.repeat(501)}]},{issues:[{category:'price',description:'Not visual'}]}])assert.throws(()=>validateVisualReview({...REVIEW,...patch}));
});
test('provider uncertainty keeps the cost reserved; known HTTP rejection settles zero',async()=>{
  for(const [status,expected] of [[400,0],[401,0],[402,0],[429,0],[408,null],[409,null],[499,null],[500,null],[502,null]]){
    const h=harness({respond:()=>new Response('fixture error',{status})});await assert.rejects(h.run());assert.equal(h.calls.length,1);assert.equal(h.settlements.length,1);assert.equal(h.settlements[0].actual,expected);assert.equal(h.releases,1);
  }
});
test('network errors, unreadable responses, absent costs and oversized output are not paid-retried',async()=>{
  for(const respond of [()=>{throw Error('Network fixture');},()=>new Response('{'),()=>new Response('x'.repeat(64001)),()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(REVIEW)}}]})]){
    const h=harness({respond});try{await h.run();}catch{}assert.equal(h.calls.length,1);assert.equal(h.settlements.length,1);assert.equal(h.settlements[0].actual,null);assert.equal(h.releases,1);
  }
});
test('ledger failures do not repeat settlement or leak the provider lock',async()=>{
  const reserveError=harness({reserveError:new Error('No remaining budget')});await assert.rejects(reserveError.run(),/remaining budget/);assert.equal(reserveError.calls.length,0);assert.equal(reserveError.settlements.length,0);
  const settleError=harness({settleError:new Error('Ledger unavailable')});await assert.rejects(settleError.run(),/Ledger unavailable/);assert.equal(settleError.settlements.length,1);assert.equal(settleError.calls.length,1);assert.equal(settleError.releases,1);
});
test('ambiguous non-numeric usage never clears the reserved cost',async()=>{
  for(const cost of ['',true,false,null,-1,'NaN',{},[]]){
    const h=harness({respond:()=>Response.json({usage:{cost},choices:[{finish_reason:'stop',message:{content:JSON.stringify(REVIEW)}}]})});
    const result=await h.run();assert.equal(result.costUsd,null);assert.equal(h.settlements[0].actual,null);assert.equal(h.settlements.length,1);assert.equal(h.releases,1);
  }
});
test('cost estimates cover image tokens, explicit image fees, overrides, request fees and provider multipliers',()=>{
  const model={...MODEL,pricing:{prompt:'0.000001',completion:'0.000005',image:'0.001',request:'0.002',overrides:[{prompt:'0.000002',image:'0.003'}]}};
  assert.ok(Math.abs(estimateImageSurcharge(model,2,1.1)-2*(4096*.000002+.003)*1.1)<1e-12);
  assert.ok(Math.abs(estimateVisualReview(model,{imageCount:2,contextBytes:9000,multiplier:1.1})-(9000*.000002+1800*.000005+.002+2*(4096*.000002+.003))*1.1)<1e-12);
  for(const bad of [{prompt:'NaN',completion:'0.01'},{prompt:'0.01'},{prompt:'0.01',completion:'0.01',image:'bad'}])assert.equal(estimateVisualReview({...MODEL,pricing:bad},{imageCount:1,contextBytes:8000}),Infinity);
});
test('expensive review, excessive scene context or absent credentials submit no inference',async()=>{
  const expensive=harness({models:[{...MODEL,pricing:{prompt:'0.001',completion:'0.001'}}]});await assert.rejects(expensive.run(),/allowance/);assert.equal(expensive.reservations.length,0);
  const oversized=harness();oversized.input.build.brief='x'.repeat(36001);await assert.rejects(oversized.run(),/too large/);assert.equal(oversized.reservations.length,0);
  const missing=harness({input:{inference:{...INFERENCE,key:''}}});await assert.rejects(missing.run(),/Configure/);assert.equal(missing.reservations.length,0);
});

// Small structural fixtures exercise RIFF/header validation, not a pixel decoder.
function webpChunk(kind,data){const chunk=Buffer.alloc(8+data.length+(data.length&1));chunk.write(kind,0,'ascii');chunk.writeUInt32LE(data.length,4);data.copy(chunk,8);return chunk;}
function webpFile(chunks){const bytes=Buffer.concat([Buffer.alloc(12),...chunks]);bytes.write('RIFF',0,'ascii');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WEBP',8,'ascii');return bytes;}
function webpImage(kind='VP8L',width=2,height=2){
  const data=Buffer.alloc(kind==='VP8L'?8:12);
  if(kind==='VP8L'){data[0]=0x2f;data.writeUInt32LE((width-1)|((height-1)<<14),1);}
  else{data.writeUIntLE(0x30,0,3);Buffer.from([0x9d,1,0x2a]).copy(data,3);data.writeUInt16LE(width,6);data.writeUInt16LE(height,8);}
  return webpChunk(kind,data);
}
function webpExtended(width=2,height=2,flags=0){const data=Buffer.alloc(10);data[0]=flags;data.writeUIntLE(width-1,4,3);data.writeUIntLE(height-1,7,3);return webpChunk('VP8X',data);}
function withWebp(bytes){const h=harness();h.input.reference={bytes,contentType:'image/webp'};h.input.build.concept={status:'ready',source:'ai_generated',isGameplay:false,contentType:'image/webp',bytes:bytes.length,imageHash:crypto.createHash('sha256').update(bytes).digest('hex'),generatedAt:750};return h;}

test('saved static VP8, VP8L and VP8X concept references preserve their WebP bytes and provenance',async()=>{
  const fixtures=[webpFile([webpImage('VP8 ')]),webpFile([webpImage()]),webpFile([webpExtended(),webpImage()]),webpFile([webpExtended(2,2,8),webpImage('VP8 '),webpChunk('EXIF',Buffer.from([1,2,3]))]),webpFile([webpExtended(2,2,16),webpChunk('ALPH',Buffer.from([0,255,255,255,255])),webpImage('VP8 ')])];
  for(const bytes of fixtures){
    const h=withWebp(bytes),checked=validateReference(h.input);assert.equal(checked.width,2);assert.equal(checked.height,2);
    const result=await h.run();assert.equal(result.referenceHash,h.input.build.concept.imageHash);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.messages[1].content.at(-1).image_url.url,'data:image/webp;base64,'+bytes.toString('base64'));
  }
});

test('WebP support is confined to concepts and never accepts WebP as trusted worker evidence',async()=>{
  const bytes=webpFile([webpImage()]),h=harness();h.input.frames[0]={...h.input.frames[0],bytes,contentType:'image/webp',hash:crypto.createHash('sha256').update(bytes).digest('hex')};h.input.build.visualFrames=[{...h.input.frames[0],bytes:bytes.length}];
  await assert.rejects(h.run(),/PNG or JPEG/);assert.equal(h.calls.length,0);assert.equal(h.reservations.length,0);
});

test('truncated WebP containers, bad chunk sizes, padding and missing or duplicate bitstreams fail before payment',async()=>{
  const valid=webpFile([webpImage()]),odd=webpFile([webpExtended(2,2,8),webpImage(),webpChunk('EXIF',Buffer.from([1]))]);
  const badSize=Buffer.from(valid);badSize.writeUInt32LE(0xffffffff,16);
  const shortRiff=Buffer.from(valid);shortRiff.writeUInt32LE(valid.length-10,4);
  const padded=Buffer.from(odd);padded[padded.length-1]=1;
  const badLossless=Buffer.from(valid);badLossless[24]|=0x20;
  const badVp8=webpFile([webpImage('VP8 ')]);badVp8[23]=0;
  const badPartition=webpFile([webpImage('VP8 ')]);badPartition[22]=0xff;
  const extendedOnly=webpFile([webpExtended()]);
  for(const bytes of [valid.subarray(0,20),valid.subarray(0,valid.length-1),Buffer.concat([valid,Buffer.from([0])]),badSize,shortRiff,padded,badLossless,badVp8,badPartition,extendedOnly,webpFile([webpImage(),webpImage()]),webpFile([webpExtended(3,2),webpImage()])]){
    const h=withWebp(bytes);await assert.rejects(h.run());assert.equal(h.calls.length,0);assert.equal(h.reservations.length,0);
  }
});

test('WebP byte and canvas limits, animated files and substituted concepts are refused before inference',async()=>{
  for(const bytes of [Buffer.alloc(MAX_REFERENCE_BYTES+1),webpFile([webpImage('VP8L',4097,1)]),webpFile([webpImage('VP8L',2000,2000)]),webpFile([webpExtended(4097,1),webpImage('VP8 ',4097,1)]),webpFile([webpExtended(2,2,2),webpImage()]),webpFile([webpExtended(),webpChunk('ANIM',Buffer.alloc(6)),webpImage()])]){
    const h=withWebp(bytes);await assert.rejects(h.run());assert.equal(h.calls.length,0);assert.equal(h.reservations.length,0);
  }
  const h=withWebp(webpFile([webpImage()]));h.input.build.concept.imageHash='0'.repeat(64);await assert.rejects(h.run(),/does not match/);assert.equal(h.calls.length,0);assert.equal(h.reservations.length,0);
  const mime=withWebp(webpFile([webpImage()]));mime.input.reference.contentType='image/png';await assert.rejects(mime.run(),/PNG/);assert.equal(mime.reservations.length,0);
});

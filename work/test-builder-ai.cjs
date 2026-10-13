'use strict';
// Provider responses are fixtures: these checks never use credentials or paid inference.
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateBuildPlan,estimate}=require('./parallax/builder-ai.cjs');
const {createTemplatePlan:baseTemplatePlan,GAMEPLAY_SOURCE}=require('./parallax/roblox-builds.cjs');
const DESIGN={
  coreLoop:'Traverse the lunar gates, collect energy and reach the landing zone',
  objective:'Touch every ordered gate and cross the finish',
  progression:'Alternating barriers increase route choices before the final gates',
  inspiration:'Original moon-base setting using clear objectives and visible progress',
  limitations:['Progress is not saved across server sessions','Human playtesting and publishing are still required'],
  unsupportedFeatures:[],
  acceptanceCriteria:['Spawn safely and locate the first gate','Reach every gate in order without blocked routes','Respawn at the latest gate after a fall','Complete the final gate and verify one finish event']
};
function createTemplatePlan(template){return {...baseTemplatePlan(template),design:structuredClone(DESIGN)};}
const MODEL={id:'anthropic/claude-opus-5.5',architecture:{output_modalities:['text']},pricing:{prompt:'0.0000001',completion:'0.0000004'},supported_parameters:['response_format']};
const BUILD={gameName:'Lunar Relay',brief:'A moon base footrace through cyan landing gates and solar panels',template:'racing'};
const INFERENCE={name:'Fixture provider',key:'OFFLINE_FIXTURE_ONLY',completionsUrl:'https://provider.invalid/completions',reserveMultiplier:1};
function harness({model=MODEL,build=BUILD,respond,reference}={}){
  const calls=[],settlements=[],reservations=[];let releases=0;
  const run=()=>generateBuildPlan({build,modelId:model.id,inference:INFERENCE,reference,getModels:async()=>[model],
    reserve:amount=>{reservations.push(amount);return()=>{releases++;};},
    settle:(reserved,actual)=>settlements.push({reserved,actual}),
    fetcher:async(url,options)=>{const request={url,...options,body:JSON.parse(options.body)};calls.push(request);return respond?respond(request):Response.json({choices:[{message:{content:JSON.stringify(createTemplatePlan(build.template))},finish_reason:'stop'}],usage:{cost:.0003}});}});
  return {run,calls,settlements,reservations,get expectedEstimate(){const request=calls[0]?.body;const user=request?.messages?.[1]?.content;const context=typeof user==='string'?user:user?.[0]?.text;return estimate(model,1,request?.max_tokens||6000,Math.max(8000,Buffer.byteLength(request?.messages?.[0]?.content||'')+Buffer.byteLength(context||'')+512));},get releases(){return releases;}};
}

test('supported JSON mode preserves a distinct custom scene and the brief across the provider boundary',async()=>{
  const plan=createTemplatePlan('racing');plan.summary='A lunar footrace through cyan landing gates and solar arrays';
  for(const part of plan.parts){part.name='Lunar '+part.name;part.color=[40,210,230];}
  const h=harness({respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan),reasoning:'PRIVATE_REASONING'},finish_reason:'stop'}],usage:{cost:.0006}})});
  const result=await h.run();assert.deepEqual(result,plan);assert.equal(h.calls.length,1);
  const request=h.calls[0];assert.deepEqual(request.body.response_format,{type:'json_object'});assert.deepEqual(JSON.parse(request.body.messages[1].content),BUILD);
  assert.equal(request.body.reasoning.exclude,true);assert.equal(request.body.stream,false);assert.equal(request.body.model,MODEL.id);
  assert.equal(h.releases,1);assert.deepEqual(h.settlements,[{reserved:h.expectedEstimate,actual:.0006}]);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_REASONING/);
});

test('catalogs without declared JSON support do not receive unsupported response-format parameters',async()=>{
  for(const supported_parameters of [undefined,[],['temperature'],'response_format']){
    const h=harness({model:{...MODEL,supported_parameters}});await h.run();assert.equal(Object.hasOwn(h.calls[0].body,'response_format'),false);assert.equal(h.releases,1);
  }
});

test('paid malformed and truncated replies are settled once and are never automatically retried',async()=>{
  for(const [content,finish_reason,error] of [['not valid JSON','stop',/valid scene plan/],[JSON.stringify(createTemplatePlan('racing')),'length',/truncated/]]){
    const h=harness({respond:()=>Response.json({choices:[{message:{content},finish_reason}],usage:{cost:.0004}})});
    await assert.rejects(h.run(),error);assert.equal(h.calls.length,1);assert.equal(h.releases,1);assert.deepEqual(h.settlements,[{reserved:h.expectedEstimate,actual:.0004}]);
  }
});

test('custom unreachable and nonsequential race plans fail validation before reaching Studio',async()=>{
  const disconnected=createTemplatePlan('racing');disconnected.parts.find(p=>p.behavior==='finish').position=[1000,1000,1000];
  const skippedGate=createTemplatePlan('racing');skippedGate.parts.find(p=>p.behavior==='checkpoint').value=99;
  for(const [plan,error] of [[disconnected,/connected surface path/],[skippedGate,/sequential/]]){
    const h=harness({respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:.0002}})});
    await assert.rejects(h.run(),error);assert.equal(h.calls.length,1);assert.equal(h.releases,1);assert.equal(h.settlements[0].actual,.0002);
  }
});

test('transport failures conservatively retain the reservation and release the shared request lock',async()=>{
  const h=harness({respond:()=>{throw new Error('Fixture connection ended');}});
  await assert.rejects(h.run(),/connection ended/);assert.equal(h.calls.length,1);assert.equal(h.releases,1);assert.deepEqual(h.settlements,[{reserved:h.expectedEstimate,actual:null}]);
});

test('ambiguous provider HTTP failures retain compute and cannot trigger automatic repair',async()=>{
  for(const status of [408,409,499,500,502]){
    const h=harness({respond:()=>new Response('unavailable',{status})});
    await assert.rejects(h.run(),error=>error.repairable!==true);
    assert.equal(h.calls.length,1);assert.deepEqual(h.settlements,[{reserved:h.expectedEstimate,actual:null}]);assert.equal(h.releases,1);
  }
});

test('only known-charge invalid plans expose bounded repair eligibility',async()=>{
  for(const [cost,repairable] of [[.001,true],[undefined,false]]){
    const h=harness({build:{...BUILD,repairFeedback:'Keep all gates connected'},respond:()=>Response.json({choices:[{message:{content:'invalid JSON'},finish_reason:'stop'}],usage:{cost}})});
    await assert.rejects(h.run(),error=>error.code==='PLAN_VALIDATION_FAILED'&&error.repairable===repairable);
    assert.equal(h.calls.length,1);assert.equal(JSON.parse(h.calls[0].body.messages[1].content).repairFeedback,'Keep all gates connected');
    assert.equal(h.settlements.length,1);
  }
});

test('custom tycoon finish requirements reach the gameplay hint instead of a hardcoded three upgrades',async()=>{
  const plan=createTemplatePlan('tycoon');plan.parts=plan.parts.filter(p=>p.behavior!=='purchase'||p.id==='upgrade_1');plan.parts.find(p=>p.behavior==='finish').value=1;
  const h=harness({build:{...BUILD,template:'tycoon'},respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:.0002}})});
  const result=await h.run();assert.equal(result.parts.filter(p=>p.behavior==='purchase').length,1);assert.equal(result.parts.find(p=>p.behavior==='finish').value,1);
  assert.match(GAMEPLAY_SOURCE,/"FINISH \/ Buy " \.\. value \.\. " upgrades"/);assert.doesNotMatch(GAMEPLAY_SOURCE,/FINISH \/ Buy 3 upgrades/);
});

test('direct generation rejects any lower-tier model before reservation or provider calls',async()=>{
  for(const id of ['openai/gpt-4o-mini','openrouter/auto','anthropic/claude-opus-latest','template','openai/gpt-6-astra:batch']){
    const h=harness({model:{...MODEL,id}});await assert.rejects(h.run(),e=>e.status===400&&/Opus 5.5 or GPT-6 Astra/.test(e.message));
    assert.equal(h.calls.length,0);assert.equal(h.reservations.length,0);assert.equal(h.settlements.length,0);
  }
});

test('Astra accepts its conservative override estimate within the advanced plan cap',async()=>{
  const model={...MODEL,id:'openai/gpt-6-astra',pricing:{prompt:'0.000005',completion:'0.000025',overrides:[{prompt:'0.00002',completion:'0.000075'}]}};
  assert.equal(estimate(model),.61);
  const h=harness({model});await h.run();assert.equal(h.reservations[0],h.expectedEstimate);assert.equal(h.calls[0].body.model,model.id);
});

test('advanced model pricing above the cap fails closed without downgrading or paying',async()=>{
  const h=harness({model:{...MODEL,pricing:{prompt:'0.0001',completion:'0.0001'}}});
  await assert.rejects(h.run(),e=>e.status===402&&/\$0\.75/.test(e.message));assert.equal(h.calls.length,0);assert.equal(h.reservations.length,0);
});

test('prompt-only planning selects its supported foundation and preserves creator inspiration as context',async()=>{
  const build={gameName:'Cloud Orchard',brief:'Gather fruit and buy orchard upgrades before unlocking the lookout',template:'auto',inspiration:'A satisfying short collection loop like Grow a Garden, with an original sky-island setting'};
  const plan=createTemplatePlan('tycoon');plan.summary='An original sky orchard with a coin-gathering loop and three lookout upgrades';
  plan.design={...plan.design,coreLoop:'Gather fruit coins, purchase orchard blocks and reach the lookout finish',objective:'Buy three upgrades and touch the lookout finish',progression:'Three visible upgrade costs increase over repeated coin circuits',inspiration:'Creator-provided collection-game reference used for short goals and visible growth; no copied assets',limitations:[...plan.design.limitations,'Plant growth, inventory and trading are not implemented']};
  const h=harness({build,respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:.0005}})});
  const result=await h.run();assert.equal(result.template,'tycoon');assert.deepEqual(result.design,plan.design);
  assert.deepEqual(JSON.parse(h.calls[0].body.messages[1].content),build);
  assert.match(h.calls[0].body.messages[0].content,/internal gameplay foundation: obby/);
  assert.match(h.calls[0].body.messages[0].content,/not verified research/);
  assert.equal(h.calls[0].headers['X-Title'],'Ropad Roblox Builder');
});

test('a revision sends the earlier design as data and can produce a different complete supported loop',async()=>{
  const previousDesign={template:'racing',summary:'Lunar gate racing',design:structuredClone(DESIGN)};
  const build={...BUILD,template:'auto',brief:'Replace the timed race with a lunar collection and upgrade loop',previousDesign};
  const h=harness({build,respond:()=>Response.json({choices:[{message:{content:JSON.stringify(createTemplatePlan('tycoon'))},finish_reason:'stop'}],usage:{cost:.0005}})});
  const result=await h.run();assert.equal(result.template,'tycoon');
  assert.deepEqual(JSON.parse(h.calls[0].body.messages[1].content).previousDesign,previousDesign);
  assert.doesNotMatch(h.calls[0].body.messages[0].content,/Lunar gate racing/);
});

test('AI plans lacking inspectable design and playtest criteria are settled but never accepted',async()=>{
  const noDesign=baseTemplatePlan('racing');
  const noCriteria=createTemplatePlan('racing');noCriteria.design.acceptanceCriteria=[];
  const noLimits=createTemplatePlan('racing');noLimits.design.limitations=[];
  const noFeatureDisclosure=createTemplatePlan('racing');delete noFeatureDisclosure.design.unsupportedFeatures;
  for(const plan of [noDesign,noCriteria,noLimits,noFeatureDisclosure]){
    const h=harness({respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:.0005}})});
    await assert.rejects(h.run(),/design|criteria|limitations/i);
    assert.equal(h.calls.length,1);assert.equal(h.settlements[0].actual,.0005);assert.equal(h.releases,1);
  }
});

test('AI design metadata cannot carry arbitrary code or self-certified release status',async()=>{
  for(const extra of [{source:'print("unreviewed")'},{shipReady:true},{design:{...DESIGN,approved:true}}]){
    const plan={...createTemplatePlan('racing'),...extra};
    const h=harness({respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:.0005}})});
    await assert.rejects(h.run(),/unsupported|design/i);assert.equal(h.calls.length,1);
  }
});

test('missing requested mechanics survive planning as explicit release blockers',async()=>{
  const build={gameName:'Cloud Companions',brief:'Create a gathering game with collectible pet AI, player trading and saved inventory',template:'auto'};
  const plan=createTemplatePlan('tycoon');plan.design.unsupportedFeatures=['Collectible pet AI','Player-to-player trading','Persistent saved inventory'];
  plan.summary='A limited gathering and upgrade scene; requested pet AI, trading and saved inventory remain unimplemented';
  const h=harness({build,respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:.0005}})});
  const result=await h.run();assert.deepEqual(result.design.unsupportedFeatures,plan.design.unsupportedFeatures);
  assert.match(h.calls[0].body.messages[0].content,/unsupportedFeatures must list every requested feature/);
  assert.match(h.calls[0].body.messages[0].content,/Do not invent farming, combat, pets/);
});

test('a verified concept reaches the advanced planner as pixels with an extra reserved image allowance',async()=>{
  const crypto=require('node:crypto');
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHdsAAAAASUVORK5CYII=','base64');
  const imageHash=crypto.createHash('sha256').update(bytes).digest('hex');
  const model={...MODEL,architecture:{input_modalities:['text','image'],output_modalities:['text']}};
  const build={...BUILD,concept:{status:'ready',source:'ai_generated',isGameplay:false,imageHash,bytes:bytes.length,contentType:'image/png',generatedAt:1000},visualReviewContext:{review:{summary:'Improve route contrast'}}};
  const h=harness({model,build,reference:{bytes,contentType:'image/png'}});await h.run();
  const message=h.calls[0].body.messages[1].content;
  assert.equal(message[1].image_url.url,'data:image/png;base64,'+bytes.toString('base64'));
  assert.equal(message[1].image_url.detail,'low');
  assert.equal(JSON.parse(message[0].text).visualTarget.hash,imageHash);
  assert.equal(JSON.parse(message[0].text).visualReviewContext.review.summary,'Improve route contrast');
  assert.ok(h.reservations[0]>estimate(model));assert.equal(h.settlements.length,1);
  assert.match(h.calls[0].body.messages[0].content,/"presentation":.*"lighting"/);
  assert.match(h.calls[0].body.messages[0].content,/Decorations cannot catch falls/);
});

test('untrusted or unsupported visual targets stop planning before any payment',async()=>{
  const crypto=require('node:crypto');
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHdsAAAAASUVORK5CYII=','base64');
  const imageHash=crypto.createHash('sha256').update(bytes).digest('hex');
  const build={...BUILD,concept:{status:'ready',source:'ai_generated',isGameplay:false,imageHash,bytes:bytes.length,contentType:'image/png',generatedAt:1000}};
  const reference={bytes,contentType:'image/png'};
  const unsupported=harness({build,reference});await assert.rejects(unsupported.run(),/cannot read/);assert.equal(unsupported.reservations.length,0);
  const changed=harness({model:{...MODEL,architecture:{input_modalities:['image'],output_modalities:['text']}},build:{...build,concept:{...build.concept,imageHash:'0'.repeat(64)}},reference});
  await assert.rejects(changed.run(),/does not match/);assert.equal(changed.reservations.length,0);assert.equal(changed.calls.length,0);
});

test('art-direction planning keeps historical compact scope as data and preserves bounded supported geometry',async()=>{
  const previousDesign={template:'racing',summary:'A compact 24 to 30 part rooftop course',design:structuredClone(DESIGN)};
  const build={...BUILD,brief:'Rework the race as a coherent lunar outpost with a distinct start, middle and finish',previousDesign};
  const before=JSON.stringify(build);
  const plan=createTemplatePlan('racing');
  plan.parts.push({id:'landmark',name:'Lunar antenna cap',position:[30,12,-70],size:[7,10,7],color:[60,92,109],material:'Metal',behavior:'decoration',value:1,shape:'Cylinder',rotation:[0,30,0]});
  plan.presentation={lighting:{clockTime:17.5,brightness:2,ambient:[112,132,155]}};
  plan.design.inspiration='Genre pacing; cool lunar metal, cyan route accents, grouped solar arrays and a tall antenna silhouette';
  plan.design.acceptanceCriteria.push('From spawn, identify the first gate and the antenna without the HUD hiding the landing','At a small viewport, inspect the final gate label and finish contrast against the backdrop');
  const h=harness({build,respond:()=>Response.json({choices:[{message:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{cost:.0005}})});
  const result=await h.run(),request=h.calls[0].body,prompt=request.messages[0].content;
  assert.deepEqual(result,plan);assert.equal(JSON.stringify(build),before);
  assert.deepEqual(JSON.parse(request.messages[1].content).previousDesign,previousDesign);
  assert.equal(request.max_tokens,6000);assert.equal(h.calls.length,1);
  assert.match(prompt,/within 3–180 parts/);
  assert.match(prompt,/Preserve the intended game loop, source scripts/);
  assert.match(prompt,/recognizable silhouettes/);
  assert.match(prompt,/Include6–8 acceptanceCriteria/);
  assert.match(prompt,/Custom client scripts may add original interactive menus/);
  assert.match(prompt,/These are pending tests, never results/);
});

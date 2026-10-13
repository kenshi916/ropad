'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRobloxPublishingService,createCreatorCredentialResolver}=require('./parallax/roblox-publishing.cjs');
function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-publication-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const buildId=crypto.randomUUID(),owner='fixture-owner',projectId=crypto.randomUUID();let content='<roblox version="4"><Item class="Folder"><Properties/></Item></roblox>',clock=1000;
  const builds={get:(id,{owner:viewer}={})=>{if(id!==buildId)throw Error('Build not found');return {id,gameName:'Skyline Circuit',lineage:{projectId},canManage:viewer===owner,readiness:{readyForCreatorPublish:options.ready!==false}};},artifact:({id,format})=>{assert.equal(id,buildId);assert.equal(format,'rbxlx');return {content};}};
  const calls=[],targets={[projectId]:{owner,placeId:'12345',universeId:'67890'}},config={stateDirectory:directory,key:'FAKE_TEST_PUBLISHING_SECRET',targets,getBuilds:()=>builds,now:()=>clock,fetcher:async(url,init)=>{
    calls.push({url,init});assert.equal(init.headers['x-api-key'],'FAKE_TEST_PUBLISHING_SECRET');assert.equal(init.headers['Content-Type'],'application/xml');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
    const row=JSON.parse(fs.readFileSync(path.join(directory,'roblox-publications.json'))).rows.at(-1);assert.equal(row.status,'uploading');
    if(options.networkError)throw Error('FAKE_TEST_PUBLISHING_SECRET remote error');return {ok:options.httpStatus?options.httpStatus<400:true,status:options.httpStatus||200,json:async()=>{if(options.badJson)throw Error('secret response');return {versionNumber:options.version??3};}};
  }};
  return {directory,buildId,projectId,owner,options,targets,config,service:createRobloxPublishingService(config),calls,setContent:v=>content=v,expire:()=>clock+=16*60*1000};
}
test('publication requires exact creator, an operator-authorized existing place, and release review',async t=>{
  const f=fixture(t);await assert.rejects(f.service.prepare({buildId:f.buildId,owner:'other'}),/creator/);assert.throws(()=>f.service.status({buildId:f.buildId,owner:'other'}),/creator/);
  f.targets[f.projectId].owner='other';await assert.rejects(f.service.prepare({buildId:f.buildId,owner:f.owner}),/authorized Roblox place/);f.targets[f.projectId].owner=f.owner;
  f.options.ready=false;await assert.rejects(f.service.prepare({buildId:f.buildId,owner:f.owner}),/playtest and creator release review/);assert.equal(f.calls.length,0);
});
test('a reviewed artifact publishes the exact bytes to the authorized place once and returns no secret or invented public accessibility',async t=>{
  const f=fixture(t),p=await f.service.prepare({buildId:f.buildId,owner:f.owner});assert.equal(f.calls.length,0);const same=await f.service.prepare({buildId:f.buildId,owner:f.owner});assert.equal(same.id,p.id);
  const args={buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash},done=await f.service.publish(args);assert.equal(done.status,'published');assert.equal(done.versionNumber,3);assert.equal(done.publicAccessVerified,false);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://apis.roblox.com/universes/v1/67890/places/12345/versions?versionType=Published');assert.equal(crypto.createHash('sha256').update(f.calls[0].init.body).digest('hex'),p.artifactHash);
  assert.equal((await f.service.publish(args)).versionNumber,3);assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify([done,f.service.config(),f.service.status({buildId:f.buildId,owner:f.owner})]),/FAKE_TEST_PUBLISHING_SECRET/);
  const restarted=createRobloxPublishingService(f.config);assert.equal((await restarted.publish(args)).versionNumber,3);assert.equal(f.calls.length,1);
});
test('artifact or authorization changes after review prevent uploads',async t=>{
  const f=fixture(t),p=await f.service.prepare({buildId:f.buildId,owner:f.owner}),args={buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash};
  await assert.rejects(f.service.publish({...args,owner:'other'}),/creator/);await assert.rejects(f.service.publish({...args,artifactHash:'0'.repeat(64)}),/project changed/);
  f.targets[f.projectId].placeId='98765';await assert.rejects(f.service.publish(args),/permissions or release review changed/);f.targets[f.projectId].placeId='12345';f.setContent('<roblox version="4"><Item class="Part"/></roblox>');await assert.rejects(f.service.publish(args),/project changed/);assert.equal(f.calls.length,0);
});
test('expired review can be replaced, while an expired intent cannot publish',async t=>{const f=fixture(t),p=await f.service.prepare({buildId:f.buildId,owner:f.owner});f.expire();await assert.rejects(f.service.publish({buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash}),/fresh publication/);const fresh=await f.service.prepare({buildId:f.buildId,owner:f.owner});assert.notEqual(fresh.id,p.id);assert.equal(f.calls.length,0);});
test('ambiguous upload outcome survives restart and blocks another version or prepared intent for that place',async t=>{
  const f=fixture(t,{networkError:true}),p=await f.service.prepare({buildId:f.buildId,owner:f.owner});f.setContent('<roblox version="4"><Item class="Part"/></roblox>');const next=await f.service.prepare({buildId:f.buildId,owner:f.owner});
  const args={buildId:f.buildId,owner:f.owner,intentId:next.id,artifactHash:next.artifactHash};await assert.rejects(f.service.publish(args),error=>/outcome unknown/.test(error.message)&&!error.message.includes('FAKE_TEST_PUBLISHING_SECRET'));
  assert.equal(f.service.status({buildId:f.buildId,owner:f.owner}).publications.at(-1).status,'uploading');f.options.networkError=false;const restarted=createRobloxPublishingService(f.config);await assert.rejects(restarted.publish(args),/outcome is unknown/);await assert.rejects(restarted.publish({...args,intentId:p.id,artifactHash:p.artifactHash}),/earlier upload outcome is unknown/);await assert.rejects(restarted.prepare({buildId:f.buildId,owner:f.owner}),/earlier upload outcome is unknown/);assert.equal(f.calls.length,1);
});
test('invalid success responses and ambiguous HTTP failures remain pending; definite rejection may be reviewed again',async t=>{
  for(const options of [{badJson:true},{version:0},{httpStatus:500},{httpStatus:408},{httpStatus:403}])await t.test(JSON.stringify(options),async t=>{const f=fixture(t,options),p=await f.service.prepare({buildId:f.buildId,owner:f.owner});await assert.rejects(f.service.publish({buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash}));assert.equal(f.service.status({buildId:f.buildId,owner:f.owner}).publications[0].status,options.httpStatus===403?'failed':'uploading');assert.equal(f.calls.length,1);});
});
test('journal changes/corruption prevent upload and never overwrite the damaged evidence',async t=>{
  for(const damage of ['corrupt','remove','valid-change'])await t.test(damage,async t=>{const f=fixture(t),p=await f.service.prepare({buildId:f.buildId,owner:f.owner}),file=path.join(f.directory,'roblox-publications.json');let bytes;if(damage==='remove')fs.unlinkSync(file);else{bytes=damage==='corrupt'?'{damaged':JSON.stringify({...JSON.parse(fs.readFileSync(file)),externalChange:true});fs.writeFileSync(file,bytes);}await assert.rejects(f.service.publish({buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash}),/journal changed/);assert.equal(f.calls.length,0);if(damage!=='remove')assert.equal(fs.readFileSync(file,'utf8'),bytes);else assert.equal(fs.existsSync(file),false);});
});
test('two creator projects cannot overwrite the same Roblox place, including configuration changed after review',async t=>{
  const f=fixture(t),p=await f.service.prepare({buildId:f.buildId,owner:f.owner});
  f.targets['another-project']={owner:'another-creator',placeId:12345,universeId:'67890'};
  assert.equal(f.service.config({buildId:f.buildId,owner:f.owner}).connected,false);
  await assert.rejects(f.service.prepare({buildId:f.buildId,owner:f.owner}),/assigned to multiple creator projects/);
  await assert.rejects(f.service.publish({buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash}),/assigned to multiple creator projects/);
  assert.equal(f.calls.length,0);assert.equal(f.service.status({buildId:f.buildId,owner:f.owner}).publications[0].status,'prepared');
  f.targets['another-project'].placeId='54321';
  assert.equal((await f.service.publish({buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash})).status,'published');
});
test('Open Cloud review refuses authored instances that require Studio publishing without uploading or saving an incomplete intent',async t=>{
  for(const className of ['EditableImage','EditableMesh','PartOperation','UnionOperation','NegateOperation','IntersectOperation','SurfaceAppearance','BaseWrap','WrapLayer','WrapTarget'])await t.test(className,async t=>{
    const f=fixture(t);f.setContent(`<roblox version="4"><Item class="${className}"><Properties/></Item></roblox>`);
    await assert.rejects(f.service.prepare({buildId:f.buildId,owner:f.owner}),error=>error.status===409&&error.message.includes('from Roblox Studio')&&error.message.includes(className));
    assert.equal(f.calls.length,0);assert.equal(f.service.status({buildId:f.buildId,owner:f.owner}).publications.length,0);
  });
});
test('XML comments and script CDATA mentioning instance names do not prevent normal publishing',async t=>{
  const f=fixture(t);f.setContent(`<roblox version="4"><!-- <Item class="SurfaceAppearance"/> --><Item class="Script"><Properties><ProtectedString name="Source"><![CDATA[local example = '<Item class="EditableMesh"/>' ]]></ProtectedString></Properties></Item></roblox>`);
  const p=await f.service.prepare({buildId:f.buildId,owner:f.owner});
  assert.equal((await f.service.publish({buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash})).status,'published');assert.equal(f.calls.length,1);
});
test('creator-scoped credentials publish only their bound project and never appear in public config or the journal',async t=>{
  const f=fixture(t),a={owner:'creator-a',projectId:crypto.randomUUID(),buildId:crypto.randomUUID(),placeId:'11',universeId:'21'},b={owner:'creator-b',projectId:crypto.randomUUID(),buildId:crypto.randomUUID(),placeId:'12',universeId:'22'};
  const targets={[a.projectId]:{...a,credentialEnv:'ROPAD_ROBLOX_CREATOR_A_KEY'},[b.projectId]:{...b,credentialEnv:'ROPAD_ROBLOX_CREATOR_B_KEY'}},env={ROPAD_ROBLOX_CREATOR_A_KEY:'FAKE_CREATOR_A_SECRET',ROPAD_ROBLOX_CREATOR_B_KEY:'FAKE_CREATOR_B_SECRET'};
  const calls=[],getBuilds=()=>({get(id,{owner}){const p=[a,b].find(p=>p.buildId===id);assert.ok(p);return {id,gameName:'Creator game',canManage:p.owner===owner,lineage:{projectId:p.projectId},readiness:{readyForCreatorPublish:true}};},artifact:()=>({content:'<roblox version="4"><Item class="Folder"/></roblox>'})});
  const service=createRobloxPublishingService({stateDirectory:f.directory,targets,getBuilds,key:'NEVER_USE_GLOBAL_FALLBACK',resolveCredential:createCreatorCredentialResolver({targets,env}),fetcher:async(url,init)=>{calls.push({url,key:init.headers['x-api-key']});return {ok:true,json:async()=>({versionNumber:1})};}});
  for(const p of [a,b]){const intent=await service.prepare({buildId:p.buildId,owner:p.owner});await service.publish({buildId:p.buildId,owner:p.owner,intentId:intent.id,artifactHash:intent.artifactHash});const config=service.config({buildId:p.buildId,owner:p.owner});assert.equal(config.configured,true);assert.equal(config.credentialMode,'creator_scoped');assert.doesNotMatch(JSON.stringify(config),/SECRET|credentialEnv|ROPAD_ROBLOX_CREATOR|FALLBACK/);}
  assert.deepEqual(calls,[{url:'https://apis.roblox.com/universes/v1/21/places/11/versions?versionType=Published',key:env.ROPAD_ROBLOX_CREATOR_A_KEY},{url:'https://apis.roblox.com/universes/v1/22/places/12/versions?versionType=Published',key:env.ROPAD_ROBLOX_CREATOR_B_KEY}]);
  assert.doesNotMatch(fs.readFileSync(path.join(f.directory,'roblox-publications.json'),'utf8'),/SECRET|credentialEnv|ROPAD_ROBLOX_CREATOR|FALLBACK/);
});
test('resolver binding mismatches or missing creator credentials never use the legacy key',async t=>{
  for(const change of [()=>null,c=>({...c,owner:'other'}),c=>({...c,projectId:'other'}),c=>({...c,placeId:'999'}),c=>({...c,universeId:'999'}),()=>{throw Error('DO_NOT_LEAK_SECRET');}])await t.test(String(change),async t=>{
    const f=fixture(t),service=createRobloxPublishingService({...f.config,resolveCredential:c=>{const result=change(c);return result&&{...result,key:'DO_NOT_LEAK_SECRET'};}});
    assert.equal(service.config({buildId:f.buildId,owner:f.owner}).configured,false);
    await assert.rejects(service.prepare({buildId:f.buildId,owner:f.owner}),error=>error.status===503&&!error.message.includes('DO_NOT_LEAK_SECRET'));
    assert.equal(f.calls.length,0);
  });
});
test('creator credential revocation after review stops the upload and preserves its prepared intent',async t=>{
  const f=fixture(t);let available=true;
  const service=createRobloxPublishingService({...f.config,resolveCredential:c=>available?{...c,key:f.config.key}:null}),p=await service.prepare({buildId:f.buildId,owner:f.owner});available=false;
  await assert.rejects(service.publish({buildId:f.buildId,owner:f.owner,intentId:p.id,artifactHash:p.artifactHash}),/scoped Roblox publishing credential/);
  assert.equal(f.calls.length,0);assert.equal(service.status({buildId:f.buildId,owner:f.owner}).publications[0].status,'prepared');
});
test('environment resolver requires an exact operator grant and refuses shared credentials between creators',()=>{
  const c={owner:'creator-a',projectId:'a',placeId:'11',universeId:'21'},targets={a:{...c,credentialEnv:'ROPAD_ROBLOX_CREATOR_A_KEY'},b:{owner:'creator-b',placeId:'12',universeId:'22',credentialEnv:'ROPAD_ROBLOX_CREATOR_B_KEY'}},env={ROPAD_ROBLOX_CREATOR_A_KEY:'FAKE_A',ROPAD_ROBLOX_CREATOR_B_KEY:'FAKE_B'},resolve=createCreatorCredentialResolver({targets,env});
  assert.equal(resolve(c).key,'FAKE_A');assert.equal(resolve({...c,owner:'creator-b'}),null);assert.equal(resolve({...c,placeId:'12'}),null);
  env.ROPAD_ROBLOX_CREATOR_B_KEY='FAKE_A';assert.throws(()=>resolve(c),/Separate scoped/);env.ROPAD_ROBLOX_CREATOR_B_KEY='FAKE_B';
  targets.b.credentialEnv=targets.a.credentialEnv;assert.throws(()=>resolve(c),/Separate scoped/);
  targets.a.credentialEnv='OPENROUTER_API_KEY';assert.equal(resolve(c),null);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync}=require('node:child_process');
const {createRobloxBuildService,createTemplatePlan,GAMEPLAY_SOURCE}=require('./parallax/roblox-builds.cjs');
const decode = value => value.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
function fixture(t,template='obby',plan) {
 const stateDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'parallax-export-'));t.after(()=>fs.rmSync(stateDirectory,{recursive:true,force:true}));
 const service=createRobloxBuildService({stateDirectory});
 const b=service.create({owner:'export-owner',gameName:'Export <game> & friends',brief:'Make a simple starter scene',template});
 service.prepare({id:b.id,owner:'export-owner',plan});return {service,b:service.get(b.id)};
}
test('rbxlx deliveries contain a complete generated scene for every supported template',t=>{
 for(const template of ['obby','tycoon','racing']) {
  const {service,b}=fixture(t,template);const artifact=service.artifact({id:b.id,format:'rbxlx'});
  assert.match(artifact.filename,/\.rbxlx$/);assert.equal(artifact.contentType,'application/xml; charset=utf-8');
  const xml=artifact.content;assert.ok(xml.startsWith('<roblox version="4">'));assert.ok(xml.endsWith('</roblox>'));
  assert.equal((xml.match(/<Item class="(?:Part|SpawnLocation)"/g)||[]).length,b.plan.parts.length);
  assert.equal((xml.match(/<Item class="SpawnLocation"/g)||[]).length,1);
  assert.equal((xml.match(/<Item class="Script"/g)||[]).length,1);
  assert.equal((xml.match(/<Item class="ObjectValue"/g)||[]).length,b.plan.parts.length);
  const referents=[...xml.matchAll(/<Item class="[^"]+" referent="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(referents).size,referents.length);
  for(const [,ref] of xml.matchAll(/<Ref name="Value">([^<]+)<\/Ref>/g)) assert.ok(referents.includes(ref));
  assert.match(xml,/<bool name="Neutral">true<\/bool>/);assert.match(xml,/<int name="Duration">0<\/int>/);
  assert.match(xml,/<bool name="AllowTeamChangeOnTouch">false<\/bool>/);
  assert.match(xml,/<token name="Material">272<\/token>/);
  assert.equal(b.delivery.available,true);assert.equal(b.delivery.kind,'generated_project');assert.equal(b.delivery.studioSaved,false);assert.equal(b.delivery.playtested,false);
  assert.equal(b.files.find(file=>file.name==='game.rbxlx').url,b.delivery.url);
 }
});
test('XML escapes hostile names while preserving fixed script and exact bindings',t=>{
 const plan=createTemplatePlan('obby');plan.parts[0].name='A <tag> & "quote" \'test\' 🦊';plan.parts[1].name=plan.parts[0].name;
 const {service,b}=fixture(t,'obby',plan);const xml=service.artifact({id:b.id,format:'rbxlx'}).content;
 assert.match(xml,/A &lt;tag&gt; &amp; &quot;quote&quot; &apos;test&apos; 🦊/);
 assert.equal(xml.includes('<tag>'),false);
 const source=decode(xml.match(/<ProtectedString name="Source">([\s\S]*?)<\/ProtectedString>/)[1]);
 assert.ok(source.endsWith(GAMEPLAY_SOURCE));assert.ok(source.indexOf('part:SetAttribute("Behavior"')<source.indexOf('local Players ='));
 assert.match(source,/binding and binding.Value/);assert.match(source,/SetAttribute\("Template", "obby"\)/);
 assert.doesNotMatch(xml,/AttributesSerialize/);assert.doesNotMatch(source,/loadstring|HttpGet|require\(|InsertService|MarketplaceService/);
});
test('place export requires a prepared plan and never includes worker credentials',t=>{
 const {service,b}=fixture(t);const token=service.issueWorkerToken({id:b.id,owner:'export-owner'});
 const xml=service.artifact({id:b.id,format:'rbxlx'}).content;assert.equal(xml.includes(token.workerToken),false);assert.equal(xml.includes('export-owner'),false);
 assert.throws(()=>service.artifact({id:b.id,owner:'other-owner',format:'rbxlx'}),/belongs/);
 const unprepared=service.create({owner:'export-owner',gameName:'Unprepared',brief:'A future course'});
 assert.equal(unprepared.delivery.available,false);assert.equal(unprepared.delivery.url,null);
 assert.throws(()=>service.artifact({id:unprepared.id,format:'rbxlx'}),/Prepare this build first/);
});
test('XML place output is deterministic and remains downloadable if Studio worker is unavailable',t=>{
 const {service,b}=fixture(t);service.workerPresence({workerId:'unavailable-worker',studioId:'studio-1',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true});service.enqueue({id:b.id,owner:'export-owner'});
 const before=service.artifact({id:b.id,format:'rbxlx'}).content;
 const lease=service.claim({workerId:'unavailable-worker',studioId:'studio-1'});
 service.report({...lease,status:'failed',message:'No Studio connection'});
 assert.equal(service.artifact({id:b.id,format:'rbxlx'}).content,before);
 assert.equal(service.get(b.id).delivery.available,true);
});

test('fixed Luau gameplay exposes elapsed time, session best, replay and checkpoint recovery through the real script',t=>{
 const executable=process.env.ROPAD_LUAU_BIN||path.join(__dirname,'qa-luau-0.741','luau.exe');
 if(!fs.existsSync(executable)){t.skip('Set ROPAD_LUAU_BIN to the official Luau CLI to execute the offline gameplay fixture');return;}
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-luau-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const harness=fs.readFileSync(path.join(__dirname,'fixtures','fixed-gameplay-harness.luau'),'utf8');
 const file=path.join(temporary,'gameplay-test.luau');fs.writeFileSync(file,harness.replace('-- FIXED_GAMEPLAY_SOURCE',GAMEPLAY_SOURCE));
 const run=spawnSync(executable,[file],{encoding:'utf8',timeout:10_000,windowsHide:true});
 assert.ifError(run.error);assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
 assert.match(run.stdout,/timing, replay, best-time, death and cleanup checks passed/);
});

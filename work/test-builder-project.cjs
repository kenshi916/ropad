'use strict';
// Offline fixtures only: no credentials, provider calls, wallet operations or
// live Studio mutation. Executed Luau checks are not real Roblox playtests.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {createRobloxBuildService,createTemplatePlan,validatePlan}=require('./parallax/roblox-builds.cjs');
const {validateSource,componentParts,projectScripts,manifest}=require('./parallax/builder-project.cjs');
const {gameplaySource,initSource,guardSource,validateBaseUrl,workerPresencePayload,executeJob}=require('./parallax/studio-worker.cjs');
const {generateBuildPlan}=require('./parallax/builder-ai.cjs');
const lua=v=>typeof v==='string'?JSON.stringify(v):typeof v==='number'?String(v):Array.isArray(v)?'{'+v.map(lua).join(',')+'}':'{'+Object.entries(v).map(([k,x])=>'['+lua(k)+']='+lua(x)).join(',')+'}';
const DESIGN={coreLoop:'Traverse the gardens and trigger a reward',objective:'Reach all gates and finish',progression:'Increasing route complexity',inspiration:'Original skyline garden',limitations:['Session-only progress','Real playtest and publication pending'],unsupportedFeatures:[],acceptanceCriteria:['Spawn safely','Traverse all gates','Respawn and replay','Cross finish','Click the instructions button','Check small-screen labels']};
function plan(){const p=createTemplatePlan('racing');p.version=2;p.design=structuredClone(DESIGN);p.project={version:1,scripts:[{id:'RewardSystem',target:'server',source:'local reward = root:FindFirstChild("Reward")\nassert(reward)\nreward.Activated:Connect(function() root:SetAttribute("RewardCount", (root:GetAttribute("RewardCount") or 0) + 1) end)'},{id:'Instructions',target:'client',source:'local player = game:GetService("Players").LocalPlayer\nlocal gui = Instance.new("ScreenGui"); gui.Name = root.Name .. "Instructions"; gui.Parent = player:WaitForChild("PlayerGui")\nlocal button = Instance.new("TextButton"); button.Text = "How to play"; button.Size = UDim2.fromOffset(160,44); button.Parent = gui\nbutton.Activated:Connect(function() button.Text = "Follow the numbered gates" end)'}],components:{hud:{title:'Sky Garden',accent:[123,250,202],panel:[12,20,34]},environment:[{id:'Tower',kind:'building',position:[50,0,0],size:[24,25,20],color:[36,48,60],accent:[115,210,200]},{id:'Canopy',kind:'tree',position:[55,20,2],size:[6,8,6],color:[57,126,90],accent:[98,181,121]}]}};return validatePlan(p);}
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-project-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const service=createRobloxBuildService({stateDirectory:directory});const b=service.create({owner:'creator',gameName:'Sky Garden',brief:'An original rooftop garden game with clickable instructions and rewards',template:'auto',modelId:'anthropic/claude-opus-5.5'});service.prepare({id:b.id,owner:'creator',plan:plan(),source:'ai'});return {service,b:service.get(b.id,{owner:'creator'}),directory};}
const capability={agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1,projectProtocol:1};
test('scene-v2 validates and round-trips real scripts plus deterministic composed art',()=>{
 const p=plan();assert.deepEqual(validatePlan(p),p);const parts=componentParts(p.project);assert.ok(parts.length>40);assert.ok(parts.every(x=>x.behavior==='decoration'));assert.equal(new Set(parts.map(x=>x.id)).size,parts.length);assert.deepEqual(componentParts(p.project),parts);
 for(const change of [p=>p.version=1,p=>p.project.scripts[1].id=p.project.scripts[0].id,p=>p.project.scripts[0].target='editor',p=>p.project.scripts[0].source='x'.repeat(24001),p=>p.project.components.environment[0].size=[0,1,1]]){const copy=plan();change(copy);assert.throws(()=>validatePlan(copy));}
});
test('default script contract rejects risky APIs and makes no sandbox claim',()=>{
 for(const source of ['require(123)','loadstring("return 1")','game:GetService("HttpService")','game:GetService("DataStoreService")','game:GetService("MarketplaceService")','game:GetService("ScriptEditorService")','print("https://example.com")','getfenv()'])assert.throws(()=>validateSource(source),/cannot access/);
 assert.equal(manifest({plan:plan()}).sandboxed,false);
 assert.equal(validateSource('local part = Instance.new("Part"); part.Parent = root'),'local part = Instance.new("Part"); part.Parent = root');
});
test('exports include the same actual server/client sources, polished HUD and composed geometry',t=>{
 const {service,b}=fixture(t);const xml=service.artifact({id:b.id,format:'rbxlx'}).content,luau=service.artifact({id:b.id,format:'luau'}).content;
 const unescape=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
 const sources=[...xml.matchAll(/<ProtectedString name="Source">([\s\S]*?)<\/ProtectedString>/g)].map(m=>unescape(m[1]));
 for(const source of projectScripts(b,lua))assert.ok(sources.includes(source.source),'missing '+source.id);
 assert.equal((xml.match(/<Item class="LocalScript"/g)||[]).length,2);
 assert.equal((xml.match(/<Item class="(?:Part|SpawnLocation)"/g)||[]).length,b.plan.parts.length+componentParts(b.plan.project).length);
 assert.match(xml,/<bool name="HttpEnabled">false/);assert.match(xml,/<bool name="LoadStringEnabled">false/);
 assert.match(luau,/RopadArt/);assert.match(luau,/RewardCount/);assert.match(luau,/RopadPresentation/);
 assert.equal(b.delivery.includesProjectSource,true);assert.equal(b.project.scriptCount,2);assert.equal(b.delivery.playtested,false);
 assert.equal(service.artifact({id:b.id,format:'rbxlx'}).content,xml);
});
test('owner code saves create immutable, idempotent versions with stale-file and ownership protection',t=>{
 const {service,b}=fixture(t),before=service.artifact({id:b.id,format:'json'}).content;
 const request={id:b.id,owner:'creator',fileId:'RewardSystem',target:'server',source:'root:SetAttribute("RewardCount", 2)',expectedHash:b.project.sourceHash,idempotencyKey:'edit-reward-001'};
 assert.throws(()=>service.projectFiles({id:b.id,owner:'other'}),/belongs/);
 assert.throws(()=>service.updateProjectFile({...request,owner:'other'}),/belongs/);
 assert.throws(()=>service.updateProjectFile({...request,expectedHash:'0'.repeat(64)}),/changed/);
 const next=service.updateProjectFile(request);assert.notEqual(next.id,b.id);assert.equal(next.lineage.projectId,b.id);assert.equal(next.lineage.parentBuildId,b.id);assert.equal(next.planSource,'creator_revision');assert.equal(next.status,'waiting_for_studio');assert.equal(next.playtestReport,undefined);
 assert.equal(service.updateProjectFile(request).id,next.id);
 assert.throws(()=>service.updateProjectFile({...request,source:'print("different")'}),/different code/);
 assert.equal(service.artifact({id:b.id,format:'json'}).content,before);assert.equal(service.projectFiles({id:next.id,owner:'creator'}).files[0].source,request.source);
});
test('v2 jobs require a project worker and carry complete source without trusting loose artifact fields',t=>{
 const {service,b}=fixture(t);service.workerPresence({workerId:'old',studioId:'old-studio',...capability,projectProtocol:undefined});assert.equal(service.canAutoEnqueue(b.id).eligible,false);
 service.workerPresence({workerId:'new',studioId:'new-studio',...capability});service.enqueue({id:b.id,owner:'creator'});assert.equal(service.claim({workerId:'old',studioId:'old-studio'}),null);
 const job=service.claim({workerId:'new',studioId:'new-studio'});assert.deepEqual(job.plan.project,b.plan.project);assert.equal(job.projectId,b.id);assert.equal(job.artifactLuau,undefined);
 const source=gameplaySource(job,'worker-run');assert.match(source,/RewardCount/);assert.match(source,/StarterPlayerScripts/);assert.match(initSource(job,{runId:'worker-run'}),/HttpEnabled = false/);
});
test('reusable workers are pinned to one project lineage and cannot claim another creator game',t=>{
 const {service,b}=fixture(t);service.workerPresence({workerId:'reuse',studioId:'revision-studio',...capability,oneBuildPerStudio:false,revisionReuseProtocol:1});service.enqueue({id:b.id,owner:'creator'});const job=service.claim({workerId:'reuse',studioId:'revision-studio'});service.report({...job,status:'ready',objectCount:b.plan.parts.length+1,playtest:{result:'passed',message:'Initialization fixture only'}});
 const other=service.create({owner:'different-creator',gameName:'Other',brief:'Another creator game',template:'auto'});service.prepare({id:other.id,owner:'different-creator',plan:plan(),source:'ai'});assert.equal(service.canAutoEnqueue(other.id).eligible,false);
 const next=service.updateProjectFile({id:b.id,owner:'creator',fileId:'RewardSystem',target:'server',source:'root:SetAttribute("Revision",2)',expectedHash:b.project.sourceHash,idempotencyKey:'edit-reuse-001'});assert.equal(service.canAutoEnqueue(next.id).eligible,true);service.enqueue({id:next.id,owner:'creator'});assert.equal(service.claim({workerId:'reuse',studioId:'revision-studio'}).buildId,next.id);
});
test('HTTPS deployed worker origin is explicit and credentials never appear in URLs',()=>{
 assert.equal(validateBaseUrl('https://ropad.fun/'),'https://ropad.fun');assert.equal(validateBaseUrl('https://www.ropad.fun'),'https://www.ropad.fun');
 for(const value of ['http://ropad.fun','https://ropad.fun.attacker.test','https://ropad.fun:8443','https://user:secret@ropad.fun','https://ropad.fun/path'])assert.throws(()=>validateBaseUrl(value));
 assert.equal(workerPresencePayload({workerId:'w',studioId:'s',reuseRevisions:true}).revisionReuseProtocol,1);
});
const executable=path.join(__dirname,'qa-luau-0.741','luau.exe'),compiler=path.join(__dirname,'qa-luau-0.741','luau-compile.exe');
test('installed project scripts and HUD compile as Luau, and the custom reward callback executes', {skip:!fs.existsSync(compiler)||!fs.existsSync(executable)},t=>{
 const {service,b,directory}=fixture(t),scripts=projectScripts(b,lua);
 for(const s of scripts){const file=path.join(directory,s.id+'.luau');fs.writeFileSync(file,s.source);const result=spawnSync(compiler,[file],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0,result.stderr);}
 const server=scripts.find(s=>s.target==='server').source;
 const harness=`local attributes={ParallaxJob=${lua(b.jobId)}}\nlocal handler\nlocal reward={Activated={Connect=function(_,callback) handler=callback end}}\nlocal scene={}\nfunction scene:GetAttribute(k)return attributes[k]end\nfunction scene:SetAttribute(k,v)attributes[k]=v end\nfunction scene:FindFirstChild(k)if k=="Reward" then return reward end end\nworkspace={WaitForChild=function()return scene end}\nscript={SetAttribute=function()end}\n${server}\nassert(attributes.RewardCount==nil)\nhandler();handler()\nassert(attributes.RewardCount==2)\nprint("Custom project callback executed twice")`;
 const file=path.join(directory,'reward-test.luau');fs.writeFileSync(file,harness);const result=spawnSync(executable,[file],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/executed twice/);
 const installer=path.join(directory,'install.luau');fs.writeFileSync(installer,service.artifact({id:b.id,format:'luau'}).content);assert.equal(spawnSync(compiler,[installer],{encoding:'utf8',timeout:10000,windowsHide:true}).status,0);
});
test('new paid-plan estimates cover serialized prior source and require an explicit higher operator allowance',async()=>{
 const model={id:'anthropic/claude-opus-5.5',architecture:{output_modalities:['text']},pricing:{prompt:'0.00001',completion:'0.00005'}};
 let calls=0,reserved=0;const args={build:{gameName:'Sky Garden',brief:'Improve the complete project',previousDesign:{project:plan().project}},modelId:model.id,getModels:async()=>[model],inference:{name:'fixture',key:'fixture',completionsUrl:'https://fixture.invalid',reserveMultiplier:1,buildOutputTokens:16000},reserve:amount=>{reserved=amount;return()=>{}},settle:()=>{},fetcher:async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan())}}],usage:{cost:.03}})}};
 await assert.rejects(generateBuildPlan(args),/allowance/);assert.equal(calls,0);
 const result=await generateBuildPlan({...args,inference:{...args.inference,buildPlanMaxEstimateUsd:2}});assert.equal(result.version,2);assert.equal(calls,1);assert.ok(reserved>.88);
});
test('executed revision installer preserves edited prior root and client source, and rejects changed ownership', {skip:!fs.existsSync(executable)},t=>{
 const {b,directory}=fixture(t),previous={rootName:'Parallax_'+ 'a'.repeat(32),jobId:'previous-job',runId:'worker-run',projectId:b.id,clientScripts:['PreviousClient']};
 const source=initSource({...b,plan:b.plan},{runId:'worker-run',previous});
 const harness=`
local function scenario(wrongOwner,unrelated)
 local function make(class,name)
  local data={ClassName=class,Name=name or class,children={},attrs={},Enabled=true}
  local methods={}
  function methods:IsA(kind)return data.ClassName==kind or kind=="BaseScript" and (data.ClassName=="Script" or data.ClassName=="LocalScript")end
  function methods:GetChildren()return table.clone(data.children)end
  function methods:GetDescendants()local out={};for _,c in ipairs(data.children)do table.insert(out,c);for _,d in ipairs(c:GetDescendants())do table.insert(out,d)end end;return out end
  function methods:FindFirstChild(n)for _,c in ipairs(data.children)do if c.Name==n then return c end end end
  function methods:GetAttribute(k)return data.attrs[k]end
  function methods:SetAttribute(k,v)data.attrs[k]=v end
  local item=setmetatable({}, {__index=function(_,k)if methods[k] then return methods[k] end;if data[k]~=nil then return data[k] end;return methods.FindFirstChild(nil,k)end,__newindex=function(self,k,v)
   if k=="Parent" then if data.Parent then for i,c in ipairs(data.Parent.children)do if c==self then table.remove(data.Parent.children,i);break end end end;if v then table.insert(v.children,self)end end;data[k]=v
  end})
  return item
 end
 workspace=make("Workspace","Workspace")
 local terrain=make("Terrain","Terrain");terrain.CountCells=function()return 0 end;terrain.Parent=workspace
 local old=make("Folder",${lua(previous.rootName)});old:SetAttribute("ParallaxJob","previous-job");old:SetAttribute("ParallaxWorker",wrongOwner and "someone-else" or "worker-run");old.Parent=workspace
 local edited=make("Part","Creator edit");edited.Position={500,10,0};edited.Parent=old
 local code=make("Script","ParallaxGameplay");code.Source="creator source retained";code.Parent=old
 local services={}
 for _,n in ipairs({"ReplicatedFirst","ReplicatedStorage","ServerScriptService","StarterGui","StarterPack","ServerStorage","StarterPlayer","Lighting","HttpService"})do services[n]=make(n,n)end
 services.RunService={IsEdit=function()return true end}
 services.Lighting.ClockTime=12;services.Lighting.Brightness=1;services.Lighting.Ambient={1,2,3}
 services.HttpService.JSONEncode=function()return "ok"end
 local starter=make("StarterPlayerScripts","StarterPlayerScripts");starter.Parent=services.StarterPlayer
 local client=make("LocalScript","PreviousClient");client:SetAttribute("ParallaxJob","previous-job");client.Source="original edited client";client.Parent=starter
 if unrelated then local other=make("Folder","Unrelated project");other.Parent=workspace end
 game={PlaceId=0,GameId=0,GetService=function(_,name)return services[name]end}
 Instance={new=make};Color3={fromRGB=function(...)return {...}end}
 local success,message=pcall(function()
${source}
 end)
 if wrongOwner or unrelated then
  assert(not success,"unsafe revision was accepted");assert(old.Parent==workspace and client.Parent==starter and code.Enabled,"preflight failure changed existing data")
 else
  assert(success,message)
  local archive=services.ServerStorage:FindFirstChild("RopadRevisionArchive")
  assert(archive and old.Parent.Name=="previous-job" and old.Parent.Parent==archive)
  assert(edited.Position[1]==500 and code.Source=="creator source retained" and not code.Enabled)
  assert(client.Source=="original edited client" and client.Parent==old.Parent and not client.Enabled)
  assert(workspace:FindFirstChild(${lua(b.rootName)}),"new version root was not created")
  assert(services.HttpService.HttpEnabled==false and services.ServerScriptService.LoadStringEnabled==false)
 end
end
scenario(false,false);scenario(true,false);scenario(false,true)
print("Owned revision archive preserves edits and rejects changed context")
`;
 const file=path.join(directory,'revision-archive-test.luau');fs.writeFileSync(file,harness);const result=spawnSync(executable,[file],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/preserves edits/);
});

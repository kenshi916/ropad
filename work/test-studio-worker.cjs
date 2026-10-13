'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const { StudioMcpClient, studioEnvironment, safeToolDiagnostic } = require('./parallax/studio-mcp-client.cjs');
const { parseArgs, validateBaseUrl, createPoolApi, workerPresencePayload, decodeToolJson, validateJob, executeJob, guardSource, initSource } = require('./parallax/studio-worker.cjs');
const { createTemplatePlan, GAMEPLAY_SOURCE } = require('./parallax/roblox-builds.cjs');

function fakeProcess(respond) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; };
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const result = respond(message);
      if (message.id != null && result !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'));
    }
  });
  return child;
}
test('MCP initializes, discovers tools, and sends explicit Studio targets over JSON lines', async t => {
  const messages = [];
  const child = fakeProcess(message => {
    messages.push(message);
    if (message.method === 'initialize') return { protocolVersion: '2025-03-26', capabilities: {} };
    if (message.method === 'tools/list') return { tools: [{ name: 'list_roblox_studios' }, { name: 'execute_luau' }] };
    if (message.method === 'tools/call') return { content: [{ type: 'text', text: '{"studios":[]}' }] };
  });
  const client = new StudioMcpClient({ process: child }); t.after(() => client.close());
  await client.initialize(); await client.call('execute_luau', { studio_id: 'studio-1', datamodel_type: 'Edit', code: 'return 1' });
  assert.equal(messages[1].method, 'notifications/initialized');
  assert.equal(messages.at(-1).params.arguments.studio_id, 'studio-1');
  await assert.rejects(client.call('unadvertised_tool', {}), /unavailable/);
});
test('MCP bounds responses, rejects invalid JSON, and terminates uncertain timed out requests', async () => {
  for (const mode of ['oversize', 'invalid', 'timeout']) {
    const child = fakeProcess(() => undefined);
    const client = new StudioMcpClient({ process: child, maxBytes: 300, timeoutMs: 10 });
    const request = client.request('test');
    if (mode === 'oversize') child.stdout.write('x'.repeat(301));
    if (mode === 'invalid') child.stdout.write('not-json\n');
    await assert.rejects(request, /size limit|invalid JSON|timed out/);
    assert.equal(child.killed, true); assert.equal(client.closed, true); assert.equal(client.pending.size, 0);
  }
});
test('Studio child environment excludes API credentials and worker tokens', () => {
  const env = studioEnvironment({ PATH: 'runtime', LOCALAPPDATA: 'roblox', PARALLAX_WORKER_KEY: 'private', OPENROUTER_API_KEY: 'private', RANDOM_SECRET: 'private' });
  assert.deepEqual(env, { PATH: 'runtime', LOCALAPPDATA: 'roblox' });
});
test('tool diagnostics remain useful without exposing credential-shaped values or local user paths', () => {
  const secret = 'b'.repeat(64);
  const result = safeToolDiagnostic({ content: [{ type: 'text', text: `ServerStorage contains existing assets; ${secret} Bearer private-token C:\\Users\\Private\\file.lua` }] });
  assert.match(result, /ServerStorage contains existing assets/);
  for (const value of [secret, 'private-token', 'Private', 'file.lua']) assert.equal(result.includes(value), false);
  assert.equal(result.length <= 280, true);
});
test('CLI requires an explicit allowlist of at most two distinct Studio IDs', () => {
  assert.equal(parseArgs(['--list'], {}).list, true);
  assert.deepEqual(parseArgs(['--studio-id', 'one', '--studio-id', 'two', '--once'], {}), { list: false, studioIds: ['one', 'two'], once: true });
  assert.deepEqual(parseArgs([], { PARALLAX_STUDIO_IDS: 'one, two' }).studioIds, ['one', 'two']);
  for (const args of [[], ['--studio-id', 'x', '--studio-id', 'x'], ['--studio-id', 'a', '--studio-id', 'b', '--studio-id', 'c'], ['--studio-id', 'a;calc'], ['--all']]) assert.throws(() => parseArgs(args, {}));
});
test('API rejects remote hosts and redirects, and never sends worker credentials in a URL', async () => {
  for (const url of ['https://example.com', 'http://localhost:61281', 'http://127.0.0.1:80', 'http://user:pass@127.0.0.1:61281', 'http://127.0.0.1:61281/path', 'http://127.0.0.1:61281/?q=x']) assert.throws(() => validateBaseUrl(url));
  let seen;
  const key = 'a'.repeat(64);
  const api = createPoolApi({ key, fetchImpl: async (url, options) => { seen = { url, options }; return new Response('{"job":null}'); } });
  assert.deepEqual(await api('claim', { workerId: 'one', studioId: 'one' }), { job: null });
  assert.equal(seen.url, 'http://127.0.0.1:61281/api/builds/pool/claim');
  assert.equal(seen.options.redirect, 'error'); assert.equal(seen.options.headers.Authorization, `Bearer ${key}`);
  assert.equal(seen.url.includes(key), false); assert.equal(seen.options.headers.Origin, undefined);
  await assert.rejects(api('../elsewhere', {}), /Unsupported/);
});
test('API bounds server JSON and never includes response bodies in error messages', async () => {
  const key = 'a'.repeat(64);
  const huge = createPoolApi({ key, fetchImpl: async () => new Response(' '.repeat(500001)) });
  await assert.rejects(huge('claim', {}), /exceeded/);
  const rejected = createPoolApi({ key, fetchImpl: async () => new Response('private-diagnostics', { status: 403 }) });
  await assert.rejects(rejected('claim', {}), error => error.status === 403 && !error.message.includes('private-diagnostics'));
});

test('updated dedicated workers advertise their exact agent protocol in authenticated presence',async()=>{
  const bodies=[];
  const api=createPoolApi({key:'a'.repeat(64),fetchImpl:async(url,options)=>{assert.match(url,/\/presence$/);bodies.push(JSON.parse(options.body));return new Response('{}');}});
  for(const busy of [false,true]) await api('presence',workerPresencePayload({workerId:'worker-1',studioId:'studio-1',busy}));
  assert.deepEqual(bodies,[{workerId:'worker-1',studioId:'studio-1',status:'idle',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1,projectProtocol:1},{workerId:'worker-1',studioId:'studio-1',status:'busy',agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1,projectProtocol:1}]);
});
test('Studio output only confirms structured, explicit results', () => {
  assert.deepEqual(decodeToolJson({ content: [{ type: 'text', text: '{"studios":[]}' }] }), { studios: [] });
  assert.deepEqual(decodeToolJson({ content: [{ type: 'text', text: 'PARALLAX_RESULT:{"safe":true}' }] }, { marker: true }), { safe: true });
  assert.throws(() => decodeToolJson({ content: [{ type: 'text', text: 'success maybe' }] }, { marker: true }), /unrecognized/);
});
function job() {
  return { leaseId: 'lease-123', leaseToken: 'b'.repeat(64), leaseExpiresAt: Date.now() + 60000, buildId: 'build-123', jobId: 'job-123', rootName: 'Parallax_' + 'c'.repeat(32), plan: createTemplatePlan('obby'), artifactLuau: 'UNTRUSTED_REMOTE_CODE', scriptSources: [{ name: 'arbitrary', source: 'UNTRUSTED_REMOTE_CODE' }] };
}
function runnerFixture({ failure, stale = false, previous = null } = {}) {
  const current = job(), calls = [], reports = [];
  let placed = 0;
  const answer = value => ({ content: [{ type: 'text', text: 'PARALLAX_RESULT:' + JSON.stringify(value) }] });
  const client = { closed: false, async call(name, args) {
    calls.push({ name, args });
    if (failure?.(name, args)) throw new Error('Injected Studio failure');
    if (name === 'execute_luau') {
      if (args.datamodel_type === 'Server') return answer({ smokePassed: true, playerInitialized: true, objectCount: current.plan.parts.length + 1 });
      if (args.code.includes('local gameplay = Instance.new')) return answer({ ok: true, objectCount: current.plan.parts.length + 1 });
      if (args.code.includes('for _, item in ipairs(')) { placed = Math.min(placed + 10, current.plan.parts.length); return answer({ ok: true, objectCount: placed }); }
      if (args.code.includes('local root = Instance.new')) return answer({ ok: true, objectCount: 0 });
      return answer({ safe: true, ok: true });
    }
    if (name === 'screen_capture') return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }] };
    if (name === 'get_console_output') return { content: [{ type: 'text', text: '' }] };
    return { content: [] };
  } };
  const api = async (name, body, options) => {
    reports.push({ name, body, options });
    if (name === 'heartbeat') { if (stale) throw Object.assign(new Error('Expired lease'), { status: 409 }); return { leaseExpiresAt: Date.now() + 60000 }; }
    return {};
  };
  return { current, calls, reports, client, api, run: () => executeJob({ client, api, studioId: 'studio-1', workerId: 'worker-1', job: current, previous, runId: 'run-1', delay: async () => {} }) };
}
test('worker applies only local reviewed generators, publishes actual captures, and reports smoke checks precisely', async () => {
  const fixture = runnerFixture(); const previous = await fixture.run();
  assert.equal(previous.rootName, fixture.current.rootName);
  assert.equal(previous.partIds.length, fixture.current.plan.parts.length);
  assert.equal(fixture.calls.every(call => call.args.studio_id === 'studio-1'), true);
  assert.equal(fixture.calls.some(call => call.args.code?.includes('UNTRUSTED_REMOTE_CODE')), false);
  assert.equal(fixture.calls.some(call => call.args.code?.includes('Parallax starter gameplay')), true);
  assert.equal(fixture.reports.filter(report => report.name === 'screen').length, 6);
  assert.deepEqual(fixture.reports.filter(report => report.name === 'screen').slice(-3).map(report => report.options.captureView),['overview','spawn','finish']);
  const angles=fixture.calls.filter(call=>call.name==='screen_capture').slice(-3).map(call=>call.args.camera_position);
  assert.equal(new Set(angles.map(JSON.stringify)).size,3);
  assert.deepEqual(fixture.calls.filter(call => call.name === 'start_stop_play').map(call => call.args.is_start), [true, false]);
  const terminal = fixture.reports.findLast(report => report.name === 'report');
  assert.equal(terminal.body.status, 'ready');
  assert.equal(terminal.body.objectCount, fixture.current.plan.parts.length + 1);
  assert.equal(terminal.body.playtest.result, 'passed'); assert.match(terminal.body.playtest.message, /not a full gameplay/);
});
test('expired leases cannot trigger Studio operations or false completion', async () => {
  const fixture = runnerFixture({ stale: true });
  await assert.rejects(fixture.run(), /lease ended/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.reports.some(report => report.name === 'report'), false);
});
test('partial mutations stop the job once and never automatically replay or clear it', async () => {
  let partsCalls = 0;
  const fixture = runnerFixture({ failure: (name, args) => name === 'execute_luau' && args.code.includes('for _, item in ipairs(') && ++partsCalls === 2 });
  await assert.rejects(fixture.run(), /Injected Studio failure/);
  assert.equal(partsCalls, 2);
  assert.equal(fixture.calls.filter(call => call.args.code?.includes('local root = Instance.new')).length, 1);
  assert.equal(fixture.reports.findLast(report => report.name === 'report').body.status, 'failed');
  assert.equal(fixture.reports.some(report => report.body?.status === 'ready'), false);
});
test('runtime failures stop this worker playtest and do not claim the game was tested', async () => {
  const fixture = runnerFixture({ failure: (name, args) => name === 'execute_luau' && args.datamodel_type === 'Server' });
  await assert.rejects(fixture.run(), /Injected Studio failure/);
  assert.deepEqual(fixture.calls.filter(call => call.name === 'start_stop_play').map(call => call.args.is_start), [true, false]);
  assert.equal(fixture.reports.findLast(report => report.name === 'report').body.playtest.result, 'failed');
});
test('guard protects published places and all existing scenes without any recycling path', () => {
  assert.throws(()=>guardSource({ runId: 'run-1', previous: { rootName: 'Parallax_prior', jobId: 'prior-job', partIds: ['one'] } }),/ownership/);
  const source = guardSource();
  assert.match(source, /game.PlaceId == 0 and game.GameId == 0/); assert.match(source, /IsEdit/);
  assert.match(source, /Terrain:CountCells\(\) == 0/);
  assert.match(source, /child.Name == "AreaTemplates" and #child:GetChildren\(\) == 0/);
  assert.doesNotMatch(source,/child == prior|allowedIds|:Destroy\(/);
  assert.doesNotMatch(initSource(job(),{runId:'run-1'}),/:Destroy\(/);
  assert.equal(source.includes(GAMEPLAY_SOURCE), false);
});

test('a previously completed Studio session rejects another job before API or Studio operations',async()=>{
  const fixture=runnerFixture({previous:{rootName:'Parallax_prior',jobId:'prior-job',partIds:['one']}});
  await assert.rejects(fixture.run(),/completed Studio scene cannot be reused/);
  assert.equal(fixture.calls.length,0);assert.equal(fixture.reports.length,0);
});

test('the worker command retires a successful slot without advertising idle or claiming a second job',async()=>{
  const fixture=runnerFixture(),presence=[],output=[],client=fixture.client,originalCall=client.call;
  let claims=0;
  client.call=async(name,args)=>name==='list_roblox_studios'?{structuredContent:{studios:[{id:'studio-1'}]}}:originalCall(name,args);
  client.close=()=>{client.closed=true;};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./parallax/studio-worker.cjs'),'utf8'),{
    module,Buffer,URL,AbortController,AbortSignal,Date,
    require:name=>name==='./studio-mcp-client.cjs'?{connectStudioMcp:async()=>client}:name==='./roblox-builds.cjs'?require('./parallax/roblox-builds.cjs'):name==='./builder-project.cjs'?require('./parallax/builder-project.cjs'):require(name),
    process:{env:{},stdout:{write:text=>output.push(text)},once(){},removeListener(){}},
    setInterval:()=>1,clearInterval(){},setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout(){},
    fetch:async(url,options)=>{
      const route=new URL(url).pathname.split('/').at(-1),body=route==='screen'?null:JSON.parse(options.body);
      if(route==='presence')presence.push(body);
      if(route==='claim'){assert.equal(++claims,1,'A retired slot attempted another claim');return Response.json({job:fixture.current});}
      return Response.json(await fixture.api(route,body));
    }
  },{filename:'studio-worker-offline-command.cjs'});
  await module.exports.main(['--studio-id','studio-1'],{PARALLAX_WORKER_KEY:'a'.repeat(64)});
  assert.equal(claims,1);assert.equal(client.closed,true);assert.equal(presence.at(-1).status,'busy');
  assert.match(output.join(''),/scene preserved and worker retired/);
});

const luauExecutable=process.env.PARALLAX_LUAU_PATH||path.join(__dirname,'qa-luau-0.741','luau.exe');
test('executed Luau guard rejects a known completed folder even after only a geometry edit',{skip:!fs.existsSync(luauExecutable)},t=>{
  const temporaryParent=path.resolve(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryParent,'ropad-worker-guard-'));
  t.after(()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),temporaryParent);assert.match(path.basename(resolved),/^ropad-worker-guard-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const source=guardSource({runId:'run-1'});
  const script=`local part={Name="Platform",Position={500,10,0},Size={40,2,20},Anchored=true}\nlocal folder={Name="Parallax_prior",ClassName="Folder",destroyed=false}\nfunction folder:IsA(name) return name=="Folder" end\nfunction folder:GetAttribute(name) if name=="ParallaxWorker" then return "run-1" else return "prior-job" end end\nfunction folder:GetChildren() return {part} end\nfunction folder:Destroy() self.destroyed=true end\nworkspace={GetChildren=function() return {folder} end}\ngame={PlaceId=0,GameId=0,GetService=function(_,name) assert(name=="RunService");return {IsEdit=function() return true end} end}\nlocal ok,message=pcall(function()\n${source}\nend)\nassert(not ok and string.find(message,"existing objects are protected"),"Completed folder was accepted")\nassert(not folder.destroyed and part.Position[1]==500,"Creator edit was changed")\nprint("Completed scene preserved")\n`;
  const file=path.join(directory,'guard.luau');fs.writeFileSync(file,script);
  const result=spawnSync(luauExecutable,[file],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/Completed scene preserved/);
});
test('unvalidated plans and malformed leases are rejected before Studio execution', async () => {
  const current = job(); current.plan.parts[0].script = 'untrusted'; assert.throws(() => validateJob(current), /Unsupported/);
  assert.throws(() => validateJob({ ...job(), leaseToken: 'bad' }), /invalid build lease/);
  assert.throws(() => validateJob({ ...job(), rootName: 'Workspace' }), /invalid build lease/);
});

test('capture transport carries a bounded named view and enhanced generators preserve collision rules',async()=>{
 let options;
 const api=createPoolApi({key:'a'.repeat(64),fetchImpl:async(url,value)=>{options=value;return Response.json({});}});
 await api('screen',null,{bytes:Buffer.alloc(32),contentType:'image/png',lease:{leaseId:'test',leaseToken:'b'.repeat(64)},captureView:'spawn'});
 assert.equal(options.headers['X-Ropad-Capture-View'],'spawn');
 await assert.rejects(api('screen',null,{captureView:'../../private'}),/Unsupported Studio capture view/);
 const current=job();current.plan.presentation={lighting:{clockTime:18,brightness:2.2,ambient:[70,90,110]}};
 const decoration={id:'spire',name:'Spire',position:[20,30,0],size:[8,60,8],behavior:'decoration',material:'Metal',color:[70,90,110],value:1,shape:'Cylinder',rotation:[0,45,0]};current.plan.parts.push(decoration);
 const {partsSource,cameraFor}=require('./parallax/studio-worker.cjs');
 assert.match(initSource(current,{runId:'test'}),/lighting.ClockTime = 18/);
 const code=partsSource(current,[decoration],'test');assert.match(code,/part.CanCollide = false; part.CanTouch = false/);assert.match(code,/CFrame.Angles/);assert.match(code,/Enum.PartType\[item.shape/);
 for(const view of ['overview','spawn','finish']) for(const value of [...cameraFor(current.plan,view).camera_position,...cameraFor(current.plan,view).look_at_position]) assert.equal(Number.isFinite(value),true);
});

test('generated decorative parts execute in Luau with no collision or gameplay geometry changes',{skip:!fs.existsSync(luauExecutable)},t=>{
 const temporaryParent=path.resolve(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryParent,'ropad-visual-parts-'));
 t.after(()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),temporaryParent);assert.match(path.basename(resolved),/^ropad-visual-parts-/);fs.rmSync(resolved,{recursive:true,force:true});});
 const current=job(),{partsSource}=require('./parallax/studio-worker.cjs');
 const parts=[{id:'spire',name:'Spire',position:[20,30,0],size:[8,60,8],behavior:'decoration',material:'Metal',color:[70,90,110],value:1,shape:'Cylinder',rotation:[0,45,0]},current.plan.parts[0]];
 const source=`local created={}\nlocal root={}\nfunction root:IsA(name) return name=="Folder" end\nfunction root:GetAttribute(name) return name=="ParallaxJob" and "job-123" or "run-1" end\nfunction root:GetChildren() return created end\nworkspace={FindFirstChild=function() return root end}\ngame={PlaceId=0,GameId=0,GetService=function(_,name) if name=="RunService" then return {IsEdit=function() return true end} end return {JSONEncode=function() return "ok" end} end}\nVector3={new=function(...) return {...} end}\nColor3={fromRGB=function(...) return {...} end}\nEnum={PartType={Block="Block",Ball="Ball",Cylinder="Cylinder"},Material={Metal="Metal",SmoothPlastic="SmoothPlastic"}}\nCFrame={new=function(...) return setmetatable({position={...}},{__mul=function(a,b) return {position=a.position,yaw=b.yaw} end}) end,Angles=function(_,yaw,_) return {yaw=yaw} end}\nInstance={new=function(class) local part={ClassName=class,CanCollide=true,CanTouch=true,attributes={}};function part:IsA(name) return self.ClassName==name end;function part:GetAttribute(name) return self.attributes[name] end;function part:SetAttribute(name,value) self.attributes[name]=value end;table.insert(created,part);return part end}\nlocal function assemble()\n${partsSource(current,parts,'run-1')}\nend\nassemble()\nassert(#created==2)\nassert(created[1].CanCollide==false and created[1].CanTouch==false and created[1].Shape=="Cylinder")\nassert(math.abs(created[1].CFrame.yaw-math.pi/4)<0.00001)\nassert(created[2].ClassName=="SpawnLocation" and created[2].CanCollide==true and created[2].CanTouch==true)\nprint("Visual geometry executed")\n`;
 const file=path.join(directory,'visual-parts.luau');fs.writeFileSync(file,source);const result=spawnSync(luauExecutable,[file],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/Visual geometry executed/);
});

test('Studio initialization disables only the permitted template spawn after full preflight',{skip:!fs.existsSync(luauExecutable)},t=>{
 const temporaryParent=path.resolve(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryParent,'ropad-spawn-guard-'));
 t.after(()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),temporaryParent);assert.match(path.basename(resolved),/^ropad-spawn-guard-/);fs.rmSync(resolved,{recursive:true,force:true});});
 const current=job();current.plan.presentation={lighting:{clockTime:17,brightness:2.3,ambient:[90,100,120]}};
 const source=`local function scenario(published, populated)\nlocal spawn={Name="SpawnLocation",ClassName="SpawnLocation",Anchored=true,Enabled=true,positionPreserved=true}\nfunction spawn:IsA(name) return name=="SpawnLocation" end\nfunction spawn:GetDescendants() return {} end\nlocal existing={Name="CreatorModel",ClassName="Model",Enabled=true}\nfunction existing:IsA() return false end\nlocal terrain={Name="Terrain",CountCells=function() return 0 end,IsA=function(_,name) return name=="Terrain" end}\nlocal children={spawn,terrain};if populated then table.insert(children,existing) end\nworkspace={Terrain=terrain,GetChildren=function() return children end,FindFirstChild=function() return nil end}\nlocal lighting={Brightness=1,ClockTime=12}\nlocal empty={GetChildren=function() return {} end}\ngame={PlaceId=published and 42 or 0,GameId=0,GetService=function(_,name) if name=="RunService" then return {IsEdit=function() return true end} elseif name=="Lighting" then return lighting elseif name=="HttpService" then return {JSONEncode=function() return "ok" end} else return empty end end}\nColor3={fromRGB=function(...) return {...} end}\nlocal created=0\nInstance={new=function(class) created+=1;local instance={ClassName=class};function instance:SetAttribute() end;return instance end}\nlocal success,message=pcall(function()\n${initSource(current,{runId:'run-1'})}\nend)\nif published or populated then assert(not success);assert(spawn.Enabled==true and lighting.Brightness==1 and created==0,"Preflight failure mutated existing content") else assert(success,message);assert(spawn.Enabled==false and spawn.positionPreserved==true,"Template spawn was not preserved and disabled");assert(lighting.Brightness==2.3 and created==1) end\nend\nscenario(false,false)\nscenario(true,false)\nscenario(false,true)\nprint("Template spawn and preflight verified")\n`;
 const file=path.join(directory,'spawn-init.luau');fs.writeFileSync(file,source);const result=spawnSync(luauExecutable,[file],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/Template spawn and preflight verified/);
});

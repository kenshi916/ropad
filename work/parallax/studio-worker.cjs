'use strict';

const crypto = require('node:crypto');
const { connectStudioMcp } = require('./studio-mcp-client.cjs');
const { validatePlan, GAMEPLAY_SOURCE } = require('./roblox-builds.cjs');
const { installProjectSource,projectScripts,manifest } = require('./builder-project.cjs');

const STUDIO_ID = /^[a-zA-Z0-9._:-]{1,120}$/;
const MARKER = 'PARALLAX_RESULT:';
const AGENT_WORKER_CAPABILITY = Object.freeze({agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio:true,visualReviewProtocol:1,projectProtocol:1});
function workerPresencePayload({workerId,studioId,busy=false,reuseRevisions=false}) { return {workerId,studioId,status:busy?'busy':'idle',...AGENT_WORKER_CAPABILITY,...(reuseRevisions?{oneBuildPerStudio:false,revisionReuseProtocol:1}:{})}; }
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Worker stopped'));
  const abort = () => { clearTimeout(timer); reject(new Error('Worker stopped')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
function lua(value) {
  if (typeof value === 'string') return '"' + [...Buffer.from(value, 'utf8')].map(n => n >= 32 && n <= 126 && n !== 34 && n !== 92 ? String.fromCharCode(n) : '\\' + String(n).padStart(3, '0')).join('') + '"';
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Invalid numeric scene value'); return String(value); }
  if (value == null) return 'nil';
  if (Array.isArray(value)) return '{' + value.map(lua).join(',') + '}';
  return '{' + Object.entries(value).map(([key, item]) => `[${lua(key)}]=${lua(item)}`).join(',') + '}';
}
function toolTexts(result) { return (result?.content || []).filter(block => block.type === 'text').map(block => block.text); }
function decodeToolJson(result, { marker = false } = {}) {
  const candidates = [];
  if (result?.structuredContent) candidates.push(result.structuredContent);
  for (const source of toolTexts(result)) {
    candidates.push(source);
    try { candidates.push(JSON.parse(source)); } catch {}
  }
  for (const candidate of candidates) {
    if (!marker && candidate && typeof candidate === 'object') return candidate;
    if (typeof candidate !== 'string') continue;
    let text = candidate;
    if (marker) {
      const at = text.indexOf(MARKER); if (at < 0) continue;
      text = text.slice(at + MARKER.length).split(/\r?\n/)[0].trim();
    }
    try { const value = JSON.parse(text); if (value && typeof value === 'object') return value; } catch {}
  }
  throw new Error('Studio returned an unrecognized result; no completion was assumed');
}
async function listStudios(client) {
  const result = decodeToolJson(await client.call('list_roblox_studios', {}));
  const studios = Array.isArray(result) ? result : result.studios;
  if (!Array.isArray(studios)) throw new Error('Studio did not return a session list');
  return studios.filter(studio => studio && STUDIO_ID.test(String(studio.id))).map(studio => ({ id: String(studio.id), name: String(studio.name || 'Untitled Studio').slice(0, 180) }));
}
function validateBaseUrl(value = 'http://127.0.0.1:61281') {
  const url = new URL(value);
  const local=url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port==='61281';
  const production=url.protocol==='https:'&&['ropad.fun','www.ropad.fun'].includes(url.hostname)&&!url.port;
  if ((!local&&!production) || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('Worker API must be local http://127.0.0.1:61281 or HTTPS ropad.fun');
  return url.origin;
}
function createPoolApi({ key, baseUrl, fetchImpl = fetch, signal } = {}) {
  if (!/^[a-fA-F0-9]{64}$/.test(key || '')) throw new Error('PARALLAX_WORKER_KEY must contain the server worker key');
  const base = validateBaseUrl(baseUrl);
  return async function request(route, data, { bytes, contentType, lease, captureView } = {}) {
    if (!['claim', 'heartbeat', 'report', 'screen', 'presence'].includes(route)) throw new Error('Unsupported worker endpoint');
    const timeout = AbortSignal.timeout(15000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (captureView !== undefined && !['overview','spawn','finish'].includes(captureView)) throw new Error('Unsupported Studio capture view');
    const response = await fetchImpl(`${base}/api/builds/pool/${route}`, { method: 'POST', redirect: 'error', signal: requestSignal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': bytes ? contentType : 'application/json', ...(lease ? { 'X-Parallax-Lease': lease.leaseId, 'X-Parallax-Lease-Token': lease.leaseToken } : {}), ...(captureView ? {'X-Ropad-Capture-View':captureView} : {}) }, body: bytes || JSON.stringify(data) });
    if (!response.ok) throw Object.assign(new Error(`Worker server request failed (${response.status})`), { status: response.status });
    const reader = response.body?.getReader();
    if (!reader) return {};
    const chunks = []; let length = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 500000) throw new Error('Worker server response exceeded its limit'); chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Worker server returned invalid JSON'); }
  };
}

function guardSource({previous=null,runId}={}) {
  if(previous && (!STUDIO_ID.test(previous.jobId||'') || !/^Parallax_[a-f0-9]{32}$/.test(previous.rootName||'') || previous.runId!==runId || !Array.isArray(previous.clientScripts)))throw new Error('Previous project ownership is not positively matched');
  return `assert(game.PlaceId == 0 and game.GameId == 0, "Refusing to modify a published place")
assert(game:GetService("RunService"):IsEdit(), "Studio must be stopped in Edit mode")
${previous?`local previousRoot = workspace:FindFirstChild(${lua(previous.rootName)})\nassert(previousRoot and previousRoot:GetAttribute("ParallaxJob")==${lua(previous.jobId)} and previousRoot:GetAttribute("ParallaxWorker")==${lua(runId)}, "Previous project ownership changed")`:''}
for _, child in ipairs(workspace:GetChildren()) do
 local allowed = child:IsA("Camera") or child:IsA("Terrain")${previous?' or child == previousRoot':''}
 if child.Name == "Baseplate" and child.ClassName == "Part" then
  allowed = child.Anchored
  for _, desc in ipairs(child:GetDescendants()) do assert(desc:IsA("Texture") or desc:IsA("Decal"), "Baseplate contains unknown content") end
 elseif child.Name == "SpawnLocation" and child:IsA("SpawnLocation") then
  allowed = child.Anchored
  for _, desc in ipairs(child:GetDescendants()) do assert(desc:IsA("Texture") or desc:IsA("Decal"), "Spawn contains unknown content") end
 end
 assert(allowed, "Use an empty, dedicated Studio place; existing objects are protected")
end
assert(workspace.Terrain:CountCells() == 0, "Use an empty, dedicated Studio place; terrain is protected")
for _, name in ipairs({"ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "StarterGui", "StarterPack"}) do
 assert(#game:GetService(name):GetChildren() == 0, "Use an empty, dedicated Studio place; existing assets are protected")
end
-- Studio may install this empty organizational folder in a new place
for _, child in ipairs(game:GetService("ServerStorage"):GetChildren()) do
 assert(child:IsA("Folder") and ((child.Name == "AreaTemplates" and #child:GetChildren() == 0)${previous?` or (child.Name == "RopadRevisionArchive" and child:GetAttribute("ParallaxWorker")==${lua(runId)})`:''}), "ServerStorage contains existing assets")
end
for _, child in ipairs(game:GetService("StarterPlayer"):GetChildren()) do
 assert(child:IsA("StarterPlayerScripts") or child:IsA("StarterCharacterScripts"), "StarterPlayer contains existing content")
 for _, source in ipairs(child:GetChildren()) do
  ${previous?`assert(child:IsA("StarterPlayerScripts") and table.find(${lua(previous.clientScripts)}, source.Name) and source:GetAttribute("ParallaxJob")==${lua(previous.jobId)}, "StarterPlayer contains unrelated scripts")`:'error("StarterPlayer contains existing content")'}
 end
end`;
}
function resultSource(value) { return `return ${lua(MARKER)} .. game:GetService("HttpService"):JSONEncode(${value})`; }
function ownedRootSource(job, runId) {
  return `assert(game.PlaceId == 0 and game.GameId == 0 and game:GetService("RunService"):IsEdit(), "Studio context changed")
local root = workspace:FindFirstChild(${lua(job.rootName)})
assert(root and root:IsA("Folder") and root:GetAttribute("ParallaxJob") == ${lua(job.jobId)} and root:GetAttribute("ParallaxWorker") == ${lua(runId)}, "Build ownership changed")`;
}
function initSource(job, { runId,previous=null }) {
  return `${guardSource({previous,runId})}
assert(not workspace:FindFirstChild(${lua(job.rootName)}), "Build already exists; refusing replay")
${previous?`-- Move positively matched prior instances intact; never clear the place\nlocal storage = game:GetService("ServerStorage")\nlocal archive = storage:FindFirstChild("RopadRevisionArchive")\nif not archive then archive = Instance.new("Folder"); archive.Name = "RopadRevisionArchive"; archive:SetAttribute("ParallaxWorker", ${lua(runId)}); archive.Parent = storage end\nassert(not archive:FindFirstChild(${lua(previous.jobId)}), "Prior version already archived")\nlocal version = Instance.new("Folder"); version.Name = ${lua(previous.jobId)}; version.Parent = archive\nlocal lightingCopy = Instance.new("Configuration"); lightingCopy.Name = "LightingState"; lightingCopy:SetAttribute("ClockTime",game:GetService("Lighting").ClockTime); lightingCopy:SetAttribute("Brightness",game:GetService("Lighting").Brightness); lightingCopy:SetAttribute("Ambient",game:GetService("Lighting").Ambient); lightingCopy.Parent = version\nfor _, desc in ipairs(previousRoot:GetDescendants()) do if desc:IsA("BaseScript") then desc:SetAttribute("RopadPreviousEnabled",desc.Enabled);desc.Enabled=false end end\npreviousRoot.Parent = version\nfor _, name in ipairs(${lua(previous.clientScripts)}) do local source=game:GetService("StarterPlayer").StarterPlayerScripts:FindFirstChild(name); if source then source:SetAttribute("RopadPreviousEnabled",source.Enabled);source.Enabled=false;source.Parent=version end end`:''}
-- Existing completed scenes and creator edits are never recycled or removed
-- A fresh Studio template may contain its own spawn. Keep the instance but
-- disable it after preflight so players always use this game's planned start.
for _, existing in ipairs(workspace:GetChildren()) do
 if existing.Name == "SpawnLocation" and existing:IsA("SpawnLocation") then existing.Enabled = false end
end
local root = Instance.new("Folder"); root.Name = ${lua(job.rootName)}
root:SetAttribute("ParallaxJob", ${lua(job.jobId)}); root:SetAttribute("ParallaxWorker", ${lua(runId)})
${job.plan.project ? 'game:GetService("HttpService").HttpEnabled = false\ngame:GetService("ServerScriptService").LoadStringEnabled = false\nassert(not game:GetService("HttpService").HttpEnabled and not game:GetService("ServerScriptService").LoadStringEnabled, "Project execution restrictions unavailable")' : ''}
root:SetAttribute("Template", ${lua(job.plan.template)}); root.Parent = workspace
${job.plan.presentation ? `local lighting = game:GetService("Lighting")
lighting.ClockTime = ${job.plan.presentation.lighting.clockTime}; lighting.Brightness = ${job.plan.presentation.lighting.brightness}
lighting.Ambient = Color3.fromRGB(${job.plan.presentation.lighting.ambient.join(',')})` : ''}
${resultSource('{ok=true,objectCount=0}')}`;
}
function partsSource(job, parts, runId) {
  return `${ownedRootSource(job, runId)}
for _, item in ipairs(${lua(parts)}) do
 for _, old in ipairs(root:GetChildren()) do assert(old:GetAttribute("PlanId") ~= item.id, "Part already exists; refusing replay") end
 local part = Instance.new(item.behavior == "spawn" and "SpawnLocation" or "Part")
 part.Name = item.name; part.Anchored = true; part.Size = Vector3.new(table.unpack(item.size)); part.Position = Vector3.new(table.unpack(item.position))
 part.Color = Color3.fromRGB(table.unpack(item.color)); part.Material = Enum.Material[item.material]
 part:SetAttribute("PlanId", item.id); part:SetAttribute("Behavior", item.behavior); part:SetAttribute("Value", item.value)
 if item.behavior == "coin" then part.Shape = Enum.PartType.Ball; part.CanCollide = false end
 if item.behavior == "decoration" then
  part.CanCollide = false; part.CanTouch = false; part.Shape = Enum.PartType[item.shape or "Block"]
  if item.rotation then part.CFrame = CFrame.new(table.unpack(item.position)) * CFrame.Angles(0, math.rad(item.rotation[2]), 0) end
 end
 if part:IsA("SpawnLocation") then part.Neutral = true; part.Duration = 0 end
 part.Parent = root
end
${resultSource('{ok=true,objectCount=#root:GetChildren()}')}`;
}
function gameplaySource(job, runId) {
  return `${ownedRootSource(job, runId)}
assert(#root:GetChildren() == ${job.plan.parts.length} and not root:FindFirstChild("ParallaxGameplay"), "Scene is incomplete or already has gameplay")
local gameplay = Instance.new("Script"); gameplay.Name = "ParallaxGameplay"
game:GetService("ScriptEditorService"):UpdateSourceAsync(gameplay, function() return ${lua(GAMEPLAY_SOURCE)} end)
gameplay.Parent = root
${installProjectSource(job,lua)}
${resultSource('{ok=true,objectCount=#root:GetChildren()}')}`;
}
function smokeSource(job) {
  const hints = job.plan.parts.filter(part => ['spawn', 'checkpoint', 'finish', 'purchase'].includes(part.behavior)).length;
  return `assert(game:GetService("RunService"):IsRunning(), "Simulation has not started")
local root = workspace:FindFirstChild(${lua(job.rootName)})
assert(root and root:GetAttribute("ParallaxJob") == ${lua(job.jobId)}, "Runtime build missing")
${job.plan.project ? `assert(#root:GetDescendants() <= 5000, "Project runtime exceeded its object allowance")\nfor _, id in ipairs(${lua(job.plan.parts.map(p=>p.id))}) do local found=false;for _, p in ipairs(root:GetChildren()) do if p:IsA("BasePart") and p:GetAttribute("PlanId")==id then found=true;break end end;assert(found,"Authored gameplay geometry disappeared") end` : `assert(#root:GetChildren() == ${job.plan.parts.length + 1}, "Runtime object count changed")`}
local script = root:FindFirstChild("ParallaxGameplay"); assert(script and script.Enabled, "Gameplay script not enabled")
local hints = 0; for _, part in ipairs(root:GetChildren()) do if part:IsA("BasePart") and part:FindFirstChild("Hint") then hints += 1 end end
assert(hints == ${hints}, "Gameplay initialization is incomplete")
${job.plan.project ? `assert(root:GetAttribute("RopadProjectHash") == ${lua(manifest(job).sourceHash)}, "Project manifest changed")\nfor _, id in ipairs(${lua(projectScripts(job,lua).filter(s=>s.target==='server').map(s=>job.rootName+'__'+s.id))}) do local source = script:FindFirstChild(id); assert(source and source:GetAttribute("RopadStarted") == true, "Custom server source did not initialize") end` : ''}
local players = game:GetService("Players"):GetPlayers(); assert(#players > 0, "No playtest character")
local player = players[1]; assert(player.Character and player.Character:FindFirstChildOfClass("Humanoid") and player:FindFirstChild("ParallaxStats"), "Player initialization is incomplete")
${resultSource('{smokePassed=true,objectCount=#root:GetChildren(),playerInitialized=true}')}`;
}
function cameraFor(plan, view = 'overview') {
  if (!['overview','spawn','finish'].includes(view)) throw new Error('Unsupported Studio capture view');
  if (view !== 'overview') {
    const part = plan.parts.find(part => part.behavior === view);
    if (!part) throw new Error('Capture requires the start and finish');
    const scale = Math.max(24, Math.min(70, Math.max(part.size[0],part.size[2]) * 1.6));
    return {camera_position:[part.position[0]+scale*.65,part.position[1]+scale*.6,part.position[2]+scale],look_at_position:[part.position[0],part.position[1]+2,part.position[2]]};
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const part of plan.parts) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], part.position[i] - part.size[i] / 2); max[i] = Math.max(max[i], part.position[i] + part.size[i] / 2); }
  const center = min.map((value, i) => (value + max[i]) / 2), range = Math.max(35, ...max.map((value, i) => value - min[i]));
  return { camera_position: [center[0] + range * .7, center[1] + range * .65, center[2] + range * .8], look_at_position: center };
}
function validateJob(raw) {
  if (!raw || !STUDIO_ID.test(raw.leaseId || '') || !/^[a-fA-F0-9]{64}$/.test(raw.leaseToken || '') || !STUDIO_ID.test(raw.buildId || '') || !STUDIO_ID.test(raw.jobId || '') || !/^Parallax_[a-f0-9]{32}$/.test(raw.rootName || '')) throw new Error('Server returned an invalid build lease');
  if (!Number.isFinite(raw.leaseExpiresAt)) throw new Error('Server did not provide a lease expiry');
  // Unvalidated top-level artifactLuau/scriptSources are ignored. V2 source is
  // accepted only through the versioned, validated project inside the plan.
  return { ...raw, plan: validatePlan(raw.plan) };
}
async function executeJob({ client, api, studioId, workerId, job: raw, previous = null, runId, signal, delay = wait, now = Date.now }) {
  if (previous && (!raw.projectId || previous.projectId!==raw.projectId || previous.runId!==runId)) throw new Error('A completed Studio scene cannot be reused for another project; use a fresh dedicated Studio');
  const job = validateJob(raw); let expiresAt = job.leaseExpiresAt; let leaseError = null; let heartbeatBusy = false; let startedPlay = false; let terminal = false;
  const lease = { leaseId: job.leaseId, leaseToken: job.leaseToken };
  const assertLease = () => { if (signal?.aborted || leaseError || now() >= expiresAt) throw new Error('Build lease ended; no further Studio changes will be made'); };
  const renew = async () => {
    if (heartbeatBusy || terminal) return;
    heartbeatBusy = true;
    try { const result = await api('heartbeat', lease); if (!Number.isFinite(result.leaseExpiresAt)) throw new Error('Lease renewal was invalid'); expiresAt = result.leaseExpiresAt; }
    catch (error) { leaseError = error; }
    finally { heartbeatBusy = false; }
  };
  const heartbeat = setInterval(renew, 15000);
  const execute = async (code, type = 'Edit') => { assertLease(); return decodeToolJson(await client.call('execute_luau', { studio_id: studioId, datamodel_type: type, code }), { marker: true }); };
  const screen = async (captureView = 'overview') => {
    assertLease();
    const capture = await client.call('screen_capture', { studio_id: studioId, capture_id: `Parallax_${job.buildId}_${captureView}`, ...cameraFor(job.plan,captureView) });
    const image = capture?.content?.find(block => block.type === 'image');
    if (!image || !['image/png', 'image/jpeg'].includes(image.mimeType) || typeof image.data !== 'string' || image.data.length > 2800000) throw new Error('Studio screenshot was unavailable or too large');
    const bytes = Buffer.from(image.data, 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('Studio screenshot exceeded its limit');
    assertLease(); await api('screen', null, { bytes, contentType: image.mimeType, lease, captureView });
  };
  try {
    await renew(); assertLease();
    await execute(`${guardSource({ previous, runId })}\n${resultSource('{safe=true}')}`);
    await api('report', { ...lease, status: 'building', objectCount: 0, message: 'Studio worker verified an empty, unpublished workspace' });
    const initialized = await execute(initSource(job, { previous, runId }));
    if (!initialized.ok || initialized.objectCount !== 0) throw new Error('Studio did not confirm build initialization');
    for (let index = 0; index < job.plan.parts.length; index += 10) {
      const batch = job.plan.parts.slice(index, index + 10);
      const built = await execute(partsSource(job, batch, runId));
      if (!built.ok || built.objectCount !== index + batch.length) throw new Error('Studio object count did not match the applied plan');
      assertLease(); await api('report', { ...lease, status: 'building', objectCount: built.objectCount, message: `Placed ${built.objectCount} of ${job.plan.parts.length} scene objects in Studio` });
      await screen(); await delay(600, signal);
    }
    const assembled = await execute(gameplaySource(job, runId));
    if (!assembled.ok || assembled.objectCount !== job.plan.parts.length + 1) throw new Error('Studio did not confirm the fixed gameplay script');
    await api('report', { ...lease, status: 'building', objectCount: assembled.objectCount, message: 'Scene assembled; starting a runtime smoke check' });
    const beforeConsole = toolTexts(await client.call('get_console_output', { studio_id: studioId })).join('\n');
    assertLease(); startedPlay = true;
    await client.call('start_stop_play', { studio_id: studioId, is_start: true });
    let smoke; let smokeFailure;
    for (let attempt = 0; attempt < 8; attempt++) {
      await delay(1500, signal);
      try { smoke = await execute(smokeSource(job), 'Server'); if (smoke.smokePassed && smoke.playerInitialized) break; } catch (error) { smokeFailure = error; }
    }
    if (!smoke?.smokePassed || !smoke.playerInitialized) throw smokeFailure || new Error('Runtime smoke check did not pass');
    if (job.plan.project) {
      const names=projectScripts(job,lua).filter(s=>s.target==='client').map(s=>job.rootName+'__'+s.id);
      const clientCheck=`local player = game:GetService("Players").LocalPlayer\nassert(player and player:FindFirstChild("PlayerScripts"), "Client player unavailable")\nfor _, name in ipairs(${lua(names)}) do local code=player.PlayerScripts:FindFirstChild(name); assert(code and code:GetAttribute("RopadStarted")==true, "Custom client source did not initialize") end\n${resultSource('{clientInitialized=true}')}`;
      let clientReady=false;for(let attempt=0;attempt<8;attempt++){try{clientReady=(await execute(clientCheck,'Client')).clientInitialized===true;if(clientReady)break;}catch{}await delay(1000,signal);}
      if(!clientReady)throw new Error('Custom client project scripts did not initialize');
    }
    const afterConsole = toolTexts(await client.call('get_console_output', { studio_id: studioId })).join('\n');
    let prefix = 0; while (prefix < beforeConsole.length && prefix < afterConsole.length && beforeConsole[prefix] === afterConsole[prefix]) prefix++;
    const newConsole = afterConsole.slice(prefix);
    if (/(?:\berror\b|stack begin|failed to load)/i.test(newConsole)) throw new Error('Studio output reported a problem during the smoke check');
    // Stopping a playtest started by this worker is cleanup, even if a lease
    // expires. It never stops a pre-existing user playtest (preflight rejects it).
    await client.call('start_stop_play', { studio_id: studioId, is_start: false }); startedPlay = false;
    await execute(`${ownedRootSource(job, runId)}\nassert(#root:GetChildren() == ${job.plan.parts.length + 1}, "Edit-time scene changed")\n${resultSource('{ok=true}')}`);
    for (const view of ['overview','spawn','finish']) await screen(view);
    assertLease();
    await api('report', { ...lease, status: 'ready', objectCount: job.plan.parts.length + 1, message: 'Studio assembled the scene and passed a runtime smoke check; full gameplay review is still required', playtest: { result: 'passed', message: 'Runtime smoke check only: scene, fixed gameplay, and player initialized without new console errors; not a full gameplay playthrough' } });
    terminal = true;
    return { rootName: job.rootName, jobId: job.jobId, partIds: job.plan.parts.map(part => part.id),projectId:job.projectId,runId,clientScripts:projectScripts(job,lua).filter(s=>s.target==='client').map(s=>job.rootName+'__'+s.id) };
  } catch (error) {
    if (startedPlay && !client.closed) { try { await client.call('start_stop_play', { studio_id: studioId, is_start: false }); } catch {} }
    if (!leaseError && now() < expiresAt && !signal?.aborted) {
      try { await api('report', { ...lease, status: 'failed', message: `Worker stopped safely: ${String(error.message).slice(0, 400)}`, playtest: { result: startedPlay ? 'failed' : 'not_run', message: 'The worker did not complete all assembly and runtime checks' } }); } catch {}
    }
    // Do not replay, clear, or recycle a partially applied or uncertain job.
    throw error;
  } finally { terminal = true; clearInterval(heartbeat); }
}

function parseArgs(argv, env = process.env) {
  const result = { list: false, studioIds: [], once: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') result.help = true;
    else if (argv[i] === '--list') result.list = true;
    else if (argv[i] === '--once') result.once = true;
    else if (argv[i] === '--reuse-revisions') result.reuseRevisions = true;
    else if (argv[i] === '--studio-id' && argv[i + 1]) result.studioIds.push(argv[++i]);
    else throw new Error('Use --list, --once, or --studio-id ID (up to two explicit Studio IDs); --help shows setup');
  }
  if (!result.studioIds.length && env.PARALLAX_STUDIO_IDS) result.studioIds = env.PARALLAX_STUDIO_IDS.split(',').map(value => value.trim()).filter(Boolean);
  if(env.ROPAD_STUDIO_REUSE_REVISIONS==='1')result.reuseRevisions=true;
  if (result.studioIds.length > 2 || result.studioIds.some(id => !STUDIO_ID.test(id)) || new Set(result.studioIds).size !== result.studioIds.length) throw new Error('Choose one or two distinct, explicit Studio IDs');
  if (!result.list && !result.help && !result.studioIds.length) throw new Error('Select dedicated Studio IDs with --studio-id; use --list to see available sessions');
  return result;
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  if (options.help) {
    process.stdout.write('Parallax Studio workers\n\nnode studio-worker.cjs --list\nnode studio-worker.cjs --studio-id ID [--studio-id SECOND_ID] [--once]\n\nEnable Studio as MCP server in Roblox Studio, then open an empty unpublished place for each worker\nChoose its explicit ID from --list; at most two sessions are supported\nSet PARALLAX_WORKER_KEY from the local server worker-key file before running jobs\nSet PARALLAX_BASE_URL to https://ropad.fun for deployment, or use local http://127.0.0.1:61281; --list needs no key\nPARALLAX_STUDIO_IDS may alternatively contain one or two comma-separated IDs\n--once polls once per Studio; otherwise empty queues back off to 30 seconds\nBy default each Studio handles one build then retires. --reuse-revisions archives only positively matched versions of the same project and waits for its next revision\nSave your build and use a fresh empty unpublished place with a new worker for the next build\nUnrelated scenes are never recycled. Prior same-project roots and scripts are archived intact with scripts disabled. Any failure stops workers without replay\nRuntime checks are smoke tests, not complete gameplay verification or automatic publishing\n');
    return;
  }
  const client = await connectStudioMcp({ env });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const studios = await listStudios(client);
    if (options.list) { process.stdout.write(JSON.stringify({ studios }, null, 2) + '\n'); return; }
    if (options.studioIds.some(id => !studios.some(studio => studio.id === id))) throw new Error('A selected Studio is not connected; no builds were claimed');
    const api = createPoolApi({ key: env.PARALLAX_WORKER_KEY, baseUrl: env.PARALLAX_BASE_URL, signal: controller.signal });
    const runId = crypto.randomUUID();
    const results = await Promise.allSettled(options.studioIds.map(async (studioId, slot) => {
      const workerId = `studio-${runId}-${slot + 1}`; let previous = null;
      let busy = false; let presencePending = false; let presenceTimer; let idleDelay = 5000;
      const presence = async () => {
        if (presencePending || controller.signal.aborted) return;
        presencePending = true;
        try { await api('presence', workerPresencePayload({workerId,studioId,busy,reuseRevisions:options.reuseRevisions})); }
        catch { /* Claim/heartbeat enforce connectivity before mutations. */ }
        finally { presencePending = false; }
      };
      try {
        // Read-only preflight before advertising this session as an idle worker.
        const safe = decodeToolJson(await client.call('execute_luau', { studio_id: studioId, datamodel_type: 'Edit', code: `${guardSource({ previous, runId })}\n${resultSource('{safe=true}')}` }), { marker: true });
        if (!safe.safe) throw new Error('Selected Studio is not an empty, unpublished workspace');
        presenceTimer = setInterval(presence, 15000);
        process.stdout.write(`Studio worker ${slot + 1} connected to ${studioId}\n`);
        do {
          if (controller.signal.aborted || client.closed) break;
          await presence();
          const result = await api('claim', { workerId, studioId });
          if (result?.job) {
            idleDelay = 5000;
            busy = true; await presence();
            previous = await executeJob({ client, api, studioId, workerId, job: result.job, previous, runId, signal: controller.signal });
            if(options.reuseRevisions){busy=false;await presence();process.stdout.write(`Studio worker ${slot + 1} preserved this project; waiting for its next explicit version\n`);if(options.once)break;continue;}
            // Retire this slot before another claim. A completed place belongs
            // to its creator; geometry edits cannot be proved absent by IDs.
            busy = true; await presence();
            process.stdout.write(`Studio worker ${slot + 1} completed a build and runtime smoke check; scene preserved and worker retired\n`);
            break;
          } else idleDelay = Math.min(30000, Math.max(5000, Math.round(idleDelay * 1.5)));
          if (!options.once) await wait(idleDelay, controller.signal);
        } while (!options.once);
      } catch (error) {
        // Cancel sibling work, but wait for its playtest cleanup before closing
        // the shared MCP transport. Never abandon a running sibling promise.
        controller.abort(); throw error;
      } finally { clearInterval(presenceTimer); }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  } finally { controller.abort(); client.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (require.main === module) main().catch(error => { process.stderr.write(`Studio worker: ${String(error.message).slice(0, 400)}\n`); process.exitCode = 1; });
module.exports = { main, parseArgs, validateBaseUrl, createPoolApi, workerPresencePayload, decodeToolJson, listStudios, validateJob, executeJob, guardSource, initSource, partsSource, gameplaySource, smokeSource, cameraFor };

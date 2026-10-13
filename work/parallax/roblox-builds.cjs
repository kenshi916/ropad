'use strict';

// Declarative Studio work only: this service never signs, publishes, or executes model code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { artifactPlace } = require('./roblox-place.cjs');
const projectTools = require('./builder-project.cjs');
const { BUILDER_MODEL_IDS, DEFAULT_BUILDER_MODEL_ID, assertBuilderModelId } = require('./builder-models.cjs');
const {rasterType}=require('./builder-concepts.cjs');
const LIMITS = Object.freeze({ sessions: 500, parts: 180, brief: 2400, screenshot: 2 * 1024 * 1024, workerTtl: 12 * 60 * 60 * 1000 });
const TEMPLATES = ['obby', 'tycoon', 'racing'];
const BEHAVIORS = ['solid', 'spawn', 'checkpoint', 'hazard', 'coin', 'finish', 'purchase', 'decoration'];
const CAPTURE_VIEWS = ['overview', 'spawn', 'finish'];
const MATERIALS = ['SmoothPlastic', 'Neon', 'Concrete', 'Grass', 'WoodPlanks', 'Metal'];
const WORKER_FRESH_MS = 45_000;
const fail = (status, message, code = 'INVALID_BUILD') => Object.assign(new Error(message), { status, code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function text(value, label, max, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || !value.trim() || Buffer.byteLength(value) > max) throw fail(400, `${label} must be nonempty and at most ${max} bytes`);
  return value.trim();
}
function imagePurpose(value='concept') {if(!['concept','thumbnail','coinIcon'].includes(value))throw fail(400,'Choose a concept image, game thumbnail or coin icon');return value;}
function buildToken(token){
  if(!token)return null;
  if(token.chain==='solana'){
    const {PublicKey}=require('@solana/web3.js');
    const address=text(token.address,'Solana mint',44);try{if(new PublicKey(address).toBase58()!==address)throw Error();}catch{throw fail(400,'Invalid Solana mint');}
    if(!['devnet','mainnet-beta'].includes(token.cluster))throw fail(400,'Choose an explicit Solana cluster');
    const signature=text(token.signature||token.transactionHash,'Solana signature',88);if(!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))throw fail(400,'Invalid Solana transaction signature');
    return {chain:'solana',cluster:token.cluster,chainId:null,chainName:token.cluster==='devnet'?'Solana devnet':'Solana mainnet',address,symbol:text(token.symbol,'Token symbol',16),signature,transactionHash:signature,verified:token.verified===true,marketCapUsd:null,agentId:null};
  }
  return {address:text(token.address,'Token address',160),symbol:text(token.symbol,'Token symbol',16),chainId:Number(token.chainId||4663),chainName:text(token.chainName,'Chain name',80,'Robinhood Chain'),transactionHash:text(token.transactionHash,'Transaction hash',160),verified:token.verified===true,agentId:token.agentId?text(String(token.agentId),'Agent ID',100):null,marketCapUsd:null};
}
function vector(value, label, min, max) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isFinite(n) || n < min || n > max)) throw fail(400, `Invalid ${label}`);
  return value.map(n => Math.round(n * 100) / 100);
}
function visualContext(value) {
  if (value === undefined) return null;
  const allowed = ['version','sourceBuildId','sourceFrames','originalBrief','review'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.sourceBuildId || '') || !Array.isArray(value.sourceFrames) || !value.sourceFrames.length || value.sourceFrames.length > 3) throw fail(400, 'Invalid visual revision evidence');
  const seen = new Set();
  const sourceFrames = value.sourceFrames.map(frame => {
    if (!frame || typeof frame !== 'object' || Object.keys(frame).some(k => !['view','hash','capturedAt','bytes','contentType','source','jobId'].includes(k)) || !CAPTURE_VIEWS.includes(frame.view) || seen.has(frame.view) || !/^[a-f0-9]{64}$/.test(frame.hash || '') || !Number.isFinite(frame.capturedAt) || !Number.isInteger(frame.bytes) || frame.bytes < 32 || frame.bytes > LIMITS.screenshot || !['image/png','image/jpeg'].includes(frame.contentType) || frame.source !== 'pooled_studio_worker' || !/^[a-f0-9-]{36}$/.test(frame.jobId || '')) throw fail(400, 'Invalid visual revision frame');
    seen.add(frame.view); return {view:frame.view,hash:frame.hash,capturedAt:frame.capturedAt,bytes:frame.bytes,contentType:frame.contentType,source:frame.source,jobId:frame.jobId};
  });
  const r = value.review;
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['version','verdict','summary','issues','revisionBrief'].includes(k)) || r.version !== 1 || !['improve','acceptable'].includes(r.verdict) || !Array.isArray(r.issues) || r.issues.length > 6) throw fail(400, 'Invalid visual revision review');
  const issues = r.issues.map(issue => {
    if (!issue || typeof issue !== 'object' || Object.keys(issue).some(k => !['category','description'].includes(k)) || !['composition','readability','lighting','materials','scale','gameplay','other'].includes(issue.category)) throw fail(400, 'Invalid visual review issue');
    return {category:issue.category,description:text(issue.description,'Visual issue',500)};
  });
  return {version:1,sourceBuildId:value.sourceBuildId,sourceFrames,originalBrief:text(value.originalBrief,'Original game brief',LIMITS.brief),review:{version:1,verdict:r.verdict,summary:text(r.summary,'Visual review summary',800),issues,revisionBrief:r.verdict === 'acceptable' && !r.revisionBrief ? '' : text(r.revisionBrief,'Visual revision brief',1800)}};
}
function revisionIdentity({owner,parentBuildId,brief,modelId,inspiration,visualReviewContext}) {
  return hash(JSON.stringify({owner,parentBuildId,brief,modelId,inspiration,visualReviewContext}));
}
function validatePlan(input) {
  if (!input || typeof input !== 'object' || !TEMPLATES.includes(input.template)) throw fail(400, 'Choose obby, tycoon, or racing');
  if (!Array.isArray(input.parts) || input.parts.length < 3 || input.parts.length > LIMITS.parts) throw fail(400, `Plan must contain 3–${LIMITS.parts} parts`);
  // Reject model code and arbitrary classes/properties even when mixed with an otherwise valid plan.
  const allowed = new Set(['version', 'template', 'summary', 'parts', 'design', 'presentation', 'project']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw fail(400, 'Plan contains unsupported fields');
  if (input.version !== undefined && ![1,2].includes(input.version) || input.project !== undefined && input.version !== 2 || input.version === 2 && !input.project) throw fail(400,'A scene-v2 plan requires a versioned project');
  const project = input.project === undefined ? null : projectTools.validateProject(input.project);
  const ids = new Set();
  const parts = input.parts.map((p, index) => {
    if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['id', 'name', 'position', 'size', 'color', 'material', 'behavior', 'value', 'shape', 'rotation'].includes(k))) throw fail(400, `Unsupported part fields at ${index}`);
    const id = text(p.id, 'Part ID', 48);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw fail(400, 'Part IDs must be unique letters, digits, hyphens, or underscores');
    ids.add(id);
    if (!BEHAVIORS.includes(p.behavior || 'solid') || !MATERIALS.includes(p.material || 'SmoothPlastic')) throw fail(400, 'Unsupported part behavior or material');
    const value = p.value == null ? 1 : p.value;
    if (!Number.isInteger(value) || value < 1 || value > 10000) throw fail(400, 'Part value must be an integer from 1 to 10000');
    // Keep gameplay surfaces axis-aligned boxes so the reachability check stays
    // conservative. Richer geometry is explicit scenery and cannot block players.
    if ((p.shape !== undefined || p.rotation !== undefined) && p.behavior !== 'decoration') throw fail(400, 'Only noncollidable decoration can use shape or rotation');
    const appearance = {};
    if (p.behavior === 'decoration') {
      if (p.shape !== undefined && !['Block', 'Ball', 'Cylinder'].includes(p.shape)) throw fail(400, 'Unsupported decoration shape');
      if (p.shape !== undefined) appearance.shape = p.shape;
      if (p.rotation !== undefined) {
        appearance.rotation = vector(p.rotation, 'decoration rotation', -180, 180);
        if (appearance.rotation[0] !== 0 || appearance.rotation[2] !== 0) throw fail(400, 'Decoration rotation supports yaw only');
      }
    }
    return { id, name: text(p.name || id, 'Part name', 64), position: vector(p.position, 'position', -2048, 2048), size: vector(p.size, 'size', .25, 512), color: vector(p.color || [106, 232, 194], 'color', 0, 255), material: p.material || 'SmoothPlastic', behavior: p.behavior || 'solid', value, ...appearance };
  });
  if (!parts.some(p => p.behavior === 'spawn') || !parts.some(p => p.behavior === 'finish')) throw fail(400, 'A plan needs a spawn and a finish');
  if (parts.filter(p => p.behavior === 'spawn').length > 1) throw fail(400, 'A plan has exactly one spawn');
  const surfaces = parts.filter(p => ['solid', 'spawn', 'checkpoint', 'finish', 'purchase'].includes(p.behavior));
  const reachable = new Set([surfaces.find(p => p.behavior === 'spawn').id]);
  // Conservative top-surface path check, not a physics/playtest claim: <=6-stud
  // horizontal gaps, <=6-stud upward jumps and <=16-stud downward drops.
  for (let pass = 0; pass < surfaces.length; pass++) {
    let grew = false;
    for (const a of surfaces.filter(p => reachable.has(p.id))) for (const b of surfaces) {
      if (reachable.has(b.id)) continue;
      const xGap = Math.max(0, Math.abs(a.position[0]-b.position[0])-(a.size[0]+b.size[0])/2);
      const zGap = Math.max(0, Math.abs(a.position[2]-b.position[2])-(a.size[2]+b.size[2])/2);
      const rise = b.position[1]+b.size[1]/2-a.position[1]-a.size[1]/2;
      if (Math.hypot(xGap,zGap) <= 6 && rise <= 6 && rise >= -16) { reachable.add(b.id); grew = true; }
    }
    if (!grew) break;
  }
  if (parts.some(p => ['finish','checkpoint','purchase'].includes(p.behavior) && !reachable.has(p.id))) throw fail(400, 'Finish, checkpoints, and purchases need a connected surface path with jumps no wider or higher than 6 studs');
  if (input.template === 'tycoon') {
    const purchases = parts.filter(p => p.behavior === 'purchase');
    if (!purchases.length || !parts.some(p => p.behavior === 'coin') || parts.some(p => p.behavior === 'finish' && p.value > purchases.length)) throw fail(400, 'Tycoon needs collectible income and enough purchase pads to satisfy the finish');
  }
  if (input.template === 'racing') {
    const checkpointValues = parts.filter(p => p.behavior === 'checkpoint').map(p => p.value).sort((a,b)=>a-b);
    if (!checkpointValues.length || checkpointValues.some((v,i)=>v!==i+1)) throw fail(400, 'Racing checkpoints must have unique sequential values starting at 1');
  }
  let design;
  if (input.design !== undefined) {
    const fields = ['coreLoop', 'objective', 'progression', 'inspiration', 'limitations', 'acceptanceCriteria', 'unsupportedFeatures'];
    if (!input.design || typeof input.design !== 'object' || Array.isArray(input.design) || Object.keys(input.design).some(k => !fields.includes(k))) throw fail(400, 'Invalid game design fields');
    design = {};
    for (const name of fields.slice(0, 4)) design[name] = text(input.design[name], `Design ${name}`, 600);
    for (const name of fields.slice(4)) {
      if (!Array.isArray(input.design[name]) || input.design[name].length < (name === 'unsupportedFeatures' ? 0 : 1) || input.design[name].length > 8) throw fail(400, `Design ${name} needs a bounded list of entries`);
      design[name] = input.design[name].map(value => text(value, `Design ${name} entry`, 240));
    }
  }
  let presentation;
  if (input.presentation !== undefined) {
    const p = input.presentation;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => k !== 'lighting') || !p.lighting || typeof p.lighting !== 'object' || Array.isArray(p.lighting)) throw fail(400, 'Invalid scene presentation');
    const l = p.lighting;
    if (Object.keys(l).some(k => !['clockTime','brightness','ambient'].includes(k)) || !Number.isFinite(l.clockTime) || l.clockTime < 0 || l.clockTime > 24 || !Number.isFinite(l.brightness) || l.brightness < 0 || l.brightness > 4) throw fail(400, 'Invalid bounded scene lighting');
    presentation = {lighting:{clockTime:l.clockTime,brightness:l.brightness,ambient:vector(l.ambient,'lighting ambient',0,255)}};
  }
  return { version: project ? 2 : 1, template: input.template, summary: text(input.summary, 'Plan summary', 1000, 'A bounded Roblox scene'), parts, ...(design ? {design} : {}), ...(presentation ? {presentation} : {}), ...(project ? {project} : {}) };
}
function buildReadiness(session) {
  const assembled = session.status === 'ready' && !!session.plan && Number.isFinite(session.assembledAt) && session.objectCount === session.plan.parts.length + 1;
  const smokePassed = session.playtestReport?.result === 'passed' && session.playtestReport?.source === 'studio_worker_report';
  const review = session.creatorReview;
  const checks = [
    {id:'plan', label:'Validated project plan', passed:!!session.plan && ['model','creator_revision'].includes(session.planSource), source:'plan_validation'},
    {id:'requirements', label:'Requested features covered by the design', passed:!!session.plan?.design && session.plan.design.acceptanceCriteria?.length >= 4 && Array.isArray(session.plan.design.unsupportedFeatures) && session.plan.design.unsupportedFeatures.length === 0, source:'model_design_report'},
    {id:'assembly', label:'Studio assembly confirmed', passed:assembled, source:'studio_worker'},
    {id:'smoke', label:'Runtime smoke check passed', passed:smokePassed, source:'studio_worker_report'},
    {id:'gameplay', label:'Creator reviewed the full gameplay loop', passed:review?.gameplayPassed === true, source:'creator_attestation'},
    {id:'performance', label:'Creator reviewed performance and controls', passed:review?.performancePassed === true, source:'creator_attestation'},
    {id:'content', label:'Creator reviewed content and originality', passed:review?.contentReviewed === true, source:'creator_attestation'}
  ];
  const readyForCreatorPublish = checks.every(check => check.passed);
  const failed = session.status === 'failed' || session.playtestReport?.result === 'failed' || session.plan?.design?.unsupportedFeatures?.length > 0 || !!review && !checks.filter(check => check.source === 'creator_attestation').every(check => check.passed);
  const stage = failed ? 'needs_fixes' : readyForCreatorPublish ? 'creator_approved' : assembled ? 'needs_review' : session.status === 'building' ? 'building' : session.plan ? 'planned' : 'draft';
  return {stage, checks, blockers:checks.filter(check => !check.passed).map(check => check.label), readyForCreatorPublish, publication:review?.publishedUrl ? {url:review.publishedUrl, verified:false, source:'creator_report'} : null};
}
// The worker protocol carries executable scene geometry only. Keep reviewed design
// metadata in durable/public records while retaining compatibility with v1 workers.
// Validate the complete plan before projecting it so metadata cannot bypass checks.
function executionPlan(input) {
  const {version,template,summary,parts,presentation,project} = validatePlan(input);
  return {version,template,summary,parts,...(presentation ? {presentation} : {}),...(project ? {project} : {})};
}
function createTemplatePlan(template = 'obby') {
  if (!TEMPLATES.includes(template)) throw fail(400, 'Unknown starter template');
  const parts = [];
  function part(id, position, size, behavior = 'solid', color = [82, 106, 125], value = 1) { parts.push({ id, name: id.replace(/_/g, ' '), position, size, behavior, color, value, material: behavior === 'hazard' || behavior === 'coin' ? 'Neon' : 'SmoothPlastic' }); }
  if (template === 'obby') {
    part('start', [0, 4, 0], [20, 2, 20], 'spawn', [97, 217, 166]);
    for (let i = 1; i <= 12; i++) {
      part(`platform_${i}`, [(i % 2) * 4, 4 + Math.floor(i / 3), -i * 12], [10, 2, 10], i % 3 === 0 ? 'checkpoint' : 'solid', i % 3 === 0 ? [118, 161, 255] : [93, 109, 142], i);
      if (i % 2 === 0) part(`coin_${i}`, [(i % 2) * 4, 8 + Math.floor(i / 3), -i * 12], [2, 2, 2], 'coin', [255, 211, 79], 10);
    }
    part('hazard_floor', [0, -5, -78], [70, 2, 180], 'hazard', [235, 66, 82]);
    part('finish', [0, 9, -160], [22, 2, 20], 'finish', [220, 178, 255]);
  } else if (template === 'tycoon') {
    part('island', [0, 0, 0], [100, 2, 100], 'solid', [55, 83, 69]);
    part('start', [0, 2, 35], [12, 1, 12], 'spawn', [97, 217, 166]);
    for (let i = 0; i < 8; i++) part(`income_${i}`, [-28 + (i % 4) * 18, 4, 15 - Math.floor(i / 4) * 18], [3, 3, 3], 'coin', [255, 211, 79], 10);
    for (let i = 1; i <= 3; i++) part(`upgrade_${i}`, [-28 + i * 14, 2, -28], [10, 1, 10], 'purchase', [95, 133, 234], i * 30);
    part('finish', [30, 2, -28], [12, 1, 12], 'finish', [220, 178, 255], 3);
  } else {
    part('track', [0, 0, -160], [36, 2, 360], 'solid', [55, 59, 72]);
    part('start', [0, 2, 5], [28, 1, 10], 'spawn', [97, 217, 166]);
    for (let i = 1; i <= 8; i++) {
      part(`gate_${i}`, [0, 2, -i * 36], [30, 1, 5], 'checkpoint', [118, 161, 255], i);
      part(`barrier_${i}`, [i % 2 ? -8 : 8, 3, -i * 36 + 16], [16, 4, 4], 'solid', [235, 129, 72]);
      part(`coin_${i}`, [i % 2 ? 9 : -9, 5, -i * 36 + 16], [2, 2, 2], 'coin', [255, 211, 79], 5);
    }
    part('finish', [0, 2, -318], [30, 1, 12], 'finish', [220, 178, 255]);
  }
  return validatePlan({ version: 1, template, summary: template === 'obby' ? 'A jumping course with checkpoints, collectible coins, hazards, and a finish' : template === 'tycoon' ? 'A coin-collection tycoon starter with three purchasable upgrades and a completion pad' : 'A timed foot-racing course with ordered checkpoints, obstacles, and collectible coins', parts });
}

// Fixed, reviewed gameplay; model responses can only change validated scene data.
const { GAMEPLAY_SOURCE } = require('./builder-gameplay.cjs');

function lua(value) {
  if (typeof value === 'string') return '"' + [...Buffer.from(value, 'utf8')].map(n => n >= 32 && n <= 126 && n !== 34 && n !== 92 ? String.fromCharCode(n) : '\\' + String(n).padStart(3, '0')).join('') + '"';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '{' + value.map(lua).join(',') + '}';
  return '{' + Object.entries(value).map(([k, v]) => `[${lua(k)}]=${lua(v)}`).join(',') + '}';
}
function artifactLuau(session) {
  const projectGuard = session.plan.project ? require('./studio-worker.cjs').guardSource() + '\ngame:GetService("HttpService").HttpEnabled = false\ngame:GetService("ServerScriptService").LoadStringEnabled = false\n' : '';
  return `-- Run in a Studio plugin or the Studio command bar, after reviewing this file\n-- Creates a new isolated folder; does not publish, delete existing content, or playtest\n${projectGuard}local plan = ${lua(session.plan)}\nlocal rootName = ${lua(session.rootName)}\nassert(not workspace:FindFirstChild(rootName), "Build already exists; inspect it instead of running twice")\nif plan.presentation then\n assert(game.PlaceId == 0 and game.GameId == 0, "Use a new unpublished place for scene lighting")\n for _, existing in ipairs(workspace:GetChildren()) do assert(existing:IsA("Camera") or existing:IsA("Terrain") or existing.Name == "Baseplate" or existing:IsA("SpawnLocation"), "Use a dedicated empty place for scene lighting") end\n local lighting = game:GetService("Lighting"); lighting.ClockTime = plan.presentation.lighting.clockTime; lighting.Brightness = plan.presentation.lighting.brightness; lighting.Ambient = Color3.fromRGB(table.unpack(plan.presentation.lighting.ambient))\nend\nlocal root = Instance.new("Folder")\nroot.Name = rootName\nroot:SetAttribute("ParallaxJob", ${lua(session.jobId)})\nroot:SetAttribute("Template", plan.template)\nfor _, item in ipairs(plan.parts) do\n local p = Instance.new(item.behavior == "spawn" and "SpawnLocation" or "Part")\n p.Name = item.name; p.Anchored = true; p.Size = Vector3.new(table.unpack(item.size)); p.Position = Vector3.new(table.unpack(item.position)); p.Color = Color3.fromRGB(table.unpack(item.color)); p.Material = Enum.Material[item.material]\n p:SetAttribute("PlanId", item.id); p:SetAttribute("Behavior", item.behavior); p:SetAttribute("Value", item.value)\n if item.behavior == "coin" then p.Shape = Enum.PartType.Ball; p.CanCollide = false end\n if item.behavior == "decoration" then p.CanCollide = false; p.CanTouch = false; p.Shape = Enum.PartType[item.shape or "Block"]; if item.rotation then p.CFrame = CFrame.new(table.unpack(item.position)) * CFrame.Angles(0, math.rad(item.rotation[2]), 0) end end\n if p:IsA("SpawnLocation") then p.Neutral = true; p.Duration = 0 end\n p.Parent = root\nend\nlocal gameplay = Instance.new("Script"); gameplay.Name = "ParallaxGameplay"\ngame:GetService("ScriptEditorService"):UpdateSourceAsync(gameplay, function() return ${lua(GAMEPLAY_SOURCE)} end)\ngameplay.Parent = root\n${projectTools.installProjectSource(session,lua)}\nroot.Parent = workspace\nprint("Parallax starter assembled — press Play to test; nothing published")\n`;
}
function write(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp'; let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temp, file);
    // Windows does not support opening directories for fsync through Node.
    if (process.platform !== 'win32') { const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function parseStoredState(bytes) {
  const state = JSON.parse(bytes.toString('utf8'));
  if (!state || state.version !== 1 || !Array.isArray(state.sessions) || state.sessions.length > LIMITS.sessions || state.poolWorkers !== undefined && !Array.isArray(state.poolWorkers)) throw new Error('Invalid Roblox build state');
  const ids = new Set();
  for (const session of state.sessions) {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !/^[a-f0-9-]{36}$/.test(session.id) || ids.has(session.id) || typeof session.owner !== 'string' || !session.owner || ![...TEMPLATES,'auto'].includes(session.template) || !Array.isArray(session.events)) throw new Error('Invalid saved build record');
    ids.add(session.id); if (session.plan) validatePlan(session.plan);
    if (session.queue?.requireAgentWorker !== undefined && typeof session.queue.requireAgentWorker !== 'boolean') throw new Error('Invalid saved worker requirement');
    if (session.queue?.requireVisualReview !== undefined && typeof session.queue.requireVisualReview !== 'boolean') throw new Error('Invalid saved visual worker requirement');
    if (session.revisionFingerprint != null && !/^[a-f0-9]{64}$/.test(session.revisionFingerprint)) throw new Error('Invalid saved revision identity');
    if (session.visualReviewContext != null) visualContext(session.visualReviewContext);
    if (session.visualFrames !== undefined) {
      if (!Array.isArray(session.visualFrames) || session.visualFrames.length > 3) throw new Error('Invalid saved visual frames');
      const views = new Set();
      for (const frame of session.visualFrames) {
        if (!frame || Object.keys(frame).some(key => !['contentType','capturedAt','bytes','source','hash','jobId','view'].includes(key)) || !CAPTURE_VIEWS.includes(frame.view) || views.has(frame.view) || !/^[a-f0-9]{64}$/.test(frame.hash || '') || frame.jobId !== session.jobId || frame.source !== 'pooled_studio_worker' || !['image/png','image/jpeg'].includes(frame.contentType) || !Number.isFinite(frame.capturedAt) || !Number.isInteger(frame.bytes) || frame.bytes < 32 || frame.bytes > LIMITS.screenshot) throw new Error('Invalid saved visual frame');
        views.add(frame.view);
      }
    }
  }
  for (const session of state.sessions.filter(item => item.revisionFingerprint)) {
    const parent = state.sessions.find(item => item.id === session.lineage?.parentBuildId);
    if (!parent || parent.owner !== session.owner || !/^[a-zA-Z0-9:_-]{8,200}$/.test(session.idempotencyKey || '') || revisionIdentity({owner:session.owner,parentBuildId:parent.id,brief:session.brief,modelId:session.modelId,inspiration:session.inspiration,visualReviewContext:session.visualReviewContext || null}) !== session.revisionFingerprint) throw new Error('Saved revision body does not match its identity');
  }
  const workerIds = new Set();
  if ((state.poolWorkers?.length || 0) > 64) throw new Error('Invalid saved worker count');
  for (const worker of state.poolWorkers || []) {
    if (!worker || typeof worker.workerId !== 'string' || typeof worker.studioId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(worker.workerId) || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(worker.studioId) || workerIds.has(worker.workerId) || !['idle','busy'].includes(worker.status) || !Number.isFinite(worker.lastSeenAt)) throw new Error('Invalid saved worker');
    workerIds.add(worker.workerId);
    const modern = worker.agentProtocol === 1 && worker.planSchema === 'scene-v1' && worker.dedicatedStudio === true && Number.isFinite(worker.capabilitySeenAt);
    const legacy = [undefined,0].includes(worker.agentProtocol) && [undefined,null].includes(worker.planSchema) && [undefined,false].includes(worker.dedicatedStudio) && [undefined,null].includes(worker.capabilitySeenAt);
    if ((!modern && !legacy) || worker.oneBuildPerStudio !== undefined && typeof worker.oneBuildPerStudio !== 'boolean') throw new Error('Invalid saved worker capability');
    if (![undefined,0,1].includes(worker.visualReviewProtocol) || worker.visualReviewProtocol === 1 && (!modern || worker.oneBuildPerStudio !== true && worker.revisionReuseProtocol!==1)) throw new Error('Invalid saved visual worker capability');
    if (![undefined,0,1].includes(worker.projectProtocol)) throw new Error('Invalid saved project worker capability');
    if (![undefined,0,1].includes(worker.revisionReuseProtocol) || worker.revisionReuseProtocol===1 && worker.projectProtocol!==1 || worker.projectScope!==undefined && !/^[a-f0-9-]{36}$/.test(worker.projectScope)) throw new Error('Invalid saved revision worker capability');
  }
  return state;
}
function validBackup(file) { try { parseStoredState(fs.readFileSync(file + '.bak')); return true; } catch { return false; } }
function storageError(file) { return fail(503, 'Saved Roblox build history is unreadable or could not be saved — builds are paused and existing files are preserved ' + (validBackup(file) ? 'A saved backup is available for operator recovery' : 'No valid saved backup was found; operator recovery is required'), 'BUILD_STORAGE_UNAVAILABLE'); }
// Recovery is an explicit operator action, never a constructor fallback or HTTP route.
// Call only with the server and workers stopped. Old files are archived before replacement.
function recoverBuildState({ stateDirectory, mode = 'backup', now = Date.now } = {}) {
  if (!stateDirectory || !['backup', 'startFresh'].includes(mode)) throw fail(400, 'Choose explicit backup or startFresh storage recovery');
  const directory = path.join(stateDirectory, 'roblox-builds'), file = path.join(directory, 'sessions.json');
  let primary;
  try { primary = fs.readFileSync(file); } catch { throw storageError(file); }
  let primaryValid = false; try { parseStoredState(primary); primaryValid = true; } catch {}
  if (primaryValid) throw fail(409, 'Saved build history is valid; recovery will not replace it', 'BUILD_STORAGE_HEALTHY');
  let recovered;
  if (mode === 'backup') { try { recovered = parseStoredState(fs.readFileSync(file + '.bak')); } catch { throw storageError(file); } }
  else recovered = { version: 1, sessions: [], poolWorkers: [] };
  const stamp = crypto.randomUUID(), archivedFile = file + '.corrupt-' + stamp + '.archive';
  write(archivedFile, primary);
  let archivedBackup = null;
  if (fs.existsSync(file + '.bak')) { archivedBackup = file + '.backup-' + stamp + '.archive'; write(archivedBackup, fs.readFileSync(file + '.bak')); }
  const recoveredAt = now(); let closedJobs = 0;
  recovered.poolWorkers = [];
  for (const session of recovered.sessions) {
    const uncertain = ['queued','claimed'].includes(session.queue?.state) || session.poolLease?.state === 'active' || session.status === 'building' || (session.workerHash && !['ready','failed'].includes(session.status));
    delete session.workerHash; delete session.workerExpiresAt; session.lastWorkerAt = null;
    if (!uncertain) continue;
    closedJobs++; session.status = 'failed'; session.updatedAt = recoveredAt;
    if (session.queue) Object.assign(session.queue, {state:'failed',failedAt:recoveredAt,failureReason:'storage_recovery'});
    if (session.poolLease) Object.assign(session.poolLease, {state:'failed',endedAt:recoveredAt});
    session.events.push({id:crypto.randomUUID(),at:recoveredAt,type:'storage_recovery',message:'Recovered from saved state — prior execution is uncertain and this job will not retry automatically'});
    session.events = session.events.slice(-100);
  }
  recovered.recovery = { at: recoveredAt, mode, previousIndexPreserved: true, previousHistoryUnavailable: mode === 'startFresh', closedJobs };
  const serialized = JSON.stringify(recovered); parseStoredState(Buffer.from(serialized));
  write(file, serialized); write(file + '.bak', serialized);
  return { mode, sessions: recovered.sessions.length, closedJobs, archivedFile, archivedBackup };
}
function createRobloxBuildService({ stateDirectory, now = Date.now, workerCapacity = 2, leaseTtl = 60_000 } = {}) {
  if (!stateDirectory) throw new Error('A stateDirectory is required for durable Roblox builds');
  if (!Number.isInteger(workerCapacity) || workerCapacity < 1 || workerCapacity > 32) throw new Error('workerCapacity must be between 1 and 32');
  if (!Number.isInteger(leaseTtl) || leaseTtl < 1000 || leaseTtl > 300_000) throw new Error('leaseTtl must be between 1000 and 300000 milliseconds');
  const directory = path.join(stateDirectory, 'roblox-builds'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'sessions.json');
  let state = { version: 1, sessions: [] };
  if (fs.existsSync(file)) { try { state = parseStoredState(fs.readFileSync(file)); } catch { throw storageError(file); } }
  else if (fs.existsSync(file + '.bak')) throw storageError(file);
  if (!Array.isArray(state.poolWorkers)) state.poolWorkers = [];
  let storageFault = false;
  const save = () => {
    if (storageFault) throw storageError(file);
    try {
      const serialized = JSON.stringify(state);
      const previous = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(serialized);
      parseStoredState(previous); write(file + '.bak', previous); write(file, serialized);
    } catch { storageFault = true; throw storageError(file); }
  };
  const entry = id => { expireLeases(); const s = state.sessions.find(s => s.id === id); if (!s) throw fail(404, 'Build not found', 'BUILD_NOT_FOUND'); return s; };
  const own = (s, owner) => { if (!owner || s.owner !== owner) throw fail(403, 'This build belongs to another session', 'BUILD_OWNER_REQUIRED'); };
  const publicSession = (s, viewerOwner) => {
    const { owner, workerHash, workerExpiresAt, idempotencyKey, revisionFingerprint, poolLease, concept, thumbnail, coinIcon, visualFrames, ...view } = s;
    const projectUrl = `/api/builds/${s.id}/artifact?format=rbxlx`;
    const lineage = s.lineage || {projectId:s.id,parentBuildId:null,version:1};
    const revisions = state.sessions.filter(item => (item.lineage?.projectId || item.id) === lineage.projectId).map(item => ({id:item.id,version:item.lineage?.version || 1,parentBuildId:item.lineage?.parentBuildId || null,gameName:item.gameName,status:item.status,createdAt:item.createdAt})).sort((a,b) => b.version-a.version);
    const imageView=(image,purpose)=>image ? {...image,purpose,imageUrl:image.imageHash?`/api/builds/${s.id}/${purpose}/image?v=${image.imageHash}`:null,url:image.imageHash?`/api/builds/${s.id}/${purpose}/image?v=${image.imageHash}`:null,...(image.status==='generating'&&now()-image.lastAttemptAt>200000?{status:'interrupted',error:'Image generation was interrupted — retry explicitly when ready'}:{})} : null;
    return structuredClone({ ...view, visualFrames:frameMetadata(s).map(frame => ({...frame,url:`/api/builds/${s.id}/screen?view=${frame.view}`})), concept:imageView(concept,'concept'), thumbnail:imageView(thumbnail,'thumbnail'), coinIcon:imageView(coinIcon,'coinIcon'), lineage, revisions, readiness:buildReadiness(s), project:projectTools.manifest(s), queue: s.queue ? { ...s.queue, position: s.queue.state === 'queued' ? queued().findIndex(job => job.id === s.id) + 1 : null } : null, delivery: { available: !!s.plan, format: 'rbxlx', url: s.plan ? projectUrl : null, kind: 'generated_project', playtested: false, published: false, source: 'validated_scene_plan', studioSaved: false, projectVersion:s.plan?.project?.version||null, includesProjectSource:!!s.plan?.project }, canManage: !!viewerOwner && viewerOwner === owner, files: s.plan ? [{name:'scene.json',url:`/api/builds/${s.id}/artifact?format=json`},{name:'build.luau',url:`/api/builds/${s.id}/artifact?format=luau`},{name:'game.rbxlx',url:projectUrl}]:[], studioConnected: !!s.lastWorkerAt && now() - s.lastWorkerAt < 45_000 && !['failed', 'cancelled'].includes(s.queue?.state), workerConfigured: (!!workerHash && workerExpiresAt > now()) || poolLease?.state === 'active', playtested: false, published: false, screenshot: s.screenshot ? { ...s.screenshot, url: `/api/builds/${s.id}/screen` } : null });
  };
  const event = (s, type, message) => { s.updatedAt = now(); s.events.push({ id: crypto.randomUUID(), at: s.updatedAt, type, message }); if (s.events.length > 100) s.events.shift(); };
  const queued = () => state.sessions.filter(s => s.queue?.state === 'queued').sort((a, b) => a.queue.queuedAt - b.queue.queuedAt || a.createdAt - b.createdAt);
  const active = () => state.sessions.filter(s => s.poolLease?.state === 'active');
  function expireLeases() {
    if (storageFault) throw storageError(file);
    let changed = false;
    for (const s of active()) if (s.poolLease.expiresAt <= now()) {
      s.poolLease.state = 'failed'; s.poolLease.endedAt = now();
      s.queue.state = 'failed'; s.queue.failedAt = now(); s.queue.failureReason = 'lease_expired';
      s.status = 'failed'; s.lastWorkerAt = null;
      event(s, 'worker_lost', 'Studio worker lease expired — execution stopped being confirmed and this job will not retry automatically');
      changed = true;
    }
    if (changed) save();
  }
  function authenticateLease({ leaseId, leaseToken }) {
    expireLeases();
    const s = state.sessions.find(item => item.poolLease?.leaseId === leaseId);
    if (!s || typeof leaseToken !== 'string' || !/^[a-f0-9]{64}$/.test(leaseToken) || !crypto.timingSafeEqual(Buffer.from(hash(leaseToken)), Buffer.from(s.poolLease.tokenHash))) throw fail(401, 'Invalid Studio worker lease', 'LEASE_UNAUTHORIZED');
    if (s.poolLease.state !== 'active') throw fail(409, 'Studio worker lease is closed; it cannot mutate this build', 'LEASE_CLOSED');
    return s;
  }
  function poolIdentity(value, label) { const id = text(value, label, 100); if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) throw fail(400, `${label} contains unsupported characters`); return id; }
  function touchWorker(workerId, studioId, status = 'idle') {
    const conflicting = active().find(s => (s.poolLease.workerId === workerId && s.poolLease.studioId !== studioId) || (s.poolLease.studioId === studioId && s.poolLease.workerId !== workerId));
    if (conflicting) throw fail(409, 'That worker or Studio instance already has an active lease', 'WORKER_BUSY');
    let worker = state.poolWorkers.find(w => w.workerId === workerId);
    if (!worker) {
      if (state.poolWorkers.length >= 64) {
        const disposable = [...state.poolWorkers].filter(w => !active().some(s => s.poolLease.workerId === w.workerId) && now() - w.lastSeenAt >= 45_000).sort((a,b) => a.lastSeenAt-b.lastSeenAt)[0];
        if (!disposable) throw fail(429, 'Studio worker registration limit reached', 'WORKER_LIMIT');
        state.poolWorkers = state.poolWorkers.filter(w => w !== disposable);
      }
      worker = {workerId}; state.poolWorkers.push(worker);
    }
    if (worker.studioId && worker.studioId !== studioId) {delete worker.projectScope;Object.assign(worker, {agentProtocol:0,planSchema:null,dedicatedStudio:false,oneBuildPerStudio:false,visualReviewProtocol:0,projectProtocol:0,revisionReuseProtocol:0,capabilitySeenAt:null});}
    Object.assign(worker, {studioId, status, lastSeenAt: now()}); return worker;
  }
  function agentCompatible(worker) {
    const age = now() - worker.capabilitySeenAt;
    return worker.agentProtocol === 1 && worker.planSchema === 'scene-v1' && worker.dedicatedStudio === true && (worker.oneBuildPerStudio === true || worker.revisionReuseProtocol===1 && worker.projectProtocol===1) && Number.isFinite(worker.capabilitySeenAt) && age >= 0 && age < WORKER_FRESH_MS;
  }
  function visualCompatible(worker) { return agentCompatible(worker) && worker.visualReviewProtocol === 1; }
  function needsVisualWorker(s, required = false) { return required || s.queue?.requireVisualReview === true || !!s.plan?.project || !!s.plan?.presentation || s.plan?.parts.some(part => part.behavior === 'decoration'); }
  function workerPresence({workerId, studioId, status = 'idle', agentProtocol, planSchema, dedicatedStudio, oneBuildPerStudio, visualReviewProtocol, projectProtocol,revisionReuseProtocol}) {
    expireLeases(); workerId = poolIdentity(workerId, 'Worker ID'); studioId = poolIdentity(studioId, 'Studio ID');
    if (!['idle', 'busy'].includes(status)) throw fail(400, 'Invalid worker presence status');
    const legacy = agentProtocol === undefined && planSchema === undefined && dedicatedStudio === undefined && oneBuildPerStudio === undefined && visualReviewProtocol === undefined;
    if (!legacy && !(agentProtocol === 1 && planSchema === 'scene-v1' && dedicatedStudio === true && (oneBuildPerStudio === true || oneBuildPerStudio === false && revisionReuseProtocol===1 && projectProtocol===1))) throw fail(400, 'A one-build dedicated Studio worker or explicit project revision worker is required', 'INVALID_WORKER_CAPABILITY');
    if (visualReviewProtocol !== undefined && visualReviewProtocol !== 1) throw fail(400,'Unsupported visual worker protocol','INVALID_WORKER_CAPABILITY');
    if (projectProtocol !== undefined && (projectProtocol !== 1 || visualReviewProtocol !== 1 || legacy)) throw fail(400,'Unsupported project worker protocol','INVALID_WORKER_CAPABILITY');
    if(revisionReuseProtocol!==undefined&&(revisionReuseProtocol!==1||projectProtocol!==1||oneBuildPerStudio!==false))throw fail(400,'Unsupported revision worker protocol','INVALID_WORKER_CAPABILITY');
    const worker = touchWorker(workerId, studioId, active().some(s => s.poolLease.workerId === workerId) ? 'busy' : status);
    Object.assign(worker, legacy ? {agentProtocol:0,planSchema:null,dedicatedStudio:false,oneBuildPerStudio:false,visualReviewProtocol:0,projectProtocol:0,revisionReuseProtocol:0,capabilitySeenAt:null} : {agentProtocol:1,planSchema:'scene-v1',dedicatedStudio:true,oneBuildPerStudio,visualReviewProtocol:visualReviewProtocol ?? 0,projectProtocol:projectProtocol ?? 0,revisionReuseProtocol:revisionReuseProtocol ?? 0,capabilitySeenAt:now()});
    save(); return {...worker, online:true, agentCompatible:agentCompatible(worker),visualReviewCompatible:visualCompatible(worker)};
  }
  function queueStatus() {
    expireLeases(); const waiting = queued(); const running = active();
    const workers = state.poolWorkers.map(w => { const s = running.find(job => job.poolLease.workerId === w.workerId); return {...w, status:s?'busy':w.status, online:now()-w.lastSeenAt>=0&&now()-w.lastSeenAt<WORKER_FRESH_MS, agentCompatible:agentCompatible(w), visualReviewCompatible:visualCompatible(w), buildId:s?.id||null, leaseExpiresAt:s?.poolLease.expiresAt||null}; });
    return {capacity: workerCapacity, recovery: state.recovery || null, queued: waiting.length, active: running.length, completed: state.sessions.filter(s => s.queue?.state === 'completed').length, failed: state.sessions.filter(s => s.queue?.state === 'failed').length, workers, jobs: state.sessions.filter(s => s.queue).sort((a,b) => b.queue.queuedAt-a.queue.queuedAt).slice(0,100).map(s => ({buildId: s.id, gameName: s.gameName, ...s.queue, position: s.queue.state === 'queued' ? waiting.findIndex(job => job.id === s.id)+1 : null}))};
  }
  function canAutoEnqueue(id, {requireVisualReview = false} = {}) {
    const s = entry(id), running = active();
    if (typeof requireVisualReview !== 'boolean') throw fail(400,'Invalid visual worker requirement');
    if (!s.plan) return {eligible:false,reason:'Prepare the AI scene plan before autonomous assembly'};
    if (['building','ready','failed'].includes(s.status) || ['claimed','completed','failed'].includes(s.queue?.state)) return {eligible:false,reason:'This build is already executing or closed; automatic replay is disabled'};
    if (s.lastWorkerAt && now()-s.lastWorkerAt < WORKER_FRESH_MS) return {eligible:false,reason:'Disconnect the manual Studio bridge before autonomous assembly'};
    if (running.length >= workerCapacity) return {eligible:false,reason:'All Studio worker slots are busy'};
    const visual = needsVisualWorker(s,requireVisualReview);
    const idle = state.poolWorkers.some(w => w.status === 'idle' && now()-w.lastSeenAt >= 0 && now()-w.lastSeenAt < WORKER_FRESH_MS && agentCompatible(w) && (!visual || visualCompatible(w)) && (!s.plan.project || w.projectProtocol===1) && (!w.projectScope || w.projectScope===(s.lineage?.projectId||s.id)) && !running.some(job => job.poolLease.workerId === w.workerId || job.poolLease.studioId === w.studioId));
    return idle ? {eligible:true,reason:null} : {eligible:false,reason:visual ? 'Waiting for a fresh idle dedicated Studio worker with visual review protocol 1 and three-view capture support' : 'Waiting for a fresh idle dedicated Studio worker supporting one build per Studio, agent protocol 1 and scene-v1'};
  }
  function enqueue({id, owner, requireAgentWorker = true, requireVisualReview = false}) {
    const s = entry(id); own(s, owner);
    if (typeof requireAgentWorker !== 'boolean' || typeof requireVisualReview !== 'boolean') throw fail(400, 'Invalid autonomous worker requirement');
    if (!s.plan) throw fail(409, 'Prepare this build before joining the Studio queue', 'PLAN_REQUIRED');
    // Every queued build uses the isolated worker contract, including manual
    // requests. A client cannot downgrade that requirement with a false flag.
    const required = true;
    const visual = needsVisualWorker(s,requireVisualReview);
    if (s.queue?.state === 'queued' && s.queue.requireAgentWorker === true && (!visual || s.queue.requireVisualReview === true)) return publicSession(s, owner);
    if (['building','ready','failed'].includes(s.status) || ['claimed','completed','failed'].includes(s.queue?.state)) throw fail(409, 'This job is already executing or closed; create a new build', 'BUILD_LOCKED');
    if (s.lastWorkerAt && now() - s.lastWorkerAt < 45_000) throw fail(409, 'Disconnect the manual Studio bridge before queuing this build', 'WORKER_BUSY');
    if (required) { const availability = canAutoEnqueue(id,{requireVisualReview:visual}); if (!availability.eligible) throw fail(409, availability.reason, 'AGENT_WORKER_REQUIRED'); }
    if (s.queue?.state === 'queued') { s.queue.requireAgentWorker = true; s.queue.requireVisualReview = visual; event(s,'queue_requirement','This queued build now requires a compatible dedicated agent worker'); save(); return publicSession(s,owner); }
    delete s.workerHash; delete s.workerExpiresAt;
    s.queue = {state:'queued',queuedAt:now(),workerId:null,studioId:null,requireAgentWorker:required,requireVisualReview:visual};
    s.status = 'waiting_for_studio'; event(s, 'queue_joined', 'Joined the Studio worker queue — waiting for an available worker'); save(); return publicSession(s, owner);
  }
  function cancelQueued({id, owner}) {
    const s = entry(id); own(s, owner);
    if (s.queue?.state !== 'queued') throw fail(409, 'Only a waiting queue entry can be cancelled', 'QUEUE_NOT_WAITING');
    s.queue.state = 'cancelled'; s.queue.cancelledAt = now(); event(s, 'queue_cancelled', 'Removed from the worker queue before execution'); save(); return publicSession(s, owner);
  }
  function claim({workerId, studioId}) {
    expireLeases(); workerId = poolIdentity(workerId, 'Worker ID'); studioId = poolIdentity(studioId, 'Studio ID');
    const running = active();
    const worker = touchWorker(workerId, studioId, running.some(s => s.poolLease.workerId === workerId) ? 'busy' : 'idle');
    if (running.some(s => s.poolLease.workerId === workerId || s.poolLease.studioId === studioId) || running.length >= workerCapacity) {save(); return null;}
    // Persisted/manual jobs from older servers are protected by the same gate.
    if (!agentCompatible(worker)) {save(); return null;}
    const s = queued().find(job => (!needsVisualWorker(job) || visualCompatible(worker)) && (!job.plan.project || worker.projectProtocol===1) && (!worker.projectScope || worker.projectScope===(job.lineage?.projectId||job.id))); if (!s) {save(); return null;}
    const plan = executionPlan(s.plan);
    if(worker.revisionReuseProtocol===1)worker.projectScope=s.lineage?.projectId||s.id;
    const leaseToken = crypto.randomBytes(32).toString('hex');
    s.poolLease = {leaseId:crypto.randomUUID(),tokenHash:hash(leaseToken),state:'active',workerId,studioId,startedAt:now(),lastHeartbeatAt:now(),expiresAt:now()+leaseTtl};
    Object.assign(s.queue, {state:'claimed',workerId,studioId,claimedAt:now(),requireAgentWorker:true});
    s.status = 'building'; s.lastWorkerAt = now(); s.progress = {completed:0,total:s.plan.parts.length+1,phase:'assigned'};
    touchWorker(workerId, studioId, 'busy'); event(s, 'worker_assigned', `Studio worker ${workerId} claimed this build`); save();
    return {leaseId:s.poolLease.leaseId,leaseToken,leaseExpiresAt:s.poolLease.expiresAt,buildId:s.id,projectId:s.lineage?.projectId||s.id,jobId:s.jobId,rootName:s.rootName,gameName:s.gameName,plan,...(s.plan.project?{}:{scriptSources:[{name:'ParallaxGameplay',source:GAMEPLAY_SOURCE}],artifactLuau:artifactLuau(s)})};
  }
  function renew(s) { s.poolLease.lastHeartbeatAt = now(); s.poolLease.expiresAt = now()+leaseTtl; s.lastWorkerAt = now(); touchWorker(s.poolLease.workerId,s.poolLease.studioId,'busy'); }
  function heartbeat(args) { const s = authenticateLease(args); renew(s); save(); return {leaseId:s.poolLease.leaseId,leaseExpiresAt:s.poolLease.expiresAt,buildId:s.id}; }
  function report(args) {
    const s = authenticateLease(args); const {status,message,objectCount,playtest} = args;
    if (!['building','ready','failed'].includes(status)) throw fail(400, 'Invalid worker status');
    if (status === 'ready' && objectCount !== s.plan.parts.length+1) throw fail(400, 'Studio must report the expected assembled object count');
    if (status === 'building' && objectCount !== undefined && (!Number.isInteger(objectCount) || objectCount < (s.progress?.completed || 0) || objectCount > s.plan.parts.length+1)) throw fail(400, 'Invalid or decreasing Studio progress count');
    let testReport;
    if (playtest !== undefined) {
      if (!playtest || typeof playtest !== 'object' || !['passed','failed','not_run'].includes(playtest.result) || Object.keys(playtest).some(k => !['result','message'].includes(k))) throw fail(400, 'Invalid reported playtest result');
      testReport = {result:playtest.result,message:playtest.message ? text(playtest.message,'Playtest report',600) : 'Worker-reported runtime check',reportedAt:now(),source:'studio_worker_report',independentlyVerified:false};
    }
    const note = message ? text(message,'Worker message',600) : status === 'ready' ? 'Studio worker confirmed scene assembly' : status === 'failed' ? 'Studio worker reported a build error' : 'Studio worker is assembling scene objects';
    renew(s);
    if (s.status !== status || objectCount !== s.progress?.completed || status !== 'building') event(s,status,note);
    if (status === 'building') s.progress = {completed:objectCount ?? s.progress?.completed ?? 0,total:s.plan.parts.length+1,phase:'assembling'};
    if (testReport) s.playtestReport = testReport;
    if (status === 'ready') {s.progress={completed:objectCount,total:objectCount,phase:'assembled'};s.objectCount=objectCount;s.assembledAt=now();}
    s.status = status;
    if (status !== 'building') {s.poolLease.state=status === 'ready' ? 'completed' : 'failed'; s.poolLease.endedAt=now();s.queue.state=s.poolLease.state;s.queue[status === 'ready' ? 'completedAt' : 'failedAt']=now();touchWorker(s.poolLease.workerId,s.poolLease.studioId,'idle');}
    save(); return publicSession(s);
  }
  const authenticate = (id, workerToken) => {
    const s = entry(id); if (typeof workerToken !== 'string' || !s.workerHash || s.workerExpiresAt <= now()) throw fail(401, 'Worker token is missing or expired', 'WORKER_UNAUTHORIZED');
    if (['queued','claimed','completed','failed'].includes(s.queue?.state)) throw fail(409, 'This build is assigned to the Studio worker pool', 'POOLED_BUILD');
    const candidate = hash(workerToken); if (!crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(s.workerHash))) throw fail(401, 'Invalid worker token', 'WORKER_UNAUTHORIZED');
    return s;
  };
  function create({ owner, gameName, brief, template = 'obby', modelId = 'template', inferenceProvider = null, token = null, idempotencyKey = null, inspiration = '', revisionOf = null, revisionFingerprint = null, visualReviewContext = null }) {
    expireLeases();
    owner = text(owner, 'Owner', 200);
    if (idempotencyKey) { idempotencyKey = text(idempotencyKey, 'Idempotency key', 200); const old = state.sessions.find(s => s.owner === owner && s.idempotencyKey === idempotencyKey); if (old) return publicSession(old, owner); }
    if (![...TEMPLATES,'auto'].includes(template)) throw fail(400, 'Unknown gameplay foundation');
    const parent = revisionOf ? entry(revisionOf) : null;
    if (parent) own(parent,owner);
    if (state.sessions.length >= LIMITS.sessions || state.sessions.filter(s => s.owner === owner).length >= 25) throw fail(429, 'Build session limit reached', 'BUILD_LIMIT');
    const id = crypto.randomUUID();
    const s = { id, owner, idempotencyKey, gameName: text(gameName, 'Game name', 80), brief: text(brief, 'Game brief', LIMITS.brief), template, modelId: text(modelId, 'Model ID', 200), inferenceProvider, token:buildToken(token), status: 'queued', createdAt: now(), updatedAt: now(), rootName: 'Parallax_' + id.replaceAll('-', ''), plan: null, jobId: null, planSource: null, events: [], lastWorkerAt: null, screenshot: null };
    s.inspiration = inspiration === '' ? '' : text(inspiration, 'Reference games and inspiration', 1200);
    if (revisionFingerprint) s.revisionFingerprint = revisionFingerprint;
    if (visualReviewContext) s.visualReviewContext = visualReviewContext;
    const projectId = parent ? parent.lineage?.projectId || parent.id : id;
    s.lineage = {projectId,parentBuildId:parent?.id || null,version:parent ? Math.max(...state.sessions.filter(item => (item.lineage?.projectId || item.id) === projectId).map(item => item.lineage?.version || 1))+1 : 1};
    if (parent?.plan) s.previousDesign = {summary:parent.plan.summary,template:parent.plan.template,...(parent.plan.design ? {design:structuredClone(parent.plan.design)} : {}),...(parent.plan.project ? {project:structuredClone(parent.plan.project)} : {})};
    event(s, 'created', 'Build brief saved — no Studio changes yet'); state.sessions.push(s); save(); return publicSession(s, owner);
  }
  function revise({id,owner,brief,modelId,inspiration,idempotencyKey,visualReviewContext}) {
    const parent = entry(id); own(parent,owner);
    const chosenModel = modelId ?? (BUILDER_MODEL_IDS.includes(parent.modelId) ? parent.modelId : DEFAULT_BUILDER_MODEL_ID);
    assertBuilderModelId(chosenModel);
    brief = text(brief,'Game brief',LIMITS.brief);
    inspiration = inspiration ?? parent.inspiration ?? '';
    inspiration = inspiration === '' ? '' : text(inspiration,'Reference games and inspiration',1200);
    const context = visualContext(visualReviewContext);
    let revisionFingerprint = null;
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{8,200}$/.test(idempotencyKey)) throw fail(400,'Invalid revision idempotency key');
      revisionFingerprint = revisionIdentity({owner,parentBuildId:id,brief,modelId:chosenModel,inspiration,visualReviewContext:context});
      const existing = state.sessions.find(item => item.owner === owner && item.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.revisionFingerprint !== revisionFingerprint || existing.lineage?.parentBuildId !== id) throw fail(409,'Revision key already belongs to different inputs','REVISION_CONFLICT');
        return publicSession(existing,owner);
      }
    }
    if (['queued','claimed'].includes(parent.queue?.state) || parent.status === 'building') throw fail(409, 'Wait for this Studio build to finish or cancel its waiting queue entry before creating an update', 'BUILD_ACTIVE');
    if (context) {
      if (context.sourceBuildId !== id) throw fail(400,'Visual review belongs to another build');
      const frames = getVisualFrames(id);
      for (const frame of context.sourceFrames) if (!frames.some(current => current.view === frame.view && current.hash === frame.hash && current.jobId === frame.jobId && current.capturedAt === frame.capturedAt && current.contentType === frame.contentType && current.bytes.length === frame.bytes)) throw fail(409,'Visual review evidence changed; review current Studio captures','VISUAL_EVIDENCE_CHANGED');
    }
    return create({owner,gameName:parent.gameName,brief,template:'auto',modelId:chosenModel,inferenceProvider:parent.inferenceProvider,token:parent.token,revisionOf:parent.id,inspiration,idempotencyKey:idempotencyKey ?? null,revisionFingerprint,visualReviewContext:context});
  }
  function review({id,owner,gameplayPassed,performancePassed,contentReviewed,notes,publishedUrl = ''}) {
    const s = entry(id); own(s,owner);
    const readiness = buildReadiness(s);
    if (!readiness.checks.find(check => check.id === 'assembly').passed || !readiness.checks.find(check => check.id === 'smoke').passed) throw fail(409, 'Creator review requires confirmed Studio assembly and a passing runtime smoke check', 'REVIEW_NOT_READY');
    for (const [name,value] of Object.entries({gameplayPassed,performancePassed,contentReviewed})) if (typeof value !== 'boolean') throw fail(400, `${name} must be true or false`);
    let canonicalUrl = null;
    if (publishedUrl !== '') {
      const raw = text(publishedUrl,'Published Roblox URL',500); let parsed;
      try { parsed = new URL(raw); } catch { throw fail(400,'Enter an HTTPS Roblox game URL'); }
      const placeId = /^\/games\/([1-9]\d*)(?:\/[^/]+)?\/?$/.exec(parsed.pathname)?.[1];
      if (parsed.protocol !== 'https:' || !['roblox.com','www.roblox.com'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password || !placeId) throw fail(400,'Enter an HTTPS Roblox game URL');
      canonicalUrl = `https://www.roblox.com/games/${placeId}`;
    }
    const creatorReview = {gameplayPassed,performancePassed,contentReviewed,notes:text(notes,'Creator review notes',2000),publishedUrl:canonicalUrl,reviewedAt:now(),source:'creator_attestation',publicationVerified:false};
    s.creatorReview = creatorReview;
    event(s,'creator_review',gameplayPassed && performancePassed && contentReviewed ? 'Creator recorded gameplay, performance, and content approval — Roblox publication is not independently verified' : 'Creator recorded issues requiring another game revision');
    save(); return publicSession(s,owner);
  }
  function projectFiles({id,owner}) {
    const s=entry(id);own(s,owner);if(!s.plan?.project)throw fail(409,'This earlier build has no editable project scripts','PROJECT_REQUIRED');
    return {buildId:id,manifest:projectTools.manifest(s),files:structuredClone(s.plan.project.scripts)};
  }
  function updateProjectFile({id,owner,fileId,target,source,expectedHash,idempotencyKey}) {
    const parent=entry(id);own(parent,owner);
    if(!parent.plan)throw fail(409,'Prepare the game before editing project code','PLAN_REQUIRED');
    if(typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(idempotencyKey))throw fail(400,'A source revision idempotency key is required');
    if(expectedHash!==projectTools.hash(JSON.stringify(parent.plan)))throw fail(409,'The project changed; reload its files before saving','PROJECT_CHANGED');
    const candidate=structuredClone(parent.plan);candidate.version=2;
    candidate.project ||= {version:1,scripts:[],components:{environment:[],hud:{title:parent.gameName,accent:[123,250,202],panel:[12,20,34]}}};
    const at=candidate.project.scripts.findIndex(s=>s.id===fileId);
    const updated={id:fileId,target,source};if(at<0)candidate.project.scripts.push(updated);else candidate.project.scripts[at]=updated;
    const plan=validatePlan(candidate),requestHash=projectTools.hash(JSON.stringify({id,expectedHash,fileId,target,source}));
    const existing=state.sessions.find(s=>s.owner===owner&&s.sourceEdit?.idempotencyKey===idempotencyKey);
    if(existing){if(existing.sourceEdit.requestHash!==requestHash)throw fail(409,'Source revision key already belongs to different code','REVISION_CONFLICT');return publicSession(existing,owner);}
    const child=revise({id,owner,brief:parent.brief,modelId:parent.modelId,inspiration:parent.inspiration});
    const s=entry(child.id);s.plan=plan;s.template=plan.template;s.planSource='creator_revision';s.jobId=crypto.randomUUID();s.status='waiting_for_studio';
    s.sourceEdit={sourceBuildId:id,sourceHash:expectedHash,requestHash,idempotencyKey,fileId,editedAt:now()};
    event(s,'source_edited','Creator saved a new project code version; earlier files and Studio scenes remain unchanged');save();return publicSession(s,owner);
  }
  function beginConcept({id,owner,purpose='concept',modelId,modelName,prompt,artDirection,estimatedCostUsd}) {
    const s=entry(id);own(s,owner);purpose=imagePurpose(purpose);
    if(s[purpose]?.status==='generating'&&now()-s[purpose].lastAttemptAt<200000)throw fail(409,'An image is already being generated');
    if(s[purpose]?.lastAttemptAt!=null&&now()-s[purpose].lastAttemptAt<30000)throw fail(429,'Wait 30 seconds between image requests');
    const old=s[purpose];
    s[purpose]={purpose,status:'generating',title:purpose==='thumbnail'?'Game thumbnail':'Visual target',source:'ai_generated',isGameplay:false,modelId:text(modelId,'Image model',200),modelName:text(modelName,'Image model name',200),prompt:old?.imageHash?old.prompt:text(prompt,'Image prompt',12000),requestedPrompt:text(prompt,'Image prompt',12000),artDirection:artDirection||'',estimatedCostUsd,lastAttemptAt:now(),createdAt:old?.createdAt||null,generatedAt:old?.generatedAt||null,imageHash:old?.imageHash||null,contentType:old?.contentType||null};
    event(s,purpose+'_requested',purpose==='thumbnail'?'Game thumbnail requested — original promotional art separate from Studio output':'Concept image requested — this visual target is separate from Studio output');save();return publicSession(s,owner);
  }
  function finishConcept({id,owner,purpose='concept',bytes,contentType,modelId,modelName,prompt,artDirection,costUsd,estimatedCostUsd,generatedAt}) {
    const s=entry(id);own(s,owner);purpose=imagePurpose(purpose);
    if(s[purpose]?.status!=='generating')throw fail(409,'No image request is active');
    const data=Buffer.from(bytes),verifiedType=rasterType(data);if(contentType!==verifiedType)throw fail(400,'Concept image type mismatch');
    const imageHash=hash(data),saved={purpose,status:'ready',title:purpose==='thumbnail'?'Game thumbnail':'Visual target',source:'ai_generated',isGameplay:false,modelId:text(modelId,'Image model',200),modelName:text(modelName,'Image model name',200),prompt:text(prompt,'Image prompt',12000),artDirection:artDirection||'',costUsd,estimatedCostUsd,imageHash,contentType:verifiedType,bytes:data.length,lastAttemptAt:s[purpose].lastAttemptAt,generatedAt,createdAt:generatedAt};
    write(path.join(directory,`${s.id}.${imageHash}.${purpose}`),data);s[purpose]=saved;
    event(s,purpose+'_ready',purpose==='thumbnail'?'AI game thumbnail saved — promotional key art, not a gameplay capture':'AI concept image saved — a design target, not a gameplay capture');save();return publicSession(s,owner);
  }
  function failConcept({id,owner,purpose='concept',message}) {
    const s=entry(id);own(s,owner);purpose=imagePurpose(purpose);
    if(s[purpose]?.status!=='generating')return publicSession(s,owner);
    s[purpose].status='failed';s[purpose].error=text(message,'Image generation error',500);
    event(s,purpose+'_failed','Image generation did not complete — Studio and existing game files are unchanged');save();return publicSession(s,owner);
  }
  function getConceptImage(id,purpose='concept') {
    const s=entry(id);purpose=imagePurpose(purpose);const concept=s[purpose];
    if(!concept?.imageHash||!/^[a-f0-9]{64}$/.test(concept.imageHash))throw fail(404,'No concept image has been generated');
    let bytes;try{bytes=fs.readFileSync(path.join(directory,`${s.id}.${concept.imageHash}.${purpose}`));}catch{throw fail(404,'The saved image is unavailable');}
    if(hash(bytes)!==concept.imageHash)throw fail(503,'The saved image failed its integrity check');
    return {bytes,contentType:rasterType(bytes)};
  }
  function attachLaunchArtwork({id,owner,artwork}) {
    const s=entry(id);own(s,owner);
    if(!artwork||!/^[a-f0-9-]{36}$/.test(artwork.id)||artwork.status!=='ready'||artwork.name!==s.gameName||artwork.brief!==s.brief||artwork.ticker!==s.token?.symbol||s.token?.verified!==true)throw fail(409,'Artwork does not match this confirmed game coin');
    if(s.launchArtworkId){if(s.launchArtworkId!==artwork.id)throw fail(409,'This game already has different launch artwork');return publicSession(s,owner);}
    const saved={};
    for(const purpose of ['thumbnail','coinIcon']){
      const source=artwork[purpose],data=Buffer.from(source?.bytes||[]),contentType=rasterType(data),imageHash=hash(data);
      if(source?.status!=='ready'||contentType!==source.contentType||imageHash!==source.hash)throw fail(409,'Launch artwork failed its integrity check');
      saved[purpose]={purpose,status:'ready',title:purpose==='thumbnail'?'Game thumbnail':'Coin icon',source:'ai_generated',isGameplay:false,launchArtworkId:artwork.id,imageHash,contentType,bytes:data.length,modelId:text(source.modelId,'Image model',200),modelName:text(source.modelName,'Image model name',200),prompt:text(source.prompt,'Image prompt',16000),artDirection:artwork.artDirection||'',costUsd:source.costUsd,estimatedCostUsd:source.estimatedCostUsd,width:source.width,height:source.height,generatedAt:source.generatedAt,createdAt:source.generatedAt};
    }
    for(const purpose of ['thumbnail','coinIcon'])write(path.join(directory,`${s.id}.${saved[purpose].imageHash}.${purpose}`),artwork[purpose].bytes);
    s.thumbnail=saved.thumbnail;s.coinIcon=saved.coinIcon;s.launchArtworkId=artwork.id;
    event(s,'launch_artwork_attached','Launch thumbnail and coin icon saved — AI promotional artwork, separate from Studio gameplay');save();return publicSession(s,owner);
  }
  function prepare({ id, owner, plan, source, modelId, inferenceProvider }) {
    const s = entry(id); own(s, owner);
    if (s.status === 'building' || s.status === 'ready') throw fail(409, 'This job is already being applied or has been assembled', 'BUILD_LOCKED');
    if (s.plan) throw fail(409, 'This job already has a plan; create a new build to change it', 'BUILD_LOCKED');
    const validated = plan ? validatePlan(plan) : createTemplatePlan(s.template);
    if (s.template !== 'auto' && validated.template !== s.template) throw fail(400, 'Model plan must keep the selected template');
    s.template = validated.template;
    s.plan = validated; s.planSource = plan && source === 'ai' ? 'model' : plan ? 'custom_plan' : 'starter_template'; s.jobId = crypto.randomUUID(); s.status = 'waiting_for_studio';
    if (modelId) s.modelId = text(modelId, 'Model ID', 200); if (inferenceProvider) s.inferenceProvider = text(inferenceProvider, 'Inference provider', 40);
    event(s, 'planned', s.planSource === 'model' ? 'Model scene plan validated — waiting for Studio' : 'Starter scene prepared — waiting for Studio'); save(); return publicSession(s, owner);
  }
  function issueWorkerToken({ id, owner }) {
    const s = entry(id); own(s, owner);
    if (needsVisualWorker(s)) throw fail(409,'Use the current Studio worker for visual scene features','VISUAL_WORKER_REQUIRED');
    if (['queued','claimed','completed','failed'].includes(s.queue?.state)) throw fail(409, 'This build is assigned to the Studio worker pool', 'POOLED_BUILD');
    const workerToken = crypto.randomBytes(32).toString('hex');
    s.workerHash = hash(workerToken); s.workerExpiresAt = now() + LIMITS.workerTtl; event(s, 'worker_token', 'Studio connection token issued — previous token revoked'); save();
    return { workerToken, sessionId: id, expiresAt: s.workerExpiresAt };
  }
  function poll({ id, workerToken }) {
    const s = authenticate(id, workerToken);
    if (needsVisualWorker(s)) throw fail(409,'Use the current Studio worker for visual scene features','VISUAL_WORKER_REQUIRED');
    const plan = s.plan && ['waiting_for_studio', 'building'].includes(s.status) ? executionPlan(s.plan) : null;
    const first = !s.lastWorkerAt; s.lastWorkerAt = now();
    if (first) event(s, 'studio_connected', 'Studio bridge connected'); save();
    return { sessionId: id, status: s.status, job: plan ? { id: s.jobId, rootName: s.rootName, gameName: s.gameName, plan, scriptSources: [{ name: 'ParallaxGameplay', source: GAMEPLAY_SOURCE }] } : null };
  }
  function acknowledge({ id, workerToken, jobId, status, message, objectCount }) {
    const s = authenticate(id, workerToken);
    if (!s.jobId || jobId !== s.jobId) throw fail(409, 'The acknowledgment belongs to another job', 'WRONG_JOB');
    if (!['building', 'ready', 'failed'].includes(status)) throw fail(400, 'Invalid worker status');
    if (s.status === 'ready' && status !== 'ready') throw fail(409, 'Completed build cannot return to an earlier state', 'BUILD_LOCKED');
    if (s.status === 'failed') throw fail(409, 'Failed build is closed; create a new job', 'BUILD_LOCKED');
    if (status === 'ready' && objectCount !== s.plan.parts.length + 1) throw fail(400, 'Studio must report the expected assembled object count');
    if (status === 'building' && objectCount !== undefined && (!Number.isInteger(objectCount) || objectCount < 0 || objectCount > s.plan.parts.length+1)) throw fail(400, 'Invalid Studio progress count');
    const note = message ? text(message, 'Worker message', 600) : status === 'ready' ? 'Studio confirmed scene assembly — playtest and publish remain manual' : status === 'building' ? 'Studio is applying scene objects' : 'Studio reported a build error';
    s.lastWorkerAt = now();
    if (s.status !== status || (status === 'building' && objectCount !== undefined && objectCount !== s.progress?.completed)) event(s, status, note);
    if (status === 'building') s.progress = {completed:objectCount ?? s.progress?.completed ?? 0,total:s.plan.parts.length+1,phase:'assembling'};
    if (status === 'ready') s.progress = {completed:objectCount,total:objectCount,phase:'assembled'};
    s.status = status;
    if (status === 'ready') { s.objectCount = objectCount; s.assembledAt = now(); } save(); return publicSession(s);
  }
  function frameMetadata(s) {
    return (s.visualFrames || []).filter(frame => CAPTURE_VIEWS.includes(frame.view) && frame.jobId === s.jobId && frame.source === 'pooled_studio_worker' && /^[a-f0-9]{64}$/.test(frame.hash || '')).slice(0,3);
  }
  function framePath(s, frame) { return path.join(directory,`${s.id}.${frame.view}.${frame.hash}.screen`); }
  function getVisualFrames(id) {
    const s = entry(id);
    return frameMetadata(s).map(frame => {
      let bytes;
      try { bytes = fs.readFileSync(framePath(s,frame)); } catch { throw fail(404,'A saved Studio view is unavailable','VISUAL_FRAME_UNAVAILABLE'); }
      if (bytes.length !== frame.bytes || hash(bytes) !== frame.hash) throw fail(409,'A saved Studio view failed integrity validation','VISUAL_FRAME_CHANGED');
      return {...frame,bytes};
    });
  }
  function saveScreenshot(s, bytes, contentType, source, captureView) {
    const data = Buffer.from(bytes || []);
    if (data.length < 32 || data.length > LIMITS.screenshot) throw fail(413, 'Screenshot must be between 32 bytes and 2 MB');
    const png = contentType === 'image/png' && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = contentType === 'image/jpeg' && data[0] === 255 && data[1] === 216 && data[2] === 255 && data.at(-2) === 255 && data.at(-1) === 217;
    if (!png && !jpg) throw fail(415, 'Only PNG or JPEG screenshots are accepted');
    if (captureView !== undefined && (!CAPTURE_VIEWS.includes(captureView) || source !== 'pooled_studio_worker')) throw fail(400,'Invalid worker capture view');
    const metadata = {contentType,capturedAt:now(),bytes:data.length,source,hash:hash(data),jobId:s.jobId};
    if (captureView !== undefined) {
      const frame = {...metadata,view:captureView};
      write(framePath(s,frame),data);
      s.visualFrames = [...frameMetadata(s).filter(item => item.view !== captureView),frame].sort((a,b) => CAPTURE_VIEWS.indexOf(a.view)-CAPTURE_VIEWS.indexOf(b.view));
    }
    if (captureView === undefined || captureView === 'overview') {
      write(path.join(directory, `${s.id}.screen`), data); s.screenshot = metadata;
    }
    save();
    return captureView ? publicSession(s).visualFrames.find(frame => frame.view === captureView) : publicSession(s).screenshot;
  }
  function screenshot({ id, owner, workerToken, bytes, contentType }) {
    const s = workerToken ? authenticate(id, workerToken) : entry(id); if (!workerToken) own(s, owner);
    if (!workerToken && s.queue?.state === 'claimed') throw fail(409, 'A pooled Studio worker owns this active screen', 'POOLED_BUILD');
    return saveScreenshot(s, bytes, contentType, workerToken ? 'connected_worker' : 'owner_screen_share');
  }
  function workerScreenshot(args) {
    const s = authenticateLease(args);
    const previous = frameMetadata(s).find(frame => frame.view === args.captureView);
    const result = saveScreenshot(s,args.bytes,args.contentType,'pooled_studio_worker',args.captureView);
    renew(s); save();
    // Both committed state and its backup now name the new frame. Only then
    // remove an obsolete image; cleanup failure must not invalidate a capture.
    if (previous && previous.hash !== result.hash) { try { fs.rmSync(framePath(s,previous),{force:true}); } catch {} }
    return result;
  }
  return {
    create, revise, review, projectFiles, updateProjectFile, beginConcept, finishConcept, failConcept, getConceptImage, attachLaunchArtwork, prepare, issueWorkerToken, poll, acknowledge, screenshot,
    enqueue, canAutoEnqueue, cancelQueued, queueStatus, claim, heartbeat, report, workerScreenshot, workerPresence, getVisualFrames,
    list(owner) { expireLeases(); return state.sessions.filter(s => !owner || s.owner === owner).sort((a, b) => b.createdAt - a.createdAt).map(s => publicSession(s, owner)); },
    get(id, { owner } = {}) { return publicSession(entry(id), owner); },
    appendEvent({id, owner, type = 'activity', message}) { const s = entry(id); own(s,owner); event(s,text(type,'Event type',40),text(message,'Event message',600)); save(); return publicSession(s,owner); },
    stopScreen({id, owner}) { const s = entry(id); own(s,owner); if(s.queue?.state === 'claimed') throw fail(409, 'A pooled Studio worker owns this active screen', 'POOLED_BUILD'); for (const frame of frameMetadata(s)) fs.rmSync(framePath(s,frame),{force:true}); s.visualFrames = []; if(s.screenshot) fs.rmSync(path.join(directory, `${s.id}.screen`), {force:true}); s.screenshot = null; save(); return publicSession(s,owner); },
    getScreenshot(id, {view} = {}) { if (view !== undefined) { if (!CAPTURE_VIEWS.includes(view)) throw fail(400,'Unknown Studio view'); const frame = getVisualFrames(id).find(frame => frame.view === view); if (!frame) throw fail(404,'This Studio view is unavailable'); return frame; } const s = entry(id); if (!s.screenshot) throw fail(404, 'No worker screenshot has been received'); return { bytes: fs.readFileSync(path.join(directory, `${s.id}.screen`)), contentType: s.screenshot.contentType }; },
    artifact({ id, owner, format = 'json' }) { const s = entry(id); if(owner !== undefined) own(s,owner); if (!s.plan) throw fail(409, 'Prepare this build first'); if (!['json', 'luau','rbxlx'].includes(format)) throw fail(400, 'Choose json or luau or rbxlx'); return { content: format === 'rbxlx' ? artifactPlace(s,GAMEPLAY_SOURCE,lua) : format === 'luau' ? artifactLuau(s) : JSON.stringify(s.plan, null, 2), contentType: format === 'rbxlx' ? 'application/xml; charset=utf-8' : format === 'luau' ? 'text/plain; charset=utf-8' : 'application/json', filename: `parallax-${s.template}-${s.id}.${format}` }; },
  };
}
module.exports = { createRobloxBuildService, recoverBuildState, createTemplatePlan, validatePlan, GAMEPLAY_SOURCE, LIMITS };

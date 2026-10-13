'use strict';

// This runner authorizes bounded work, never publication. Provider wrappers must
// compose the supplied durable budget hooks with the server's daily ledger.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {assertBuilderModelId} = require('./builder-models.cjs');
const FILE_NAME = 'builder-agents.json';
const MAX_RUNS = 500, MAX_ACTIVE = 4, MAX_BUDGET_USD = 1;
const HARD_BUDGET_USD = 25;
const STAGES = ['prompt','planning','concept','thumbnail','assembly','smoke','visual_review','review','failure'];
const PAID_STAGES = ['planning','concept','thumbnail','visual_review'];
const REVIEW_CATEGORIES = ['composition','readability','lighting','materials','scale','gameplay','other'];
const STATUSES = ['running','paused','review','failed','interrupted'];
const fail = (message, status = 409, code = 'AGENT_CONFLICT') => Object.assign(new Error(message), {status,code});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fingerprint = build => hash(JSON.stringify({id:build.id,brief:build.brief,gameName:build.gameName,modelId:build.modelId,inspiration:build.inspiration || '',previousDesign:build.previousDesign || null}));
const dollars = value => Math.round(value * 1e8) / 1e8;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const storageError = () => fail('Agent history is unreadable or changed; autonomous work is paused and existing files are preserved',503,'AGENT_STORAGE_UNAVAILABLE');
const currentId = run => run.currentBuildId || run.buildId;
const objectKeys = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>keys.includes(key));
function visualReview(value) {
  const invalid=()=>{throw fail('The visual reviewer returned an invalid structured result',502,'VISUAL_REVIEW_INVALID');};
  const exact=(object,keys)=>object && typeof object==='object' && !Array.isArray(object) && Object.keys(object).length===keys.length && Object.keys(object).every(key=>keys.includes(key));
  if(!exact(value,['version','verdict','summary','issues','revisionBrief']) || value.version!==1 || !['improve','acceptable'].includes(value.verdict) || typeof value.summary!=='string' || !value.summary.trim() || Buffer.byteLength(value.summary)>800 || !Array.isArray(value.issues) || value.issues.length>6 || typeof value.revisionBrief!=='string' || Buffer.byteLength(value.revisionBrief)>1800) invalid();
  if(value.issues.some(issue=>!exact(issue,['category','description']) || !REVIEW_CATEGORIES.includes(issue.category) || typeof issue.description!=='string' || !issue.description.trim() || Buffer.byteLength(issue.description)>500)) invalid();
  if(value.verdict==='improve' && (!value.revisionBrief.trim() || !value.issues.length) || value.verdict==='acceptable' && value.revisionBrief!=='') invalid();
  return structuredClone(value);
}
function snapshot(build) {
  return hash(JSON.stringify({fingerprint:fingerprint(build),plan:build.plan,jobId:build.jobId,screenshot:build.screenshot,concept:build.concept,thumbnail:build.thumbnail,queue:build.queue?.state,playtest:build.playtestReport}));
}
function validFrameMetadata(frames) {
  return Array.isArray(frames) && frames.length>0 && frames.length<=3 && new Set(frames.map(frame=>frame?.view)).size===frames.length && frames.every(frame=>objectKeys(frame,['view','hash','jobId','capturedAt','bytes','contentType','source']) && ['overview','spawn','finish'].includes(frame.view) && /^[a-f0-9]{64}$/.test(frame.hash) && uuid(frame.jobId) && Number.isFinite(frame.capturedAt) && Number.isInteger(frame.bytes) && frame.bytes>=32 && frame.bytes<=2*1024*1024 && ['image/png','image/jpeg'].includes(frame.contentType) && frame.source==='pooled_studio_worker');
}

function decode(bytes) {
  const state = JSON.parse(bytes.toString('utf8'));
  if(state?.version !== 1 || !Array.isArray(state.runs) || state.runs.length > MAX_RUNS) throw storageError();
  const ids = new Set(), builds = new Set();
  for(const run of state.runs) {
    // Existing approvals never gain paid visual work merely because the server updated.
    if(run.includeVisualReview===undefined)run.includeVisualReview=false;if(run.currentBuildId===undefined)run.currentBuildId=run.buildId;if(run.visualRevisionCount===undefined)run.visualRevisionCount=0;if(run.visualReviews===undefined)run.visualReviews=[];if(run.maxVisualRevisions===undefined)run.maxVisualRevisions=1;
    if(!uuid(run.runId) || !uuid(run.buildId) || !uuid(run.currentBuildId) || ids.has(run.runId) || builds.has(run.buildId) || builds.has(run.currentBuildId) || typeof run.owner !== 'string' || !run.owner || run.owner.length > 200 || !STATUSES.includes(run.status) || !STAGES.includes(run.stage) || !money(run.budgetUsd) || run.budgetUsd < .01 || run.budgetUsd > HARD_BUDGET_USD || !Number.isFinite(run.startedAt) || !Number.isFinite(run.updatedAt) || typeof run.pauseRequested !== 'boolean' || typeof run.includeConcept !== 'boolean' || typeof run.includeThumbnail !== 'boolean' || typeof run.includeVisualReview!=='boolean' || !/^[a-f0-9]{64}$/.test(run.fingerprint) || !Number.isInteger(run.repairAttempts) || run.repairAttempts < 0 || run.repairAttempts > 1 || !Array.isArray(run.charges) || run.charges.length > 8 || !Array.isArray(run.history) || run.history.length > 80 || run.maxVisualRevisions!==1 || ![0,1].includes(run.visualRevisionCount) || !Array.isArray(run.visualReviews) || run.visualReviews.length>2) throw storageError();
    if(run.rootFingerprint!==undefined && !/^[a-f0-9]{64}$/.test(run.rootFingerprint) || run.pausedSnapshot && !/^[a-f0-9]{64}$/.test(run.pausedSnapshot)) throw storageError();
    if(run.visualRevisionCount===0 && run.currentBuildId!==run.buildId || run.visualRevisionCount===1 && run.currentBuildId===run.buildId) throw storageError();
    if(!run.includeVisualReview && (run.visualRevisionCount || run.visualReviews.length || run.pendingRevision) || run.visualRevisionCount && !/^[a-f0-9]{64}$/.test(run.rootFingerprint)) throw storageError();
    const reviewedIds=new Set();
    for(const review of run.visualReviews) {if(!objectKeys(review,['buildId','reviewedAt','modelId','modelName','referenceHash','sourceFrames','result']) || !uuid(review.buildId) || ![run.buildId,run.currentBuildId].includes(review.buildId) || reviewedIds.has(review.buildId) || !Number.isFinite(review.reviewedAt) || review.modelId!==run.modelId || review.modelName!==undefined && (typeof review.modelName!=='string' || review.modelName.length>200) || review.referenceHash!==undefined && !/^[a-f0-9]{64}$/.test(review.referenceHash) || !validFrameMetadata(review.sourceFrames)) throw storageError();visualReview(review.result);reviewedIds.add(review.buildId);}
    if(run.pendingRevision && (!objectKeys(run.pendingRevision,['id','idempotencyKey','brief','modelId','inspiration','visualReviewContext']) || run.visualRevisionCount!==0 || !run.includeVisualReview || run.pendingRevision.id!==run.currentBuildId || typeof run.pendingRevision.idempotencyKey!=='string' || run.pendingRevision.idempotencyKey!==`agent-visual-${run.runId}-1` || typeof run.pendingRevision.brief!=='string' || run.pendingRevision.brief.length>2400 || run.pendingRevision.modelId!==run.modelId || typeof run.pendingRevision.inspiration!=='string' || run.pendingRevision.inspiration.length>1200)) throw storageError();
    assertBuilderModelId(run.modelId);
    ids.add(run.runId); builds.add(run.buildId);builds.add(run.currentBuildId);
    const chargeIds = new Set();
    for(const charge of run.charges) {
      if(!uuid(charge.id) || !uuid(charge.actionId) || chargeIds.has(charge.id) || !PAID_STAGES.includes(charge.stage) || !['reserved','settled','unknown'].includes(charge.status) || !money(charge.estimate) || charge.estimate <= 0 || charge.estimate > HARD_BUDGET_USD || charge.actual !== null && !money(charge.actual)) throw storageError();
      chargeIds.add(charge.id);
    }
    if(run.action && (run.status!=='running' || !PAID_STAGES.includes(run.action.kind) || !Number.isFinite(run.action.startedAt) || !uuid(run.action.id) || run.action.fingerprint !== run.fingerprint)) throw storageError();
    if(run.charges.some(c=>c.status==='reserved' && c.actionId!==run.action?.id)) throw storageError();
    if(run.history.some(row=>!Number.isFinite(row.at) || !STAGES.includes(row.stage) || typeof row.message !== 'string' || row.message.length > 800)) throw storageError();
  }
  return state;
}

function createBuilderAgentService({stateDirectory,getBuilds,generatePlan,generateConcept,reviewVisual,provider='openrouter',canEnqueue,now=Date.now,maxBudgetUsd=MAX_BUDGET_USD} = {}) {
  if(!Number.isFinite(maxBudgetUsd)||maxBudgetUsd<.01||maxBudgetUsd>HARD_BUDGET_USD)throw fail('Invalid operator agent budget cap',500);
  if(typeof stateDirectory !== 'string' || !stateDirectory || typeof getBuilds !== 'function') throw fail('Durable builder storage is required',500);
  fs.mkdirSync(stateDirectory,{recursive:true,mode:0o700});
  const file = path.join(stateDirectory,FILE_NAME);
  let state = {version:1,runs:[]}, diskHash = null, storageFault = false, closed = false, ticking = null;
  if(fs.existsSync(file)) {
    try {const bytes=fs.readFileSync(file);state=decode(bytes);diskHash=hash(bytes);} catch {throw storageError();}
  }
  const recovered = new Set(state.runs.filter(run=>run.status==='running' && run.action).map(run=>run.runId));
  const executing = new Set();

  function assertStorage() {
    if(storageFault) throw storageError();
    try {
      const current=fs.existsSync(file)?hash(fs.readFileSync(file)):null;
      if(current!==diskHash) throw storageError();
    } catch {storageFault=true;throw storageError();}
  }
  function save() {
    assertStorage();
    const temporary = file+'.'+crypto.randomUUID()+'.tmp'; let fd;
    try {
      const bytes = JSON.stringify(state); decode(Buffer.from(bytes));
      fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temporary,file);diskHash=hash(bytes);
    } catch {storageFault=true;throw storageError();}
    finally {if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  function costs(run) {
    const spentUsd=dollars(run.charges.reduce((sum,c)=>sum+(c.status==='reserved'?0:c.actual===null?c.estimate:c.actual),0));
    const reservedUsd=dollars(run.charges.reduce((sum,c)=>sum+(c.status==='reserved'?c.estimate:0),0));
    const unknown=run.charges.filter(c=>c.status==='unknown');
    return {spentUsd,reservedUsd,unknownChargeUsd:dollars(unknown.reduce((sum,c)=>sum+c.estimate,0)),unknownChargeCount:unknown.length,remainingUsd:Math.max(0,dollars(run.budgetUsd-spentUsd-reservedUsd))};
  }
  function view(run,owner) {
    if(!run) return null;
    const {owner:privateOwner,fingerprint:privateFingerprint,rootFingerprint,pausedSnapshot,pendingRevision,charges,action,repairFeedback,...data}=run;
    return structuredClone({...data,...costs(run),maxRepairAttempts:1,visualLoopVersion:run.includeVisualReview?1:null,canManage:!!owner && owner===privateOwner,publication:'not_published'});
  }
  const find = id => state.runs.find(run=>run.buildId===id || currentId(run)===id);
  function buildFor(id,owner) {
    const build=getBuilds().get(id,{owner});
    if(!owner || !build.canManage) throw fail('This build belongs to another creator',403,'BUILD_OWNER_REQUIRED');
    return build;
  }
  function checkpoint(run,patch,message) {
    const changed=Object.entries(patch).some(([key,value])=>run[key]!==value) || message && run.message!==message;
    if(!changed) return;
    Object.assign(run,patch,{updatedAt:now()});
    if(message) {run.message=message;run.history.push({at:now(),stage:run.stage,message});if(run.history.length>80)run.history.shift();}
    save();
  }
  function stop(run,status,message,code) {
    if(status==='paused') run.pausedSnapshot=snapshot(buildFor(currentId(run),run.owner));
    for(const charge of run.charges) if(charge.status==='reserved') {charge.status='unknown';charge.actual=null;}
    checkpoint(run,{status,stage:status==='paused'?run.stage:'failure',finishedAt:now(),action:null,waitingForWorker:false,error:code?{code,message}:null},message);
  }
  function pauseBoundary(run) {
    if(!run.pauseRequested && !closed) return false;
    stop(run,'paused','Agent paused at a safe boundary; saved work and spending records are retained');return true;
  }
  function ensureDesign(build) {
    assertBuilderModelId(build.modelId);
    if(!build.plan || !['model','creator_revision'].includes(build.planSource) || !build.plan.design || !Array.isArray(build.plan.design.unsupportedFeatures) || !Array.isArray(build.plan.design.acceptanceCriteria) || build.plan.design.acceptanceCriteria.length<4) throw fail('A complete advanced-model design is required; create a new prompt revision',409,'DESIGN_REQUIRED');
    if(build.plan.design.unsupportedFeatures.length) throw fail('The requested design includes unsupported features; revise the prompt before Studio assembly',409,'UNSUPPORTED_FEATURES');
  }
  function start({id,owner,includeConcept,includeThumbnail,includeVisualReview,budgetUsd,maxVisualRevisions} = {}) {
    if(closed) throw fail('The agent service is stopping',503,'AGENT_CLOSED');
    assertStorage();
    let build=buildFor(id,owner);const old=find(id);assertBuilderModelId(build.modelId);
    if(old) {
      if(old.owner!==owner) throw fail('This agent belongs to another creator',403);
      if(old.status==='running' || old.status==='review') return view(old,owner);
      if(old.status!=='paused') throw fail('Create a new prompt revision after a failed or interrupted agent run; saved work is preserved',409,'AGENT_REVISION_REQUIRED');
      if(budgetUsd!==undefined && budgetUsd!==old.budgetUsd || includeConcept!==undefined && includeConcept!==old.includeConcept || includeThumbnail!==undefined && includeThumbnail!==old.includeThumbnail || includeVisualReview!==undefined && includeVisualReview!==old.includeVisualReview || maxVisualRevisions!==undefined && maxVisualRevisions!==old.maxVisualRevisions) throw fail('Resume keeps the original approved budget, artwork and visual review choices',409,'AGENT_APPROVAL_UNCHANGED');
      build=buildFor(currentId(old),owner);
      if(fingerprint(build)!==old.fingerprint) throw fail('The saved prompt changed; create a new revision',409,'AGENT_BUILD_CHANGED');
      if(state.runs.filter(run=>run.status==='running').length>=MAX_ACTIVE) throw fail('The autonomous builder queue is full',429,'AGENT_LIMIT');
      if(build.workerConfigured || build.status==='building' || ['queued','claimed'].includes(build.queue?.state) || build.concept?.status==='generating' || build.thumbnail?.status==='generating') throw fail('Finish or disconnect the existing manual build activity before resuming the agent');
      if(build.status==='failed' || build.queue?.state==='failed') throw fail('A failed Studio workspace requires a new prompt revision',409,'AGENT_REVISION_REQUIRED');
      if(old.pausedSnapshot && snapshot(build)!==old.pausedSnapshot) throw fail('This workspace changed while the agent was paused; create a new revision to approve further work',409,'AGENT_BUILD_CHANGED');
      checkpoint(old,{status:'running',pauseRequested:false,finishedAt:null,error:null},'Agent resumed within its original remaining budget');return view(old,owner);
    }
    includeConcept=includeConcept ?? true;includeThumbnail=includeThumbnail ?? true;includeVisualReview=includeVisualReview ?? typeof reviewVisual==='function';budgetUsd=budgetUsd ?? 1;
    if(typeof includeConcept!=='boolean' || typeof includeThumbnail!=='boolean' || typeof includeVisualReview!=='boolean' || maxVisualRevisions!==undefined && maxVisualRevisions!==1 || !money(budgetUsd) || budgetUsd<.01 || budgetUsd>maxBudgetUsd) throw fail('Choose artwork and visual review options and an agent budget between $0.01 and $'+maxBudgetUsd.toFixed(2),400,'AGENT_BUDGET_INVALID');
    if(includeVisualReview && typeof reviewVisual!=='function') throw fail('Visual review is not configured for this server',503,'VISUAL_REVIEW_UNAVAILABLE');
    if(state.runs.length>=MAX_RUNS || state.runs.filter(run=>run.status==='running').length>=MAX_ACTIVE) throw fail('The autonomous builder queue is full',429,'AGENT_LIMIT');
    if(build.workerConfigured || build.status==='building' || ['queued','claimed'].includes(build.queue?.state) || ['generating'].includes(build.concept?.status) || ['generating'].includes(build.thumbnail?.status)) throw fail('Finish or disconnect the existing manual build activity before starting the agent');
    if(build.status==='failed' || build.queue?.state==='failed') throw fail('A failed Studio workspace requires a new prompt revision',409,'AGENT_REVISION_REQUIRED');
    const run={runId:crypto.randomUUID(),buildId:id,currentBuildId:id,owner,modelId:build.modelId,fingerprint:fingerprint(build),rootFingerprint:fingerprint(build),status:'running',stage:'prompt',pauseRequested:false,includeConcept,includeThumbnail,includeVisualReview,maxVisualRevisions:1,visualRevisionCount:0,visualReviews:[],budgetUsd:dollars(budgetUsd),startedAt:now(),updatedAt:now(),finishedAt:null,repairAttempts:0,action:null,charges:[],history:[],waitingForWorker:false,message:'Creator approved a bounded agent run; no publication is authorized',error:null};
    run.history.push({at:now(),stage:run.stage,message:run.message});state.runs.push(run);save();return view(run,owner);
  }
  function pause({id,owner} = {}) {
    assertStorage();
    buildFor(id,owner);const run=find(id);
    if(!run || run.owner!==owner) throw fail('No agent run exists for this creator',404);
    if(run.status!=='running') return view(run,owner);
    checkpoint(run,{pauseRequested:true},'Pause requested; any current provider request or claimed Studio job must finish safely');
    const build=buildFor(currentId(run),owner);
    if(build.queue?.state==='queued') getBuilds().cancelQueued({id:currentId(run),owner});
    if(!run.action && build.queue?.state!=='claimed' && !executing.has(run.runId)) pauseBoundary(run);
    return view(run,owner);
  }
  function budgetHooks(run) {
    let charge=null;
    return {
      reserve(estimate) {
        if(closed || run.pauseRequested) throw fail('Agent paused before the next provider request',409,'AGENT_PAUSED');
        if(charge || !money(estimate) || estimate<=0 || estimate>HARD_BUDGET_USD) throw fail('The provider did not supply a valid bounded estimate',402,'AGENT_COST_INVALID');
        if(estimate>costs(run).remainingUsd) throw fail('The next step exceeds this run’s approved remaining budget',402,'AGENT_BUDGET_EXHAUSTED');
        charge={id:crypto.randomUUID(),actionId:run.action.id,stage:run.action.kind,estimate:dollars(estimate),actual:null,status:'reserved',at:now()};run.charges.push(charge);save();
        let released=false;
        return ()=>{if(released)return;released=true;if(charge.status==='reserved'){charge.status='unknown';charge.actual=null;save();}};
      },
      settle(estimate,actual) {
        if(!charge || charge.status!=='reserved' || Math.abs(charge.estimate-estimate)>1e-7 || actual!==null && !money(actual)) throw fail('Provider accounting did not match the reserved agent work',503,'AGENT_ACCOUNTING_INVALID');
        charge.actual=actual===null?null:dollars(actual);charge.status=actual===null?'unknown':'settled';save();
      }
    };
  }
  function recoverAction(run,build) {
    for(const charge of run.charges) if(charge.status==='reserved') {charge.status='unknown';charge.actual=null;}
    const action=run.action;let adopted=false;
    if(action.fingerprint===fingerprint(build) && action.kind!=='visual_review') {
      if(action.kind==='planning') adopted=!!build.plan && build.planSource==='model' && build.modelId===run.modelId && !action.baseline.plan;
      else {const image=build[action.kind];adopted=image?.status==='ready' && !!image.imageHash && image.lastAttemptAt>=action.startedAt && (image.imageHash!==action.baseline.imageHash || image.generatedAt>action.baseline.generatedAt);}
    }
    recovered.delete(run.runId);
    if(!adopted) {stop(run,'interrupted','The previous provider request has no matching saved result; no paid request will be repeated automatically','AGENT_INTERRUPTED');return;}
    run.action=null;save();
    if(run.includeVisualReview && costs(run).unknownChargeCount) {stop(run,'interrupted','Recovered saved work but its provider cost is uncertain; no automatic paid work will continue','AGENT_INTERRUPTED');return;}
    if(pauseBoundary(run)) return;
    checkpoint(run,{},'Recovered the matching saved result without making another paid request');
  }
  function observationFrames(build) {
    if(typeof getBuilds().getVisualFrames!=='function') throw fail('The Studio worker must save actual game screenshots before visual review',409,'VISUAL_EVIDENCE_REQUIRED');
    const frames=getBuilds().getVisualFrames(build.id);
    if(!Array.isArray(frames) || !frames.length || frames.length>3) throw fail('The Studio worker must save actual game screenshots before visual review',409,'VISUAL_EVIDENCE_REQUIRED');
    const views=new Set();
    return frames.map(frame=>{
      if(!['overview','spawn','finish'].includes(frame.view) || views.has(frame.view) || !Buffer.isBuffer(frame.bytes) || frame.bytes.length<32 || frame.bytes.length>2*1024*1024 || !['image/png','image/jpeg'].includes(frame.contentType) || frame.source!=='pooled_studio_worker' || !Number.isFinite(frame.capturedAt) || frame.jobId!==build.jobId || frame.hash!==hash(frame.bytes)) throw fail('Visual review requires verified screenshots from this build’s actual Studio job',409,'VISUAL_EVIDENCE_REQUIRED');
      views.add(frame.view);return {view:frame.view,hash:frame.hash,capturedAt:frame.capturedAt,bytes:frame.bytes.length,contentType:frame.contentType,source:frame.source,jobId:frame.jobId};
    });
  }
  function sameFrames(a,b) {return JSON.stringify(a)===JSON.stringify(b);}
  function ensureSmoke(build) {
    ensureDesign(build);
    if(!build.readiness?.checks?.find(check=>check.id==='assembly')?.passed || !build.readiness?.checks?.find(check=>check.id==='smoke')?.passed) throw fail('Confirmed assembly and a passing runtime smoke check are required; human review cannot replace a failed or missing check',409,'SMOKE_REQUIRED');
  }
  function reviewRecord(raw,run,build,sourceFrames) {
    const keys=['version','verdict','summary','issues','revisionBrief'],metadata=['evidence','modelId','modelName','reviewedAt','referenceHash'];
    if(!raw || typeof raw!=='object' || Array.isArray(raw) || Object.keys(raw).some(key=>!keys.includes(key) && !metadata.includes(key))) throw fail('Unexpected visual review fields',502,'VISUAL_REVIEW_INVALID');
    const result=visualReview(Object.fromEntries(keys.map(key=>[key,raw[key]])));
    if(raw.modelId!==undefined && raw.modelId!==run.modelId || raw.modelName!==undefined && (typeof raw.modelName!=='string' || raw.modelName.length>200) || raw.reviewedAt!==undefined && !Number.isFinite(raw.reviewedAt) || raw.referenceHash!==undefined && raw.referenceHash!==null && !/^[a-f0-9]{64}$/.test(raw.referenceHash)) throw fail('Visual review provenance does not match this run',502,'VISUAL_REVIEW_INVALID');
    if(raw.evidence!==undefined && (!Array.isArray(raw.evidence) || raw.evidence.length!==sourceFrames.length || new Set(raw.evidence.map(item=>item?.view)).size!==sourceFrames.length || raw.evidence.some(item=>!item || !sourceFrames.some(frame=>item.view===frame.view && (item.hash || item.imageHash)===frame.hash && item.capturedAt===frame.capturedAt && item.jobId===frame.jobId)))) throw fail('Visual review evidence does not match the actual Studio frames',502,'VISUAL_REVIEW_INVALID');
    return {buildId:build.id,reviewedAt:now(),modelId:run.modelId,...(raw.modelName?{modelName:raw.modelName}:{}),...(raw.referenceHash?{referenceHash:raw.referenceHash}:{}),sourceFrames,result};
  }
  async function paid(run,build,kind) {
    let sourceFrames;
    if(kind==='visual_review') {ensureSmoke(build);sourceFrames=observationFrames(build);}
    run.action={id:crypto.randomUUID(),kind,startedAt:now(),fingerprint:run.fingerprint,baseline:{plan:!!build.plan,imageHash:build[kind]?.imageHash || null,generatedAt:build[kind]?.generatedAt ?? -1}};save();
    const actionId=run.action.id;
    const hooks=budgetHooks(run);executing.add(run.runId);
    try {
      if(kind==='planning') {
        if(typeof generatePlan!=='function') throw fail('AI game planning is unavailable',503);
        const context=run.repairFeedback?{...build,repairFeedback:run.repairFeedback}:build;
        const plan=await generatePlan({build:context,modelId:run.modelId,operationId:actionId,...hooks});
        if(!run.charges.some(c=>c.actionId===actionId)) throw fail('The provider did not record its generation cost',503,'AGENT_ACCOUNTING_INVALID');
        assertStorage();getBuilds().prepare({id:currentId(run),owner:run.owner,plan,source:'ai',modelId:run.modelId,inferenceProvider:provider});
      } else if(kind==='visual_review') {
        if(typeof reviewVisual!=='function') throw fail('Visual review is unavailable on this server',503,'VISUAL_REVIEW_UNAVAILABLE');
        const result=await reviewVisual({build,modelId:run.modelId,operationId:actionId,...hooks});
        if(!run.charges.some(c=>c.actionId===actionId)) throw fail('The visual reviewer did not record its generation cost',503,'AGENT_ACCOUNTING_INVALID');
        assertStorage();const current=buildFor(currentId(run),run.owner);ensureSmoke(current);
        if(fingerprint(current)!==run.fingerprint || !sameFrames(sourceFrames,observationFrames(current))) throw fail('Studio evidence changed while the model was reviewing it; saved charges are retained',409,'VISUAL_EVIDENCE_CHANGED');
        run.visualReviews.push(reviewRecord(result,run,build,sourceFrames));
      } else {
        if(typeof generateConcept!=='function') throw fail('AI artwork generation is unavailable',503);
        const result=await generateConcept({build,purpose:kind,operationId:actionId,...hooks,onStart:metadata=>{assertStorage();return getBuilds().beginConcept({id:currentId(run),owner:run.owner,...metadata,purpose:kind});}});
        if(!run.charges.some(c=>c.actionId===actionId)) throw fail('The provider did not record its generation cost',503,'AGENT_ACCOUNTING_INVALID');
        assertStorage();getBuilds().finishConcept({id:currentId(run),owner:run.owner,...result,purpose:kind});
      }
      for(const charge of run.charges) if(charge.status==='reserved') {charge.status='unknown';charge.actual=null;}
      run.action=null;save();
      if(run.includeVisualReview && run.charges.some(c=>c.actionId===actionId && c.status==='unknown')) {stop(run,'interrupted','Provider completion or cost is uncertain; no visual review or revision will be retried automatically','AGENT_INTERRUPTED');return;}
      if(pauseBoundary(run)) return;
      checkpoint(run,{},kind==='planning'?'Advanced-model design saved and validated':kind==='concept'?'Concept image saved as the visual design target':kind==='visual_review'?'AI visual critique saved with the actual Studio screenshot evidence':'Game thumbnail saved as promotional artwork');
    } catch(error) {
      if(storageFault) throw error;
      const charges=run.charges.filter(c=>c.actionId===actionId);
      for(const charge of run.charges) if(charge.status==='reserved') {charge.status='unknown';charge.actual=null;}
      const known=charges.length>0 && charges.every(c=>c.status==='settled' && c.actual!==null);
      if(['concept','thumbnail'].includes(kind)) {try{getBuilds().failConcept({id:currentId(run),owner:run.owner,purpose:kind,message:'Agent artwork generation did not complete; inspect the saved spending record'});}catch{}}
      run.action=null;save();
      if(error.code==='AGENT_PAUSED') {pauseBoundary(run);return;}
      const current=getBuilds().get(currentId(run),{owner:run.owner});
      if(kind==='planning' && error.code==='PLAN_VALIDATION_FAILED' && error.repairable===true && known && run.repairAttempts===0 && !current.plan && !current.queue && !current.lastWorkerAt && !run.pauseRequested && !closed) {
        checkpoint(run,{repairAttempts:1,repairFeedback:String(error.repairFeedback || error.message || 'Return one valid supported scene').slice(0,600)},'The plan failed validation before Studio changed; one bounded repair is permitted within the same budget');return;
      }
      const uncertain=charges.some(c=>c.status==='unknown');
      stop(run,uncertain?'interrupted':'failed',uncertain?'Provider completion or cost is uncertain; saved reservations are retained and no paid retry will run':String(error.message || 'Agent step failed').slice(0,600),uncertain?'AGENT_INTERRUPTED':error.code || 'AGENT_STEP_FAILED');
    } finally {executing.delete(run.runId);}
  }
  async function step(run) {
    if(run.status!=='running') return;
    assertStorage();
    let build=buildFor(currentId(run),run.owner);
    if(currentId(run)!==run.buildId && fingerprint(buildFor(run.buildId,run.owner))!==run.rootFingerprint) {stop(run,'failed','The original approved game prompt changed during visual improvement','AGENT_BUILD_CHANGED');return;}
    if(fingerprint(build)!==run.fingerprint) {stop(run,'failed','The saved prompt or model changed during this run','AGENT_BUILD_CHANGED');return;}
    if(recovered.has(run.runId)) {recoverAction(run,build);return;}
    if(run.includeVisualReview && costs(run).unknownChargeCount) {stop(run,'interrupted','Unknown provider costs must be resolved before any further autonomous work','AGENT_INTERRUPTED');return;}
    if(run.pauseRequested || closed) {
      if(build.queue?.state==='queued') getBuilds().cancelQueued({id:currentId(run),owner:run.owner});
      if(build.queue?.state==='claimed') {checkpoint(run,{},'Pause requested; the claimed Studio job may finish but no next stage will start');return;}
      pauseBoundary(run);return;
    }
    if(build.status==='failed' || build.queue?.state==='failed') {stop(run,'failed','Studio execution failed or became uncertain; create a new revision with a fresh worker','STUDIO_FAILED');return;}
    if(run.stage==='prompt') {checkpoint(run,{stage:run.includeVisualReview && run.includeConcept && !build.plan?'concept':'planning'},'Inspecting the saved prompt and advanced builder model');return;}
    if(run.stage==='planning') {
      if(!build.plan) {await paid(run,build,'planning');return;}
      ensureDesign(build);checkpoint(run,{stage:'concept'},'Supported gameplay requirements are represented in the validated design');return;
    }
    if(run.stage==='concept' || run.stage==='thumbnail') {
      const kind=run.stage,conceptFirst=kind==='concept' && run.includeVisualReview && !build.plan && run.visualRevisionCount===0;
      if(!conceptFirst) ensureDesign(build);
      const enabled=run.visualRevisionCount===0 && (kind==='concept'?run.includeConcept:run.includeThumbnail);
      if(enabled && build[kind]?.status!=='ready') {await paid(run,build,kind);return;}
      checkpoint(run,{stage:conceptFirst?'planning':kind==='concept'?'thumbnail':'assembly'},enabled?'Saved artwork is available':run.visualRevisionCount?'The revision keeps its original visual reference without buying duplicate artwork':'This artwork step was excluded from the approved run');return;
    }
    if(run.stage==='assembly') {
      ensureDesign(build);
      if(build.queue?.state==='completed' || build.status==='ready') {checkpoint(run,{stage:'smoke',waitingForWorker:false},'Studio assembly finished; checking the worker runtime report');return;}
      if(['queued','claimed'].includes(build.queue?.state)) {
        if(build.queue.requireAgentWorker!==true) throw fail('This job is not protected by the modern dedicated worker requirement',409,'AGENT_WORKER_REQUIRED');
        checkpoint(run,{waitingForWorker:build.queue.state==='queued'},build.queue.state==='queued'?'Waiting in the dedicated agent worker queue':'A dedicated Studio worker is assembling the game');return;
      }
      const eligibility=typeof canEnqueue==='function'?canEnqueue(build,{requireVisualReview:run.includeVisualReview}):{eligible:false,reason:'A compatible dedicated Studio worker is required'};
      if(!eligibility?.eligible) {checkpoint(run,{waitingForWorker:true},String(eligibility?.reason || 'Waiting for an available dedicated Studio worker').slice(0,600));return;}
      assertStorage();getBuilds().enqueue({id:currentId(run),owner:run.owner,requireAgentWorker:true,requireVisualReview:run.includeVisualReview});
      checkpoint(run,{waitingForWorker:true},'Queued once for a compatible dedicated Studio worker');return;
    }
    if(run.stage==='smoke') {
      ensureSmoke(build);
      if(run.includeVisualReview) {observationFrames(build);checkpoint(run,{stage:'visual_review',waitingForWorker:false},'Inspecting actual Studio screenshots against the game brief and visual target');return;}
      checkpoint(run,{status:'review',stage:'review',finishedAt:now(),waitingForWorker:false},'Build and worker smoke check completed; creator gameplay, performance and content review are still required before manual publication');
      return;
    }
    if(run.stage==='visual_review') {
      ensureSmoke(build);const frames=observationFrames(build);
      const review=run.visualReviews.find(item=>item.buildId===build.id);
      if(!review) {await paid(run,build,'visual_review');return;}
      if(!sameFrames(frames,review.sourceFrames)) throw fail('Studio evidence changed after visual review; create a new revision for further review',409,'VISUAL_EVIDENCE_CHANGED');
      if(review.result.verdict==='acceptable' || run.visualRevisionCount>=run.maxVisualRevisions) {
        checkpoint(run,{status:'review',stage:'review',finishedAt:now(),waitingForWorker:false},review.result.verdict==='acceptable'?'AI visual review found no required revision; creator gameplay, performance and content review are still required before manual publication':'The bounded visual improvement pass is complete with unresolved visual issues; inspect both versions and the saved critique before any manual publication');return;
      }
      if(costs(run).unknownChargeCount) {stop(run,'interrupted','Unknown provider costs must be resolved before any further paid work','AGENT_INTERRUPTED');return;}
      const original=buildFor(run.buildId,run.owner);
      // Preserve every original requirement, including Unicode text. The bounded
      // structured critique accompanies the full brief rather than truncating it.
      const request={id:build.id,idempotencyKey:`agent-visual-${run.runId}-1`,brief:original.brief,modelId:run.modelId,inspiration:original.inspiration || '',visualReviewContext:{version:1,sourceBuildId:build.id,sourceFrames:review.sourceFrames,originalBrief:original.brief,review:review.result}};
      if(!run.pendingRevision) {run.pendingRevision=request;save();}
      else if(JSON.stringify(run.pendingRevision)!==JSON.stringify(request)) throw fail('The saved visual revision request no longer matches the approved game and screenshot critique',409,'AGENT_REVISION_MISMATCH');
      assertStorage();const child=getBuilds().revise({...run.pendingRevision,owner:run.owner});
      if(!child?.canManage || child.lineage?.parentBuildId!==build.id || child.modelId!==run.modelId || child.brief!==run.pendingRevision.brief) throw fail('The visual revision did not match the saved authorized request',409,'AGENT_REVISION_MISMATCH');
      checkpoint(run,{currentBuildId:child.id,fingerprint:fingerprint(child),visualRevisionCount:1,pendingRevision:null,stage:'planning',waitingForWorker:false,repairFeedback:null,pausedSnapshot:null},'Created one separate visual improvement version; the original Studio scene, coin lineage and shared spending cap are preserved');
    }
  }
  function tick() {
    if(ticking) return ticking;
    if(closed || storageFault) return Promise.resolve();
    ticking=(async()=>{for(const run of state.runs.filter(item=>item.status==='running')) {
      if(closed) break;
      try {await step(run);} catch(error) {if(storageFault)throw error;stop(run,'failed',String(error.message || 'Agent execution stopped').slice(0,600),error.code || 'AGENT_STEP_FAILED');}
    }})().finally(()=>{ticking=null;});return ticking;
  }
  function assertManualAllowed(id) {assertStorage();if(find(id)?.status==='running')throw fail('Pause the autonomous agent before making manual changes to this workspace',409,'AGENT_ACTIVE');}
  function close() {
    if(closed) return ticking || Promise.resolve();closed=true;
    for(const run of state.runs.filter(item=>item.status==='running')) pause({id:run.buildId,owner:run.owner});
    return ticking || Promise.resolve();
  }
  return {start,pause,tick,get:(id,{owner}={})=>view(find(id),owner),assertManualAllowed,close};
}

module.exports={createBuilderAgentService,FILE_NAME,MAX_BUDGET_USD};

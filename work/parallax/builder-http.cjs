'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const {BUILDER_MODEL_IDS,DEFAULT_BUILDER_MODEL_ID,MAX_BUILD_PLAN_ESTIMATE,listBuilderModels,selectBuilderModel,estimateBuildPlan}=require('./builder-models.cjs');

function createBuildRouter({stateDirectory,buildOutputTokens=6000,buildPlanMaxEstimateUsd=MAX_BUILD_PLAN_ESTIMATE,maxAgentBudgetUsd=1,publicOrigin=null,getPublishing,getLaunchConfig,getService,getAgentService,getCompute,reconcileFee,walletSession,walletSessions,authorizeMutation,json,readJson,getModels,generatePlan,getConceptModels,generateConcept,provider,providerName,configured,visualReviewEnabled=false,modelReserveMultiplier=1,now=Date.now}){
  const designJobs=new Set();
  const conceptJobs=new Set();
  let secret=crypto.randomBytes(32);
  let poolKey=null;
  if(stateDirectory){
    fs.mkdirSync(stateDirectory,{recursive:true});const p=path.join(stateDirectory,'builder-cookie.key');
    try{secret=fs.readFileSync(p);if(secret.length!==32)throw fail('Workspace identity storage is unavailable',503);}
    catch(e){if(e.code!=='ENOENT')throw e;fs.writeFileSync(p,secret,{flag:'wx'});}
  }
  // This credential is for local trusted worker processes, never browser clients.
  function authenticatePool(req){
    if(!stateDirectory)throw fail('Persistent worker storage is required',503);
    if(req.headers.origin)throw fail('Worker endpoints are unavailable to browser scripts',403);
    if(!poolKey){
      const p=path.join(stateDirectory,'studio-pool.key');
      try{poolKey=fs.readFileSync(p,'utf8').trim();}
      catch(e){if(e.code!=='ENOENT')throw e;poolKey=crypto.randomBytes(32).toString('hex');fs.writeFileSync(p,poolKey,{flag:'wx',mode:0o600});}
      if(!/^[a-f0-9]{64}$/.test(poolKey))throw fail('Studio worker credential storage is unavailable',503);
    }
    const supplied=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];
    if(!supplied||!crypto.timingSafeEqual(Buffer.from(poolKey,'hex'),Buffer.from(supplied,'hex')))throw fail('Studio pool worker authentication required',401);
  }
  function ensurePoolCredential(){
    if(!stateDirectory)return;
    const p=path.join(stateDirectory,'studio-pool.key');
    if(!fs.existsSync(p))fs.writeFileSync(p,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  }
  function localOwner(req,res){
    const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('parallax_builder='))?.slice(17)||'';
    const [id,signature]=raw.split('.');
    const sign=value=>crypto.createHmac('sha256',secret).update(value).digest('hex');
    if(/^[a-f0-9]{48}$/.test(id||'')&&/^[a-f0-9]{64}$/.test(signature||'')&&crypto.timingSafeEqual(Buffer.from(sign(id),'hex'),Buffer.from(signature,'hex')))return 'local:'+id;
    const fresh=crypto.randomBytes(24).toString('hex');
    res.setHeader('Set-Cookie',`parallax_builder=${fresh}.${sign(fresh)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${publicOrigin&&req.headers.host===new URL(publicOrigin).host?'; Secure':''}`);
    return 'local:'+fresh;
  }
  const identities=(req,res)=>[...(walletSessions?walletSessions(req):[walletSession?.(req)]).map(session=>session?.address),localOwner(req,res)].filter(Boolean);
  function owned(req,res,id){
    for(const owner of identities(req,res)){if(getService().get(id,{owner}).canManage)return owner;}
    throw fail('Connect the launching wallet or use the browser that created this workspace',403);
  }
  function publicBuild(req,res,id){
    const owners=identities(req,res);let b=getService().get(id),viewer;
    for(const owner of owners){const candidate=getService().get(id,{owner});if(candidate.canManage){b=candidate;viewer=owner;break;}}
    return agentBuild(b,viewer);
  }
  function agentBuild(build,owner){const release=getPublishing?.().latest(build.id);return {...build,...(release?{publicationReceipt:release,readiness:{...build.readiness,publication:{url:release.url,verified:true,source:'roblox_open_cloud',versionNumber:release.versionNumber,publicAccessVerified:false}}}:{}),agent:getAgentService?getAgentService().get(build.id,{owner}):null};}
  function bearer(req){const match=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'');if(!match)throw fail('Connect the Studio bridge with its workspace token',401);return match[1];}
  async function bytes(req,limit=700000){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>limit)throw fail('Screen frame is too large',413);chunks.push(c);}return Buffer.concat(chunks);}
  function file(res,content,type,filename){res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store',...(filename?{'Content-Disposition':`attachment; filename="${filename}"`}:{})});res.end(content);}
  return async function route(req,res,url,host){
    if(!url.pathname.startsWith('/api/builds'))return false;
    const service=getService();
    if(url.pathname==='/api/builds/config'&&req.method==='GET'){
      localOwner(req,res);ensurePoolCredential();json(res,200,{provider,providerName,configured,screenMode:'worker_or_owner_frames',apiVersion:2,creationMode:'prompt',workerPlanSchema:'scene-v1',projectProtocol:1,revisionReuseProtocol:1,workerPlanSchemas:['scene-v1','scene-v2'],projectFiles:true,customScripts:true,customHud:true,manualQueueRequiresAgentWorker:true,oneBuildPerStudio:true,coinNetwork:'solana',coinCluster:getLaunchConfig?getLaunchConfig().cluster:'devnet',mainnetAvailable:getLaunchConfig?getLaunchConfig().mainnetAvailable===true:false,revisions:true,releaseReview:true,conceptGeneration:typeof generateConcept==='function',thumbnailGeneration:typeof generateConcept==='function',autonomousBuilds:typeof getAgentService==='function',visualReviewVersion:visualReviewEnabled?1:0,visualSceneVersion:1,maxVisualRevisions:1,visualCaptureViews:['overview','spawn','finish'],maxAgentBudgetUsd,agentWorkerProtocol:1,computeAccounting:typeof getCompute==='function',supportedGameplay:['obby','tycoon','racing'],persistentStorage:!!stateDirectory,pool:service.queueStatus()});return true;
    }
    if(url.pathname==='/api/builds/pool'&&req.method==='GET'){ensurePoolCredential();json(res,200,service.queueStatus());return true;}
    const poolAction=/^\/api\/builds\/pool\/(presence|claim|heartbeat|report|screen)$/.exec(url.pathname)?.[1];
    if(poolAction){
      if(req.method!=='POST')throw fail('Method not allowed',405);
      authenticatePool(req);
      if(poolAction==='screen'){
        json(res,200,service.workerScreenshot({leaseId:req.headers['x-parallax-lease'],leaseToken:req.headers['x-parallax-lease-token'],bytes:await bytes(req,2*1024*1024),contentType:req.headers['content-type'],captureView:req.headers['x-ropad-capture-view']||'overview'}));return true;
      }
      const input=await readJson(req,8192);
      if(poolAction==='presence'){json(res,200,service.workerPresence({workerId:input.workerId,studioId:input.studioId,status:input.status,agentProtocol:input.agentProtocol,planSchema:input.planSchema,dedicatedStudio:input.dedicatedStudio,oneBuildPerStudio:input.oneBuildPerStudio,visualReviewProtocol:input.visualReviewProtocol,projectProtocol:input.projectProtocol,revisionReuseProtocol:input.revisionReuseProtocol}));return true;}
      if(poolAction==='claim'){json(res,200,{job:service.claim({workerId:input.workerId,studioId:input.studioId})});return true;}
      if(poolAction==='heartbeat'){json(res,200,service.heartbeat({leaseId:input.leaseId,leaseToken:input.leaseToken}));return true;}
      json(res,200,service.report({leaseId:input.leaseId,leaseToken:input.leaseToken,status:input.status,message:input.message,objectCount:input.objectCount,playtest:input.playtest}));return true;
    }
    if(url.pathname==='/api/builds/models'&&req.method==='GET'){
      const data=listBuilderModels(await getModels()).map(m=>{const estimate=estimateBuildPlan(m,modelReserveMultiplier,buildOutputTokens);return {id:m.id,name:m.name,pricing:m.pricing,estimatedPlanCostUsd:Number.isFinite(estimate)?estimate:null,withinPlanAllowance:Number.isFinite(estimate)&&estimate<=buildPlanMaxEstimateUsd};});
      json(res,200,{provider,providerName,configured,defaultModelId:DEFAULT_BUILDER_MODEL_ID,allowedModelIds:BUILDER_MODEL_IDS,maxPlanEstimateUsd:buildPlanMaxEstimateUsd,outputTokenAllowance:buildOutputTokens,data});return true;
    }
    if(url.pathname==='/api/builds/concept-models'&&req.method==='GET'){
      if(!getConceptModels)throw fail('Concept image generation is unavailable on this server',503);
      json(res,200,await getConceptModels());return true;
    }
    if(url.pathname==='/api/builds/bridge'&&req.method==='GET'){
      file(res,fs.readFileSync(path.join(__dirname,'roblox-studio-bridge.luau')),'text/plain; charset=utf-8','ParallaxStudioBridge.luau');return true;
    }
    if(url.pathname==='/api/builds'&&req.method==='GET'){
      const owners=identities(req,res);json(res,200,{builds:service.list().map(b=>{for(const owner of owners){const c=service.get(b.id,{owner});if(c.canManage)return agentBuild(c,owner);}return agentBuild(b);})});return true;
    }
    if(url.pathname==='/api/builds'&&req.method==='POST'){
      authorizeMutation(req,host);const input=await readJson(req,8192),owner=identities(req,res)[0];
      if(publicOrigin&&owner.startsWith('local:'))throw fail('Connect and verify your creator wallet before creating a public project',401);
      if(input.template!==undefined&&input.template!=='auto')throw fail('Game starters have been removed — describe the game in your prompt');
      const modelId=input.modelId??DEFAULT_BUILDER_MODEL_ID;
      selectBuilderModel(await getModels(),modelId);
      const b=service.create({owner,gameName:input.gameName,brief:input.brief,template:'auto',modelId,inferenceProvider:provider,inspiration:input.inspiration});
      json(res,201,{build:service.get(b.id,{owner})});return true;
    }
    const match=/^\/api\/builds\/([a-f0-9-]{36})(?:\/(prepare|generate|compute|project(?:\/file)?|publication(?:\/prepare|\/publish)?|fees\/reconcile|(?:concept|thumbnail)(?:\/image)?|coinIcon\/image|agent(?:\/start|\/pause)?|revisions|review|connect|enqueue|cancel-queue|artifact|screen|screen-stop|worker(?:\/ack|\/screenshot)?))?$/.exec(url.pathname);
    if(!match)throw fail('Unknown build endpoint',404);
    const [,id,action]=match;
    if(action==='worker'&&req.method==='GET'){json(res,200,service.poll({id,workerToken:bearer(req)}));return true;}
    if(action==='worker/ack'&&req.method==='POST'){const input=await readJson(req,4096);json(res,200,service.acknowledge({id,workerToken:bearer(req),jobId:input.jobId,status:input.status,message:input.message,objectCount:input.objectCount}));return true;}
    if(action==='worker/screenshot'&&req.method==='POST'){json(res,200,service.screenshot({id,workerToken:bearer(req),bytes:await bytes(req),contentType:req.headers['content-type']}));return true;}
    if(!action&&req.method==='GET'){json(res,200,{build:publicBuild(req,res,id)});return true;}
    if(action==='agent'&&req.method==='GET'){const build=publicBuild(req,res,id);json(res,200,{build,agent:build.agent});return true;}
    if(action==='project'&&req.method==='GET'){const owner=owned(req,res,id);json(res,200,service.projectFiles({id,owner}));return true;}
    if(action==='publication'&&req.method==='GET'){const owner=owned(req,res,id);if(!getPublishing)throw fail('Roblox publishing service is unavailable',503);json(res,200,getPublishing().status({buildId:id,owner}));return true;}
    if(action==='compute'&&req.method==='GET'){
      if(!getCompute)throw fail('Compute accounting is unavailable on this server',503);
      const build=publicBuild(req,res,id),owner=build.canManage?owned(req,res,id):undefined;
      json(res,200,getCompute({build,owner}));return true;
    }
    if(['concept/image','thumbnail/image','coinIcon/image'].includes(action)&&req.method==='GET'){
      const frame=service.getConceptImage(id,action.split('/')[0]);file(res,frame.bytes,frame.contentType);return true;
    }
    if(action==='screen'&&req.method==='GET'){
      const view=url.searchParams.get('view');if(view && !['overview','spawn','finish'].includes(view))throw fail('Choose an overview, spawn or finish view');
      const frame=service.getScreenshot(id,view?{view}:{});if(!frame)throw fail('No Studio screen has been shared',404);
      file(res,frame.bytes,frame.contentType||frame.type);return true;
    }
    if(action==='artifact'&&req.method==='GET'){
      // Plans and generated source are public build evidence, never worker credentials.
      const artifact=service.artifact({id,format:url.searchParams.get('format')||'luau'});
      file(res,artifact.content,artifact.contentType,artifact.filename);return true;
    }
    if(req.method!=='POST')throw fail('Method not allowed',405);
    authorizeMutation(req,host);const owner=owned(req,res,id);
    if(action==='project/file'){
      const agent=getAgentService?.().get(id,{owner});if(agent&&['running','pausing'].includes(agent.status))throw fail('Pause the agent before editing project code',409);
      const input=await readJson(req,110000);const build=service.updateProjectFile({id,owner,fileId:input.fileId,target:input.target,source:input.source,expectedHash:input.expectedHash,idempotencyKey:input.idempotencyKey});json(res,201,{build:agentBuild(build,owner)});return true;
    }
    if(action==='publication/prepare'||action==='publication/publish'){
      if(!getPublishing)throw fail('Roblox publishing service is unavailable',503);const input=await readJson(req,2048);
      const result=action==='publication/prepare'?await getPublishing().prepare({buildId:id,owner}):await getPublishing().publish({buildId:id,owner,intentId:input.intentId,artifactHash:input.artifactHash});json(res,200,result);return true;
    }
    if(action==='fees/reconcile'){
      if(!reconcileFee)throw fail('Fee accounting is unavailable on this server',503);
      const input=await readJson(req,2048);
      const result=await reconcileFee({build:service.get(id,{owner}),owner,signature:input.signature,instructionIndex:input.instructionIndex});
      json(res,200,result);return true;
    }
    if(action==='agent/start'||action==='agent/pause'){
      if(!getAgentService)throw fail('Autonomous game builds are unavailable on this server',503);
      const input=await readJson(req,4096);
      if(action==='agent/start'){
        if(!configured)throw fail('Configure AI compute before starting the agent',503);
        if(designJobs.has(id)||[...conceptJobs].some(key=>key.startsWith(id+':')))throw fail('Wait for the current creator request before starting the agent',409);
        const selected=selectBuilderModel(await getModels(),service.get(id,{owner}).modelId);
        const savedRun=getAgentService().get(id,{owner});
        const wantsVisual=savedRun?savedRun.includeVisualReview===true:(input.includeVisualReview??visualReviewEnabled);
        if(wantsVisual && !selected.architecture?.input_modalities?.includes('image'))throw fail('The selected advanced model must support image input for visual building',503);
        if(designJobs.has(id)||[...conceptJobs].some(key=>key.startsWith(id+':')))throw fail('Wait for the current creator request before starting the agent',409);
      }
      const agent=action==='agent/start'?getAgentService().start({id,owner,budgetUsd:input.budgetUsd,includeConcept:input.includeConcept,includeThumbnail:input.includeThumbnail,includeVisualReview:input.includeVisualReview}):getAgentService().pause({id,owner});
      const build=agentBuild(service.get(id,{owner}),owner);json(res,200,{build,agent});return true;
    }
    if(['generate','concept','thumbnail','enqueue','cancel-queue','revisions','connect'].includes(action))getAgentService?.().assertManualAllowed(id);
    if(['concept','thumbnail'].includes(action)){
      if(!generateConcept)throw fail('Concept image generation is unavailable on this server',503);
      const jobKey=id+':'+action;
      if(conceptJobs.has(jobKey))throw fail('An image is already being generated',409);
      const input=await readJson(req,4096),build=service.get(id,{owner});let started=false;
      getAgentService?.().assertManualAllowed(id);
      if(conceptJobs.has(jobKey))throw fail('An image is already being generated',409);
      conceptJobs.add(jobKey);
      try{
        const result=await generateConcept({build,purpose:action,artDirection:input.artDirection,modelId:input.modelId,onStart:metadata=>{service.beginConcept({id,owner,...metadata});started=true;}});
        json(res,200,{build:service.finishConcept({id,owner,...result})});
      }catch(error){if(started)service.failConcept({id,owner,purpose:action,message:error.status?error.message:'Image generation was interrupted'});throw error;}
      finally{conceptJobs.delete(jobKey);}
      return true;
    }
    if(action==='enqueue'){if(designJobs.has(id))throw fail('AI design is still running for this workspace',409);json(res,200,{build:service.enqueue({id,owner,requireAgentWorker:true})});return true;}
    if(action==='cancel-queue'){json(res,200,{build:service.cancelQueued({id,owner})});return true;}
    if(action==='prepare')throw fail('Game starters have been removed — describe your game and generate an advanced AI plan',410);
    if(action==='revisions'){
      if(designJobs.has(id))throw fail('AI design is still running for this workspace',409);
      const input=await readJson(req,8192),parent=service.get(id,{owner});
      const modelId=input.modelId??(BUILDER_MODEL_IDS.includes(parent.modelId)?parent.modelId:DEFAULT_BUILDER_MODEL_ID);
      selectBuilderModel(await getModels(),modelId);
      getAgentService?.().assertManualAllowed(id);
      if(designJobs.has(id))throw fail('AI design is still running for this workspace',409);
      json(res,201,{build:service.revise({id,owner,brief:input.brief,modelId,inspiration:input.inspiration})});return true;
    }
    if(action==='review'){
      const input=await readJson(req,8192);
      json(res,200,{build:service.review({id,owner,gameplayPassed:input.gameplayPassed,performancePassed:input.performancePassed,contentReviewed:input.contentReviewed,notes:input.notes,publishedUrl:input.publishedUrl})});return true;
    }
    if(action==='generate'){
      const input=await readJson(req),b=service.get(id,{owner});if(b.plan||b.status!=='queued')throw fail('This workspace already has a build plan — create a new workspace to change it',409);
      const modelId=input.modelId??b.modelId;
      selectBuilderModel(await getModels(),modelId);
      getAgentService?.().assertManualAllowed(id);
      if(service.get(id,{owner}).plan||service.get(id,{owner}).status!=='queued')throw fail('This workspace already has a build plan — create a new workspace to change it',409);
      if(designJobs.has(id))throw fail('AI design is still running for this workspace',409);designJobs.add(id);
      try{service.appendEvent({id,owner,type:'design_requested',message:'AI scene design requested — Studio has not been changed'});const plan=await generatePlan({build:b,modelId});json(res,200,{build:service.prepare({id,owner,plan,source:'ai',modelId,inferenceProvider:provider})});}
      catch(e){service.appendEvent({id,owner,type:'design_failed',message:e.status?e.message:'AI design did not complete — no Studio changes made'});throw e;}
      finally{designJobs.delete(id);}
      return true;
    }
    if(action==='connect'){json(res,200,{...service.issueWorkerToken({id,owner}),baseUrl:publicOrigin||'http://'+host,bridgeUrl:'/api/builds/bridge'});return true;}
    if(action==='screen'){json(res,200,service.screenshot({id,owner,bytes:await bytes(req),contentType:req.headers['content-type']}));return true;}
    if(action==='screen-stop'){if(service.stopScreen)service.stopScreen({id,owner});json(res,200,{stopped:true});return true;}
    throw fail('Unknown build action',404);
  };
}
module.exports={createBuildRouter};

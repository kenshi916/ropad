'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value);
// Open Cloud does not update these authored instance types. Uploading a place
// containing them would give a version receipt without reproducing the project.
// https://create.roblox.com/docs/cloud/guides/usage-place-publishing#limitations
const studioOnlyClasses=new Set(['EditableImage','EditableMesh','PartOperation','UnionOperation','NegateOperation','IntersectOperation','SurfaceAppearance','BaseWrap','WrapLayer','WrapTarget']);
function publicationArtifact(content){
  if(typeof content!=='string'||!content.includes('<roblox')||Buffer.byteLength(content)>20*1024*1024)throw fail('A complete supported Studio project is required',409);
  const markup=content.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g,'');
  const unsupported=[...new Set([...markup.matchAll(/<Item\b[^>]*\bclass\s*=\s*(["'])([^"']+)\1/g)].map(m=>m[2]).filter(name=>studioOnlyClasses.has(name)))];
  if(unsupported.length)throw fail('Publish this project from Roblox Studio to preserve '+unsupported.join(', ')+'; Open Cloud does not update these instance types',409);
  return content;
}
// Operator-only references select a scoped secret. Browser requests never supply
// the secret, environment reference, or Roblox destination. The repeated binding
// also protects callers that accidentally resolve another creator's credential.
function createCreatorCredentialResolver({targets={},env=process.env}={}){
  return context=>{
    const t=targets[context.projectId];
    if(!t||t.owner!==context.owner||String(t.placeId)!==context.placeId||String(t.universeId)!==context.universeId)return null;
    const name=t.credentialEnv;
    if(typeof name!=='string'||!/^ROPAD_ROBLOX_CREATOR_[A-Z0-9_]{1,80}_KEY$/.test(name))return null;
    const key=env[name];if(typeof key!=='string'||!key.trim())return null;
    // Distinct creators must not quietly share a server credential, including
    // aliases with identical values. Roblox-side scopes still need verification.
    if(Object.values(targets).some(other=>other&&other.owner!==context.owner&&typeof other.credentialEnv==='string'&&(other.credentialEnv===name||env[other.credentialEnv]===key)))throw fail('Separate scoped Roblox publishing credentials are required for each creator',503);
    return {...context,key};
  };
}
// The API key and project-to-place grants are operator configuration, never
// supplied by the browser. A creator cannot choose another tenant's place.
function createRobloxPublishingService({stateDirectory,key='',targets={},resolveCredential=null,getBuilds,fetcher=fetch,now=Date.now}={}){
  if(resolveCredential!==null&&typeof resolveCredential!=='function')throw fail('Invalid server publishing credential resolver',503);
  const file=stateDirectory&&path.join(stateDirectory,'roblox-publications.json');let rows=[],fault=false,tail=Promise.resolve(),diskDigest=null;
  if(file)try{const bytes=fs.readFileSync(file),saved=JSON.parse(bytes);if(saved.version!==1||!Array.isArray(saved.rows)||saved.rows.length>500||new Set(saved.rows.map(r=>r.id)).size!==saved.rows.length||saved.rows.some(r=>!r.id||!r.owner||!r.buildId||!['prepared','uploading','published','failed'].includes(r.status)||!id(r.placeId)||!id(r.universeId)||!/^[a-f0-9]{64}$/.test(r.artifactHash)||!Number.isFinite(r.createdAt)||!Number.isFinite(r.updatedAt)||!Number.isFinite(r.expiresAt)||r.status==='published'&&(!Number.isSafeInteger(r.versionNumber)||r.versionNumber<1)))throw Error();rows=saved.rows;diskDigest=sha(bytes);}catch(e){if(e.code!=='ENOENT')fault=true;}
  function assertStorage(){if(!file||fault)throw fail('Publishing storage is unavailable; preserve the journal for recovery',503);try{if((fs.existsSync(file)?sha(fs.readFileSync(file)):null)!==diskDigest)throw Error();}catch{fault=true;throw fail('Publishing journal changed on disk; recover it before another upload',503);}}
  function save(){assertStorage();const tmp=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fs.mkdirSync(stateDirectory,{recursive:true});const bytes=JSON.stringify({version:1,rows});fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);diskDigest=sha(bytes);}catch{fault=true;throw fail('Publishing journal could not be saved',503);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
  function exclusive(fn){const next=tail.then(fn);tail=next.catch(()=>{});return next;}
  function target(build,owner){const projectId=build.lineage?.projectId||build.id,t=targets[projectId];if(!t||t.owner!==owner||typeof t.placeId==='number'&&!Number.isSafeInteger(t.placeId)||typeof t.universeId==='number'&&!Number.isSafeInteger(t.universeId)||!id(String(t.placeId))||!id(String(t.universeId)))throw fail('An operator must connect this creator project to an authorized Roblox place',409);
    if(Object.entries(targets).some(([otherProject,other])=>otherProject!==projectId&&other&&String(other.placeId)===String(t.placeId)))throw fail('This Roblox place is assigned to multiple creator projects; connect a separate place for each game before publishing',409);
    return {projectId,placeId:String(t.placeId),universeId:String(t.universeId)};}
  function owned(buildId,owner){const b=getBuilds().get(buildId,{owner});if(!b.canManage)throw fail('Only this game’s creator can publish it',403);return b;}
  function credential(t,owner){
    if(!resolveCredential){if(!key)throw fail('Configure the server’s scoped Roblox publishing key',503);return key;}
    let resolved;try{resolved=resolveCredential({...t,owner});}catch{throw fail('This creator’s scoped Roblox publishing credential is unavailable',503);}
    if(!resolved||resolved.owner!==owner||resolved.projectId!==t.projectId||String(resolved.placeId)!==t.placeId||String(resolved.universeId)!==t.universeId||typeof resolved.key!=='string'||!resolved.key.trim()||/[\r\n]/.test(resolved.key))throw fail('Connect a scoped Roblox publishing credential for this creator and exact project target',503);
    return resolved.key;
  }
  function safe(row){const fields=['id','owner','buildId','projectId','placeId','universeId','artifactHash','artifactBytes','gameName','status','createdAt','updatedAt','expiresAt','versionNumber','error'];return {...Object.fromEntries(fields.filter(k=>row[k]!==undefined).map(k=>[k,row[k]])),url:'https://www.roblox.com/games/'+row.placeId,publicAccessVerified:false};}
  function config({buildId,owner}={}){let t=null,credentialConfigured=!resolveCredential&&!!key;if(buildId&&owner){try{t=target(owned(buildId,owner),owner);credentialConfigured=!!credential(t,owner);}catch{credentialConfigured=false;}}
    return {configured:credentialConfigured&&!!file&&!fault,connected:!!t,target:t,credentialMode:resolveCredential?'creator_scoped':'operator_legacy',requiresExistingPlace:true,requiresCreatorReview:true,publicAccessVerified:false};}
  function latest(buildId){const row=rows.filter(r=>r.buildId===buildId&&r.status==='published').sort((a,b)=>b.updatedAt-a.updatedAt)[0];return row?safe(row):null;}
  async function prepare({buildId,owner}){return exclusive(async()=>{
    assertStorage();
    const build=owned(buildId,owner),t=target(build,owner);credential(t,owner);
    if(rows.some(r=>r.placeId===t.placeId&&r.universeId===t.universeId&&r.status==='uploading'))throw fail('An earlier upload outcome is unknown for this place; inspect Roblox version history before another publication',409);
    if(!build.readiness?.readyForCreatorPublish)throw fail('Complete this version’s playtest and creator release review first',409);
    const content=publicationArtifact(getBuilds().artifact({id:buildId,format:'rbxlx'}).content);
    const hash=sha(content),prior=rows.find(r=>r.buildId===buildId&&r.artifactHash===hash&&r.placeId===t.placeId&&r.universeId===t.universeId&&(r.status==='published'||r.status==='prepared'&&r.expiresAt>=now()));if(prior)return safe(prior);
    if(rows.length>=500)throw fail('Publishing journal requires operator archival',503);
    const row={id:crypto.randomUUID(),owner,buildId,...t,artifactHash:hash,artifactBytes:Buffer.byteLength(content),gameName:build.gameName,status:'prepared',createdAt:now(),updatedAt:now(),expiresAt:now()+15*60*1000};rows.push(row);save();return safe(row);
  });}
  async function publish({buildId,owner,intentId,artifactHash}){return exclusive(async()=>{
    assertStorage();
    const b=owned(buildId,owner),t=target(b,owner),row=rows.find(r=>r.id===intentId&&r.buildId===buildId&&r.owner===owner);if(!row)throw fail('Publishing review not found',404);
    if(row.status==='published')return safe(row);
    if(row.status==='uploading')throw fail('The upload outcome is unknown; inspect Roblox version history before retrying',409);
    if(rows.some(r=>r.id!==row.id&&r.placeId===t.placeId&&r.universeId===t.universeId&&r.status==='uploading'))throw fail('An earlier upload outcome is unknown for this place; inspect Roblox version history before another publication',409);
    if(row.status!=='prepared'||row.expiresAt<now())throw fail('Review a fresh publication before uploading',409);
    if(t.placeId!==row.placeId||t.universeId!==row.universeId||!b.readiness?.readyForCreatorPublish)throw fail('Publishing permissions or release review changed',409);
    const publishKey=credential(t,owner);
    const content=publicationArtifact(getBuilds().artifact({id:buildId,format:'rbxlx'}).content);if(artifactHash!==row.artifactHash||sha(content)!==row.artifactHash)throw fail('The project changed after review; prepare a new publication',409);
    row.status='uploading';row.updatedAt=now();save();
    let response;try{response=await fetcher('https://apis.roblox.com/universes/v1/'+row.universeId+'/places/'+row.placeId+'/versions?versionType=Published',{method:'POST',headers:{'x-api-key':publishKey,'Content-Type':'application/xml'},body:content,redirect:'error',signal:AbortSignal.timeout(60000)});}catch{throw fail('Upload outcome unknown; inspect Roblox version history before another attempt',502);}
    if(!response.ok){if([400,401,403,404,413,415,422,429].includes(response.status)){row.status='failed';row.error='Roblox rejected publication ('+response.status+')';row.updatedAt=now();save();}throw fail('Roblox did not confirm publication; check the scoped key, target and version history',502);}
    let result;try{result=await response.json();}catch{throw fail('Roblox upload response was unreadable; inspect version history',502);}
    if(!Number.isSafeInteger(result.versionNumber)||result.versionNumber<1)throw fail('Roblox did not return a place version; inspect version history',502);
    row.status='published';row.versionNumber=result.versionNumber;row.updatedAt=now();save();return safe(row);
  });}
  function status({buildId,owner}){assertStorage();owned(buildId,owner);return {configuration:config({buildId,owner}),publications:rows.filter(r=>r.buildId===buildId&&r.owner===owner).map(safe)};}
  return {config,prepare,publish,status,latest};
}
module.exports={createRobloxPublishingService,createCreatorCredentialResolver};

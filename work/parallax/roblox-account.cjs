'use strict';
// Identity only. OAuth access tokens are discarded after userinfo; this module
// grants no publishing permission and never handles Roblox session cookies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PublicKey}=require('@solana/web3.js');
const AUTH='https://apis.roblox.com/oauth/v1/authorize',TOKEN='https://apis.roblox.com/oauth/v1/token',USERINFO='https://apis.roblox.com/oauth/v1/userinfo';
const SCOPES=Object.freeze(['openid','profile']),TTL=10*60*1000,MAX_LINKS=1000,MAX_FLOWS=1000;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function ownerAddress(value){try{const key=new PublicKey(value);if(typeof value!=='string'||key.toBase58()!==value||!PublicKey.isOnCurve(key.toBytes()))throw Error();return value;}catch{throw fail('A verified Solana creator wallet is required',401);}}
function bindingHash(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fail('The original wallet session is required',401);return value;}
function callbackUri(value){
  if(!value)return null;
  let u;try{if(typeof value!=='string'||value.length>256)throw Error();u=new URL(value);}catch{throw fail('Configure a valid Roblox OAuth callback URL within 256 characters',503);}
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/roblox/oauth/callback'||!(u.protocol==='https:'||u.protocol==='http:'&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/roblox\/oauth\/callback$/.test(value)))throw fail('Roblox OAuth requires HTTPS or explicit localhost HTTP at /roblox/oauth/callback',503);
  return u.href;
}
function cleanText(value,max){return typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=max&&!/[\x00-\x1f\x7f]/.test(value)?value.trim():null;}
function profile(input){
  const id=input?.sub,displayName=cleanText(input?.name,200),username=cleanText(input?.preferred_username,100);
  if(typeof id!=='string'||!/^[1-9]\d{0,18}$/.test(id)||!displayName||!username)throw fail('Roblox did not return a verifiable account profile',502);
  const profileUrl='https://www.roblox.com/users/'+id+'/profile';
  if(input.profile!==undefined){let u;try{u=new URL(input.profile);}catch{throw fail('Roblox returned an invalid account profile URL',502);}if(u.protocol!=='https:'||u.hostname!=='www.roblox.com'||u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/users/'+id+'/profile')throw fail('Roblox returned an inconsistent account profile URL',502);}
  return {id,displayName,username,profileUrl};
}
async function boundedJson(response){
  try{
    if(Number(response.headers?.get?.('content-length'))>65536)throw Error();
    if(!response.body){const data=await response.json();if(Buffer.byteLength(JSON.stringify(data))>65536)throw Error();return data;}
    const chunks=[];let count=0;for await(const chunk of response.body){count+=chunk.length;if(count>65536)throw Error();chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw fail('Roblox returned an unreadable account response',502);}
}
function createRobloxAccountService({stateDirectory,clientId='',clientSecret='',redirectUri='',fetcher=fetch,now=Date.now}={}){
  const redirect=callbackUri(redirectUri),file=stateDirectory&&path.join(stateDirectory,'roblox-accounts.json');
  if(typeof clientId!=='string'||clientId.length>512||/[\x00-\x20\x7f]/.test(clientId)||typeof clientSecret!=='string'||clientSecret.length>8192||/[\x00-\x1f\x7f]/.test(clientSecret))throw fail('Roblox OAuth application configuration is invalid',503);
  let rows=[],diskDigest=null,fault=false;const pending=new Map(),active=new Map(),issued=new Map();
  if(file&&fs.existsSync(file))try{
    const bytes=fs.readFileSync(file),saved=JSON.parse(bytes);if(saved.version!==1||Object.keys(saved).sort().join(',')!=='accounts,version'||!Array.isArray(saved.accounts)||saved.accounts.length>MAX_LINKS)throw Error();
    const owners=new Set();for(const row of saved.accounts){ownerAddress(row.owner);if(owners.has(row.owner)||Object.keys(row).sort().join(',')!=='account,owner'||Object.keys(row.account||{}).sort().join(',')!=='displayName,id,linkedAt,profileUrl,username'||!Number.isFinite(row.account.linkedAt))throw Error();owners.add(row.owner);const a=row.account,checked=profile({sub:a.id,name:a.displayName,preferred_username:a.username,profile:a.profileUrl});if(Object.keys(checked).some(k=>checked[k]!==a[k]))throw Error();}
    rows=saved.accounts;diskDigest=digest(bytes);
  }catch{throw fail('Saved Roblox account links are unreadable; preserve them for recovery',503);}
  function assertStorage(){if(!file||fault)throw fail('Persistent Roblox account storage is unavailable',503);try{if((fs.existsSync(file)?digest(fs.readFileSync(file)):null)!==diskDigest)throw Error();}catch{fault=true;throw fail('Roblox account history changed; preserve it for recovery',503);}}
  function save(){assertStorage();const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fs.mkdirSync(stateDirectory,{recursive:true,mode:0o700});const bytes=Buffer.from(JSON.stringify({version:1,accounts:rows}));fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);diskDigest=digest(bytes);}catch{fault=true;throw fail('Roblox account links could not be saved; preserve them for recovery',503);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  function config(){return {configured:!!(file&&clientId&&clientSecret.trim()&&redirect&&!fault),scopes:[...SCOPES],identityOnly:true,publishingAuthorized:false,reason:!file?'Persistent account storage is required':!clientId||!clientSecret.trim()||!redirect?'Configure the Roblox OAuth application and callback URL':fault?'Account storage requires recovery':null};}
  function status({owner}){ownerAddress(owner);assertStorage();const row=rows.find(r=>r.owner===owner);return {connected:!!row,account:row?structuredClone(row.account):null,identityOnly:true,publishingAuthorized:false};}
  function prune(){const time=now();for(const [key,value] of pending)if(value.expiresAt<=time)pending.delete(key);for(const [key,times] of issued){const current=times.filter(t=>t>time-60000);if(current.length)issued.set(key,current);else issued.delete(key);}}
  function invalidate(owner){for(const [state,item] of pending)if(item.owner===owner)pending.delete(state);for(const item of active.values())if(item.owner===owner)item.cancelled=true;}
  function start({owner,binding}){
    ownerAddress(owner);bindingHash(binding);assertStorage();const settings=config();if(!settings.configured)throw fail(settings.reason,503);
    if(rows.some(r=>r.owner===owner))throw fail('Disconnect the linked Roblox account before connecting another',409);
    prune();const recent=issued.get(owner)||[];
    if(recent.length>=5||[...pending.values(),...active.values()].filter(p=>p.owner===owner).length>=3)throw fail('Too many Roblox connection attempts; finish or wait before retrying',429);
    if(pending.size+active.size>=MAX_FLOWS||rows.length>=MAX_LINKS)throw fail('Roblox account connection capacity is temporarily full',429);
    const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(32).toString('base64url'),expiresAt=now()+TTL;
    const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    pending.set(state,{owner,binding,verifier,expiresAt,cancelled:false});issued.set(owner,[...recent,now()]);
    const url=new URL(AUTH);url.search=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',scope:SCOPES.join(' '),state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    return {authorizationUrl:url.href,expiresAt};
  }
  async function complete({owner,binding,state,code,error,isCurrent=()=>true}){
    ownerAddress(owner);bindingHash(binding);assertStorage();prune();
    const flow=typeof state==='string'&&/^[A-Za-z0-9_-]{43}$/.test(state)?pending.get(state):null;
    if(!flow||flow.expiresAt<=now())throw fail('This Roblox connection request expired or was already used; start again',401);
    if(flow.owner!==owner||!crypto.timingSafeEqual(Buffer.from(flow.binding,'hex'),Buffer.from(binding,'hex')))throw fail('Return using the original creator wallet session',403);
    pending.delete(state); // Consume synchronously, before any network request.
    if(error!==undefined)throw fail('Roblox authorization was declined or could not complete; start again',400);
    if(!cleanText(code,4096))throw fail('Roblox did not return a valid authorization code',400);
    if(rows.some(r=>r.owner===owner))throw fail('Disconnect the linked Roblox account before connecting another',409);
    active.set(state,flow);
    function current(){let sessionCurrent=false;try{sessionCurrent=typeof isCurrent==='function'&&isCurrent()===true;}catch{}assertStorage();if(!sessionCurrent||flow.cancelled||flow.expiresAt<=now()||rows.some(r=>r.owner===owner))throw fail('This Roblox connection is no longer current; start again',409);}
    try{
      current();
      let response;
      try{response=await fetcher(TOKEN,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'authorization_code',code,code_verifier:flow.verifier,redirect_uri:redirect}).toString(),signal:AbortSignal.timeout(15000)});}catch{throw fail('Roblox authorization could not be verified; start a new connection',502);}
      if(!response.ok)throw fail('Roblox rejected the authorization code; start a new connection',502);
      const token=await boundedJson(response),access=token?.access_token;
      if(typeof access!=='string'||!access||access.length>8192||/[\x00-\x20\x7f]/.test(access)||typeof token.token_type!=='string'||token.token_type.toLowerCase()!=='bearer'||token.expires_in!==undefined&&(!Number.isFinite(Number(token.expires_in))||Number(token.expires_in)<=0))throw fail('Roblox did not return a usable account authorization',502);
      if(token.scope!==undefined&&(typeof token.scope!=='string'||SCOPES.some(scope=>!token.scope.split(' ').includes(scope))))throw fail('Roblox did not grant the requested identity permissions',502);
      current();
      let userResponse;try{userResponse=await fetcher(USERINFO,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+access,Accept:'application/json'},signal:AbortSignal.timeout(15000)});}catch{throw fail('The Roblox account profile could not be verified; start again',502);}
      if(!userResponse.ok)throw fail('Roblox did not verify the account profile; start again',502);
      const account={...profile(await boundedJson(userResponse)),linkedAt:now()};current();
      rows.push({owner,account});save();invalidate(owner);return status({owner});
    }finally{active.delete(state);flow.verifier='';}
  }
  function disconnect({owner}){ownerAddress(owner);assertStorage();invalidate(owner);const filtered=rows.filter(row=>row.owner!==owner);if(filtered.length!==rows.length){rows=filtered;save();}return status({owner});}
  return {config,status,start,complete,disconnect};
}
module.exports={createRobloxAccountService};

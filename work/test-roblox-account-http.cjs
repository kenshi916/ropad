'use strict';
// Only local HTTP and deterministic Roblox fixtures; no live grants or accounts.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createApp}=require('./parallax/server.cjs');
const {Keypair}=require('./parallax/node_modules/@solana/web3.js');
async function harness(t,{configured=true,wrongOrigin=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-account-http-')),probe=http.createServer();
 await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const base='http://127.0.0.1:'+port,calls=[],code='offline-authorization-code';
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  if(url==='https://apis.roblox.com/oauth/v1/token')return Response.json({access_token:'fixture-access-token',refresh_token:'fixture-refresh-token',token_type:'Bearer',scope:'openid profile',expires_in:900});
  if(url==='https://apis.roblox.com/oauth/v1/userinfo')return Response.json({sub:'12345',name:'Example Creator',preferred_username:'example_creator'});
  throw Error('Unexpected external call');
 };
 const config=configured?{clientId:'123456',clientSecret:'fixture-client-secret',redirectUri:(wrongOrigin?'http://localhost:'+port:base)+'/roblox/oauth/callback'}:{};
 const app=createApp({port,stateDirectory:directory,robloxOAuthConfig:config,fetcher,key:'',models:[],verifySignature:async()=>true,cameraWorkers:false,autonomousWorkers:false});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>{app.server.closeAllConnections();app.server.close(r);});fs.rmSync(directory,{recursive:true,force:true});});
 const csrf=(await(await fetch(base+'/api/status')).json()).csrf;
 function client(){let cookie='';return async(endpoint,body,headers={})=>{
  const response=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{Origin:base,'X-Parallax-Token':csrf,'Content-Type':'application/json',Cookie:cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const set=response.headers.getSetCookie();if(set.length)cookie=set.map(c=>c.split(';')[0]).join('; ');
  return {status:response.status,headers:response.headers,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};
 };}
 async function login(request,address=Keypair.generate().publicKey.toBase58()){
  const challenge=await request('/api/auth/challenge',{address});assert.equal(challenge.status,200);
  const result=await request('/api/auth/verify',{id:challenge.data.id,signatureBase64:Buffer.alloc(64).toString('base64')});assert.equal(result.status,200);return address;
 }
 const owner=client(),other=client();const address=await login(owner);await login(other);return {base,owner,other,anonymous:client(),login,address,code,calls,directory};
}
test('account routes require the original authenticated wallet session, CSRF and owner isolation',async t=>{
 const h=await harness(t),start='/api/roblox/account/start',complete='/api/roblox/account/complete';
 assert.equal((await h.anonymous(start,{})).status,401);
 assert.equal((await h.owner(start,{}, {'X-Parallax-Token':'wrong'})).status,403);
 const begin=await h.owner(start,{});assert.equal(begin.status,200,JSON.stringify(begin.data));const state=new URL(begin.data.authorizationUrl).searchParams.get('state');
 const input={state,code:h.code};assert.equal((await h.other(complete,input)).status,403);
 const secondSession=h.anonymous;await h.login(secondSession,h.address);assert.equal((await secondSession(complete,input)).status,403);
 assert.equal(h.calls.length,0);
 const result=await h.owner(complete,input);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.account.id,'12345');assert.equal(result.data.publishingAuthorized,false);
 assert.equal((await h.other('/api/roblox/account')).data.account,null);
 assert.equal((await h.owner('/api/roblox/account')).data.account.username,'example_creator');
 assert.doesNotMatch(JSON.stringify(result.data),/fixture-access-token|fixture-refresh-token|fixture-client-secret|offline-authorization-code/);
 assert.notEqual((await h.owner(complete,input)).status,200);assert.equal(h.calls.length,2);
 assert.equal((await h.owner('/api/roblox/account/disconnect',{})).data.connected,false);
 assert.equal((await h.owner('/api/roblox/account')).data.account,null);
});
test('only the exact GET callback is reachable cross-site and it cannot exchange a code',async t=>{
 const h=await harness(t),headers={'Sec-Fetch-Site':'cross-site'};
 const callback=await h.anonymous('/roblox/oauth/callback?code=untrusted-code&state=untrusted-state',undefined,headers);
 assert.equal(callback.status,200);assert.match(callback.data,/roblox-oauth-callback.js/);
 assert.doesNotMatch(callback.data,/untrusted-code|untrusted-state/);assert.equal(callback.headers.get('referrer-policy'),'no-referrer');assert.equal(callback.headers.get('cache-control'),'no-store');assert.match(callback.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 for(const route of ['/api/roblox/account','/roblox/oauth/callback/extra','/roblox/oauth/callback.js'])assert.equal((await h.anonymous(route,undefined,headers)).status,403);
 assert.equal((await h.owner('/api/roblox/account/complete',{state:'x',code:'x'},headers)).status,403);
 assert.equal((await h.owner('/roblox/oauth/callback',{},headers)).status,403);assert.equal(h.calls.length,0);
});
test('unconfigured account linking reports the prerequisite without changing saved games or making requests',async t=>{
 const h=await harness(t,{configured:false});const config=await h.anonymous('/api/roblox/account');
 assert.equal(config.status,200);assert.equal(config.data.configured,false);assert.equal(config.data.connected,false);assert.equal(config.data.authenticated,false);
 assert.equal((await h.owner('/api/roblox/account/start',{})).status,503);assert.equal(h.calls.length,0);
});
test('callback and launch origins must match rather than moving wallet sessions between localhost aliases',async t=>{
 const h=await harness(t,{wrongOrigin:true});const config=await h.owner('/api/roblox/account');
 assert.equal(config.data.configured,false);assert.match(config.data.reason,/localhost/);
 assert.equal((await h.owner('/api/roblox/account/start',{})).status,503);assert.equal(h.calls.length,0);
});

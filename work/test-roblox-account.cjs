'use strict';
// Offline OAuth fixtures only; no application registration or live requests.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Keypair}=require('./parallax/node_modules/@solana/web3.js');
const {createRobloxAccountService}=require('./parallax/roblox-account.cjs');
const BINDING='1'.repeat(64),OTHER_BINDING='2'.repeat(64),CLIENT_ID='offline-client-id',SECRET='OFFLINE_CLIENT_SECRET_NOT_FOR_OUTPUT',ACCESS='OFFLINE_ACCESS_TOKEN_NOT_FOR_OUTPUT',CODE='OFFLINE_AUTHORIZATION_CODE';
const PROFILE={sub:'123456789',name:'Orbit Creator',preferred_username:'OrbitCreator',profile:'https://www.roblox.com/users/123456789/profile'};
function fixture(t,overrides={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-roblox-account-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const owner=Keypair.generate().publicKey.toBase58(),other=Keypair.generate().publicKey.toBase58(),calls=[];let time=100000;
 const options={stateDirectory:directory,clientId:CLIENT_ID,clientSecret:SECRET,redirectUri:'https://ropad.com/roblox/oauth/callback',now:()=>time,fetcher:async(url,init)=>{calls.push({url,init});if(overrides.fetcher)return overrides.fetcher(url,init);if(url.endsWith('/token'))return Response.json({access_token:ACCESS,token_type:'Bearer',expires_in:900,scope:'openid profile',refresh_token:'NEVER_PERSIST_REFRESH_TOKEN',id_token:'NEVER_PERSIST_ID_TOKEN'});if(url.endsWith('/userinfo'))return Response.json(PROFILE);throw Error('Unexpected fixture URL');},...overrides};
 return {directory,file:path.join(directory,'roblox-accounts.json'),owner,other,calls,options,service:createRobloxAccountService(options),advance:n=>time+=n};
}
function start(h,owner=h.owner,binding=BINDING){const result=h.service.start({owner,binding}),url=new URL(result.authorizationUrl);return {result,url,state:url.searchParams.get('state')};}
function complete(h,flow,args={}){return h.service.complete({owner:h.owner,binding:BINDING,state:flow.state,code:CODE,...args});}
test('configuration is redacted and optional; only canonical callback paths with HTTPS or explicit loopback HTTP are accepted',t=>{
 const h=fixture(t);assert.deepEqual(h.service.config(),{configured:true,scopes:['openid','profile'],identityOnly:true,publishingAuthorized:false,reason:null});assert.doesNotMatch(JSON.stringify(h.service.config()),new RegExp(CLIENT_ID+'|'+SECRET));
 const inactive=createRobloxAccountService({...h.options,clientId:'',clientSecret:'',redirectUri:''});assert.equal(inactive.config().configured,false);assert.throws(()=>inactive.start({owner:h.owner,binding:BINDING}),/Configure/);assert.equal(h.calls.length,0);
 for(const redirectUri of ['http://localhost:61281/roblox/oauth/callback','http://127.0.0.1:61281/roblox/oauth/callback','https://ropad.com/roblox/oauth/callback'])assert.equal(createRobloxAccountService({...h.options,redirectUri}).config().configured,true);
 for(const redirectUri of ['http://ropad.com/roblox/oauth/callback','http://127.1/roblox/oauth/callback','http://2130706433/roblox/oauth/callback','http://localhost.evil.com/roblox/oauth/callback','https://ropad.com/callback','https://user:pass@ropad.com/roblox/oauth/callback','https://ropad.com/roblox/oauth/callback?next=evil','https://ropad.com/roblox/oauth/callback#fragment','https://'+'a'.repeat(230)+'.com/roblox/oauth/callback','javascript:alert(1)'])assert.throws(()=>createRobloxAccountService({...h.options,redirectUri}),/OAuth/);
});
test('authorization uses one-use state and PKCE; tokens and code never reach persistent records or public outputs',async t=>{
 const h=fixture(t),f=start(h);assert.equal(f.url.origin+f.url.pathname,'https://apis.roblox.com/oauth/v1/authorize');assert.equal(f.url.searchParams.get('scope'),'openid profile');assert.equal(f.url.searchParams.get('response_type'),'code');assert.equal(f.url.searchParams.get('code_challenge_method'),'S256');assert.match(f.state,/^[A-Za-z0-9_-]{43}$/);assert.equal(f.result.expiresAt,700000);assert.doesNotMatch(f.result.authorizationUrl,/secret|token|code_verifier/);assert.equal(fs.existsSync(h.file),false);
 const result=await complete(h,f);assert.equal(result.connected,true);assert.equal(result.identityOnly,true);assert.equal(result.publishingAuthorized,false);assert.deepEqual(result.account,{id:PROFILE.sub,displayName:PROFILE.name,username:PROFILE.preferred_username,profileUrl:PROFILE.profile,linkedAt:100000});assert.equal(h.calls.length,2);
 const token=h.calls[0],form=new URLSearchParams(token.init.body);assert.equal(token.url,'https://apis.roblox.com/oauth/v1/token');assert.equal(token.init.method,'POST');assert.equal(token.init.redirect,'error');assert.equal(token.init.headers['Content-Type'],'application/x-www-form-urlencoded');assert.equal(form.get('client_id'),CLIENT_ID);assert.equal(form.get('client_secret'),SECRET);assert.equal(form.get('code'),CODE);assert.equal(form.get('grant_type'),'authorization_code');assert.equal(form.get('redirect_uri'),h.options.redirectUri);assert.match(form.get('code_verifier'),/^[A-Za-z0-9_-]{43}$/);assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'),f.url.searchParams.get('code_challenge'));
 assert.equal(h.calls[1].url,'https://apis.roblox.com/oauth/v1/userinfo');assert.equal(h.calls[1].init.headers.Authorization,'Bearer '+ACCESS);assert.equal(h.calls[1].init.redirect,'error');
 const disk=fs.readFileSync(h.file,'utf8'),publicData=JSON.stringify([result,h.service.status({owner:h.owner}),h.service.config()]);for(const sensitive of [SECRET,ACCESS,CODE,'NEVER_PERSIST_REFRESH_TOKEN','NEVER_PERSIST_ID_TOKEN',form.get('code_verifier'),f.state]){assert.equal(disk.includes(sensitive),false);assert.equal(publicData.includes(sensitive),false);}
 assert.equal(createRobloxAccountService(h.options).status({owner:h.owner}).connected,true);assert.equal(h.service.status({owner:h.other}).connected,false);
 await assert.rejects(complete(h,f),/already used/);assert.equal(h.calls.length,2);
});
test('state is bound to the original wallet and session; wrong callers cannot consume it',async t=>{
 const h=fixture(t),f=start(h);await assert.rejects(complete(h,f,{owner:h.other}),/original creator wallet session/);await assert.rejects(complete(h,f,{binding:OTHER_BINDING}),/original creator wallet session/);await assert.rejects(complete(h,f,{binding:'invalid'}),/original wallet session/);await assert.rejects(complete(h,{state:'a'.repeat(43)}),/expired or was already/);assert.equal(h.calls.length,0);assert.equal((await complete(h,f)).connected,true);
});
test('expired, cancelled and invalid callback codes are consumed without external calls',async t=>{
 const h=fixture(t),expired=start(h);h.advance(600001);await assert.rejects(complete(h,expired),/expired/);
 for(const args of [{error:'provider error '+SECRET},{code:''},{code:'code\nheader'}]){const f=start(h);await assert.rejects(complete(h,f,args),e=>!e.message.includes(SECRET));await assert.rejects(complete(h,f),/already used/);}
 assert.equal(h.calls.length,0);assert.equal(h.service.status({owner:h.owner}).connected,false);
});
test('concurrent replay exchanges a code once and another callback cannot silently overwrite an account',async t=>{
 const h=fixture(t),f=start(h),other=start(h);const results=await Promise.allSettled([complete(h,f),complete(h,f),complete(h,other)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.ok(h.calls.filter(c=>c.url.endsWith('/token')).length<=2);assert.equal(h.service.status({owner:h.owner}).account.id,PROFILE.sub);assert.throws(()=>start(h),/Disconnect/);const saved=fs.readFileSync(h.file,'utf8');await assert.rejects(complete(h,other));assert.equal(fs.readFileSync(h.file,'utf8'),saved);
});
test('disconnect removes only its owner link and invalidates pending as well as in-flight completion',async t=>{
 let release;const h=fixture(t,{fetcher:async(url)=>url.endsWith('/token')?Response.json({access_token:ACCESS,token_type:'Bearer'}):new Promise(resolve=>{release=()=>resolve(Response.json(PROFILE));})});
 const f=start(h),pending=start(h),completion=complete(h,f);for(let n=0;!release&&n<50;n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(release);assert.equal(h.service.disconnect({owner:h.owner}).connected,false);release();await assert.rejects(completion,/no longer current/);await assert.rejects(complete(h,pending),/already used/);assert.equal(h.service.status({owner:h.owner}).connected,false);
 const linked=fixture(t);await complete(linked,start(linked));assert.equal(linked.service.disconnect({owner:linked.other}).connected,false);assert.equal(linked.service.status({owner:linked.owner}).connected,true);assert.equal(linked.service.disconnect({owner:linked.owner}).connected,false);assert.equal(createRobloxAccountService(linked.options).status({owner:linked.owner}).connected,false);assert.equal(linked.calls.length,2);assert.equal(start(linked).url.searchParams.get('scope'),'openid profile');
});
test('wallet logout or session expiry during provider verification prevents userinfo or durable account linking',async t=>{
 for(const stage of ['token','userinfo'])await t.test(stage,async t=>{
   let release,sessionActive=true;const calls=[];
   const h=fixture(t,{fetcher:async url=>{calls.push(url);const response=()=>Response.json(url.endsWith('/token')?{access_token:ACCESS,token_type:'Bearer'}:PROFILE);return url.endsWith('/'+stage)?new Promise(resolve=>{release=()=>resolve(response());}):response();}});
   const flow=start(h),completion=complete(h,flow,{isCurrent:()=>sessionActive});for(let n=0;!release&&n<50;n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
   sessionActive=false;release();await assert.rejects(completion,/no longer current/);assert.equal(h.service.status({owner:h.owner}).connected,false);assert.equal(fs.existsSync(h.file),false);assert.equal(calls.length,stage==='token'?1:2);await assert.rejects(complete(h,flow),/already used/);
 });
});
test('provider errors, malformed profiles and remote redirects never create a link or leak response credentials',async t=>{
 for(const mode of ['transport','token-rejected','token-html','bad-token-type','token-no-scope','userinfo-rejected','profile-missing','profile-wrong-id','profile-external-url','oversized'])await t.test(mode,async t=>{
 const h=fixture(t,{fetcher:async url=>{
   if(mode==='transport')throw Error(SECRET+' '+ACCESS);
   if(url.endsWith('/token')){if(mode==='token-rejected')return Response.json({secret:SECRET},{status:401});if(mode==='token-html')return new Response('<h1>'+SECRET+'</h1>');if(mode==='oversized')return new Response('x'.repeat(70000));return Response.json({access_token:ACCESS,token_type:mode==='bad-token-type'?'Basic':'Bearer',...(mode==='token-no-scope'?{scope:'openid'}:{})});}
   if(mode==='userinfo-rejected')return Response.json({error:ACCESS},{status:403});
   return Response.json(mode==='profile-missing'?{secret:SECRET}:mode==='profile-wrong-id'?{...PROFILE,sub:'a different user'}:mode==='profile-external-url'?{...PROFILE,profile:'https://evil.com/user'}:PROFILE);
 }});await assert.rejects(complete(h,start(h)),e=>e.status===502&&!e.message.includes(SECRET)&&!e.message.includes(ACCESS));assert.equal(h.service.status({owner:h.owner}).connected,false);assert.equal(fs.existsSync(h.file),false);
 });
});
test('restart discards pending secrets while preserving existing links; new account requires explicit disconnect',async t=>{
 const h=fixture(t),f=start(h);h.service=createRobloxAccountService(h.options);await assert.rejects(complete(h,f),/already used/);await complete(h,start(h));const disk=fs.readFileSync(h.file);assert.throws(()=>start(h),/Disconnect/);assert.deepEqual(fs.readFileSync(h.file),disk);h.service.disconnect({owner:h.owner});await complete(h,start(h));assert.equal(h.service.status({owner:h.owner}).account.id,PROFILE.sub);
});
test('corrupt or changed account history fails closed before linking and preserves original bytes',async t=>{
 for(const mode of ['corrupt','remove','valid-change'])await t.test(mode,async t=>{
 const h=fixture(t);await complete(h,start(h));const original=fs.readFileSync(h.file),otherFlow=start(h,h.other),changed=mode==='corrupt'?Buffer.from('{damaged'):Buffer.from(JSON.stringify({...JSON.parse(original),externalChange:true}));if(mode==='remove')fs.unlinkSync(h.file);else fs.writeFileSync(h.file,changed);
 await assert.rejects(h.service.complete({owner:h.other,binding:BINDING,state:otherFlow.state,code:CODE}),/history changed/);assert.equal(h.calls.length,2);assert.throws(()=>h.service.disconnect({owner:h.owner}),/storage is unavailable/);if(mode!=='remove'){assert.deepEqual(fs.readFileSync(h.file),changed);assert.throws(()=>createRobloxAccountService(h.options),/unreadable/);}else assert.equal(fs.existsSync(h.file),false);
 });
});
test('disk changes during external verification stop persistence; provider calls never repair external state',async t=>{
 const h=fixture(t);let userInfoCalls=0;h.options.fetcher=async url=>{if(url.endsWith('/token'))return Response.json({access_token:ACCESS,token_type:'Bearer'});userInfoCalls++;fs.writeFileSync(h.file,'external damage');return Response.json(PROFILE);};h.service=createRobloxAccountService(h.options);await assert.rejects(complete(h,start(h)),/history changed/);assert.equal(userInfoCalls,1);assert.equal(fs.readFileSync(h.file,'utf8'),'external damage');
});
test('pending-flow and per-owner rate limits are bounded, while status returns defensive copies',async t=>{
 const h=fixture(t);for(let i=0;i<3;i++)start(h);assert.throws(()=>start(h),e=>e.status===429);assert.equal(h.calls.length,0);h.service.disconnect({owner:h.owner});for(let i=0;i<2;i++){const f=start(h);await assert.rejects(complete(h,f,{error:'declined'}));}assert.throws(()=>start(h),e=>e.status===429);h.advance(60001);await complete(h,start(h));const view=h.service.status({owner:h.owner});view.account.username='Modified';assert.equal(h.service.status({owner:h.owner}).account.username,PROFILE.preferred_username);
});

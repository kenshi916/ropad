'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.join(__dirname,'parallax/dist'),source=fs.readFileSync(path.join(base,'roblox-account.js'),'utf8'),callback=fs.readFileSync(path.join(base,'roblox-oauth-callback.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Element{
  constructor(){this.innerHTML='';this.isConnected=true;this.nodes=new Map();this.hidden=false;this.textContent='';}
  querySelector(selector){if(!this.nodes.has(selector))this.nodes.set(selector,new Element());return this.nodes.get(selector);}
  addEventListener(type,handler){this['on'+type]=handler;}
}
const identity={id:'123456',displayName:'Skyline Maker',username:'SkylineCreator'};
const configured={configured:true,authenticated:true,connected:false,account:null,identityOnly:true,publishingAuthorized:false,scopes:['openid','profile']};
function fixture({account=configured,wallet=true,startUrl='https://apis.roblox.com/oauth/v1/authorize?client_id=example&state=opaque',invalidated=()=>Promise.resolve(),responses={}}={}){
  const host=new Element(),requests=[],calls=[],listeners=new Map();let connected=wallet,accountValue=account;
  const window={RopadSolana:{get:()=>connected?{address:'wallet-one'}:null,connect:()=>calls.push('wallet-picker'),authenticate:async()=>calls.push('authenticate'),check:address=>{assert.equal(address,'wallet-one');return{address:'wallet-one'};},whenInvalidated:invalidated},addEventListener:(event,handler)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(handler);},removeEventListener:(event,handler)=>listeners.get(event)?.delete(handler)};
  const context={window,URL,AbortController,fetch:async(url,options={})=>{
    requests.push({url,...options,body:options.body?JSON.parse(options.body):undefined});
    let value=url==='/api/status'?{csrf:'csrf-test'}:url==='/api/roblox/account'?accountValue:url==='/api/roblox/account/start'?{authorizationUrl:startUrl,expiresAt:Date.now()+60000}:url==='/api/roblox/account/disconnect'?{...configured}:{};
    if(Object.hasOwn(responses,url))value=typeof responses[url]==='function'?await responses[url](options):responses[url];
    return{ok:true,json:async()=>value};
  }};
  vm.runInNewContext(source,context);return{window,host,requests,calls,listeners,setAccount:value=>accountValue=value,emit:event=>{for(const handler of listeners.get(event)||[])handler();},setWallet:value=>connected=value};
}
test('unconfigured account card remains honest and mounting performs only reads',async()=>{
  const h=fixture({account:{...configured,configured:false,reason:'Open the configured Ropad origin'}});await h.window.RopadRobloxAccount.mount(h.host);
  assert.match(h.host.innerHTML,/Roblox connection setup pending/);assert.match(h.host.innerHTML,/build now and publish from your own Roblox Studio/);assert.doesNotMatch(h.host.innerHTML,/data-ra-connect[\s>]/);assert.equal(h.calls.length,0);assert.equal(h.requests.some(r=>r.method==='POST'),false);
  h.host.querySelector('[data-ra-details]').onclick();assert.match(h.host.innerHTML,/Open the configured Ropad origin/);assert.match(h.host.innerHTML,/do not need to send a password or API key/);
});
test('connecting Roblox without a Solana wallet opens the wallet picker and creates no OAuth request',async()=>{
  const h=fixture({wallet:false});await h.window.RopadRobloxAccount.mount(h.host);await h.host.querySelector('[data-ra-connect]').onclick();
  assert.deepEqual(h.calls,['wallet-picker']);assert.equal(h.requests.some(r=>r.url==='/api/roblox/account/start'),false);assert.match(h.host.innerHTML,/Connect your creator wallet/);
});
test('OAuth starts only after wallet authentication and presents an explicit safe external link',async()=>{
  const h=fixture();await h.window.RopadRobloxAccount.mount(h.host);await h.host.querySelector('[data-ra-connect]').onclick();
  assert.deepEqual(h.calls,['authenticate']);const request=h.requests.find(r=>r.url==='/api/roblox/account/start');assert.equal(request.method,'POST');assert.equal(request.credentials,'same-origin');assert.equal(request.headers['X-Parallax-Token'],'csrf-test');
  assert.match(h.host.innerHTML,/Continue on Roblox ↗/);assert.match(h.host.innerHTML,/target="_blank" rel="noopener noreferrer"/);assert.match(h.host.innerHTML,/separate publishing permission/);
});
test('OAuth authorization URLs cannot redirect to lookalike origins, credentials, or different paths',async()=>{
  for(const startUrl of ['https://apis.roblox.com.evil.example/oauth/v1/authorize','http://apis.roblox.com/oauth/v1/authorize','https://user:pass@apis.roblox.com/oauth/v1/authorize','https://apis.roblox.com:444/oauth/v1/authorize','https://apis.roblox.com/other','https://apis.roblox.com/oauth/v1/authorize#fragment']){
    const h=fixture({startUrl});await h.window.RopadRobloxAccount.mount(h.host);await h.host.querySelector('[data-ra-connect]').onclick();assert.doesNotMatch(h.host.innerHTML,/Continue on Roblox ↗/);assert.match(h.host.innerHTML,/connection could not be opened/);
  }
});
test('verified identity renders safely and ignores provider-supplied profile URLs',async()=>{
  const h=fixture({account:{...configured,connected:true,account:{...identity,displayName:'<img src=x>',profileUrl:'javascript:alert(1)'}}});await h.window.RopadRobloxAccount.mount(h.host);
  assert.match(h.host.innerHTML,/&lt;img src=x&gt;/);assert.match(h.host.innerHTML,/https:\/\/www.roblox.com\/users\/123456\/profile/);assert.doesNotMatch(h.host.innerHTML,/javascript:|<img src=x>/);assert.match(h.host.innerHTML,/CONNECTED/);
});
test('wallet change clears connected identity and pending authorization immediately',async()=>{
  let unblock,gate=Promise.resolve();const h=fixture({invalidated:()=>gate});await h.window.RopadRobloxAccount.mount(h.host);await h.host.querySelector('[data-ra-connect]').onclick();assert.match(h.host.innerHTML,/Continue on Roblox/);
  gate=new Promise(resolve=>unblock=resolve);h.setAccount({...configured,authenticated:false});h.emit('ropad-solana-wallet-change');assert.doesNotMatch(h.host.innerHTML,/Continue on Roblox/);unblock();await tick();assert.doesNotMatch(h.host.innerHTML,/CONNECTED/);
});
test('stale account reads cannot expose the previous wallet identity',async()=>{
  let release,reads=0;const gate=new Promise(resolve=>release=resolve),h=fixture({responses:{'/api/roblox/account':async()=>{reads++;if(reads===1){await gate;return{...configured,connected:true,account:identity};}return{...configured,authenticated:false};}}});
  const mounted=h.window.RopadRobloxAccount.mount(h.host);await tick();h.emit('ropad-solana-wallet-change');await tick();release();await mounted;assert.doesNotMatch(h.host.innerHTML,/Skyline Maker|CONNECTED/);
});
test('unmount removes listeners, aborts pending reads, and rejects late DOM writes',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),h=fixture({responses:{'/api/roblox/account':async()=>{await gate;return configured;}}});const mounted=h.window.RopadRobloxAccount.mount(h.host);await tick();h.window.RopadRobloxAccount.unmount(h.host);h.host.innerHTML='Preserved next view';release();await mounted;
  assert.equal(h.host.innerHTML,'Preserved next view');assert.equal(h.listeners.get('focus').size,0);assert.equal(h.listeners.get('ropad-solana-wallet-change').size,0);assert.equal(h.requests[0].signal.aborted,true);
});
test('focus on a detached host cleans up its event listeners',async()=>{
  const h=fixture();await h.window.RopadRobloxAccount.mount(h.host);h.host.isConnected=false;h.emit('focus');assert.equal(h.listeners.get('focus').size,0);assert.equal(h.listeners.get('ropad-solana-wallet-change').size,0);
});
test('disconnect requires creator authentication and CSRF without granting publication',async()=>{
  const h=fixture({account:{...configured,connected:true,account:identity}});await h.window.RopadRobloxAccount.mount(h.host);await h.host.querySelector('[data-ra-disconnect]').onclick();assert.deepEqual(h.calls,['authenticate']);const request=h.requests.find(r=>r.url==='/api/roblox/account/disconnect');assert.equal(request.headers['X-Parallax-Token'],'csrf-test');assert.match(h.host.innerHTML,/account disconnected/);assert.doesNotMatch(h.host.innerHTML,/Skyline Maker/);
});
function callbackFixture({search='?code=private-code&state=private-state',completion={connected:true,account:identity},fail=false}={}){
  const nodes={},requests=[],history=[];const window={location:{search,pathname:'/roblox/oauth/callback'},history:{replaceState:(...args)=>history.push(args)}};
  vm.runInNewContext(callback,{window,URLSearchParams,AbortSignal,document:{getElementById:id=>nodes[id]||(nodes[id]=new Element())},fetch:async(url,options)=>{requests.push({url,...options,body:options.body?JSON.parse(options.body):null});assert.equal(history.length,1);return{ok:!fail,json:async()=>url==='/api/status'?{csrf:'callback-csrf'}:completion};}});
  return{nodes,requests,history};
}
test('callback strips its query before requests and sends code only to same-origin CSRF-protected completion',async()=>{
  const h=callbackFixture();await tick();assert.equal(h.history[0][2],'/roblox/oauth/callback');assert.deepEqual(h.requests.map(r=>r.url),['/api/status','/api/roblox/account/complete']);const request=h.requests[1];assert.equal(request.credentials,'same-origin');assert.equal(request.headers['X-Parallax-Token'],'callback-csrf');assert.equal(request.body.code,'private-code');assert.equal(request.body.state,'private-state');assert.match(h.nodes['ra-callback-heading'].textContent,/account connected/);assert.match(h.nodes['ra-callback-status'].textContent,/original Ropad tab/);assert.equal(h.nodes['ra-callback-account'].hidden,false);
});
test('cancelled or incomplete callbacks make no API requests and never echo sensitive query values',async()=>{
  for(const search of ['?error=private-denial&error_description=secret','?code=secret-without-state','?state=secret-without-code']){const h=callbackFixture({search});await tick();assert.equal(h.requests.length,0);assert.doesNotMatch(Object.values(h.nodes).map(n=>n.textContent).join(' '),/private-denial|secret/);assert.equal(h.history[0][2],'/roblox/oauth/callback');}
});
test('callback errors stay generic and never expose OAuth codes or token details',async()=>{
  const h=callbackFixture({fail:true});await tick();assert.match(h.nodes['ra-callback-heading'].textContent,/not completed/);assert.doesNotMatch(Object.values(h.nodes).map(n=>n.textContent).join(' '),/private-code|private-state|csrf/);assert.equal(h.nodes['ra-callback-account'].hidden,true);
});

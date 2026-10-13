'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=fs.existsSync(path.join(__dirname,'parallax/dist/release-center.js'))?path.join(__dirname,'parallax/dist/release-center.js'):path.join(__dirname,'../dist/release-center.js');
const source=fs.readFileSync(file,'utf8');
const build=(patch={})=>({id:'game-123',gameName:'Skyline Circuit',status:'ready',canManage:false,...patch});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const pending=[];
 const window={RopadSolana:{signTransaction(){throw Error('Release inspection must not request signatures');}},open(){throw Error('Release inspection must not launch external navigation');}};
 const document={createElement(){let html='';return {set innerHTML(value){html=value;},get firstElementChild(){const body=html.match(/^<main[^>]*>([\s\S]*)<\/main>$/);return {innerHTML:body?.[1]||html};}};}};
 const fetch=(url,options={})=>new Promise((resolve,reject)=>pending.push({url,options,resolve:value=>resolve({ok:true,json:async()=>value}),fail:()=>resolve({ok:false,json:async()=>({error:'Unavailable'})}),reject}));
 vm.runInNewContext(source,{window,document,fetch,AbortController,console},{filename:file});
 function root(){const nodes={};let html='';return {isConnected:true,nodes,get innerHTML(){return html;},set innerHTML(value){html=value;for(const key of ['publication','launch','fees']){const match=value.match(new RegExp('<div data-rc-'+key+'[^>]*>([\\s\\S]*?)<\\/div>'));nodes['[data-rc-'+key+']']={innerHTML:match?.[1]||''};}},querySelector:selector=>nodes[selector]||null};}
 function mount(item){const r=root();r.innerHTML=window.RopadReleaseCenter.render(item);window.RopadReleaseCenter.wire(item,r);return r;}
 return {api:window.RopadReleaseCenter,pending,root,mount,window};
}

test('spectators see separate game and coin requirements without private publication requests',()=>{
 const h=fixture(),item=build(),html=h.api.render(item);h.mount(item);
 assert.deepEqual(h.pending.map(x=>x.url),['/api/solana/launches/config','/api/solana/fees/config']);
 assert.doesNotMatch(html,/data-builder-action="(?:publish|review|update|project-edit|launch|fee-sharing)"/);
 assert.match(html,/Connect and verify the creator wallet/);assert.match(html,/A coin launch does not publish the Roblox experience/);
 for(const value of ['true',1,{},null]){const v=fixture();v.mount(build({canManage:value}));assert.equal(v.pending.length,2);}
});

test('creator inspection is GET-only and does not initiate uploads, payments or signing',()=>{
 const h=fixture();h.mount(build({canManage:true}));assert.equal(h.pending.length,3);
 assert.equal(h.pending[2].url,'/api/builds/game-123/publication');
 for(const request of h.pending){assert.equal(request.options.method||'GET','GET');assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.body,undefined);assert.equal(request.options.headers.Accept,'application/json');assert.ok(request.options.signal);}
});

test('names, review labels and private publication fields are escaped before insertion',async()=>{
 const h=fixture(),attack='<img src=x onerror="alert(1)">';
 const item=build({canManage:true,gameName:attack,readiness:{checks:[{label:attack,passed:false}]}}),html=h.api.render(item),root=h.mount(item);
 assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
 h.pending[2].resolve({configuration:{connected:true,configured:true,target:{universeId:attack,placeId:attack}}});await flush();
 const status=root.nodes['[data-rc-publication]'].innerHTML;assert.doesNotMatch(status,/<img/);assert.match(status,/&lt;img/);
});

test('unconfigured or invalid fee policy never implies a payout or provider balance',async()=>{
 const h=fixture(),root=h.mount(build());h.pending[1].resolve({status:'inactive',providerCreditsUsd:999999,receivedSol:12345});await flush();
 assert.match(root.nodes['[data-rc-fees]'].innerHTML,/not configured/);assert.doesNotMatch(root.nodes['[data-rc-fees]'].innerHTML,/999999|12345/);
 const html=h.api.render(build());assert.match(html,/SOL arriving in a compute treasury is not OpenRouter credit/);assert.match(html,/do not automatically own the game or receive its Roblox income/);assert.match(html,/not guaranteed earnings/);assert.match(html,/do not yet include a production purchase-receipt system/);
 for(const splitBps of [{platform:5000,compute:2000,creator:5000},{platform:-100,compute:10100},{platform:5000,compute:5000,creator:'0'},{platform:NaN,compute:10000}]){
  const v=fixture(),r=v.mount(build());v.pending[1].resolve({status:'configured',splitBps});await flush();assert.match(r.nodes['[data-rc-fees]'].innerHTML,/could not be validated/);assert.doesNotMatch(r.nodes['[data-rc-fees]'].innerHTML,/Configured policy/);
 }
});

test('valid percentage breakdown remains a policy and never claims confirmed on-chain income',async()=>{
 const h=fixture(),root=h.mount(build());h.pending[1].resolve({status:'configured',splitBps:{platform:2000,compute:3000,creator:5000},providerCreditsUsd:100000});await flush();
 const html=root.nodes['[data-rc-fees]'].innerHTML;assert.match(html,/creator 50% · platform 20% · AI compute 30%/);assert.match(html,/Configuration is not proof/);assert.doesNotMatch(html,/100000|earned|payout available/);
 const v=fixture(),r=v.mount(build());v.pending[1].resolve({status:'configured',splitBps:{platform:4000,compute:6000}});await flush();assert.match(r.nodes['[data-rc-fees]'].innerHTML,/no separate creator share/);
});

test('losing creator authority clears private status and ignores old responses even when fetch ignores abort',async()=>{
 const h=fixture(),owner=build({canManage:true}),root=h.mount(owner),old=h.pending.slice();
 old[2].resolve({configuration:{connected:true,configured:true,target:{universeId:'111',placeId:'222'}}});await flush();assert.match(root.nodes['[data-rc-publication]'].innerHTML,/111/);
 h.api.refresh(build({canManage:false}),root);assert.ok(old.every(x=>x.options.signal.aborted));assert.doesNotMatch(root.innerHTML,/Authorized target|111|222|data-builder-action="publish"/);
 old[0].resolve({cluster:'mainnet-beta'});old[1].resolve({status:'configured',splitBps:{platform:0,compute:0,creator:10000}});await flush();
 assert.doesNotMatch(root.nodes['[data-rc-launch]'].innerHTML,/Mainnet/);assert.doesNotMatch(root.nodes['[data-rc-fees]'].innerHTML,/creator 100%/);assert.equal(h.pending.length,5);
 // Separate pending private request demonstrates an actual late private response.
 const v=fixture(),r=v.mount(owner),privateRequest=v.pending[2];v.api.refresh(build({canManage:false}),r);privateRequest.resolve({configuration:{connected:true,configured:true,target:{universeId:'SECRET999',placeId:'SECRET888'}}});await flush();assert.doesNotMatch(r.nodes['[data-rc-publication]'].innerHTML,/SECRET|Authorized target/);
});

test('responses cannot update a detached page and unchanged refresh does not duplicate requests',async()=>{
 const h=fixture(),item=build({canManage:true}),root=h.mount(item);h.api.refresh(item,root);assert.equal(h.pending.length,3);
 const before=root.nodes['[data-rc-publication]'].innerHTML;root.isConnected=false;h.pending[2].resolve({configuration:{connected:true,configured:true,target:{universeId:'123',placeId:'456'}}});await flush();assert.equal(root.nodes['[data-rc-publication]'].innerHTML,before);
});

test('connection errors produce unavailable states instead of success claims',async()=>{
 const h=fixture(),root=h.mount(build({canManage:true}));for(const request of h.pending)request.fail();await flush();
 assert.match(root.nodes['[data-rc-publication]'].innerHTML,/Publishing status unavailable/);assert.match(root.nodes['[data-rc-launch]'].innerHTML,/Launch configuration unavailable/);assert.match(root.nodes['[data-rc-fees]'].innerHTML,/No revenue or payout balance can be inferred/);
});

test('upload receipt and mint verification have distinct labels and cannot certify public player access',()=>{
 const h=fixture(),mint={chain:'solana',cluster:'mainnet-beta',verified:true,address:'11111111111111111111111111111111'};
 const html=h.api.render(build({publicationReceipt:{status:'published',versionNumber:7},token:mint}));assert.match(html,/Version uploaded/);assert.match(html,/Public player access still needs checking/);assert.match(html,/Mainnet mint verified/);
 for(const publicationReceipt of [{status:'prepared',versionNumber:7},{status:'published',versionNumber:0},{status:'published',versionNumber:'7'},{status:'published',versionNumber:NaN}])assert.doesNotMatch(h.api.render(build({publicationReceipt})),/<b>Version uploaded/);
 for(const token of [{...mint,verified:false},{...mint,verified:'true'},{...mint,address:'<script>'},{...mint,cluster:'devnet'}])assert.doesNotMatch(h.api.render(build({token})),/Mainnet mint verified/);
});

test('unknown network data is unavailable rather than labeled Devnet',async()=>{
 for(const config of [{},{cluster:'unknown'},{cluster:null}]){const h=fixture(),root=h.mount(build());h.pending[0].resolve(config);await flush();const html=root.nodes['[data-rc-launch]'].innerHTML;assert.doesNotMatch(html,/Devnet mode|Mainnet launch service selected/);assert.match(html,/unavailable|unrecognized|unknown|could not/i);}
});

test('malformed release check arrays do not crash the release page',()=>{
 const h=fixture();for(const checks of [{},'not-checks',false,123])assert.doesNotThrow(()=>h.api.render(build({readiness:{checks}})));
});

test('invalid project IDs cannot create API paths, navigation or private requests',()=>{
 for(const id of ['../secret','..','a/b','',null,'x" onclick="alert(1)','a'.repeat(129)]){
  const h=fixture(),item=build({id,canManage:true}),html=h.api.render(item);h.mount(item);
  assert.match(html,/Game link unavailable/);assert.doesNotMatch(html,/api\/builds|#\/token|#\/workspace/);assert.equal(h.pending.length,0);
 }
});

test('mainnet service availability requires an explicit true flag',async()=>{
 for(const mainnetAvailable of [undefined,false,'true',1]){const h=fixture(),r=h.mount(build());h.pending[0].resolve({cluster:'mainnet-beta',mainnetAvailable});await flush();assert.doesNotMatch(r.nodes['[data-rc-launch]'].innerHTML,/Mainnet launch service selected/);}
 const h=fixture(),r=h.mount(build());h.pending[0].resolve({cluster:'mainnet-beta',mainnetAvailable:true});await flush();assert.match(r.nodes['[data-rc-launch]'].innerHTML,/Wallet approval and chain confirmation are required/);
});

test('wallet connection and creator verification are separate actions',()=>{
 const h=fixture();assert.match(h.api.render(build()),/data-builder-action="wallet">Connect creator wallet/);
 h.window.RopadSolana.get=()=>({address:'a-connected-wallet'});assert.match(h.api.render(build()),/data-builder-action="verify-owner">Verify creator wallet/);
 const html=h.api.render(build({canManage:true}));assert.doesNotMatch(html,/Connect creator wallet|Verify creator wallet/);assert.match(html,/data-builder-action="publish"/);
});

test('malformed pass flags cannot mark quality checks complete',()=>{
 for(const passed of ['false','true',1,{},null]){const h=fixture(),html=h.api.render(build({readiness:{checks:[{label:'Actual playtest',passed}]}}));assert.doesNotMatch(html,/<li class="passed">/);}
 assert.match(fixture().api.render(build({readiness:{checks:[{label:'Actual playtest',passed:true}]}})),/<li class="passed">/);
});

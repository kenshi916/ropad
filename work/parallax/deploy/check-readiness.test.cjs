'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {checkReadiness,checkFrontend}=require('./check-readiness.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-deploy-check-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const env={ROPAD_PUBLIC_ORIGIN:'https://ropad.fun',ROPAD_DOMAIN:'ropad.fun',ROPAD_BIND_HOST:'0.0.0.0',ROPAD_SOLANA_MAINNET_ENABLED:'0',OPENROUTER_API_KEY:'never-print-this-fixture-secret'};return {directory,env};}
test('readiness reports only booleans and names, leaves files untouched and does not claim deployment',t=>{const f=fixture(t),before=fs.readdirSync(f.directory),r=checkReadiness({env:f.env,stateDirectory:f.directory}),serialized=JSON.stringify(r);assert.equal(r.runtimeConfigured,true);assert.equal(r.launchConfigurationComplete,false);assert.equal(r.checks.mainnetExplicitlyDisabled,true);assert.equal(r.checks.inferenceKeyConfigured,true);assert.ok(r.missing.includes('explicit_mainnet_opt_in'));assert.ok(r.unverified.includes('wallet_signed_launch_and_trade'));assert.equal(serialized.includes(f.env.OPENROUTER_API_KEY),false);assert.equal(serialized.includes(f.directory),false);assert.equal(serialized.includes('https://ropad.fun'),false);assert.deepEqual(fs.readdirSync(f.directory),before);});
test('invalid configuration errors never echo environment values or private source records',t=>{const f=fixture(t);f.env.ROPAD_PUBLIC_ORIGIN='https://private-token-value:password@example.com';fs.writeFileSync(path.join(f.directory,'fee-accounting-config.json'),'private-saved-record-not-json');const r=checkReadiness({env:f.env,stateDirectory:f.directory});assert.equal(r.runtimeConfigured,false);assert.equal(r.checks.feeRecipientsConfigured,false);assert.doesNotMatch(JSON.stringify(r),/password|private-token|private-saved-record/);assert.equal(fs.readFileSync(path.join(f.directory,'fee-accounting-config.json'),'utf8'),'private-saved-record-not-json');});
test('mismatched proxy host and unsupported Studio worker domains stay visible',t=>{const f=fixture(t);f.env.ROPAD_DOMAIN='api.ropad.fun';const r=checkReadiness({env:f.env,stateDirectory:f.directory});assert.equal(r.checks.proxyHostnameMatchesOrigin,false);f.env.ROPAD_PUBLIC_ORIGIN='https://api.ropad.fun';const other=checkReadiness({env:f.env,stateDirectory:f.directory});assert.equal(other.checks.workerRemoteOriginSupported,false);});
test('creator publishing readiness checks every target-specific key without exposing values or accepting a global fallback',t=>{
 const f=fixture(t),projects={a:{owner:'creator-a',placeId:'11',universeId:'21',credentialEnv:'ROPAD_ROBLOX_CREATOR_A_KEY'},b:{owner:'creator-b',placeId:'12',universeId:'22',credentialEnv:'ROPAD_ROBLOX_CREATOR_B_KEY'}};
 fs.writeFileSync(path.join(f.directory,'roblox-publishing-config.json'),JSON.stringify({credentialMode:'creator_scoped',projects}));f.env.ROBLOX_OPEN_CLOUD_API_KEY='unused-global-secret';f.env.ROPAD_ROBLOX_CREATOR_A_KEY='secret-a';
 const run=()=>checkReadiness({env:f.env,stateDirectory:f.directory});let r=run();assert.equal(r.checks.creatorScopedPublishing,true);assert.equal(r.checks.publishingTargetsConfigured,true);assert.equal(r.checks.robloxPublishingKeyConfigured,false);
 f.env.ROPAD_ROBLOX_CREATOR_B_KEY='secret-b';r=run();assert.equal(r.checks.robloxPublishingKeyConfigured,true);assert.doesNotMatch(JSON.stringify(r),/secret-a|secret-b|unused-global-secret|creator-a|creator-b|ROPAD_ROBLOX_CREATOR/);
 f.env.ROPAD_ROBLOX_CREATOR_B_KEY='secret-a';assert.equal(run().checks.robloxPublishingKeyConfigured,false);
});
test('publishing readiness rejects duplicate places and preserves legacy single-operator configuration checks',t=>{
 const f=fixture(t),projects={a:{owner:'one',placeId:'11',universeId:'21'},b:{owner:'two',placeId:'11',universeId:'21'}},file=path.join(f.directory,'roblox-publishing-config.json');f.env.ROBLOX_OPEN_CLOUD_API_KEY='legacy-secret';
 fs.writeFileSync(file,JSON.stringify({projects}));assert.equal(checkReadiness({env:f.env,stateDirectory:f.directory}).checks.publishingTargetsConfigured,false);delete projects.b;fs.writeFileSync(file,JSON.stringify({projects}));const r=checkReadiness({env:f.env,stateDirectory:f.directory});assert.equal(r.checks.publishingTargetsConfigured,true);assert.equal(r.checks.creatorScopedPublishing,false);assert.equal(r.checks.robloxPublishingKeyConfigured,true);
});
test('health probe uses the allowed loopback Host and reports no response bodies',async t=>{const server=http.createServer((req,res)=>{assert.equal(req.url,'/api/health');assert.equal(req.headers.host,'127.0.0.1:'+server.address().port);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,service:'ropad',ignoredSecret:'do-not-print'}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const r=await promisify(execFile)(process.execPath,[path.join(__dirname,'healthcheck.cjs')],{env:{...process.env,PORT:String(server.address().port)}});assert.equal(r.stdout,'');assert.equal(r.stderr,'');});
test('health probe fails an unhealthy response without printing it',async t=>{const server=http.createServer((req,res)=>{res.writeHead(503);res.end('private-error-record');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());await assert.rejects(promisify(execFile)(process.execPath,[path.join(__dirname,'healthcheck.cjs')],{env:{...process.env,PORT:String(server.address().port)}}),e=>e.code===1&&e.stdout===''&&e.stderr==='');});
function frontendFixture(t){
 const f=fixture(t),appDirectory=path.join(f.directory,'app'),dist=path.join(appDirectory,'dist');fs.mkdirSync(dist,{recursive:true});
 const files=['builders.js','ropad-solana.js','ropad-trade.js','token-page.js','fee-sharing.js','release-center.js','roblox-account.js','roblox-oauth-callback.html','roblox-oauth-callback.js','styles.css'];
 for(const file of files)fs.writeFileSync(path.join(dist,file),'fixture');
 const html='<link rel="stylesheet" href="styles.css">'+files.filter(file=>file.endsWith('.js')).map(file=>`<script src="${file}"></script>`).join('');
 fs.writeFileSync(path.join(dist,'index.html'),html);return {...f,appDirectory,dist,html};
}
test('readiness rejects missing entrypoint assets and the disconnected preview without printing source paths',t=>{
 const f=frontendFixture(t),run=()=>checkReadiness({env:f.env,stateDirectory:f.directory,appDirectory:f.appDirectory});
 assert.equal(run().runtimeConfigured,true);fs.unlinkSync(path.join(f.dist,'styles.css'));
 let r=run();assert.equal(r.runtimeConfigured,false);assert.ok(r.missing.includes('frontendAssetsPresent'));assert.equal(JSON.stringify(r).includes(f.appDirectory),false);
 fs.writeFileSync(path.join(f.dist,'styles.css'),'fixture');fs.writeFileSync(path.join(f.dist,'hosting-status.js'),'fixture');
 fs.writeFileSync(path.join(f.dist,'index.html'),f.html+'<script src="hosting-status.js"></script>');
 r=run();assert.equal(r.checks.frontendAssetsPresent,true);assert.equal(r.checks.frontendPreviewDisabled,false);assert.equal(r.runtimeConfigured,false);
});
test('frontend checks require callback files and reject external or encoded path dependencies',t=>{
 const f=frontendFixture(t);assert.deepEqual(checkFrontend(f.appDirectory),{frontendAssetsPresent:true,frontendPreviewDisabled:true});
 fs.unlinkSync(path.join(f.dist,'roblox-oauth-callback.html'));assert.equal(checkFrontend(f.appDirectory).frontendAssetsPresent,false);
 fs.writeFileSync(path.join(f.dist,'roblox-oauth-callback.html'),'fixture');
 for(const src of ['https://example.invalid/browser.js','/%2e%2e%5cprivate.txt']){fs.writeFileSync(path.join(f.dist,'index.html'),f.html+`<script src="${src}"></script>`);assert.equal(checkFrontend(f.appDirectory).frontendAssetsPresent,false);}
});
test('compute-first preset stays inactive until reviewed recipients are supplied and validates shares',t=>{
 const f=fixture(t),preset=JSON.parse(fs.readFileSync(path.join(__dirname,'fee-accounting-config.compute-first.example.json'),'utf8')),file=path.join(f.directory,'fee-accounting-config.json');
 assert.deepEqual(preset.splitBps,{compute:6000,creator:3000,platform:1000});assert.equal(preset.platformMint,null);assert.equal(preset.platformTreasury,'');assert.equal(preset.computeTreasury,'');
 const run=()=>{fs.writeFileSync(file,JSON.stringify(preset));return checkReadiness({env:f.env,stateDirectory:f.directory});};assert.equal(run().checks.feeRecipientsConfigured,false);
 const {PublicKey}=require('@solana/web3.js');[preset.platformMint,preset.platformTreasury,preset.computeTreasury]=[1,2,3].map(value=>new PublicKey(Buffer.alloc(32,value)).toBase58());
 const valid=run();assert.equal(valid.checks.feeRecipientsConfigured,true);assert.equal(valid.launchConfigurationComplete,false);assert.equal(valid.checks.mainnetExplicitlyDisabled,true);
 for(const value of [preset.platformMint,preset.platformTreasury,preset.computeTreasury])assert.equal(JSON.stringify(valid).includes(value),false);
 preset.splitBps.compute=5000;assert.equal(run().checks.feeRecipientsConfigured,false);preset.splitBps.compute=6000;preset.computeTreasury=preset.platformTreasury;preset.platformMint=null;assert.equal(run().checks.feeRecipientsConfigured,true);preset.computeTreasury='not-a-solana-address';assert.equal(run().checks.feeRecipientsConfigured,false);
});

test('zero daily compute budget pauses paid-work readiness without invalidating a configured runtime',t=>{
 const f=fixture(t),run=()=>checkReadiness({env:f.env,stateDirectory:f.directory});
 f.env.ROPAD_DAILY_COMPUTE_BUDGET_USD='0';let r=run();assert.equal(r.runtimeConfigured,true);assert.equal(r.checks.dailyComputeBudgetAllowsWork,false);assert.ok(r.missing.includes('dailyComputeBudgetAllowsWork'));assert.equal(r.launchConfigurationComplete,false);
 f.env.ROPAD_DAILY_COMPUTE_BUDGET_USD='25';r=run();assert.equal(r.checks.dailyComputeBudgetAllowsWork,true);assert.equal(r.checks.mainnetExplicitlyDisabled,true);
 f.env.ROPAD_DAILY_COMPUTE_BUDGET_USD='1001';assert.equal(run().checks.runtimeConfigurationValid,false);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'watch-studio-playtest.cjs'),'utf8');
const studioId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',buildId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',jobId='cccccccc-cccc-cccc-cccc-cccccccccccc';
async function run({startupFailure=false,requested=false,recover=false}={}){
 const files=new Map(),signals={},logs=[],delays=[];let closed=false,connections=0,recovered=false;
 const localFs={mkdirSync(){},writeFileSync:(p,b)=>files.set(p,b),renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},readFileSync(){throw Error('Not found');}};
 const client={closed:false,async call(){if(requested)return{content:[{type:'text',text:'Current Studio Mode: Edit'}]};this.closed=true;throw Error('Studio MCP disconnected');},close(){closed=true;}};
 const process={argv:['node','watch',studioId,buildId,jobId],on:(name,fn)=>signals[name]=fn};
 const context={__dirname,Buffer,AbortSignal,Date,process,console:{log:value=>logs.push(JSON.parse(value))},setTimeout(fn,ms){delays.push(ms);if(requested||recovered)signals.SIGTERM();fn();},fetch:async()=>{if(startupFailure)throw Error('Private raw transport details');return{ok:true,json:async()=>({build:{id:buildId,jobId}})};},require(name){if(name==='node:fs')return localFs;if(name==='./parallax/studio-mcp-client.cjs')return{connectStudioMcp:async()=>{connections++;if(connections===1)return client;if(recover){recovered=true;return{closed:false,call:async()=>({content:[{type:'text',text:'Current Studio Mode: Edit'}]}),close(){closed=true;}};}throw Error('Transport disconnected');}};return require(name);}};
 vm.runInNewContext(source,context,{filename:'watch-studio-playtest.cjs'});await new Promise(resolve=>setImmediate(resolve));
 const status=JSON.parse([...files].find(([p])=>p.endsWith('status.json'))[1]);return{status,logs,closed,process,connections,delays};
}
test('closed MCP exhausts only three reconnect attempts and retains an honest error',async()=>{
 const h=await run();assert.equal(h.status.state,'error');assert.equal(h.status.stopReason,'mcp-reconnect-exhausted');assert.equal(h.status.failedStage,'studio-state');assert.equal(h.logs[0].status,'error');assert.equal(h.closed,true);assert.equal(h.connections,4);assert.deepEqual(h.delays,[1000,2000,4000]);assert.equal(h.logs[0].reconnectAttempts,3);
});
test('startup failure remains distinguishable and never publishes raw transport diagnostics',async()=>{
 const h=await run({startupFailure:true});assert.equal(h.status.state,'error');assert.equal(h.status.stopReason,'startup-failed');assert.equal(h.status.failedStage,'verify-build');assert.equal(h.process.exitCode,1);assert.doesNotMatch(JSON.stringify(h.status),/Private raw/);
});
test('requested capture shutdown truthfully marks the stream stopped and closes its client',async()=>{
 const h=await run({requested:true});assert.equal(h.status.state,'stopped');assert.equal(h.status.stopReason,'requested');assert.equal(h.status.error,null);assert.equal(h.closed,true);
});
test('a recovered MCP connection stays non-live until matching Play mode and new captures',async()=>{
 const h=await run({recover:true});assert.equal(h.connections,2);assert.equal(h.status.state,'stopped');assert.equal(h.status.stopReason,'requested');assert.equal(h.logs[0].capturedFrames,0);assert.equal(h.logs[0].reconnectAttempts,1);
});

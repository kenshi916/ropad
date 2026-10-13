'use strict';
// Read-only Studio capture. No AI requests, input simulation, worker credentials or build mutations.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {connectStudioMcp}=require('./parallax/studio-mcp-client.cjs');
const [studioId,buildId,jobId]=process.argv.slice(2);
for(const value of [studioId,buildId,jobId])if(!/^[a-f0-9-]{36}$/.test(value||''))throw Error('Pass explicit Studio, build and job UUIDs');
const dir=path.join(__dirname,'parallax/dist/runtime-playtest',buildId);
const actionPath=path.join(__dirname,'../outputs/skyline-playtest-action.json');
fs.mkdirSync(dir,{recursive:true});
let running=true,client,last={},count=0,stopReason='',stage='connect',reconnectAttempts=0;
const stop=()=>{running=false;stopReason='requested';};process.on('SIGINT',stop);process.on('SIGTERM',stop);
function write(file,bytes){const target=path.join(dir,file),temp=target+'.tmp';fs.writeFileSync(temp,bytes);fs.renameSync(temp,target);}
function state(update){last={buildId,studioId,jobId,mode:'playtest',...last,...update};write('status.json',JSON.stringify(last));}
function action(){try{const data=JSON.parse(fs.readFileSync(actionPath,'utf8'));if(data.buildId===buildId&&typeof data.action==='string')return data.action.slice(0,180);}catch{}return 'Observing the current Studio playtest';}
async function reconnect(){
 while(running&&reconnectAttempts<3){
  reconnectAttempts++;
  state({state:'error',error:'Studio capture disconnected; reconnecting',action:'Waiting for the Studio capture connection',reconnectAttempt:reconnectAttempts});
  await new Promise(resolve=>setTimeout(resolve,1000*Math.pow(2,reconnectAttempts-1)));
  if(!running)return false;
  try{client=await connectStudioMcp();return true;}catch{}
 }
 if(running){stopReason='mcp-reconnect-exhausted';process.exitCode=1;state({state:'error',error:'Studio capture disconnected after three reconnect attempts',action:'Capture connection requires attention'});}
 return false;
}
async function main(){
 client=await connectStudioMcp();
 stage='verify-build';
 const response=await fetch('http://127.0.0.1:61281/api/builds/'+buildId,{signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Build service unavailable');
 const publicBuild=(await response.json()).build;
 if(publicBuild?.jobId!==jobId)throw Error('Job identity does not match this Ropad build');
 while(running){
  const start=Date.now();
  try{
   stage='studio-state';
   const result=await client.call('get_studio_state',{studio_id:studioId});
   const text=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
   if(!/Current Studio Mode:\s*Play\b/.test(text)){
    if(!/Current Studio Mode:\s*(?:Edit|Run|Pause|Paused)\b/.test(text))throw Error('Studio mode could not be verified');
    state({state:'stopped',action:'Studio is not in Play mode',error:null,failedStage:null});
   }
   else{
    stage='verify-place';
    const probe=await client.call('execute_luau',{studio_id:studioId,datamodel_type:'Server',code:'local r=workspace:FindFirstChild("Parallax_'+buildId.replaceAll('-','')+'");return r and r:GetAttribute("ParallaxJob") == "'+jobId+'" and "ROPAD_WATCH_MATCH" or "ROPAD_WATCH_MISMATCH"'});
    if(!(probe.content||[]).some(x=>x.type==='text'&&x.text.trim()==='ROPAD_WATCH_MATCH'))throw Error('Studio is not running this game job');
    stage='screen-capture';
    const shot=await client.call('screen_capture',{studio_id:studioId,capture_id:'RopadLivePlaytest'});
    const item=shot.content?.find(x=>x.type==='image');
    if(!item||!['image/jpeg','image/png'].includes(item.mimeType))throw Error('Studio did not return a supported frame');
    const bytes=Buffer.from(item.data,'base64');if(bytes.length<32||bytes.length>4*1024*1024)throw Error('Frame size outside capture bounds');
    write('frame.jpg',bytes); // Browser decodes the actual JPEG/PNG signature.
    state({state:'live',capturedAt:Date.now(),frameId:crypto.createHash('sha256').update(bytes).digest('hex').slice(0,24),action:action(),error:null,failedStage:null});
    count++;
   }
  }catch(error){state({state:'error',error:'Studio capture is unavailable',action:'Capture interrupted',failedStage:stage});if(client.closed){if(!await reconnect())break;}}
  await new Promise(resolve=>setTimeout(resolve,Math.max(250,1200-(Date.now()-start))));
 }
}
main().catch(()=>{stopReason='startup-failed';state({state:'error',error:'Studio capture could not start',action:'Capture unavailable',failedStage:stage});process.exitCode=1;}).finally(()=>{
 // Preserve capture failures: Studio may still be playing after its MCP connection closes.
 if(stopReason==='requested')state({state:'stopped',action:'Playtest capture stopped',error:null,stopReason});
 else if(last.state==='error')state({stopReason:stopReason||'capture-failed'});
 else state({state:'stopped',action:'Playtest capture stopped',stopReason:stopReason||'completed'});
 client?.close();console.log(JSON.stringify({capturedFrames:count,status:last.state,stopReason:last.stopReason,reconnectAttempts}));
});

'use strict';
// Local HTTP and provider fixtures only: no paid generation or chain calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createApp}=require('./parallax/server.cjs');
const {Keypair}=require('./parallax/node_modules/@solana/web3.js');
const IMAGE='openai/gpt-image-2';
const params={aspect_ratio:{values:['16:9','1:1']},quality:{values:['high']},background:{values:['opaque']},n:{min:1,max:1},input_references:{min:0,max:16},output_compression:{min:0,max:100}};
function png(width,height){const data=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(data);data.write('IHDR',12);data.writeUInt32BE(width,16);data.writeUInt32BE(height,20);return data;}
async function harness(t,{budget=1}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ropad-art-http-'));
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const base='http://127.0.0.1:'+port,calls=[];
 const fetcher=async(url,options={})=>{
  if(url.endsWith('/images/models'))return Response.json({data:[{id:IMAGE,name:'OpenAI: GPT Image 2',architecture:{input_modalities:['text'],output_modalities:['image']},supported_parameters:params}]});
  if(url.endsWith('/endpoints'))return Response.json({id:IMAGE,endpoints:[{provider_name:'OpenAI',provider_slug:'openai',provider_tag:'openai',supported_parameters:params,allowed_passthrough_parameters:['moderation'],pricing:[{billable:'input_text',unit:'token',cost_usd:.000005},{billable:'input_image',unit:'token',cost_usd:.000008},{billable:'output_image',unit:'token',cost_usd:.00003}]}]});
  if(url.endsWith('/images')){const body=JSON.parse(options.body);calls.push(body);return Response.json({data:[{b64_json:png(body.aspect_ratio==='1:1'?1024:1536,body.aspect_ratio==='1:1'?1024:864).toString('base64'),media_type:'image/png'}],usage:{cost:.05}});}
  throw Error('Unexpected network request in offline test');
 };
 const app=createApp({port,stateDirectory:directory,key:'OFFLINE_TEST_KEY',fetcher,budget,models:[],verifySignature:async()=>true,cameraWorkers:false,autonomousWorkers:false});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>{app.server.closeAllConnections();app.server.close(r);});fs.rmSync(directory,{recursive:true,force:true});});
 const csrf=(await(await fetch(base+'/api/status')).json()).csrf;
 function client(){let cookie='';return async(endpoint,body,headers={})=>{const response=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{Origin:base,'X-Parallax-Token':csrf,'Content-Type':'application/json',Cookie:cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});const set=response.headers.getSetCookie();if(set.length)cookie=set.map(c=>c.split(';')[0]).join('; ');const contentType=response.headers.get('content-type');return {status:response.status,data:contentType?.includes('json')?await response.json():Buffer.from(await response.arrayBuffer())};};}
 async function login(request){const address=Keypair.generate().publicKey.toBase58();const challenge=await request('/api/auth/challenge',{address});assert.equal(challenge.status,200);assert.equal((await request('/api/auth/verify',{id:challenge.data.id,signatureBase64:Buffer.alloc(64).toString('base64')})).status,200);}
 const owner=client(),other=client();await login(owner);await login(other);return {base,app,owner,other,anonymous:client(),calls};
}
const request={name:'Orbit Garden',ticker:'ORBIT',brief:'An original floating island garden race with mint checkpoint gates',inspiration:'Clear checkpoint progression',artDirection:'Ivory architecture, mint gates, warm sunlight',idempotencyKey:'offline-artwork-request-one'};
async function finished(owner,id){for(let i=0;i<100;i++){const r=await owner('/api/launch-artwork/'+id);if(!['queued','generating'].includes(r.data.artwork?.status))return r.data.artwork;await new Promise(r=>setTimeout(r,5));}throw Error('Offline job failed to finish');}
test('artwork HTTP routes require creator auth and CSRF, persist both images, and expose only public rasters',async t=>{
 const h=await harness(t);
 assert.equal((await h.anonymous('/api/launch-artwork',request)).status,401);
 assert.equal((await h.owner('/api/launch-artwork',request,{'X-Parallax-Token':'wrong'})).status,403);
 const created=await h.owner('/api/launch-artwork',request);assert.equal(created.status,202,JSON.stringify(created.data));const id=created.data.artwork.id;
 const result=await finished(h.owner,id);assert.equal(result.status,'ready',JSON.stringify(result));assert.equal(h.calls.length,2);assert.equal(result.owner,undefined);
 assert.equal((await h.other('/api/launch-artwork/'+id)).status,403);
 const again=await h.owner('/api/launch-artwork',request);assert.equal(again.data.artwork.id,id);assert.equal(h.calls.length,2);
 for(const purpose of ['thumbnail','coinIcon']){
  const publicImage=await h.anonymous(result[purpose].url,undefined,{'Sec-Fetch-Site':'cross-site'});assert.equal(publicImage.status,200);assert.ok(Buffer.isBuffer(publicImage.data));
  assert.equal((await h.anonymous('/api/launch-artwork/'+id+'/'+purpose+'/image?hash=wrong')).status,404);
 }
 assert.equal((await h.owner('/api/launch-artwork/'+id,undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
 const runtime=await h.owner('/api/status');assert.ok(Math.abs(runtime.data.spent-.1)<1e-9);assert.equal(runtime.data.unknownCharges,0);
});
test('launch artwork fails before paid provider work when shared compute budget cannot reserve it',async t=>{
 const h=await harness(t,{budget:.001});const created=await h.owner('/api/launch-artwork',request);const result=await finished(h.owner,created.data.artwork.id);
 assert.equal(result.status,'failed');assert.equal(h.calls.length,0);assert.match(result.error,/budget|allowance|compute/i);
});

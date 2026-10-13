'use strict';
// Durable pre-launch art. A submitted request is never repeated automatically.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PublicKey}=require('@solana/web3.js');
const {rasterType}=require('./builder-concepts.cjs');
const {publicOrigin:validateOrigin}=require('./runtime-config.cjs');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KINDS=['thumbnail','coinIcon'];
function text(value,label,max,min=0){if(typeof value!=='string'||value.trim().length<min||Buffer.byteLength(value)>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw fail('Invalid '+label);return value.trim();}
function ownerAddress(value){try{const key=new PublicKey(value);if(typeof value!=='string'||key.toBase58()!==value||!PublicKey.isOnCurve(key.toBytes()))throw Error();return value;}catch{throw fail('A signed Solana wallet is required',401);}}
function safeFailure(error){
  const message=typeof error?.message==='string'?error.message:'';
  if(error?.status===402&&/budget|allowance|compute|fund/i.test(message))return 'The available compute budget cannot cover launch artwork; fund compute or wait for the daily budget to reset';
  if(error?.status===402&&/credit/i.test(message))return 'The image provider needs available credits before launch artwork can be generated';
  if(error?.status===429)return 'Image generation is rate limited; retry this saved request later';
  if([401,403].includes(error?.status))return 'The configured image provider is not authorized; operator configuration is required';
  if([400,503].includes(error?.status)&&/model|catalog|pricing|configure|provider|reserv|budget|compute/i.test(message))return 'The image provider or its verified cost allowance is unavailable; operator configuration is required';
  return 'Image generation did not complete; retry this saved request when the provider is available';
}
function artworkInput(input){
  const name=text(input.name,'game name',80,2);if(name.length>40)throw fail('Game name must be at most 40 characters');
  const ticker=text(input.ticker,'ticker',10,2).toUpperCase();if(!/^[A-Z][A-Z0-9]{1,9}$/.test(ticker))throw fail('Ticker must use 2–10 letters or numbers');
  return {name,ticker,brief:text(input.brief,'game prompt',2400,12),inspiration:text(input.inspiration??'','inspiration',1200),artDirection:text(input.artDirection??'','art direction',1200)};
}
function dimensions(bytes,type){
  let width,height;
  if(type==='image/png'&&bytes.length>=24&&bytes.subarray(12,16).toString()==='IHDR'){width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
  else if(type==='image/jpeg'){
    let p=2;while(p+4<=bytes.length){if(bytes[p++]!==255)break;while(bytes[p]===255)p++;const marker=bytes[p++];if(marker===0xd9||marker===0xda)break;if(marker===1||marker>=0xd0&&marker<=0xd7)continue;const size=bytes.readUInt16BE(p);if(size<2||p+size>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&size>=8){height=bytes.readUInt16BE(p+3);width=bytes.readUInt16BE(p+5);break;}p+=size;}
  }else if(type==='image/webp'&&bytes.length>=30){
    const kind=bytes.subarray(12,16).toString();
    if(kind==='VP8X'){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
    else if(kind==='VP8 '&&bytes.subarray(23,26).equals(Buffer.from([0x9d,1,0x2a]))){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
    else if(kind==='VP8L'&&bytes[20]===0x2f){const packed=bytes.readUInt32LE(21);width=(packed&0x3fff)+1;height=((packed>>>14)&0x3fff)+1;}
  }
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>8192||height>8192)throw fail('Image provider returned unsupported raster dimensions',502);
  return {width,height};
}
function createLaunchArtworkService({stateDirectory,generateImage,publicOrigin='',now=Date.now}={}){
  if(!stateDirectory||typeof generateImage!=='function')throw fail('Persistent launch artwork generation is unavailable',503);
  const origin=validateOrigin(publicOrigin),directory=path.join(stateDirectory,'launch-artwork'),file=path.join(directory,'index.json');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  let records=[],diskDigest=null,fault=false;const running=new Set();
  if(fs.existsSync(file))try{
    const bytes=fs.readFileSync(file),saved=JSON.parse(bytes);if(saved.version!==1||!Array.isArray(saved.artworks)||saved.artworks.length>500)throw Error();
    const ids=new Set(),keys=new Set();
    for(const row of saved.artworks){
      if(!UUID.test(row.id)||ids.has(row.id)||!['queued','generating','ready','failed','needs_review'].includes(row.status)||!Number.isFinite(row.createdAt)||!Number.isFinite(row.updatedAt))throw Error();
      ownerAddress(row.owner);const key=row.owner+':'+text(row.idempotencyKey,'artwork request key',128,8);if(keys.has(key))throw Error();keys.add(key);ids.add(row.id);
      if(hash(JSON.stringify(artworkInput(row)))!==row.fingerprint)throw Error();
      for(const kind of KINDS){const asset=row[kind];if(!asset)continue;if(!['queued','generating','ready','failed','needs_review'].includes(asset.status)||asset.operationId&&!UUID.test(asset.operationId))throw Error();if(asset.status==='ready'&&(!/^[a-f0-9]{64}$/.test(asset.hash)||!['image/png','image/jpeg','image/webp'].includes(asset.contentType)))throw Error();}
      if(row.status==='ready'&&KINDS.some(kind=>row[kind]?.status!=='ready'))throw Error();
    }
    records=saved.artworks;diskDigest=hash(bytes);
  }catch{throw fail('Saved launch artwork is unreadable; preserve it for recovery',503);}
  function assertStorage(){if(fault)throw fail('Launch artwork storage requires recovery',503);try{if((fs.existsSync(file)?hash(fs.readFileSync(file)):null)!==diskDigest)throw Error();}catch{fault=true;throw fail('Launch artwork history changed; preserve it for recovery',503);}}
  function write(target,bytes){const temp=target+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,target);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  function save(){assertStorage();try{const bytes=Buffer.from(JSON.stringify({version:1,artworks:records}));write(file,bytes);diskDigest=hash(bytes);}catch(error){fault=true;throw fail('Launch artwork could not be saved; preserve it for recovery',503);}}
  // A process interruption after onStart may already have incurred a charge.
  let interrupted=false;for(const row of records){for(const kind of KINDS)if(row[kind]?.status==='generating'){row[kind].status='needs_review';row[kind].error='Generation was interrupted after submission; review provider usage before retrying';row.status='needs_review';interrupted=true;}if(row.status==='generating'){row.status='failed';interrupted=true;}}
  if(interrupted)save();
  function owned({owner,id}){assertStorage();ownerAddress(owner);const row=records.find(r=>r.id===id);if(!row)throw fail('Launch artwork was not found',404);if(row.owner!==owner)throw fail('This artwork belongs to another wallet',403);return row;}
  function assetView(row,kind){const a=row[kind];if(!a)return null;const {operationId,...view}=a;return {...view,...(a.hash?{url:`/api/launch-artwork/${row.id}/${kind}/image?hash=${a.hash}`}:{})};}
  function output(row){const {owner,idempotencyKey,fingerprint,...view}=row;return {artwork:{...structuredClone(view),thumbnail:assetView(row,'thumbnail'),coinIcon:assetView(row,'coinIcon'),modelName:row.thumbnail?.modelName||row.coinIcon?.modelName||null,retryable:row.status==='failed'||row.status==='queued',source:'ai_generated',isGameplay:false}};}
  function publicAsset(row,purpose){const asset=row[purpose];if(asset?.status!=='ready')throw fail('This launch image is not ready',404);const target=path.join(directory,`${row.id}.${asset.hash}.${purpose}`);let bytes;try{bytes=fs.readFileSync(target);}catch{throw fail('The saved launch image is unavailable',503);}if(hash(bytes)!==asset.hash||rasterType(bytes)!==asset.contentType)throw fail('The saved launch image failed its integrity check',503);return {bytes,contentType:asset.contentType,hash:asset.hash};}
  async function run(row){
    if(running.has(row.id))return;running.add(row.id);
    try{
      for(const purpose of KINDS){
        if(row[purpose]?.status==='ready'){publicAsset(row,purpose);continue;}
        if(row[purpose]?.status==='needs_review'){row.status='needs_review';save();return;}
        let started=false;const operationId=crypto.randomUUID();row.status='generating';row.updatedAt=now();row[purpose]={status:'queued',operationId};delete row.error;save();
        try{
          const generated=await generateImage({owner:row.owner,artworkId:row.id,operationId,...artworkInput(row),purpose,onStart:info=>{
            if(started)throw fail('The image request was already submitted',409);assertStorage();
            if(!Number.isFinite(info?.estimatedCostUsd)||info.estimatedCostUsd<=0||info.estimatedCostUsd>1)throw fail('Image estimate exceeds the launch artwork allowance',402);
            row[purpose]={status:'generating',operationId,modelId:text(info.modelId,'image model',200,1),modelName:text(info.modelName,'image model name',200,1),estimatedCostUsd:info.estimatedCostUsd,startedAt:now()};row.updatedAt=now();save();started=true;
          }});
          if(!started)throw fail('Image provider did not record a bounded cost reservation',502);
          const bytes=Buffer.from(generated.bytes),contentType=rasterType(bytes),size=dimensions(bytes,contentType);
          if(generated.contentType!==contentType||purpose==='coinIcon'&&(bytes.length>5*1024*1024||size.width!==size.height))throw fail('Coin artwork must be a square raster image within 5 MB',502);
          if(purpose==='thumbnail'&&Math.abs(size.width/size.height-16/9)>.01)throw fail('Game thumbnail must use a 16:9 landscape composition',502);
          const imageHash=hash(bytes);assertStorage();write(path.join(directory,`${row.id}.${imageHash}.${purpose}`),bytes);
          const estimate=row[purpose].estimatedCostUsd;
          row[purpose]={status:'ready',operationId,hash:imageHash,contentType,...size,bytes:bytes.length,aspectRatio:purpose==='coinIcon'?'1:1':`${size.width}:${size.height}`,targetAspectRatio:purpose==='coinIcon'?'1:1':'16:9',source:'ai_generated',isGameplay:false,modelId:text(generated.modelId,'image model',200,1),modelName:text(generated.modelName,'image model name',200,1),prompt:text(generated.prompt,'image prompt',16000,1),estimatedCostUsd:estimate,costUsd:Number.isFinite(generated.costUsd)&&generated.costUsd>=0?generated.costUsd:null,generatedAt:Number.isFinite(generated.generatedAt)?generated.generatedAt:now()};
          row.updatedAt=now();save();
        }catch(error){
          const uncertain=started&&error.safeToRetry!==true;row[purpose].status=uncertain?'needs_review':'failed';row[purpose].error=uncertain?'The image request may have been charged but its result is unconfirmed; operator review is required':safeFailure(error);row.status=row[purpose].status;row.error=row[purpose].error;row.updatedAt=now();save();return;
        }
      }
      row.status='ready';row.updatedAt=now();delete row.error;save();
    }catch{if(!fault){row.status='needs_review';row.error='Saved artwork needs operator review before another generation';try{save();}catch{}}}finally{running.delete(row.id);}
  }
  function create({owner,idempotencyKey,...input}){
    assertStorage();ownerAddress(owner);idempotencyKey=text(idempotencyKey,'artwork request key',128,8);const data=artworkInput(input),fingerprint=hash(JSON.stringify(data));
    let row=records.find(r=>r.owner===owner&&r.idempotencyKey===idempotencyKey);
    if(row&&row.fingerprint!==fingerprint)throw fail('This artwork request key belongs to different launch details',409);
    // Reusing a different key does not repeat the same paid images.
    row=row||records.find(r=>r.owner===owner&&r.fingerprint===fingerprint);
    if(!row){if(records.length>=500||records.filter(r=>r.owner===owner).length>=50)throw fail('Saved launch artwork limit reached',429);row={id:crypto.randomUUID(),owner,idempotencyKey,fingerprint,...data,status:'queued',createdAt:now(),updatedAt:now(),thumbnail:null,coinIcon:null};records.push(row);save();}
    if(['queued','failed'].includes(row.status)&&!running.has(row.id)){if(row.status==='failed'){row.status='queued';row.updatedAt=now();delete row.error;save();}queueMicrotask(()=>{void run(row);});}
    return output(row);
  }
  function get(input){return output(owned(input));}
  function readImage({id,purpose,hash:expectedHash}){assertStorage();if(!UUID.test(id)||!KINDS.includes(purpose))throw fail('Launch image not found',404);const row=records.find(r=>r.id===id);if(!row||expectedHash&&row[purpose]?.hash!==expectedHash)throw fail('Launch image not found',404);return publicAsset(row,purpose);}
  function resolve({owner,id,name,ticker,brief,inspiration,artDirection}){
    const row=owned({owner,id});if(row.name!==name||row.ticker!==ticker||row.brief!==brief||inspiration!==undefined&&row.inspiration!==inspiration||artDirection!==undefined&&row.artDirection!==artDirection)throw fail('Launch artwork belongs to different game details',409);
    if(row.status!=='ready')throw fail('Complete both launch images before launching this coin',409);
    const result=output(row).artwork;for(const kind of KINDS){const image=publicAsset(row,kind);result[kind]={...result[kind],...image,publicUrl:origin?origin+result[kind].url:null};}return result;
  }
  return {create,get,readImage,resolve};
}
module.exports={createLaunchArtworkService,artworkInput,dimensions};

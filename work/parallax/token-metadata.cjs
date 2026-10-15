'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {publicOrigin:validateOrigin}=require('./runtime-config.cjs');
const {normalizeProjectLinks}=require('./project-links.cjs');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const OBJECT_NAME=/^[a-f0-9]{64}\.(json|png|jpg)$/;
const STORAGE_LIMITS=Object.freeze({globalBytes:128*1024*1024,globalFiles:10000,walletBytes:16*1024*1024,walletFiles:100,uploadsPerMinute:5});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function externalImage(value){
  let u;try{u=new URL(value);}catch{throw fail('Choose a public HTTPS token image');}
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||net.isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||/\.(localhost|local|internal|test|invalid|example)$/.test(u.hostname)||value.length>1800||u.href.length>2048)throw fail('Choose a public HTTPS token image');
  return u.href;
}
function createTokenMetadataService({stateDirectory,publicOrigin,now=Date.now,storageLimits={}}={}){
  const origin=validateOrigin(publicOrigin),directory=stateDirectory&&path.join(stateDirectory,'public-token-metadata'),usageFile=stateDirectory&&path.join(stateDirectory,'token-metadata-usage.json');
  const limits={...STORAGE_LIMITS,...storageLimits};
  if(Object.keys(limits).some(key=>!Object.hasOwn(STORAGE_LIMITS,key)||!Number.isSafeInteger(limits[key])||limits[key]<=0||limits[key]>STORAGE_LIMITS[key]))throw fail('Invalid token metadata storage limits',503);
  function config(){return {available:!!(origin&&directory),publicOrigin:origin,storage:'content-addressed',reason:origin?null:'Configure the public Ropad HTTPS domain to host token artwork and metadata, or provide an existing metadata URI'};}
  function object(bytes,ext){const name=digest(bytes)+'.'+ext;return {name,bytes,url:origin+'/public/tokens/'+name};}
  function exists(item){
    const target=path.join(directory,item.name);
    try{if(!fs.lstatSync(target).isFile()||!fs.readFileSync(target).equals(item.bytes))throw fail('Stored metadata failed its integrity check',503);return true;}
    catch(e){if(e.code==='ENOENT')return false;throw e;}
  }
  function removeTemporary(file,maxBytes){
    // Only exact application-owned staging paths reach this helper. Never
    // truncate/follow a symlink or remove an unexpected oversized object.
    try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>maxBytes)throw Error();fs.unlinkSync(file);}
    catch(e){if(e.code!=='ENOENT')throw fail('Token metadata staging requires recovery',503);}
  }
  function syncDirectory(name){
    // Windows does not support opening a directory for fsync through Node.
    if(process.platform==='win32')return;
    let fd;try{fd=fs.openSync(name,'r');fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function put(item){
    fs.mkdirSync(directory,{recursive:true});const target=path.join(directory,item.name),temporary=path.join(directory,'.ropad-upload-'+item.name+'.tmp');
    if(exists(item)){
      // A crash after linking may leave a second name for the complete object.
      // Unknown/corrupt debris stays counted by the global storage scan.
      try{const stat=fs.lstatSync(temporary);if(stat.isFile()&&stat.size===item.bytes.length&&fs.readFileSync(temporary).equals(item.bytes))removeTemporary(temporary,item.bytes.length);}catch(e){if(e.status)throw e;}
      return;
    }
    removeTemporary(temporary,item.bytes.length);let fd;
    try{
      fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,item.bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      // Same-filesystem hard-link installation is atomic and cannot overwrite
      // an immutable final path, unlike rename on POSIX. Only complete, synced
      // bytes ever acquire the public hash filename.
      try{fs.linkSync(temporary,target);}catch(e){if(e.code!=='EEXIST')throw e;if(!exists(item))throw e;}
      syncDirectory(directory);
    }catch(e){if(e.status)throw e;throw fail('Token metadata could not be stored',503);}
    finally{if(fd!==undefined)fs.closeSync(fd);removeTemporary(temporary,item.bytes.length);}
  }
  function usage(){
    try{
      const stat=fs.statSync(usageFile);if(stat.size>8*1024*1024)throw Error();
      const value=JSON.parse(fs.readFileSync(usageFile,'utf8'));
      if(value.version!==1||!Array.isArray(value.uploads)||value.uploads.length>STORAGE_LIMITS.globalFiles)throw Error();
      const seen=new Set();
      for(const row of value.uploads){
        if(!row||typeof row.owner!=='string'||!/^(managed|[a-f0-9]{64})$/.test(row.owner)||!/^[a-f0-9]{64}$/.test(row.requestHash)||!Number.isFinite(row.at)||!Array.isArray(row.objects)||row.objects.length<1||row.objects.length>2)throw Error();
        const id=row.owner+':'+row.requestHash;if(seen.has(id))throw Error();seen.add(id);
        const names=new Set();for(const item of row.objects){if(!OBJECT_NAME.test(item.name)||names.has(item.name)||!Number.isSafeInteger(item.bytes)||item.bytes<=0||item.bytes>2*1024*1024)throw Error();names.add(item.name);}
      }
      return value;
    }catch(e){if(e.code==='ENOENT')return {version:1,uploads:[]};throw fail('Token metadata quota history is unavailable; preserve it for recovery',503);}
  }
  function saveUsage(value){
    // One fixed stage bounds journal debris across repeated process crashes.
    const temporary=usageFile+'.tmp';let fd;
    try{fs.mkdirSync(stateDirectory,{recursive:true});removeTemporary(temporary,8*1024*1024);fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,usageFile);syncDirectory(stateDirectory);}
    catch{throw fail('Token metadata quota could not be saved',503);}
    finally{if(fd!==undefined)fs.closeSync(fd);removeTemporary(temporary,8*1024*1024);}
  }
  function reserve(objects,owner,requestHash){
    // Hash reuse remains available even when capacity is full or a previous
    // quota journal needs recovery. No new bytes are written in that case.
    const missing=objects.filter(item=>!exists(item));if(!missing.length)return;
    const ownerHash=owner===undefined?'managed':digest(owner),saved=usage();
    const prior=saved.uploads.find(row=>row.owner===ownerHash&&row.requestHash===requestHash);
    if(prior){
      if(missing.some(item=>!prior.objects.some(old=>old.name===item.name&&old.bytes===item.bytes.length)))throw fail('Token metadata recovery does not match its reserved objects',503);
      return;
    }
    const files=new Map();
    try{for(const name of fs.readdirSync(directory)){const stat=fs.lstatSync(path.join(directory,name));if(!stat.isFile())throw Error();files.set(name,stat.size);}}
    catch(e){if(e.code!=='ENOENT')throw fail('Token metadata storage could not be measured',503);}
    // Include write-ahead reservations not yet written, so a crash cannot reset
    // either global capacity or a creator's upload allowance.
    for(const row of saved.uploads)for(const item of row.objects){if(files.has(item.name)&&files.get(item.name)!==item.bytes)throw fail('Token metadata quota integrity check failed',503);files.set(item.name,item.bytes);}
    for(const item of missing)files.set(item.name,item.bytes.length);
    if(files.size>limits.globalFiles||[...files.values()].reduce((n,size)=>n+size,0)>limits.globalBytes||saved.uploads.length>=STORAGE_LIMITS.globalFiles)throw fail('Token artwork storage is full; existing artwork remains available',429);
    const timestamp=now();if(!Number.isFinite(timestamp))throw fail('Token metadata clock is unavailable',503);
    if(owner!==undefined){
      const rows=saved.uploads.filter(row=>row.owner===ownerHash),owned=new Map();
      for(const row of rows)for(const item of row.objects)owned.set(item.name,item.bytes);
      for(const item of missing)owned.set(item.name,item.bytes.length);
      if(owned.size>limits.walletFiles||[...owned.values()].reduce((n,size)=>n+size,0)>limits.walletBytes)throw fail('This wallet has reached its token artwork storage allowance',429);
      if(rows.filter(row=>row.at>timestamp-60000).length>=limits.uploadsPerMinute)throw fail('Wait a minute before uploading more token artwork',429);
    }
    saved.uploads.push({owner:ownerHash,requestHash,at:timestamp,objects:missing.map(item=>({name:item.name,bytes:item.bytes.length}))});saveUsage(saved);
  }
  function create({name,symbol,description='',imageUrl,imageBase64,contentType,links:inputLinks},{owner}={}){
    if(!directory||!origin)throw fail(config().reason||'Persistent metadata storage is required',503);
    if(owner!==undefined&&(typeof owner!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)))throw fail('Verified creator wallet required',401);
    if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name.trim())>32||/[\x00-\x1f\x7f]/.test(name)||typeof symbol!=='string'||!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(symbol)||typeof description!=='string'||description.length>2400)throw fail('Provide a token name, symbol and a description within the supported lengths');
    const links=normalizeProjectLinks(inputLinks);let image;const objects=[];
    if(imageBase64){
      if(imageUrl)throw fail('Choose one token image source');
      if(typeof imageBase64!=='string'||imageBase64.length>2800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64))throw fail('Choose a PNG or JPEG image smaller than 2 MB');
      const bytes=Buffer.from(imageBase64,'base64');if(bytes.toString('base64')!==imageBase64||bytes.length>2*1024*1024||bytes.length<16)throw fail('Choose a PNG or JPEG image smaller than 2 MB');
      const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
      if(!(png&&contentType==='image/png'||jpg&&contentType==='image/jpeg'))throw fail('Token artwork must be a PNG or JPEG image');
      const item=object(bytes,png?'png':'jpg');objects.push(item);image=item.url;
    }else image=externalImage(imageUrl);
    const metadata={name:name.trim(),symbol:symbol.toUpperCase(),description:description.trim(),image,external_url:links?.website||origin,...links};
    const metadataObject=object(Buffer.from(JSON.stringify(metadata)),'json'),metadataUri=metadataObject.url;objects.push(metadataObject);
    if(metadataUri.length>200)throw fail('The configured domain produces a metadata URI longer than Pump supports',503);
    reserve(objects,owner,metadataObject.name.split('.')[0]);for(const item of objects)put(item);
    return {metadataUri,imageUrl:image,metadata};
  }
  function read(name){
    if(!directory||!/^([a-f0-9]{64})\.(json|png|jpg)$/.test(name))throw fail('Metadata file not found',404);
    let bytes;try{bytes=fs.readFileSync(path.join(directory,name));}catch(e){throw fail('Metadata file not found',e.code==='ENOENT'?404:503);}
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==name.split('.')[0])throw fail('Metadata failed its integrity check',503);
    return {bytes,contentType:name.endsWith('.json')?'application/json':name.endsWith('.png')?'image/png':'image/jpeg'};
  }
  return {config,create,read};
}
module.exports={createTokenMetadataService,externalImage,STORAGE_LIMITS};

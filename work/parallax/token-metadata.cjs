'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {publicOrigin:validateOrigin}=require('./runtime-config.cjs');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function externalImage(value){
  let u;try{u=new URL(value);}catch{throw fail('Choose a public HTTPS token image');}
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||net.isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||/\.(localhost|local|internal|test|invalid|example)$/.test(u.hostname)||value.length>1800||u.href.length>2048)throw fail('Choose a public HTTPS token image');
  return u.href;
}
function createTokenMetadataService({stateDirectory,publicOrigin}={}){
  const origin=validateOrigin(publicOrigin),directory=stateDirectory&&path.join(stateDirectory,'public-token-metadata');
  function config(){return {available:!!(origin&&directory),publicOrigin:origin,storage:'content-addressed',reason:origin?null:'Configure the public Ropad HTTPS domain to host token artwork and metadata, or provide an existing metadata URI'};}
  function put(bytes,ext){
    fs.mkdirSync(directory,{recursive:true});const hash=crypto.createHash('sha256').update(bytes).digest('hex'),name=hash+'.'+ext,target=path.join(directory,name);
    try{fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw fail('Token metadata could not be stored',503);if(!fs.readFileSync(target).equals(bytes))throw fail('Stored metadata failed its integrity check',503);}
    return origin+'/public/tokens/'+name;
  }
  function create({name,symbol,description='',imageUrl,imageBase64,contentType}){
    if(!directory||!origin)throw fail(config().reason||'Persistent metadata storage is required',503);
    if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name.trim())>32||/[\x00-\x1f\x7f]/.test(name)||typeof symbol!=='string'||!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(symbol)||typeof description!=='string'||description.length>2400)throw fail('Provide a token name, symbol and a description within the supported lengths');
    let image;
    if(imageBase64){
      if(imageUrl)throw fail('Choose one token image source');
      if(typeof imageBase64!=='string'||imageBase64.length>2800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64))throw fail('Choose a PNG or JPEG image smaller than 2 MB');
      const bytes=Buffer.from(imageBase64,'base64');if(bytes.toString('base64')!==imageBase64||bytes.length>2*1024*1024||bytes.length<16)throw fail('Choose a PNG or JPEG image smaller than 2 MB');
      const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
      if(!(png&&contentType==='image/png'||jpg&&contentType==='image/jpeg'))throw fail('Token artwork must be a PNG or JPEG image');
      image=put(bytes,png?'png':'jpg');
    }else image=externalImage(imageUrl);
    const metadata={name:name.trim(),symbol:symbol.toUpperCase(),description:description.trim(),image,external_url:origin};
    const metadataUri=put(Buffer.from(JSON.stringify(metadata)),'json');
    if(metadataUri.length>200)throw fail('The configured domain produces a metadata URI longer than Pump supports',503);
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
module.exports={createTokenMetadataService,externalImage};

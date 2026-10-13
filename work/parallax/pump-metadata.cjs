'use strict';
// Fetch public token metadata without permitting loopback/private-network requests
// or redirects. DNS addresses are resolved, checked, and pinned to the request.
const https=require('node:https'),dns=require('node:dns/promises'),net=require('node:net'),crypto=require('node:crypto');
const fail=message=>Object.assign(new Error(message),{status:400,code:'INVALID_TOKEN_METADATA'});
function publicIp(address){
  if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||a===192&&b===2||a===198&&b===51||a===203&&b===0);}
  if(net.isIP(address)===6){const a=address.toLowerCase();return /^2[0-9a-f]{3}:|^3[0-9a-f]{3}:/.test(a)&&!a.startsWith('2001:db8:')&&!a.startsWith('2001:0:')&&!a.startsWith('2002:');}
  return false;
}
function publicHttps(value,max=200){
  let url;try{if(typeof value!=='string'||value.length>max)throw Error();url=new URL(value);}catch{throw fail('A public HTTPS token metadata URL is required');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||!url.hostname.includes('.')||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||net.isIP(url.hostname.replace(/^\[|\]$/g,''))&&!publicIp(url.hostname.replace(/^\[|\]$/g,'')))throw fail('Token metadata and artwork must use public HTTPS URLs');
  return url.href;
}
async function publicBytes(uri,limit){
  const url=new URL(publicHttps(uri,2048)),host=url.hostname.replace(/^\[|\]$/g,''),addresses=await dns.lookup(host,{all:true});
  if(!addresses.length||addresses.some(row=>!publicIp(row.address)))throw fail('Token metadata host resolves to a restricted network');
  const pinned=addresses[0];
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{lookup:(_host,options,done)=>options?.all?done(null,[pinned]):done(null,pinned.address,pinned.family),headers:{Accept:'application/json,image/png,image/jpeg,image/webp'},timeout:12000,signal:AbortSignal.timeout(15000)},response=>{
      if(response.statusCode!==200||Number(response.headers['content-length']||0)>limit){response.resume();reject(fail('Token metadata or artwork is unavailable or exceeds its size limit'));return;}
      let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>limit){request.destroy();reject(fail('Token metadata or artwork exceeds its size limit'));}else chunks.push(chunk);});
      response.on('error',()=>reject(fail('Token metadata download failed')));response.on('end',()=>resolve({bytes:Buffer.concat(chunks),contentType:String(response.headers['content-type']||'').split(';')[0].toLowerCase()}));
    });
    request.on('timeout',()=>request.destroy());request.on('error',()=>reject(fail('Token metadata or artwork could not be fetched')));
  });
}
function imageType(bytes){if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';if(bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';return null;}
async function validatePumpMetadata({uri,name,symbol,fetchBytes=publicBytes}){
  uri=publicHttps(uri);const response=await fetchBytes(uri,65536);if(!Buffer.isBuffer(response.bytes)||response.bytes.length>65536)throw fail('Token metadata exceeds its size limit');
  let metadata;try{metadata=JSON.parse(response.bytes.toString('utf8'));}catch{throw fail('Token metadata must be a JSON document');}
  if(!metadata||Array.isArray(metadata)||metadata.name!==name||metadata.symbol!==symbol)throw fail('Hosted token metadata name and symbol must match this launch');
  const image=publicHttps(metadata.image,2048),art=await fetchBytes(image,5*1024*1024);
  if(!Buffer.isBuffer(art.bytes)||art.bytes.length>5*1024*1024||!imageType(art.bytes))throw fail('Hosted token artwork must be a PNG, JPEG or WebP image within 5 MB');
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  return {uri,image,metadataHash:hash(response.bytes),imageHash:hash(art.bytes),metadataBytes:response.bytes.length,imageBytes:art.bytes.length};
}
module.exports={validatePumpMetadata,publicHttps,publicIp,publicBytes};

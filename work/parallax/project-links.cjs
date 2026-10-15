'use strict';
const net=require('node:net');
const fail=message=>Object.assign(new Error(message),{status:400});
const LINK_FIELDS=Object.freeze(['website','twitter','telegram','discord']);
const HOSTS={twitter:new Set(['x.com','www.x.com','twitter.com','www.twitter.com']),telegram:new Set(['t.me','www.t.me','telegram.me','www.telegram.me']),discord:new Set(['discord.gg','www.discord.gg','discord.com','www.discord.com','discordapp.com','www.discordapp.com'])};
function normalizeProjectLinks(value){
  if(value===undefined||value===null)return undefined;
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!LINK_FIELDS.includes(key)))throw fail('Choose only website, twitter, telegram and discord project links');
  const result={};
  for(const field of LINK_FIELDS){
    if(value[field]===undefined||value[field]===null||value[field]==='')continue;
    if(typeof value[field]!=='string')throw fail('Enter a valid HTTPS '+field+' link');
    const raw=value[field].trim();if(!raw)continue;
    let url;try{
      if(raw.length>512||/[\x00-\x20\x7f\\]/.test(raw))throw Error();url=new URL(raw);
      const host=url.hostname.replace(/^\[|\]$/g,'');
      if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||net.isIP(host)||!host.includes('.')||host.endsWith('.')||host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||/\.(localhost|local|internal|test|invalid|example|lan|home|onion|arpa)$/.test(host)||url.href.length>512)throw Error();
      if(HOSTS[field]&&!HOSTS[field].has(host))throw Error();
    }catch{throw fail('Enter a public HTTPS '+field+' link'+(field==='twitter'?' on x.com or twitter.com':field==='telegram'?' on t.me or telegram.me':field==='discord'?' on discord.gg or discord.com':''));}
    result[field]=url.href;
  }
  return Object.keys(result).length?result:undefined;
}
function normalizeProjectDescription(value){
  if(value===undefined||value===null||value==='')return undefined;
  if(typeof value!=='string'||value.trim().length>280||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw fail('Public description must be at most 280 characters');
  return value.trim()||undefined;
}
module.exports={LINK_FIELDS,normalizeProjectLinks,normalizeProjectDescription};

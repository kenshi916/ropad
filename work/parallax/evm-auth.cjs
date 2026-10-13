'use strict';
const crypto=require('node:crypto');
const {isAddress,getAddress,verifyMessage}=require('viem');
const {createSiweMessage}=require('viem/siwe');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

function createEvmAuth({now=Date.now,verify=verifyMessage}={}) {
  const challenges=new Map(),sessions=new Map(),issued=new Map();
  const cookieName='parallax_orbio_session';
  const cookieId=req=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  function session(req){const id=cookieId(req),s=sessions.get(id);if(!s||s.expiresAt<=now()){if(id)sessions.delete(id);return null;}return s;}
  function owner(req){const s=session(req);if(!s)throw fail('Connect your Ethereum wallet and sign in to continue',401);return s.address;}
  function challenge(address,origin){
    if(typeof address!=='string'||!isAddress(address))throw fail('Choose a valid Ethereum wallet address');
    address=getAddress(address);const account=address.toLowerCase();
    const recent=(issued.get(account)||[]).filter(t=>now()-t<60000);
    if(recent.length>=5)throw fail('Wait a minute before requesting another wallet signature',429);
    recent.push(now());issued.set(account,recent);if(issued.size>1000)issued.delete(issued.keys().next().value);
    for(const [id,c] of challenges)if(c.expiresAt<=now())challenges.delete(id);
    if(challenges.size>=1000)throw fail('Too many sign-in requests; try again shortly',429);
    const id=crypto.randomUUID(),expiresAt=now()+300000;
    const message=createSiweMessage({address,chainId:4663,domain:new URL(origin).host,uri:origin,version:'1',nonce:crypto.randomBytes(24).toString('hex'),issuedAt:new Date(now()),expirationTime:new Date(expiresAt),statement:'Sign in to Ropad to manage your game and prepare an Orbio agent coin on Robinhood Chain. This does not authorize a transaction or spend tokens.'});
    challenges.set(id,{address:account,origin,message,expiresAt});return {id,message,chainId:4663,expiresAt:new Date(expiresAt).toISOString()};
  }
  async function authenticate({id,signature},origin,res){
    const c=challenges.get(id);challenges.delete(id);
    if(!c||c.expiresAt<=now()||c.origin!==origin)throw fail('This wallet challenge has expired; request a new signature',401);
    let valid=false;
    if(typeof signature==='string'&&/^0x[a-fA-F0-9]{130}$/.test(signature)){
      try{valid=await verify({address:c.address,message:c.message,signature});}catch{}
    }
    if(!valid)throw fail('Ethereum wallet signature could not be verified',401);
    for(const [key,s] of sessions)if(s.expiresAt<=now())sessions.delete(key);
    if(sessions.size>=1000)sessions.delete(sessions.keys().next().value);
    const sid=crypto.randomBytes(32).toString('hex');sessions.set(sid,{address:c.address,chainId:4663,expiresAt:now()+86400000});
    res.setHeader('Set-Cookie',`${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return {authenticated:true,address:c.address,chainId:4663};
  }
  function logout(req,res){const id=cookieId(req);if(id)sessions.delete(id);res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);return {authenticated:false,address:null,chainId:4663};}
  return {challenge,authenticate,session,owner,logout};
}
module.exports={createEvmAuth};

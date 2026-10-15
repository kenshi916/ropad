'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const fail=message=>Object.assign(new Error(message),{status:503});
function publicOrigin(value){
  if(!value)return null;
  let u;try{if(typeof value!=='string'||value.length>512)throw Error();u=new URL(value);}catch{throw fail('ROPAD_PUBLIC_ORIGIN must be an HTTPS origin');}
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||net.isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||/\.(localhost|local|internal|test|invalid|example)$/.test(u.hostname))throw fail('ROPAD_PUBLIC_ORIGIN must be a public HTTPS origin without a path');
  return u.origin;
}
function readRuntimeConfig({stateDirectory,env=process.env}={}){
  let stored={};if(stateDirectory){try{stored=JSON.parse(fs.readFileSync(path.join(stateDirectory,'ropad-config.json'),'utf8'));if(!stored||Array.isArray(stored)||typeof stored!=='object')throw Error();}catch(e){if(e.code!=='ENOENT')throw fail('Ropad configuration could not be read; saved data has not been changed');}}
  const origin=publicOrigin(env.ROPAD_PUBLIC_ORIGIN||stored.publicOrigin);
  if(env.ROPAD_SOLANA_MAINNET_ENABLED!==undefined&&!['0','1'].includes(env.ROPAD_SOLANA_MAINNET_ENABLED)||stored.mainnetEnabled!==undefined&&typeof stored.mainnetEnabled!=='boolean')throw fail('Set ROPAD_SOLANA_MAINNET_ENABLED to 0 or 1, or mainnetEnabled to a boolean');
  const enabled=env.ROPAD_SOLANA_MAINNET_ENABLED!==undefined?env.ROPAD_SOLANA_MAINNET_ENABLED==='1':stored.mainnetEnabled===true;
  const rpc=env.ROPAD_SOLANA_RPC_URL||stored.solanaRpcUrl||'https://api.mainnet-beta.solana.com';
  let rpcUrl;try{if(typeof rpc!=='string'||rpc.length>2048)throw Error();rpcUrl=new URL(rpc);}catch{throw fail('Configure a valid Solana HTTPS RPC endpoint');}if(rpcUrl.protocol!=='https:'||rpcUrl.username||rpcUrl.password||rpcUrl.hash)throw fail('Solana RPC must use HTTPS without embedded user credentials or fragments');
  const bind=env.ROPAD_BIND_HOST||stored.bindHost||'127.0.0.1';if(!['127.0.0.1','0.0.0.0'].includes(bind))throw fail('ROPAD_BIND_HOST must be 127.0.0.1 or 0.0.0.0');if(bind==='0.0.0.0'&&!origin)throw fail('Public binding requires ROPAD_PUBLIC_ORIGIN and a TLS reverse proxy');
  const wallets=(env.ROPAD_OPERATOR_WALLETS||stored.operatorWallets||'').toString().split(',').map(v=>v.trim()).filter(Boolean);
  try{const {PublicKey}=require('@solana/web3.js');for(const value of wallets){const address=new PublicKey(value);if(address.toBase58()!==value||!PublicKey.isOnCurve(address.toBytes()))throw Error();}}catch{throw fail('Configure valid Solana signing addresses for operator wallets');}
  const pumpLookupTableAddress=env.ROPAD_PUMP_LOOKUP_TABLE_ADDRESS??stored.pumpLookupTableAddress??'';
  try{if(typeof pumpLookupTableAddress!=='string')throw Error();if(pumpLookupTableAddress){const {PublicKey}=require('@solana/web3.js'),address=new PublicKey(pumpLookupTableAddress);if(address.toBase58()!==pumpLookupTableAddress)throw Error();}}catch{throw fail('Configure a valid Solana Pump lookup table address');}
  const bounded=(key,storedKey,fallback,min,max,integer=false)=>{const value=Number(env[key]??stored[storedKey]??fallback);if(!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw fail(key+' is outside its supported allowance');return value;};
  const buildOutputTokens=bounded('ROPAD_BUILD_OUTPUT_TOKENS','buildOutputTokens',6000,1000,32000,true),buildPlanMaxEstimateUsd=bounded('ROPAD_BUILD_PLAN_CAP_USD','buildPlanMaxEstimateUsd',.75,.01,25),maxAgentBudgetUsd=bounded('ROPAD_AGENT_MAX_BUDGET_USD','maxAgentBudgetUsd',1,.01,25);
  const dailyBudgetValue=env.ROPAD_DAILY_COMPUTE_BUDGET_USD??stored.dailyComputeBudgetUsd??1;
  if(!['number','string'].includes(typeof dailyBudgetValue)||typeof dailyBudgetValue==='string'&&!dailyBudgetValue.trim())throw fail('ROPAD_DAILY_COMPUTE_BUDGET_USD is outside its supported allowance');
  const dailyComputeBudgetUsd=bounded('ROPAD_DAILY_COMPUTE_BUDGET_USD','dailyComputeBudgetUsd',1,0,1000);
  return {buildOutputTokens,buildPlanMaxEstimateUsd,maxAgentBudgetUsd,dailyComputeBudgetUsd,pumpLookupTableAddress,publicOrigin:origin,mainnetEnabled:enabled,defaultCluster:enabled?'mainnet-beta':'devnet',solanaRpcUrl:rpc,bindHost:bind,operatorWallets:[...new Set(wallets)],providerAccountId:env.ROPAD_PROVIDER_ACCOUNT_ID||stored.providerAccountId||''};
}
module.exports={publicOrigin,readRuntimeConfig};

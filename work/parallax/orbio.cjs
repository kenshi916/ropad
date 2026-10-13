'use strict';

// Public, read-only Orbio discovery. No credentials, wallet signing, or arbitrary RPC proxy.
const API='https://api.orbio.so';
const MAINNET_RPC='https://rpc.mainnet.chain.robinhood.com';
const TESTNET_RPC='https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID=4663, TESTNET_CHAIN_ID=46630;
const ADDRESSES=Object.freeze({factory:'0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',vault:'0x0e1651aec67b2a049a4fa6aeb6c1c305aabfc35b',pair:'0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3'});
const LINKS=Object.freeze({launch:'https://www.orbio.so/launchpad/launch',docs:'https://www.orbio.so/launchpad/docs',models:'https://api.orbio.so/api/v1/models?output_modalities=text',pons:'https://www.ponsfamily.com',network:'https://docs.robinhood.com/chain/add-network-to-wallet/'});
const ADDRESS=/^0x[0-9a-fA-F]{40}$/, HASH=/^0x[0-9a-fA-F]{64}$/, UINT=/^(0|[1-9][0-9]*)$/;
const MAX_UINT=(1n<<256n)-1n, TIMEOUT_MS=8000, TTL_MS=30000;
function fail(message,status=503){const error=new Error(message);error.status=status;error.statusCode=status;return error;}
const text=(value,max=500)=>typeof value==='string'?value.slice(0,max):null;
const uint=value=>typeof value==='string'&&UINT.test(value)&&value.length<=78&&BigInt(value)<=MAX_UINT?value:null;
const address=value=>typeof value==='string'&&ADDRESS.test(value)?value.toLowerCase():null;
const hash=value=>typeof value==='string'&&HASH.test(value)?value.toLowerCase():null;
const bool=value=>typeof value==='boolean'?value:null;
const int=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
function https(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
function decimal(value,decimals){const parsed=uint(value);if(parsed===null)return null;const n=BigInt(parsed),scale=10n**BigInt(decimals);return (n/scale).toString()+((n%scale)?'.'+(n%scale).toString().padStart(decimals,'0').replace(/0+$/,''):'');}
function numericArg(value,fallback,min,max,label){if(value===undefined||value===null||value==='')return fallback;if(typeof value==='string'&&UINT.test(value))value=Number(value);if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('Invalid '+label,400);return value;}
function identifier(value){if(typeof value!=='string')throw fail('Enter an Orbio agent ID or token address',400);if(ADDRESS.test(value))return value.toLowerCase();if(uint(value)!==null)return value;throw fail('Enter an Orbio agent ID or token address',400);}

function normalizeAgent(raw){
  if(!raw||typeof raw!=='object'||uint(raw.agentId)===null||!address(raw.token))throw fail('Orbio returned an invalid agent record');
  const price=raw.price&&typeof raw.price==='object'?raw.price:{};
  const amounts=(object,keys)=>Object.fromEntries(keys.map(key=>[key,uint(object?.[key])]));
  const token=address(raw.token),launchTx=hash(raw.launchTx);
  return {chainId:CHAIN_ID,agentId:raw.agentId,token,name:text(raw.name,120),symbol:text(raw.symbol,40),logo:https(raw.logo),description:text(raw.description,5000),owner:address(raw.owner),agentWallet:address(raw.agentWallet),receiver:address(raw.receiver),decimals:int(raw.decimals,255),totalSupply:uint(raw.totalSupply),feeBps:int(raw.feeBps,10000),launchedAt:uint(raw.launchedAt),launchTx,
    price:{source:text(price.source,40),graduated:bool(price.graduated),orbioPerToken:typeof price.orbioPerToken==='string'&&/^\d+(?:\.\d+)?$/.test(price.orbioPerToken)?price.orbioPerToken.slice(0,100):null,priceMicroUsd:uint(price.priceMicroUsd),marketCapMicroUsd:uint(price.marketCapMicroUsd)},
    stake:amounts(raw.stake,['orbioWei','claimedFeesWei','protocolFeeWei','stakedWei','withdrawnWei']),credit:amounts(raw.credit,['owedAtoms','claimedAtoms','activatedAtoms','mintedAtoms']),
    links:{launch:LINKS.launch,token:'https://robin.etherscan.io/token/'+token,launchTx:launchTx?'https://robin.etherscan.io/tx/'+launchTx:null,pons:'https://www.ponsfamily.com/launchpad/'+token}};
}

function createOrbioService({fetcher=globalThis.fetch,now=Date.now}={}){
  if(typeof fetcher!=='function'||typeof now!=='function')throw new TypeError('A fetch function and clock are required');
  const cache=new Map(),pending=new Map();let rpcId=0;
  const checkedAt=()=>new Date(now()).toISOString();
  async function cached(key,load){
    const hit=cache.get(key);if(hit&&now()-hit.at<TTL_MS)return structuredClone(hit.value);
    if(pending.has(key))return structuredClone(await pending.get(key));
    const task=(async()=>{const value=await load();cache.set(key,{at:now(),value});if(cache.size>100)cache.delete(cache.keys().next().value);return value;})();
    pending.set(key,task);try{return structuredClone(await task);}finally{pending.delete(key);}
  }
  async function request(url,options={},maxBytes=4*1024*1024){
    // All callers construct paths beneath the pinned hosts; reject redirects as well.
    if(![API,MAINNET_RPC,TESTNET_RPC].includes(new URL(url).origin))throw fail('Unsupported upstream');
    const controller=new AbortController();let timer;
    try{
      return await Promise.race([(async()=>{
        const response=await fetcher(url,{...options,redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...options.headers}});
        if(!response.ok)throw fail(response.status===404?'Orbio agent not found':'Orbio service is temporarily unavailable',response.status===404?404:503);
        const length=Number(response.headers?.get?.('content-length'));if(length>maxBytes)throw fail('Orbio response exceeds the allowed size');
        let body='';
        if(response.body&&typeof response.body[Symbol.asyncIterator]==='function'){
          const chunks=[];let size=0;for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>maxBytes){controller.abort();throw fail('Orbio response exceeds the allowed size');}chunks.push(bytes);}body=Buffer.concat(chunks).toString('utf8');
        }else if(typeof response.text==='function'){body=await response.text();if(Buffer.byteLength(body)>maxBytes)throw fail('Orbio response exceeds the allowed size');}
        else{const value=await response.json();body=JSON.stringify(value);if(Buffer.byteLength(body)>maxBytes)throw fail('Orbio response exceeds the allowed size');}
        return JSON.parse(body);
      })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('Orbio service request timed out'));},TIMEOUT_MS);})]);
    }catch(error){if(error?.status===404)throw fail('Orbio agent not found',404);throw fail('Orbio service is temporarily unavailable');}finally{clearTimeout(timer);}
  }
  async function rpc(url,method,params){const id=++rpcId;const data=await request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})},128*1024);if(data?.error||data?.id!==id||data?.jsonrpc!=='2.0'||!Object.hasOwn(data,'result'))throw fail('Robinhood Chain read is unavailable');return data.result;}
  async function network(url,expectedChainId){
    const keys=Object.keys(ADDRESSES);
    const reads=await Promise.allSettled([rpc(url,'eth_chainId',[]),...keys.map(key=>rpc(url,'eth_getCode',[ADDRESSES[key],'latest']))]);
    const chain=reads[0].status==='fulfilled'&&typeof reads[0].value==='string'&&/^0x[0-9a-f]+$/i.test(reads[0].value)?Number(BigInt(reads[0].value)):null;
    const contracts=Object.fromEntries(keys.map((key,index)=>{const read=reads[index+1];const code=read.status==='fulfilled'&&typeof read.value==='string'&&/^0x(?:[0-9a-f]{2})*$/i.test(read.value)?read.value:null;return [key,{address:ADDRESSES[key],codePresent:code===null?null:code.length>2}];}));
    const available=chain===expectedChainId&&Object.values(contracts).every(c=>c.codePresent!==null);
    return {available,expectedChainId,chainId:chain,chainMatches:chain===expectedChainId,contracts,allContractsPresent:available&&Object.values(contracts).every(c=>c.codePresent===true)};
  }
  async function status(){return cached('status',async()=>{
    const reads=await Promise.allSettled([request(API+'/api/protocol/status'),request(API+'/api/protocol/agents/terms'),network(MAINNET_RPC,CHAIN_ID),network(TESTNET_RPC,TESTNET_CHAIN_ID)]);
    const source=reads[0].status==='fulfilled'?reads[0].value:null,raw=reads[1].status==='fulfilled'?reads[1].value:null;
    const errors=[];
    const sourceMatches=source?.chainId===CHAIN_ID&&address(source?.addresses?.agentVault)===ADDRESSES.vault&&address(source?.addresses?.orbio)===ADDRESSES.pair;
    const termsMatch=raw?.chainId===CHAIN_ID&&address(raw?.vault)===ADDRESSES.vault&&address(raw?.pairToken)===ADDRESSES.pair;
    const fee=uint(raw?.launchFeeWei),economics=hash(raw?.economics);
    const termsValid=termsMatch&&fee!==null&&economics!==null&&['live','pairApproved','paused'].every(k=>typeof raw[k]==='boolean')&&['feeBps','conversionBps','creditBps','gatewayBps'].every(k=>int(raw[k],10000)!==null)&&int(raw?.cliffSeconds)!==null;
    const terms=termsValid?{live:raw.live,chainId:CHAIN_ID,vault:ADDRESSES.vault,pairToken:ADDRESSES.pair,launchFeeWei:fee,economics,pairApproved:raw.pairApproved,paused:raw.paused,feeBps:raw.feeBps,conversionBps:raw.conversionBps,creditBps:raw.creditBps,gatewayBps:raw.gatewayBps,cliffSeconds:raw.cliffSeconds}:null;
    const mainnet=reads[2].status==='fulfilled'?reads[2].value:{available:false,expectedChainId:CHAIN_ID,chainId:null,chainMatches:false,contracts:{},allContractsPresent:false};
    const testnet=reads[3].status==='fulfilled'?reads[3].value:{available:false,expectedChainId:TESTNET_CHAIN_ID,chainId:null,chainMatches:false,contracts:{},allContractsPresent:false};
    if(!source||!raw)errors.push('Orbio public launch status is unavailable');
    else if(!sourceMatches||!termsValid)errors.push('Orbio deployment or launch terms differ from the verified configuration');
    if(!mainnet.available)errors.push('Robinhood Chain mainnet could not be verified');
    else if(!mainnet.allContractsPresent)errors.push('A required mainnet contract is unavailable');
    if(!testnet.available)errors.push('Robinhood Chain testnet probe is unavailable');
    if(terms?.paused)errors.push('The Orbio launchpad is paused');
    if(terms&&!terms.pairApproved)errors.push('The ORBIO pairing is not approved');
    const apiReady=sourceMatches&&source?.live===true&&source?.indexer?.healthy===true&&source?.indexer?.halted===false&&termsValid&&terms.live&&!terms.paused&&terms.pairApproved;
    if(source&&sourceMatches&&(!source.live||source.indexer?.healthy!==true||source.indexer?.halted!==false))errors.push('Orbio protocol or indexer is not ready');
    return {provider:'Orbio',checkedAt:checkedAt(),chainId:CHAIN_ID,externalLaunchReady:!!apiReady&&mainnet.allContractsPresent,integratedSigningAvailable:false,testnetAvailable:false,testnetReason:'No verified Orbio or Pons testnet deployment is configured; mainnet addresses are never reused for testnet launches',launchFee:terms?{wei:fee,eth:decimal(fee,18),currency:'ETH',includesGas:false}:null,terms,checks:{api:{available:!!source&&!!raw,deploymentMatches:!!sourceMatches&&!!termsValid,live:bool(source?.live),indexerHealthy:bool(source?.indexer?.healthy)},mainnet,testnet},errors,links:{...LINKS}};
  });}
  function validateEnvelope(data){if(!data||data.chainId!==CHAIN_ID||!address(data.vault)||address(data.vault)!==ADDRESSES.vault)throw fail('Orbio returned a different deployment');}
  async function agents(args={}){
    if(!args||typeof args!=='object'||Array.isArray(args))throw fail('Invalid agent search',400);
    const limit=numericArg(args.limit,24,1,200,'page size'),offset=numericArg(args.offset,0,0,100000,'page offset'),params=new URLSearchParams({limit:String(limit),offset:String(offset)});
    if(args.wallet!==undefined&&args.wallet!==null&&args.wallet!==''){if(!address(args.wallet))throw fail('Enter a valid EVM wallet address',400);params.set('wallet',address(args.wallet));}
    if(args.q!==undefined&&args.q!==null&&args.q!==''){if(typeof args.q!=='string'||args.q.length>100||/[\x00-\x1f\x7f]/.test(args.q))throw fail('Search must be at most 100 characters',400);if(args.q.trim())params.set('q',args.q.trim());}
    return cached('agents:'+params,async()=>{const data=await request(API+'/api/protocol/agents?'+params);validateEnvelope(data);if(!Array.isArray(data.data)||data.data.length>200)throw fail('Orbio returned an invalid agent list');return {checkedAt:checkedAt(),chainId:CHAIN_ID,live:bool(data.live),data:data.data.map(normalizeAgent),page:{limit,offset,total:int(data.page?.total)}};});
  }
  async function agent(value){const id=identifier(value);return cached('agent:'+id,async()=>{const payload=await request(API+'/api/protocol/agents/'+encodeURIComponent(id));if(payload?.chainId!==undefined&&payload.chainId!==CHAIN_ID)throw fail('Orbio returned a different deployment');const raw=payload?.agent||payload?.data||payload;if(!raw||Array.isArray(raw))throw fail('Orbio returned an invalid agent record');const data=normalizeAgent(raw);if(ADDRESS.test(id)?data.token!==id:data.agentId!==id)throw fail('Orbio returned a different agent');return {checkedAt:checkedAt(),chainId:CHAIN_ID,data};});}
  async function models(){return cached('models',async()=>{const payload=await request(API+'/api/v1/models?output_modalities=text');if(!Array.isArray(payload?.data)||payload.data.length>3000)throw fail('Orbio model catalogue is unavailable');const modalities=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&/^[a-z_]{1,30}$/.test(x)):[];const data=payload.data.filter(m=>typeof m?.id==='string'&&m.id.length<=200&&/^[A-Za-z0-9_.:/-]+$/.test(m.id)&&m.architecture?.output_modalities?.includes('text')).map(m=>({id:m.id,name:text(m.name,200)||m.id,architecture:{input_modalities:modalities(m.architecture?.input_modalities),output_modalities:modalities(m.architecture?.output_modalities)},pricing:Object.fromEntries(['prompt','completion','image','request'].map(key=>[key,typeof m.pricing?.[key]==='string'&&/^\d+(?:\.\d+)?$/.test(m.pricing[key])?m.pricing[key]:null])),context_length:int(m.context_length)}));return {checkedAt:checkedAt(),data,visionCount:data.filter(m=>m.architecture.input_modalities.includes('image')).length};});}
  return {status,agents,agent,models};
}

module.exports={createOrbioService,API,MAINNET_RPC,TESTNET_RPC,CHAIN_ID,TESTNET_CHAIN_ID,ADDRESSES,LINKS};

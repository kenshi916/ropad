'use strict';

// Wallet-signed Pons v2 curve trades. No private keys or broadcasting on the server.
// Interface and integer pricing: https://docs.ponsfamily.com/v2
const {parseAbi,encodeFunctionData,decodeFunctionResult,formatUnits,parseUnits,isAddress,zeroAddress}=require('viem');
const crypto=require('node:crypto');
const {NETWORK,FACTORY,PAIR,FACTORY_ABI}=require('./orbio-launch.cjs');
const ERC20=parseAbi(['function decimals() view returns (uint8)','function symbol() view returns (string)','function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function approve(address,uint256) returns (bool)']);
const CURVE=parseAbi(['function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)','function sellableTokens() view returns (uint256)','function feeBps() view returns (uint256)','function creatorTaxBps() view returns (uint256)','function currentSnipeTaxBps(address) view returns (uint256)','function readyToGraduate() view returns (bool)','function pairToken() view returns (address)','function isNativeQuote() view returns (bool)','function buy(uint256,uint256,address) payable returns (uint256)','function sell(uint256,uint256,address) returns (uint256)']);
const BPS=10000n,TTL=60000;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const addr=v=>{if(typeof v!=='string'||!isAddress(v,{strict:false})||same(v,zeroAddress))throw fail('A valid wallet or token address is required');return v.toLowerCase();};
const hex=n=>'0x'+BigInt(n).toString(16);
function amount(value,decimals){if(typeof value!=='string'||value.length>96||! /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)||value.split('.')[1]?.length>decimals)throw fail('Enter a positive amount within the asset’s decimal precision');const n=parseUnits(value,decimals);if(n<=0n||n>=2n**256n)throw fail('Amount is outside the supported range');return n;}
function priceTrade({side,input,q,t,sellable,fee,tax,snipe=0n}){
  if(q<=0n||t<=0n||fee<0n||tax<0n||fee+tax>=9900n||snipe<0n)throw fail('Curve pricing is unavailable',503);
  if(side==='sell'){const gross=input*q/(t+input);return {output:gross-gross*fee/BPS-gross*tax/BPS,spent:input,refund:0n};}
  if(snipe>BPS-fee-tax-100n)snipe=BPS-fee-tax-100n;
  const net=input-input*fee/BPS-input*tax/BPS-input*snipe/BPS;
  let output=net*t/(q+net),spent=input;
  if(output>sellable){if(sellable<=0n||sellable>=t)throw fail('The curve is closed',409);output=sellable;const needed=output*q/(t-output)+1n,rate=BPS-fee-tax-snipe;spent=(needed*BPS+rate-1n)/rate;if(spent>input)spent=input;}
  return {output,spent,refund:input-spent};
}
function createOrbioTradeService({fetcher=fetch,now=Date.now}={}){
  let rpcId=0;const intents=new Map();
  async function rpc(method,params){
    const id=++rpcId;let value;
    try{const r=await fetcher(NETWORK.rpc,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();const source=await r.text();if(source.length>300000)throw Error();value=JSON.parse(source);}catch{throw fail('Robinhood Chain is unavailable — no transaction was sent',503);}
    if(value.id!==id||value.error||!Object.hasOwn(value,'result'))throw fail(method==='eth_call'?'The transaction could not be simulated with this wallet and balance':'The chain request failed — refresh the quote',422);
    return value.result;
  }
  async function read(address,abi,functionName,args=[],block='latest') {return decodeFunctionResult({abi,functionName,data:await rpc('eth_call',[{to:address,data:encodeFunctionData({abi,functionName,args})},block])});}
  async function inspect(token){
    token=addr(token);
    if(BigInt(await rpc('eth_chainId',[]))!==BigInt(NETWORK.chainId))throw fail('The RPC returned a different chain',503);
    const block=await rpc('eth_blockNumber',[]);
    const launch=await read(FACTORY,FACTORY_ABI,'getLaunchedToken',[token],block);
    if(!launch.exists||!same(launch.token,token)||!same(launch.pairToken,PAIR))throw fail('This is not a registered ORBIO-paired Pons v2 token',422);
    const curve=addr(launch.curve);
    const [code,pair,native,decimals,symbol,pairDecimals]=await Promise.all([rpc('eth_getCode',[curve,block]),read(curve,CURVE,'pairToken',[],block),read(curve,CURVE,'isNativeQuote',[],block),read(token,ERC20,'decimals',[],block),read(token,ERC20,'symbol',[],block),read(PAIR,ERC20,'decimals',[],block)]);
    if(typeof code!=='string'||code.length<=2||!same(pair,PAIR)||native||decimals>36||pairDecimals>36)throw fail('The registered trading contract could not be verified',422);
    return {token,curve,block,phase:Number(launch.phase),decimals:Number(decimals),symbol:String(symbol).slice(0,30),pairDecimals:Number(pairDecimals)};
  }
  async function market({token}){const info=await inspect(token);return {...info,chainId:NETWORK.chainId,pair:PAIR,pairSymbol:'ORBIO',venue:info.phase===0?'Pons v2 curve':info.phase===2?'Uniswap v4':'Curve closed',available:info.phase===0,externalUrl:'https://www.ponsfamily.com/launchpad/'+info.token,checkedAt:now()};}
  async function quote({token,owner,side,amount:inputText,slippageBps=100}){
    owner=addr(owner);if(!['buy','sell'].includes(side))throw fail('Choose buy or sell');
    if(!Number.isInteger(slippageBps)||slippageBps<10||slippageBps>500)throw fail('Slippage must be between 0.1% and 5%');
    const info=await inspect(token);if(info.phase!==0)throw fail(info.phase===2?'This token has graduated — trade its pool on Pons':'The curve is closed while graduation is pending',409);
    const {curve,block}=info,inAsset=side==='buy'?PAIR:info.token,outAsset=side==='buy'?info.token:PAIR,inDecimals=side==='buy'?info.pairDecimals:info.decimals,outDecimals=side==='buy'?info.decimals:info.pairDecimals,input=amount(inputText,inDecimals);
    const [reserves,sellable,fee,tax,snipe,ready,balance,allowance]=await Promise.all([read(curve,CURVE,'getReserves',[],block),read(curve,CURVE,'sellableTokens',[],block),read(curve,CURVE,'feeBps',[],block),read(curve,CURVE,'creatorTaxBps',[],block),side==='buy'?read(curve,CURVE,'currentSnipeTaxBps',[owner],block):0n,read(curve,CURVE,'readyToGraduate',[],block),read(inAsset,ERC20,'balanceOf',[owner],block),read(inAsset,ERC20,'allowance',[owner,curve],block)]);
    if(sellable<=0n||(side==='sell'&&ready))throw fail('The curve is closing for graduation — refresh on Pons',409);
    if(balance<input)throw fail('Insufficient '+(side==='buy'?'ORBIO':info.symbol)+' balance');
    const appliedSnipe=snipe>BPS-fee-tax-100n?BPS-fee-tax-100n:snipe;
    const priced=priceTrade({side,input,q:reserves[0],t:reserves[1],sellable,fee,tax,snipe:appliedSnipe});if(priced.output<=0n||priced.spent<=0n)throw fail('The amount is too small to receive tokens');
    // The buy contract enforces a rate for clamped fills. Scale its minimum to full input.
    const minRateOutput=side==='buy'?(priced.output*input+priced.spent-1n)/priced.spent:priced.output;
    const minimum=minRateOutput*BigInt(10000-slippageBps)/BPS;if(minimum<=0n)throw fail('The minimum output rounds to zero — increase the amount');
    let kind='swap',to=curve,data=encodeFunctionData({abi:CURVE,functionName:side,args:[input,minimum,owner]}),approvalAmount=null;
    if(allowance<input){kind=allowance>0n?'reset_approval':'approval';to=inAsset;approvalAmount=allowance>0n?0n:input;data=encodeFunctionData({abi:ERC20,functionName:'approve',args:[curve,approvalAmount]});}
    const transaction={from:owner,to,data,value:'0x0'};
    const simulated=await rpc('eth_call',[transaction,'latest']);
    if(kind!=='swap'&&decodeFunctionResult({abi:ERC20,functionName:'approve',data:simulated})!==true)throw fail('The token rejected this allowance approval',422);
    const [gas,gasPrice]=await Promise.all([rpc('eth_estimateGas',[transaction]),rpc('eth_gasPrice',[])]);
    transaction.chainId=NETWORK.chainHex;transaction.gas=hex((BigInt(gas)*120n+99n)/100n);
    const intentId=crypto.randomUUID(),createdAt=now(),expiresAt=createdAt+TTL;
    const result={intentId,kind,side,token:info.token,symbol:info.symbol,pair:PAIR,pairSymbol:'ORBIO',curve,owner,chainId:NETWORK.chainId,realFunds:true,createdAt,expiresAt,block,slippageBps,amountIn:formatUnits(input,inDecimals),expectedOut:formatUnits(priced.output,outDecimals),minimumOut:formatUnits(minimum,outDecimals),minimumType:side==='buy'?'rate_full_input_equivalent':'quantity',inputSymbol:side==='buy'?'ORBIO':info.symbol,outputSymbol:side==='buy'?info.symbol:'ORBIO',refund:formatUnits(priced.refund,inDecimals),partialFill:priced.refund>0n,approvalAmount:approvalAmount===null?null:formatUnits(approvalAmount,inDecimals),feeBps:Number(fee),creatorTaxBps:Number(tax),snipeTaxBps:Number(appliedSnipe),estimatedGasEth:formatUnits(BigInt(transaction.gas)*BigInt(gasPrice),18),simulation:'passed',transaction};
    for(const [id,item]of intents)if(now()-item.createdAt>24*3600000)intents.delete(id);if(intents.size>=1000)throw fail('Too many pending trade previews',429);intents.set(intentId,result);return structuredClone(result);
  }
  async function receipt({owner,intentId,hash}){
    owner=addr(owner);if(typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash))throw fail('A valid transaction hash is required');
    const intent=intents.get(intentId);if(!intent||!same(intent.owner,owner))throw fail('This trade preview is unavailable — inspect the saved transaction on the explorer before retrying',404);
    if(BigInt(await rpc('eth_chainId',[]))!==BigInt(NETWORK.chainId))throw fail('Wrong chain',503);
    const tx=await rpc('eth_getTransactionByHash',[hash]);if(!tx)return {status:'pending',hash};
    if(!same(tx.hash,hash)||!same(tx.from,owner)||!same(tx.to,intent.transaction.to)||!same(tx.input,intent.transaction.data)||BigInt(tx.value)!==0n||tx.chainId&&BigInt(tx.chainId)!==4663n)throw fail('This transaction does not match the reviewed trade',422);
    const r=await rpc('eth_getTransactionReceipt',[hash]);if(!r)return {status:'pending',hash};
    if(!same(r.transactionHash,hash)||!same(tx.blockNumber,r.blockNumber)||BigInt(r.blockNumber)<=BigInt(intent.block))throw fail('This transaction predates the reviewed trade',422);
    const canonical=await rpc('eth_getBlockByNumber',[r.blockNumber,false]);if(!canonical||!same(canonical.hash,r.blockHash)||!same(tx.blockHash,r.blockHash))return {status:'pending',hash};
    return {status:BigInt(r.status)===1n?'confirmed':'reverted',kind:intent.kind,hash,blockNumber:BigInt(r.blockNumber).toString(),explorerUrl:NETWORK.explorer+'/tx/'+hash};
  }
  return {market,quote,receipt};
}
module.exports={createOrbioTradeService,priceTrade,amount,ERC20,CURVE,TTL};

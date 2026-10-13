'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createOrbioTradeService,priceTrade,amount,CURVE,ERC20}=require('./parallax/orbio-trade.cjs');
const {FACTORY,PAIR,FACTORY_ABI}=require('./parallax/orbio-launch.cjs');
const {decodeFunctionData,encodeFunctionResult}=require('./parallax/node_modules/viem');
const TOKEN='0x'+'1'.repeat(40),OWNER='0x'+'2'.repeat(40),CURVE_ADDR='0x'+'3'.repeat(40),HASH='0x'+'4'.repeat(64),BLOCK='0x'+'5'.repeat(64);
function fixture(overrides={}){
 let calls=[],sent=null;const f={phase:0,allowance:0n,balance:1000n*10n**18n,sellable:100000n*10n**18n,ready:false,chain:'0x1237',...overrides};
 const fetcher=async(url,options)=>{assert.equal(url,'https://rpc.mainnet.chain.robinhood.com');const {id,method,params}=JSON.parse(options.body);calls.push({method,params});let result;
 if(method==='eth_chainId')result=f.chain;
 else if(method==='eth_blockNumber')result='0x100';
 else if(method==='eth_getCode')result='0x1234';
 else if(method==='eth_estimateGas')result='0x186a0';
 else if(method==='eth_gasPrice')result='0x3b9aca00';
 else if(method==='eth_getTransactionByHash')result=sent;
 else if(method==='eth_getTransactionReceipt')result={transactionHash:HASH,status:'0x1',blockHash:BLOCK,blockNumber:f.inclusionBlock||'0x101'};
 else if(method==='eth_getBlockByNumber')result={hash:f.canonical||BLOCK};
 else if(method==='eth_call'){
  const {to,data}=params[0],abi=to.toLowerCase()===FACTORY.toLowerCase()?FACTORY_ABI:to.toLowerCase()===CURVE_ADDR?CURVE:ERC20,{functionName:name,args}=decodeFunctionData({abi,data});
  const values={getLaunchedToken:{token:TOKEN,curve:CURVE_ADDR,deployer:OWNER,creatorFeeRecipient:OWNER,pairToken:PAIR,graduationThreshold:100n,poolFee:0,tickSpacing:1,creatorTaxBps:0,buybackEnabled:false,phase:f.phase,sweptQuote:0n,sweptTokens:0n,sweptAt:0n,exists:true},pairToken:PAIR,isNativeQuote:false,decimals:18,symbol:'GAME',getReserves:[1000n*10n**18n,1000000n*10n**18n],sellableTokens:f.sellable,feeBps:100n,creatorTaxBps:50n,currentSnipeTaxBps:0n,readyToGraduate:f.ready,balanceOf:f.balance,allowance:f.allowance,approve:true,buy:999n,sell:999n};
  if(f.rpcError&&name===f.rpcError)return {ok:true,text:async()=>JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000}})};
  result=encodeFunctionResult({abi,functionName:name,result:name==='approve'&&f.approveFalse?false:values[name]});
 }else throw Error(method);
 return {ok:true,text:async()=>JSON.stringify({jsonrpc:'2.0',id,result})};};
 return {service:createOrbioTradeService({fetcher,now:()=>1000}),calls,send:q=>{sent={...q.transaction,hash:HASH,input:q.transaction.data,blockHash:BLOCK,blockNumber:f.inclusionBlock||'0x101'};}};
}
test('curve math charges buy input and sell output separately; clamps and refunds last buy',()=>{
 assert.deepEqual(priceTrade({side:'buy',input:1000n,q:10000n,t:100000n,sellable:90000n,fee:100n,tax:100n}),{output:8925n,spent:1000n,refund:0n});
 assert.deepEqual(priceTrade({side:'sell',input:1000n,q:10000n,t:100000n,sellable:90000n,fee:100n,tax:100n}),{output:99n,spent:1000n,refund:0n});
 const clamped=priceTrade({side:'buy',input:1000n,q:10000n,t:100000n,sellable:100n,fee:100n,tax:100n});assert.equal(clamped.output,100n);assert.equal(clamped.refund,988n);
});
test('amount rejects rounded precision, negative, exponents, and overflow',()=>{for(const value of ['-1','1e2','0','1.0000001','01','9'.repeat(90)])assert.throws(()=>amount(value,6));assert.equal(amount('1.23',6),1230000n);});
test('approval is exact amount to the registered curve and is simulated',async()=>{const f=fixture(),q=await f.service.quote({token:TOKEN,owner:OWNER,side:'buy',amount:'2'});assert.equal(q.kind,'approval');assert.equal(q.approvalAmount,'2');assert.equal(q.transaction.to,PAIR);assert.equal(q.transaction.value,'0x0');const d=decodeFunctionData({abi:ERC20,data:q.transaction.data});assert.deepEqual(d.args,[CURVE_ADDR,2n*10n**18n]);assert.ok(f.calls.some(c=>c.method==='eth_estimateGas'));});
test('nonzero insufficient allowance requires a zero reset before exact approval',async()=>{const {service}=fixture({allowance:1n});const q=await service.quote({token:TOKEN,owner:OWNER,side:'sell',amount:'2'});assert.equal(q.kind,'reset_approval');assert.equal(q.approvalAmount,'0');});
test('funded allowance produces a simulated swap with minimum output and wallet recipient',async()=>{const f=fixture({allowance:100n*10n**18n});const q=await f.service.quote({token:TOKEN,owner:OWNER,side:'buy',amount:'2',slippageBps:100});assert.equal(q.kind,'swap');assert.equal(q.simulation,'passed');const d=decodeFunctionData({abi:CURVE,data:q.transaction.data});assert.equal(d.functionName,'buy');assert.equal(d.args[0],2n*10n**18n);assert.ok(d.args[1]>0n);assert.equal(d.args[2],OWNER);f.send(q);assert.equal((await f.service.receipt({owner:OWNER,intentId:q.intentId,hash:HASH})).status,'confirmed');await assert.rejects(f.service.receipt({owner:TOKEN,intentId:q.intentId,hash:HASH}),/unavailable/);});
test('graduation, wrong chain, funds, invalid slippage and failed simulation cannot produce transactions',async()=>{
 for(const cfg of [{phase:2},{ready:true},{sellable:0n},{chain:'0x1'},{balance:0n},{rpcError:'sell'}]){const {service}=fixture({allowance:100n*10n**18n,...cfg});await assert.rejects(service.quote({token:TOKEN,owner:OWNER,side:'sell',amount:'2'}));}
 await assert.rejects(fixture().service.quote({token:TOKEN,owner:OWNER,side:'buy',amount:'2',slippageBps:10000}),/Slippage/);
});
test('receipt stays pending when the inclusion block is no longer canonical',async()=>{const f=fixture({canonical:HASH}),q=await f.service.quote({token:TOKEN,owner:OWNER,side:'buy',amount:'2'});f.send(q);assert.equal((await f.service.receipt({owner:OWNER,intentId:q.intentId,hash:HASH})).status,'pending');});
test('a false ERC20 approval result fails simulation',async()=>{await assert.rejects(fixture({approveFalse:true}).service.quote({token:TOKEN,owner:OWNER,side:'buy',amount:'2'}),/rejected/);});
test('historical transaction cannot satisfy a new preview',async()=>{const f=fixture({inclusionBlock:'0x100'}),q=await f.service.quote({token:TOKEN,owner:OWNER,side:'buy',amount:'2'});f.send(q);await assert.rejects(f.service.receipt({owner:OWNER,intentId:q.intentId,hash:HASH}),/predates/);});

'use strict';
// Canonical, SOL-quoted PumpSwap pools only. Read one coherent account snapshot
// and use the official SDK's v2 pricing (including retained fee buckets).
const {PublicKey,SystemProgram}=require('@solana/web3.js');
const {TOKEN_PROGRAM_ID,NATIVE_MINT,MintLayout,unpackMint,unpackAccount,getAssociatedTokenAddressSync,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction}=require('@solana/spl-token');
const amm=require('@pump-fun/pump-swap-sdk'),BN=require('bn.js');
const fail=(message,status=422,code='UNVERIFIED_POOL')=>Object.assign(new Error(message),{status,code});
function createPumpSwapAdapter({connection,sdk=amm.PUMP_AMM_SDK}){
  async function read({mint,owner,tokenProgram,minContextSlot}){
    const poolKey=amm.canonicalPumpPoolPda(mint),poolBase=getAssociatedTokenAddressSync(mint,poolKey,true,tokenProgram),poolQuote=getAssociatedTokenAddressSync(NATIVE_MINT,poolKey,true,TOKEN_PROGRAM_ID),userBase=owner?getAssociatedTokenAddressSync(mint,owner,false,tokenProgram):null,userQuote=owner?getAssociatedTokenAddressSync(NATIVE_MINT,owner,false,TOKEN_PROGRAM_ID):null;
    const keys=[amm.GLOBAL_CONFIG_PDA,amm.PUMP_AMM_FEE_CONFIG_PDA,poolKey,poolBase,poolQuote,amm.PUMP_AMM_PROGRAM_ID,mint,NATIVE_MINT,...(owner?[owner,userBase,userQuote]:[])],response=await connection.getMultipleAccountsInfoAndContext(keys,{commitment:'confirmed',minContextSlot});
    if(!Number.isSafeInteger(response.context?.slot)||response.context.slot<minContextSlot||response.value?.length!==keys.length)throw fail('A coherent PumpSwap account snapshot is unavailable',503);
    const [globalInfo,feeInfo,poolInfo,baseVaultInfo,quoteVaultInfo,programInfo,mintAccount,quoteMintAccount,ownerInfo,userBaseAccountInfo,userQuoteAccountInfo]=response.value;
    if(!poolInfo)return {available:false,reason:'Bonding curve completed; waiting for its canonical PumpSwap pool',slot:response.context.slot,poolKey};
    if(!globalInfo?.owner.equals(amm.PUMP_AMM_PROGRAM_ID)||!feeInfo?.owner.equals(amm.PUMP_FEE_PROGRAM_ID)||!poolInfo.owner.equals(amm.PUMP_AMM_PROGRAM_ID)||!programInfo?.executable||!mintAccount?.owner.equals(tokenProgram)||!quoteMintAccount?.owner.equals(TOKEN_PROGRAM_ID))throw fail('Canonical PumpSwap accounts could not be verified');
    let pool,globalConfig,feeConfig,baseVault,quoteVault,mintInfo,quoteMintInfo,userBaseInfo,userQuoteInfo;
    try{pool=sdk.decodePool(poolInfo);globalConfig=sdk.decodeGlobalConfig(globalInfo);feeConfig=sdk.decodeFeeConfig(feeInfo);baseVault=unpackAccount(poolBase,baseVaultInfo,tokenProgram);quoteVault=unpackAccount(poolQuote,quoteVaultInfo,TOKEN_PROGRAM_ID);mintInfo=unpackMint(mint,mintAccount,tokenProgram);quoteMintInfo=unpackMint(NATIVE_MINT,quoteMintAccount,TOKEN_PROGRAM_ID);if(userBaseAccountInfo)userBaseInfo=unpackAccount(userBase,userBaseAccountInfo,tokenProgram);if(userQuoteAccountInfo)userQuoteInfo=unpackAccount(userQuote,userQuoteAccountInfo,TOKEN_PROGRAM_ID);}catch{throw fail('PumpSwap pool, mint or vault data is invalid');}
    if(pool.index!==0||!pool.creator.equals(amm.pumpPoolAuthorityPda(mint))||!pool.baseMint.equals(mint)||!pool.quoteMint.equals(NATIVE_MINT)||!pool.poolBaseTokenAccount.equals(poolBase)||!pool.poolQuoteTokenAccount.equals(poolQuote)||!baseVault.owner.equals(poolKey)||!quoteVault.owner.equals(poolKey)||!baseVault.mint.equals(mint)||!quoteVault.mint.equals(NATIVE_MINT)||baseVault.isFrozen||quoteVault.isFrozen||!mintInfo.isInitialized||mintInfo.decimals!==6||mintInfo.freezeAuthority!==null||mintInfo.supply<=0n||!quoteMintInfo.isInitialized||quoteMintInfo.decimals!==9)throw fail('Only the canonical SOL-paired PumpSwap pool is supported');
    if(owner&&(!ownerInfo||!ownerInfo.owner.equals(SystemProgram.programId)||ownerInfo.executable||!Number.isSafeInteger(ownerInfo.lamports)))throw fail('This wallet needs a funded Solana system account',400,'INSUFFICIENT_BALANCE');
    if(userBaseInfo&&(!userBaseInfo.owner.equals(owner)||!userBaseInfo.mint.equals(mint)||userBaseInfo.isFrozen)||userQuoteInfo&&(!userQuoteInfo.owner.equals(owner)||!userQuoteInfo.mint.equals(NATIVE_MINT)||userQuoteInfo.isFrozen||!userQuoteInfo.isNative))throw fail('The wallet token account is not usable');
    const virtualQuote=BigInt(pool.virtualQuoteReserves.toString()),feeBuckets=BigInt(pool.protocolFees.toString())+BigInt(pool.creatorFees.toString()),pricedQuote=quoteVault.amount+virtualQuote,realQuote=quoteVault.amount-feeBuckets;
    if(feeBuckets<0n||baseVault.amount<=0n||pricedQuote<=0n||realQuote<=0n)throw fail('The canonical pool has insufficient verified liquidity',409,'POOL_LIQUIDITY_UNAVAILABLE');
    const quoteArgs={baseReserve:new BN(baseVault.amount.toString()),quoteReserve:new BN(quoteVault.amount.toString()),virtualQuoteReserves:pool.virtualQuoteReserves,feeBucketsTotal:new BN(feeBuckets.toString()),globalConfig,baseMintAccount:MintLayout.decode(mintAccount.data.subarray(0,MintLayout.span)),baseMint:mint,coinCreator:pool.coinCreator,creator:pool.creator,feeConfig,quoteMint:NATIVE_MINT,isMayhemMode:pool.isMayhemMode,creatorFeeBps:pool.creatorFeeBps};
    const fees=amm.computeFeesBps({...quoteArgs,baseMintSupply:new BN(mintInfo.supply.toString()),quoteReserve:new BN(pricedQuote.toString())}),feeBps=BigInt(fees.lpFeeBps.toString())+BigInt(fees.protocolFeeBps.toString())+(pool.coinCreator.equals(PublicKey.default)?0n:BigInt(fees.creatorFeeBps.toString()));if(feeBps<0n||feeBps>=10000n)throw fail('The pool fee schedule is invalid');
    const unsupported=pool.isMayhemMode||pool.isCashbackCoin||pool.isHolderReward,disabled=Number(globalConfig.disableFlags??0),available=!unsupported&&(disabled&24)===0;
    return {available,reason:unsupported?'This PumpSwap pool mode is not supported':!available?'PumpSwap trading is disabled by its current protocol configuration':null,poolKey,pool,slot:response.context.slot,baseReserve:baseVault.amount,pricedQuote,realQuote,feeBps,mintInfo,userBaseInfo,userQuoteInfo,ownerInfo,quoteArgs,swapState:{globalConfig,feeConfig,poolKey,poolAccountInfo:poolInfo,pool,poolBaseAmount:quoteArgs.baseReserve,poolQuoteAmount:quoteArgs.quoteReserve,baseTokenProgram:tokenProgram,quoteTokenProgram:TOKEN_PROGRAM_ID,baseMint:mint,baseMintAccount:quoteArgs.baseMintAccount,user:owner,userBaseTokenAccount:userBase,userQuoteTokenAccount:userQuote,userBaseAccountInfo:userBaseAccountInfo??null,userQuoteAccountInfo:userQuoteAccountInfo??null}};
  }
  function quote(s,side,input){if(!s.available)throw fail(s.reason,409,'POOL_UNAVAILABLE');let result;try{result=side==='buy'?amm.buyQuoteInput({...s.quoteArgs,quote:new BN(input.toString()),slippage:0}).base:amm.sellBaseInput({...s.quoteArgs,base:new BN(input.toString()),slippage:0}).uiQuote;}catch{throw fail('The amount exceeds current pool liquidity',422,'POOL_QUOTE_FAILED');}return BigInt(result.toString());}
  async function instructions(s,side,input,minimum){
    const raw=side==='buy'?await sdk.buyExactQuoteInV2Instructions(s.swapState,new BN(input.toString()),new BN(minimum.toString())):await sdk.sellV2Instructions(s.swapState,new BN(input.toString()),new BN(minimum.toString()));
    if(!Array.isArray(raw)||!raw.length||raw.some(ix=>![amm.PUMP_AMM_PROGRAM_ID,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,SystemProgram.programId,s.swapState.baseTokenProgram].some(p=>ix.programId.equals(p))||ix.keys.some(k=>k.isSigner&&!k.pubkey.equals(s.swapState.user))))throw fail('The SDK returned an unexpected pool instruction',503);
    const swaps=raw.filter(ix=>ix.programId.equals(amm.PUMP_AMM_PROGRAM_ID));if(swaps.length!==1)throw fail('Exactly one canonical pool swap is required',503);
    // V2 requires the selected official buyback recipient's WSOL ATA. The SDK
    // derives its address but intentionally leaves its creation to the caller.
    const swap=swaps[0],idl=amm.OFFLINE_PUMP_AMM_PROGRAM.idl.instructions.find(i=>i.name===(side==='buy'?'buyExactQuoteInV2':'sellV2'));
    if(!idl||!Buffer.from(swap.data).subarray(0,8).equals(Buffer.from(idl.discriminator)))throw fail('The SDK selected an unexpected swap instruction',503);
    const ataIndex=idl.accounts.findIndex(a=>a.name==='buybackFeeRecipient');
    if(ataIndex<0)throw fail('The official pool fee layout is unsupported',503);
    const ata=swap.keys[ataIndex]?.pubkey,recipient=ata?s.swapState.globalConfig.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default)&&ata.equals(getAssociatedTokenAddressSync(NATIVE_MINT,k,true,TOKEN_PROGRAM_ID))):null;
    if(!recipient)throw fail('The selected pool fee recipient is invalid',503);
    return [createAssociatedTokenAccountIdempotentInstruction(s.swapState.user,ata,recipient,NATIVE_MINT,TOKEN_PROGRAM_ID),...raw];
  }
  return {read,quote,instructions};
}
module.exports={createPumpSwapAdapter};

'use strict';
// Roblox launch orchestration only. The existing Devnet service constructs and
// verifies the exact SPL transaction; this layer never activates camera missions.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PublicKey}=require('@solana/web3.js');
const {assertBuilderModelId,DEFAULT_BUILDER_MODEL_ID}=require('./builder-models.cjs');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const UUID=/^[a-f0-9-]{36}$/;
const FEE_FIELDS=['feeSharingRequired','feeSharingAtomic','feePolicyHash','feeShares','sharingConfig','permanentShares','feeSharingVerified'];
function feeSnapshot(result){return Object.fromEntries(FEE_FIELDS.filter(k=>k!=='feeSharingVerified'&&result?.[k]!==undefined).map(k=>[k,result[k]]));}
function validateFeeSnapshot(result,previous,owner){
  if(previous?.feeSharingRequired===true&&result.feeSharingRequired!==true)throw fail('Required creator-fee routing cannot be removed from a saved launch',503);
  if(result.feeSharingRequired!==true)return;
  try{
    if(result.feeSharingAtomic!==true||result.permanentShares!==true||!/^[a-f0-9]{64}$/.test(result.feePolicyHash||'')||!Array.isArray(result.feeShares)||!result.feeShares.length||result.feeShares.length>10)throw Error();
    address(result.sharingConfig);if(result.sharingConfig!==require('@pump-fun/pump-sdk').feeSharingConfigPda(new PublicKey(result.mint)).toBase58())throw Error();const seen=new Set(),roles=new Set();let sum=0;
    for(const row of result.feeShares){
      address(row.address);if(seen.has(row.address)||!Number.isSafeInteger(row.shareBps)||row.shareBps<=0||row.shareBps>10000)throw Error();
      const allocations=row.role==='combined'?row.allocationsBps:{[row.role]:row.shareBps};
      if(!allocations||typeof allocations!=='object'||Array.isArray(allocations)||!Object.keys(allocations).length||row.role==='combined'&&Object.keys(allocations).length<2)throw Error();
      let allocated=0;for(const [role,bps] of Object.entries(allocations)){if(!['compute','creator','platform'].includes(role)||roles.has(role)||!Number.isSafeInteger(bps)||bps<=0||role==='creator'&&row.address!==owner)throw Error();roles.add(role);allocated+=bps;}
      if(allocated!==row.shareBps)throw Error();seen.add(row.address);sum+=row.shareBps;
    }
    if(sum!==10000||!roles.has('compute')||!roles.has('platform'))throw Error();
    if(previous?.feeSharingRequired&&JSON.stringify(feeSnapshot(previous))!==JSON.stringify(feeSnapshot(result)))throw Error();
  }catch{throw fail('The permanent creator-fee policy is missing, invalid or changed',503);}
  if(result.status==='confirmed'&&result.feeSharingVerified!==true)throw fail('Finalized creator-fee routing verification is required before creating the game workspace',503);
}
function address(value,signer=false){try{if(typeof value!=='string')throw Error();const key=new PublicKey(value);if(key.toBase58()!==value||signer&&!PublicKey.isOnCurve(key.toBytes()))throw Error();return value;}catch{throw fail('A valid Solana address is required');}}
function field(value,name,max,min=1){if(typeof value!=='string'||value.trim().length<min||Buffer.byteLength(value)>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw fail(`${name} must contain ${min} or more characters within ${max} bytes`);return value.trim();}
function missionData(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Enter your game launch details');
  if(input.template!==undefined&&input.template!=='auto')throw fail('Describe the game in your prompt instead of choosing a starter');
  const name=field(input.name,'Game name',80,2);if(name.length>40)throw fail('Game name must be at most 40 characters');
  const ticker=field(input.ticker,'Ticker',10,2).toUpperCase();if(!/^[A-Z][A-Z0-9]{1,9}$/.test(ticker))throw fail('Ticker must use 2–10 letters or numbers and start with a letter');
  const inspiration=input.inspiration==null||input.inspiration===''?'':field(input.inspiration,'Reference games',1200);
  const extra={};if(input.artworkId!==undefined){if(!UUID.test(input.artworkId))throw fail('Choose saved launch artwork');extra.artworkId=input.artworkId;}
  if(input.artDirection!==undefined&&input.artDirection!=='')extra.artDirection=field(input.artDirection,'Art direction',1200);
  return {kind:'roblox',name,ticker,brief:field(input.brief,'Game prompt',2400,12),modelId:assertBuilderModelId(input.modelId??DEFAULT_BUILDER_MODEL_ID),inspiration,template:'auto',...(input.metadataUri?{metadataUri:require('./pump-metadata.cjs').publicHttps(input.metadataUri)}:{}),...extra};
}
function decodeState(bytes,cluster='devnet'){
  const saved=JSON.parse(bytes.toString('utf8'));
  if(saved.version!==1||saved.cluster!==cluster||!Array.isArray(saved.launches)||saved.launches.length>500)throw Error('Invalid launch index');
  const ids=new Set();
  for(const record of saved.launches){
    if(!UUID.test(record.launchId)||ids.has(record.launchId)||record.missionId!=='roblox_'+record.launchId||!['draft','prepared','pending','confirmed','failed','expired'].includes(record.status)||!Number.isFinite(record.createdAt)||!Number.isFinite(record.updatedAt))throw Error('Invalid saved game launch');
    ids.add(record.launchId);address(record.owner,true);const mission=missionData(record.mission);
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify({owner:record.owner,mission})).digest('hex');if(record.fingerprint!==fingerprint)throw Error('Saved mission fingerprint does not match');
    if(record.result){if(record.result.intentId!==record.intentId||record.result.cluster!==cluster)throw Error('Invalid saved token intent');address(record.result.mint);validateFeeSnapshot(record.result,undefined,record.owner);}
    if(record.status==='confirmed'&&(!record.result||record.result.status!=='confirmed'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(record.result.signature||'')))throw Error('Invalid saved confirmation');
    if(record.buildId&&!UUID.test(record.buildId))throw Error('Invalid saved game link');
  }
  return saved.launches;
}
function createClusterLaunchService({stateDirectory,devnet,getBuilds,getArtwork,createMetadata,validateModel=async()=>{},inferenceProvider='openrouter',now=Date.now,cluster='devnet'}){
  if(!stateDirectory)throw fail('Persistent game launch storage is required',503);
  const file=path.join(stateDirectory,cluster==='devnet'?'roblox-solana-launches.json':'roblox-solana-mainnet-launches.json');fs.mkdirSync(stateDirectory,{recursive:true});
  let records=[],fault=false,diskDigest=null;
  if(fs.existsSync(file)){
    try{const bytes=fs.readFileSync(file);records=decodeState(bytes,cluster);diskDigest=digest(bytes);}
    catch{throw fail('Saved Solana game launches are unreadable — recovery is required before another launch',503);}
  }
  function assertStorage(){
    if(fault)throw fail('Game launch storage is unavailable',503);
    try{const currentDigest=fs.existsSync(file)?digest(fs.readFileSync(file)):null;if(currentDigest!==diskDigest)throw Error('History changed');}
    catch{fault=true;throw fail('Game launch state could not be saved — history changed on disk; recovery is required before another launch',503);}
  }
  function save(){
    assertStorage();
    const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
    try{const bytes=JSON.stringify({version:1,cluster,launches:records});fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);diskDigest=digest(bytes);}
    catch{fault=true;throw fail('Game launch state could not be saved — do not launch again until recovery',503);}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  let queue=Promise.resolve();const exclusive=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  function config(){
    const {allowanceUsd,...settings}=devnet.config();
    if(cluster==='mainnet-beta'){if(settings.cluster!==cluster)throw fail('The mainnet launch service returned a different network',503);return {...settings,creatorOwnership:'Signed Solana launching wallet'};}
    if(settings.cluster!=='devnet'||settings.rpcUrl!=='https://api.devnet.solana.com')throw fail('Only the pinned Solana Devnet launch service is available',503);
    return {...settings,chain:'solana',networkName:'Solana devnet',mainnetAvailable:false,tradingAvailable:false,liquidityCreated:false,metadataOnchain:false,computeFunding:'Sponsored server compute under the shared daily budget; test SOL is not converted to AI credits',creatorOwnership:'Signed Solana launching wallet'};
  }
  function owned(owner,{launchId,intentId}){
    address(owner,true);
    if(launchId?!UUID.test(launchId):typeof intentId!=='string'||!intentId)throw fail('Choose a saved game launch');
    const record=records.find(item=>launchId?item.launchId===launchId:item.intentId===intentId);
    if(!record)throw fail('Saved game launch was not found',404);if(record.owner!==owner)throw fail('This game launch belongs to another Solana wallet',403);return record;
  }
  function output(record){
    const result={...config(),...(record.result?{feeSharingRequired:false,feeSharingAtomic:false,feePolicyHash:null,feeShares:null,sharingConfig:null,permanentShares:false,feeSharingVerified:false}:{}),...record.result,launchId:record.launchId,mission:structuredClone(record.mission),owner:record.owner,status:record.status,createdAt:record.createdAt,updatedAt:record.updatedAt,intentId:record.intentId||null,buildId:record.buildId||null};
    if(record.buildId){try{result.buildSession=getBuilds().get(record.buildId,{owner:record.owner});}catch{result.buildError='Your token is confirmed; retry its status to recover the game workspace without launching again';}}
    if(record.buildError)result.buildError=record.buildError;if(record.lastError)result.lastError=record.lastError;return result;
  }
  async function artworkFor(owner,mission){
    if(!mission.artworkId)return null;if(typeof getArtwork!=='function')throw fail('Saved launch artwork is unavailable',503);
    const artwork=await getArtwork({owner,id:mission.artworkId,name:mission.name,ticker:mission.ticker,brief:mission.brief,inspiration:mission.inspiration,...(mission.artDirection!==undefined?{artDirection:mission.artDirection}:{})});
    if(!artwork||artwork.id!==mission.artworkId||artwork.status!=='ready'||artwork.name!==mission.name||artwork.ticker!==mission.ticker||artwork.brief!==mission.brief||!artwork.thumbnail?.bytes||!artwork.coinIcon?.bytes)throw fail('Complete the saved launch artwork before preparing this coin',409);
    return artwork;
  }
  async function accept(record,result){
    if(!result||result.owner!==record.owner||result.missionId!==record.missionId||result.cluster!==cluster||!['prepared','pending','confirmed','failed','expired'].includes(result.status)||typeof result.intentId!=='string')throw fail('Solana launch service returned a different game or network',503);
    address(result.mint);
    if(record.intentId&&record.intentId!==result.intentId)throw fail('Solana launch intent changed unexpectedly',503);
    if(record.result?.mint&&record.result.mint!==result.mint)throw fail('Solana launch mint changed unexpectedly',503);
    if(result.status==='confirmed'&&(typeof result.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(result.signature)))throw fail('A confirmed Solana transaction signature is required',503);
    if(cluster==='mainnet-beta'&&result.status==='confirmed'&&(!result.verified||!result.finalized||!result.metadataVerified||!result.bondingCurveCreated))throw fail('Finalized Pump mint and metadata verification is required',503);
    validateFeeSnapshot(result,record.result,record.owner);
    const allowed=['cluster','status','intentId','mint','tokenAccount','transactionBase64','blockhash','lastValidBlockHeight','expiresAt','rentLamports','estimatedNetworkFeeLamports','totalRequiredLamports','signature','confirmedAt','explorerUrl','mintExplorerUrl','transactionVersion','fundingLamports','estimatedAccountCostLamports','realFunds','costIsEstimate','initialBuyLamports','simulation','metadataUri','metadata','curve','pumpUrl','verified','finalized','metadataVerified','bondingCurveCreated','slot','verificationSlot','actualNetworkFeeLamports','submissionUncertain','lastError'];
    const safe=Object.fromEntries([...allowed,...FEE_FIELDS].filter(key=>result[key]!==undefined).map(key=>[key,structuredClone(result[key])]));
    record.result=safe;record.intentId=result.intentId;record.status=result.status;record.updatedAt=now();delete record.lastError;save();
    if(record.status==='confirmed'){
      try{
        const m=record.mission,artwork=await artworkFor(record.owner,m),builds=getBuilds(),build=builds.create({owner:record.owner,gameName:m.name,brief:m.brief,template:'auto',inspiration:m.inspiration,modelId:m.modelId,inferenceProvider,idempotencyKey:'solana-'+cluster+':'+record.launchId,token:{chain:'solana',cluster,address:result.mint,symbol:m.ticker,signature:result.signature,verified:true,marketCapUsd:null}});
        if(artwork){if(typeof builds.attachLaunchArtwork!=='function')throw fail('Game artwork attachment is unavailable',503);builds.attachLaunchArtwork({id:build.id,owner:record.owner,artwork});}
        record.buildId=build.id;delete record.buildError;save();
      }catch{record.buildError='Your token is confirmed; retry this launch status to recover the workspace without paying again';save();}
    }
    return output(record);
  }
  async function recorded(record,operation){
    try{return accept(record,await operation());}
    catch(error){if(['TRANSACTION_FAILED','TRANSACTION_EXPIRED'].includes(error.code)){record.status=error.code==='TRANSACTION_FAILED'?'failed':'expired';record.updatedAt=now();record.lastError=error.message;save();}throw error;}
  }
  async function prepare({owner,launchId,...input}){return exclusive(async()=>{
    assertStorage();
    address(owner,true);config();let record;
    if(launchId)record=owned(owner,{launchId});
    else{
      let mission=missionData(input.mission?{...input.mission,...(input.metadataUri?{metadataUri:input.metadataUri}:{}),...(input.artworkId?{artworkId:input.artworkId}:{})}:input);await validateModel(mission.modelId);
      const artwork=await artworkFor(owner,mission);
      if(artwork&&cluster==='mainnet-beta'){
        if(typeof createMetadata!=='function'||!artwork.coinIcon.publicUrl)throw fail('Configure public HTTPS artwork hosting before a mainnet launch',503);
        const metadata=await createMetadata({name:mission.name,symbol:mission.ticker,description:mission.brief,imageUrl:artwork.coinIcon.publicUrl});
        if(mission.metadataUri&&mission.metadataUri!==metadata.metadataUri)throw fail('This metadata does not match the selected launch artwork',409);
        mission=missionData({...mission,metadataUri:metadata.metadataUri});
      }
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify({owner,mission})).digest('hex');
      record=records.find(item=>item.owner===owner&&item.fingerprint===fingerprint);
      if(!record){if(records.length>=500||records.filter(item=>item.owner===owner).length>=50)throw fail('Game launch limit reached',429);const launchId=crypto.randomUUID();record={launchId,missionId:'roblox_'+launchId,owner,mission,fingerprint,status:'draft',createdAt:now(),updatedAt:now()};records.push(record);save();}
    }
    await validateModel(record.mission.modelId);
    await artworkFor(owner,record.mission);
    return recorded(record,()=>devnet.prepareLaunch({owner,missionId:record.missionId,...(cluster==='mainnet-beta'?{name:record.mission.name,symbol:record.mission.ticker,metadataUri:record.mission.metadataUri}:{})}));
  });}
  async function submit({owner,intentId,signedTransactionBase64}){return exclusive(async()=>{assertStorage();config();const record=owned(owner,{intentId});return recorded(record,()=>devnet.submit({owner,intentId:record.intentId,signedTransactionBase64,beforeBroadcast:assertStorage}));});}
  async function status({owner,intentId,launchId}){return exclusive(async()=>{assertStorage();config();const record=owned(owner,{intentId,launchId});if(!record.intentId)return output(record);return recorded(record,()=>devnet.status({owner,intentId:record.intentId}));});}
  function list(owner){assertStorage();address(owner,true);return records.filter(item=>item.owner===owner).sort((a,b)=>b.createdAt-a.createdAt).map(output);}
  function verifiedCreator(projectId,mint){assertStorage();if(cluster!=='mainnet-beta'||!UUID.test(projectId))return null;address(mint);const rows=records.filter(r=>r.buildId===projectId&&r.status==='confirmed'&&r.result?.mint===mint&&r.result.verified===true&&r.result.finalized===true);return rows.length===1?rows[0].owner:null;}
  return {config,prepare,submit,status,list,verifiedCreator};
}
function createRobloxSolanaLaunchService(options){
  const {mainnet=null,defaultCluster='devnet'}=options;
  if(!['devnet','mainnet-beta'].includes(defaultCluster)||defaultCluster==='mainnet-beta'&&!mainnet)throw fail('Choose an available default Solana launch network',503);
  const devnet=createClusterLaunchService({...options,cluster:'devnet'}),production=mainnet?createClusterLaunchService({...options,devnet:mainnet,cluster:'mainnet-beta'}):null;
  function choose(cluster){if(cluster==='devnet')return devnet;if(cluster==='mainnet-beta'&&production)return production;throw fail('The selected Solana launch network is unavailable',503);}
  function saved(input){const candidates=[devnet,production].filter(Boolean).filter(service=>service.list(input.owner).some(row=>input.launchId?row.launchId===input.launchId:row.intentId===input.intentId));if(candidates.length===1)return candidates[0];if(candidates.length>1)throw fail('Launch identity conflicts between networks; recovery is required',503);return choose(input.cluster||defaultCluster);}
  return {
    config:()=>({...choose(defaultCluster).config(),defaultCluster,supportedClusters:['devnet',...(production?.config().mainnetAvailable?['mainnet-beta']:[])],mainnetAvailable:!!production?.config().mainnetAvailable,networks:{devnet:devnet.config(),...(production?{'mainnet-beta':production.config()}:{})}}),
    prepare:async input=>(input.launchId?saved(input):choose(input.cluster||defaultCluster)).prepare(input),
    submit:async input=>saved(input).submit(input),status:async input=>saved(input).status(input),
    list:owner=>[...devnet.list(owner),...(production?production.list(owner):[])].sort((a,b)=>b.createdAt-a.createdAt),
    verifiedCreator:(projectId,mint)=>production?.verifiedCreator(projectId,mint)??null
  };
}
module.exports={createRobloxSolanaLaunchService,missionData};

const fs=require('node:fs'),path=require('node:path'),root=path.join(__dirname,'parallax');
function edit(name,changes){let text=fs.readFileSync(path.join(root,name),'utf8');for(const [from,to]of changes){if(!text.includes(from))throw Error(name+' missing anchor');text=text.replace(from,to);}fs.writeFileSync(path.join(root,name),text);}
edit('runtime-config.cjs',[
 ["  return {publicOrigin:origin", "  const bounded=(key,storedKey,fallback,min,max,integer=false)=>{const value=Number(env[key]??stored[storedKey]??fallback);if(!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw fail(key+' is outside its supported allowance');return value;};\n  const buildOutputTokens=bounded('ROPAD_BUILD_OUTPUT_TOKENS','buildOutputTokens',6000,1000,32000,true),buildPlanMaxEstimateUsd=bounded('ROPAD_BUILD_PLAN_CAP_USD','buildPlanMaxEstimateUsd',.75,.01,25),maxAgentBudgetUsd=bounded('ROPAD_AGENT_MAX_BUDGET_USD','maxAgentBudgetUsd',1,.01,25);\n  return {buildOutputTokens,buildPlanMaxEstimateUsd,maxAgentBudgetUsd,publicOrigin:origin"]
]);
edit('server.cjs',[
 ["key=inference.key;", "key=inference.key;inference.buildOutputTokens=settings.buildOutputTokens??6000;inference.buildPlanMaxEstimateUsd=settings.buildPlanMaxEstimateUsd??.75;"],
 ['createBuilderAgentService({stateDirectory,getBuilds,provider,now,','createBuilderAgentService({stateDirectory,getBuilds,provider,now,maxBudgetUsd:settings.maxAgentBudgetUsd??1,'],
 ['createBuildRouter({stateDirectory,publicOrigin:settings.publicOrigin,','createBuildRouter({stateDirectory,buildOutputTokens:inference.buildOutputTokens,buildPlanMaxEstimateUsd:inference.buildPlanMaxEstimateUsd,maxAgentBudgetUsd:settings.maxAgentBudgetUsd??1,publicOrigin:settings.publicOrigin,'],
 ['createSolanaFeeAccountingService({stateDirectory,config,resolveProjectMint,now})',"createSolanaFeeAccountingService({stateDirectory,config,resolveProjectMint,connection:new (require('@solana/web3.js').Connection)(settings.solanaRpcUrl||'https://api.mainnet-beta.solana.com',{commitment:'confirmed',disableRetryOnRateLimit:true}),now})"]
]);
edit('builder-http.cjs',[
 ['createBuildRouter({stateDirectory,publicOrigin=null,','createBuildRouter({stateDirectory,buildOutputTokens=6000,buildPlanMaxEstimateUsd=MAX_BUILD_PLAN_ESTIMATE,maxAgentBudgetUsd=1,publicOrigin=null,'],
 ['maxAgentBudgetUsd:1,agentWorkerProtocol','maxAgentBudgetUsd,agentWorkerProtocol'],
 ['estimateBuildPlan(m,modelReserveMultiplier)','estimateBuildPlan(m,modelReserveMultiplier,buildOutputTokens)'],
 ['estimate<=MAX_BUILD_PLAN_ESTIMATE','estimate<=buildPlanMaxEstimateUsd'],
 ['maxPlanEstimateUsd:MAX_BUILD_PLAN_ESTIMATE,data','maxPlanEstimateUsd:buildPlanMaxEstimateUsd,outputTokenAllowance:buildOutputTokens,data']
]);
console.log('Operator-configurable build allowances added without changing defaults');

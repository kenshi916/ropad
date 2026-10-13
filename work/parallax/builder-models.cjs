'use strict';
// Only these exact provider model IDs may design new Roblox scenes. Historical
// workspace records retain their original model IDs as provenance.
const BUILDER_MODEL_IDS=Object.freeze(['anthropic/claude-opus-5.5','openai/gpt-6-astra']);
const DEFAULT_BUILDER_MODEL_ID=BUILDER_MODEL_IDS[0];
const MAX_BUILD_PLAN_ESTIMATE=.75;
const MAX_BUILD_OUTPUT_TOKENS=6000;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function assertBuilderModelId(id){
  if(!BUILDER_MODEL_IDS.includes(id))throw fail('Choose Claude Opus 5.5 or GPT-6 Astra for a custom Roblox game');
  return id;
}
function listBuilderModels(catalog){
  const rows=Array.isArray(catalog)?catalog:[];
  return BUILDER_MODEL_IDS.map(id=>rows.find(m=>m?.id===id&&Array.isArray(m.architecture?.output_modalities)&&m.architecture.output_modalities.includes('text'))).filter(Boolean);
}
function selectBuilderModel(catalog,id=DEFAULT_BUILDER_MODEL_ID){
  assertBuilderModelId(id);
  const model=listBuilderModels(catalog).find(m=>m.id===id);
  if(!model)throw fail('The selected advanced model is unavailable in the current provider catalog — choose another listed advanced model',503);
  return model;
}
function estimateBuildPlan(model,multiplier=1,outputTokens=MAX_BUILD_OUTPUT_TOKENS,inputTokens=8000){
  const prices=[model.pricing,...(Array.isArray(model.pricing?.overrides)?model.pricing.overrides:[])];let total=0;
  if(!Number.isFinite(multiplier)||multiplier<=0||!Number.isInteger(outputTokens)||outputTokens<1000||outputTokens>32000||!Number.isInteger(inputTokens)||inputTokens<1||inputTokens>200000)return Infinity;
  for(const [key,tokens] of [['prompt',inputTokens],['completion',outputTokens],['request',1]]){
    const values=prices.map(p=>p?.[key]).filter(v=>v!==undefined).map(Number);
    if(!values.length){if(key!=='request')return Infinity;continue;}
    if(values.some(v=>!Number.isFinite(v)||v<0))return Infinity;
    total+=Math.max(...values)*tokens;
  }
  return Math.max(.001,total*multiplier);
}
module.exports={BUILDER_MODEL_IDS,DEFAULT_BUILDER_MODEL_ID,MAX_BUILD_PLAN_ESTIMATE,MAX_BUILD_OUTPUT_TOKENS,assertBuilderModelId,listBuilderModels,selectBuilderModel,estimateBuildPlan};

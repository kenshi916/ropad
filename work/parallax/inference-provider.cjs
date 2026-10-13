'use strict';

// A fixed allowlist keeps credentials bound to the operator-selected gateway.
// We never infer an Orbio credential from an OpenRouter key or use a user URL.
function createInferenceProvider({provider='openrouter',key='',orbioKey=''}={}) {
  if(provider==='openrouter') return {
    id:provider,name:'OpenRouter',key,
    modelsUrl:'https://openrouter.ai/api/v1/models?output_modalities=all',
    completionsUrl:'https://openrouter.ai/api/v1/chat/completions',
    catalogUrl:'https://openrouter.ai/models',reserveMultiplier:1
  };
  if(provider==='orbio') return {
    id:provider,name:'Orbio',key:orbioKey,
    modelsUrl:'https://api.orbio.so/api/v1/models?output_modalities=text',
    completionsUrl:'https://api.orbio.so/api/v1/chat/completions',
    catalogUrl:'https://www.orbio.so/models',reserveMultiplier:1.1
  };
  throw new Error('PARALLAX_AI_PROVIDER must be openrouter or orbio');
}

module.exports={createInferenceProvider};

(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const modelsAllowed = ['anthropic/claude-opus-5.5', 'openai/gpt-6-astra'];
  const providers = {
    phantom: {name:'Phantom',icon:'assets/wallets/phantom.svg',url:'https://phantom.com/download',get:()=>window.phantom?.solana?.isPhantom ? window.phantom.solana : window.solana?.isPhantom ? window.solana : null},
    solflare: {name:'Solflare',icon:'assets/model-logos/solflare-wallet.svg',url:'https://www.solflare.com/download/',get:()=>window.solflare?.isSolflare ? window.solflare : null}
  };
  const state = {wallet:null,epoch:0,invalidating:Promise.resolve(),busy:false,version:0,draft:{},intent:null,config:null,models:[],step:1,mounted:false,artTab:'thumbnail',artwork:null,artBusy:false};
  const launch = document.getElementById('launch-dialog');
  let body = document.getElementById('launch-body'),pendingSeed=null;
  const short = value => value ? value.slice(0,5)+'…'+value.slice(-4) : '';
  const base64 = bytes => { let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary); };
  const unbase64 = value => Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  const addressOf = provider => provider?.publicKey?.toString?.() || '';
  const validLamports = value => (typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=0;
  const sol = (value,cluster='devnet') => validLamports(value) ? (Number(value)/1e9).toFixed(9).replace(/0+$/,'').replace(/\.$/,'')+(cluster==='mainnet-beta'?' SOL':' test SOL') : 'Unavailable';
  async function api(url,body_) {
    const options={credentials:'same-origin',signal:AbortSignal.timeout(60000)};
    if(body_!==undefined){const s=await fetch('/api/status',{credentials:'same-origin'});if(!s.ok)throw Error('The local service is unavailable');const status=await s.json();Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json','X-Parallax-Token':status.csrf},body:JSON.stringify(body_)});}
    const response=await fetch(url,options);let result;try{result=await response.json();}catch{throw Error('The Solana service returned an unreadable response');}
    if(!response.ok)throw Error(result.error||'The Solana request did not complete');return result;
  }
  function dispatch() {
    document.querySelectorAll('.b-wallet').forEach(button=>{button.innerHTML=`<img src="${state.wallet?providers[state.wallet.id].icon:providers.phantom.icon}" alt=""><span>${state.wallet?esc(short(state.wallet.address)):'Connect wallet'}</span>`;button.title=state.wallet?state.wallet.name+' · Solana · '+state.wallet.address:'Connect Phantom or Solflare on Solana';});
    window.dispatchEvent(new CustomEvent('ropad-solana-wallet-change',{detail:{address:state.wallet?.address||null}}));
    if(state.mounted&&state.step===2&&!state.intent){const form=body.querySelector('form');if(form)captureBuilder(form);renderBuilder();}
  }
  function detach() { const w=state.wallet;if(!w)return;w.provider.removeListener?.('accountChanged',w.accountHandler);w.provider.removeListener?.('disconnect',w.disconnectHandler); }
  function invalidate(message) {
    state.epoch++;state.intent=null;clearTimeout(state.artTimer);state.artwork=null;state.artKey=null;delete state.draft.artworkId;
    state.invalidating=state.invalidating.catch(()=>{}).then(()=>api('/api/auth/logout',{}));
    state.invalidating.catch(()=>{});
    dispatch();const approve=body?.querySelector('[data-solana-approve]');if(approve){approve.disabled=true;feedback(message+' Review this launch again',true);}
    window.ParallaxBuilders?.refresh();
  }
  function check(expected) {
    const w=state.wallet;if(!w)throw Error('Connect Phantom or Solflare to continue');
    if(addressOf(w.provider)!==w.address || expected && w.address!==expected){detach();state.wallet=null;invalidate('The wallet account changed');throw Error('Wallet account changed Connect and verify the intended creator wallet');}
    return w;
  }
  async function authenticate() {
    await state.invalidating;const w=check(),epoch=state.epoch,address=w.address;
    const session=await api('/api/auth/session');check(address);if(epoch!==state.epoch)throw Error('Wallet account changed');
    if(session.authenticated&&session.address===address)return session;
    if(typeof w.provider.signMessage!=='function')throw Error('This wallet cannot sign the creator verification message');
    const challenge=await api('/api/auth/challenge',{address});check(address);if(epoch!==state.epoch)throw Error('Wallet account changed');
    const signed=await w.provider.signMessage(new TextEncoder().encode(challenge.message),'utf8');check(address);if(epoch!==state.epoch)throw Error('Wallet account changed');
    const bytes=signed.signature||signed;if(!(bytes instanceof Uint8Array)||bytes.length!==64)throw Error('Wallet returned an invalid message signature');
    const result=await api('/api/auth/verify',{id:challenge.id,signatureBase64:base64(bytes)});check(address);
    if(epoch!==state.epoch||!result.authenticated||result.address!==address)throw Error('Creator wallet verification did not complete');
    window.ParallaxBuilders?.refresh();
    return result;
  }
  function walletPicker(message='',error=false) {
    const w=state.wallet;
    window.openInfo('ROPAD / SOLANA WALLET',`<div class="r-solana-wallet"><h2>${w?'Wallet connected':'Connect a Solana wallet'}</h2><p>Phantom and Solflare connect your Solana account Creator verification and token transactions each require a separate approval</p>${w?`<div class="r-solana-connected"><img src="${providers[w.id].icon}" alt=""><div><strong>${esc(w.name)}</strong><code>${esc(w.address)}</code><small>Solana account · Each launch displays its network before approval</small></div></div><button class="button" data-solana-disconnect>Disconnect wallet</button>`:`<div class="r-solana-wallet-options">${Object.entries(providers).map(([id,p])=>`<button class="r-solana-wallet-row" data-solana-wallet="${id}"${state.busy?' disabled':''}><img src="${p.icon}" alt=""><span><b>${p.name}</b><small>${p.get()?'Detected in this browser':'Extension not detected'}</small></span><em>${p.get()?'Connect ↗':'Get wallet ↗'}</em></button>`).join('')}</div>`}<p class="r-solana-feedback${error?' is-error':''}" role="status">${esc(message||'Connection shares your public address No token transaction is requested here')}</p><p class="r-solana-note">Use the desktop browser where your wallet extension is installed</p></div>`);
    const host=document.getElementById('info-body');host.querySelectorAll('[data-solana-wallet]').forEach(button=>button.onclick=()=>connect(button.dataset.solanaWallet));
    host.querySelector('[data-solana-disconnect]')?.addEventListener('click',async()=>{const current=state.wallet;detach();state.wallet=null;invalidate('Wallet disconnected');try{await current?.provider.disconnect?.();}catch{}walletPicker('Disconnected from Ropad');});
  }
  async function connect(id) {
    if(!id){walletPicker();return null;}if(state.busy)return null;
    const config=providers[id];if(!config)throw Error('Choose Phantom or Solflare');const provider=config.get();
    if(!provider){walletPicker(config.name+' is not installed in this browser');const host=document.getElementById('info-body');host.insertAdjacentHTML('beforeend',`<a class="button" href="${config.url}" target="_blank" rel="noopener">Get ${config.name} ↗</a>`);return null;}
    state.busy=true;
    try{
      const response=await provider.connect(),address=(response?.publicKey||provider.publicKey)?.toString();
      if(!address||addressOf(provider)!==address)throw Error('The wallet account changed during connection');
      detach();state.wallet={id,name:config.name,address,provider,chain:'solana'};
      const boundWallet=state.wallet;
      state.wallet.accountHandler=publicKey=>{if(state.wallet!==boundWallet)return;const next=publicKey?.toString?.();if(!next){detach();state.wallet=null;}else state.wallet.address=next;invalidate('The wallet account changed');};
      state.wallet.disconnectHandler=()=>{if(state.wallet!==boundWallet)return;detach();state.wallet=null;invalidate('Wallet disconnected');};
      provider.on?.('accountChanged',state.wallet.accountHandler);provider.on?.('disconnect',state.wallet.disconnectHandler);invalidate('Wallet connected');
      walletPicker('Connected Return to your launch or verify your creator wallet');return state.wallet;
    }catch(error){walletPicker(/reject|cancel|declin/i.test(error.message||'')?'Connection cancelled':error.message,true);return null;}finally{state.busy=false;document.getElementById('info-body')?.querySelectorAll('[data-solana-wallet]').forEach(button=>button.disabled=false);}
  }
  function feedback(message,error=false){const node=body?.querySelector('[data-solana-feedback]');if(node){node.textContent=message;node.classList.toggle('is-error',error);}}
  function shell(){return ++state.version;}
  const isMainnet = value => value?.cluster==='mainnet-beta';
  function network(intent){
    if(!['devnet','mainnet-beta'].includes(intent.cluster))throw Error('Unknown Solana launch network');
    if(intent.status==='prepared'){
      if(isMainnet(intent)&&state.config?.mainnetAvailable!==true)throw Error('New mainnet launches are disabled Saved transactions can still be checked');
      const fields=['fundingLamports','rentLamports','estimatedNetworkFeeLamports','totalRequiredLamports'];
      if(fields.some(key=>!validLamports(intent[key]))||Number(intent.totalRequiredLamports)!==Number(intent.fundingLamports)+Number(intent.rentLamports)+Number(intent.estimatedNetworkFeeLamports))throw Error('The exact SOL quote is incomplete or inconsistent Request a fresh quote');
      if(isMainnet(intent)&&(intent.realFunds!==true||intent.simulation!=='passed'||intent.transactionVersion!=='v0'))throw Error('Mainnet simulation and transaction review are required');
    }
    return intent;
  }
  const active = version => state.mounted && version===state.version;
  const usd = value => Number.isFinite(Number(value))&&Number(value)>=0?'$'+Number(value).toFixed(2):'Unavailable';
  const modelName = id => (state.models.find(model=>model.id===id)?.name||({'anthropic/claude-opus-5.5':'Claude Opus 5.5','openai/gpt-6-astra':'GPT-6 Astra'})[id]||'Choose your builder').replace(/^(?:Anthropic|OpenAI):\s*/i,'');
  const assetUrl = value => typeof value==='string'&&(/^(?:\/api\/launch-artwork\/)[a-zA-Z0-9-]+\/(thumbnail|coinIcon)\/image(?:\?hash=[a-f0-9]+)?$/.test(value)||/^https:\/\//.test(value))?value:'';
  function openLaunch(seed={}) {
    pendingSeed={...seed};
    if(window.location?.hash==='#/launch'&&state.mounted)return mount(state.host,pendingSeed);
    window.location.hash='#/launch';
  }
  async function mount(host,seed){
    clearTimeout(state.artTimer);body=host;state.host=host;state.mounted=true;state.step=1;state.artBusy=false;state.artError='';state.artwork=null;state.artKey=null;
    const initial=seed||pendingSeed||{};pendingSeed=null;state.draft={...initial};state.intent=null;const version=shell();
    body.innerHTML='<main class="rl-page"><h1>Launch a game-building agent</h1><p class="rl-loading" role="status">Preparing your launch</p></main>';
    try{
      const [config,catalog,metadata,builder,pool,artConfig]=await Promise.all([api('/api/solana/launches/config'),api('/api/builds/models'),api('/api/solana/metadata/config').catch(()=>({available:false})),api('/api/builds/config').catch(()=>null),api('/api/builds/pool').catch(()=>null),api('/api/launch-artwork/config').catch(()=>({available:false}))]);
      if(!active(version))return;
      state.config=config;network(config);state.metadata=metadata;state.builder=builder;state.pool=pool;state.artConfig=artConfig;
      state.draft.cluster=initial.cluster||config.defaultCluster||config.cluster;state.models=modelsAllowed.map(id=>(catalog.data||[]).find(m=>m.id===id)).filter(Boolean);state.aiConfigured=catalog.configured===true;
      state.draft.modelId=state.models.some(model=>model.id===initial.modelId)?initial.modelId:state.models[0]?.id||'';
      state.maxBudget=Number.isFinite(Number(builder?.maxAgentBudgetUsd))&&Number(builder.maxAgentBudgetUsd)>0?Math.min(25,Number(builder.maxAgentBudgetUsd)):0;
      state.draft.budgetUsd=state.maxBudget?Math.min(Number(initial.budgetUsd)||1,state.maxBudget):'';
      renderForm();
    }catch(error){if(active(version)){body.innerHTML='<main class="rl-page"><h1>Launch service unavailable</h1><p>'+esc(error.message)+'</p><button class="button" data-solana-retry>Try again</button></main>';body.querySelector('[data-solana-retry]')?.addEventListener('click',()=>mount(host,initial));}}
  }
  function unmountAccounts(){body?.querySelectorAll('[data-launch-roblox-account]').forEach(host=>window.RopadRobloxAccount?.unmount(host));}
  function unmount(){unmountAccounts();state.mounted=false;state.version++;state.artBusy=false;state.host=null;clearTimeout(state.artTimer);}
  function preview(){
    const d=state.draft,cover=assetUrl(state.artwork?.thumbnail?.url),icon=assetUrl(state.artwork?.coinIcon?.url);
    return `<aside class="rl-preview" aria-label="Your game preview"><span class="rl-kicker">YOUR GAME COIN</span><div class="rl-preview-cover">${cover?`<img src="${esc(cover)}" alt="AI-generated game cover"><span>Concept artwork</span>`:'<div class="rl-cover-placeholder"><span aria-hidden="true">↗</span><p>Your game starts here</p><small>Generate its first artwork from your idea</small></div>'}</div><div class="rl-preview-identity">${icon?`<img src="${esc(icon)}" alt="Generated coin icon">`:`<span class="rl-preview-icon" aria-hidden="true">${esc((d.name||'R').slice(0,1).toUpperCase())}</span>`}<div><h2 data-launch-preview-name>${esc(d.name||d.gameName||'Your game name')}</h2><span data-launch-preview-ticker>${d.ticker?'$'+esc(d.ticker.toUpperCase()):'$TICKER'}</span></div></div><p class="rl-preview-brief" data-launch-preview-brief>${esc(d.brief||'An original Roblox game, built by your AI agent')}</p><div class="rl-preview-meta"><span>Builder</span><strong>${esc(modelName(d.modelId))}</strong></div><div class="rl-preview-meta"><span>Network</span><strong>${d.cluster==='mainnet-beta'?'Solana mainnet':'Solana devnet · Test'}</strong></div><p class="rl-preview-note">One game, one agent, one coin</p></aside>`;
  }
  function frame(content){
    unmountAccounts();
    body.innerHTML=`<main class="rl-page"><a class="rl-back" href="#/">← Back to games</a><header class="rl-heading"><h1>Launch a game-building agent</h1><p>Give it an idea, choose its builder, and create its Solana coin</p></header><div class="rl-layout"><section class="rl-form-card"><nav class="rl-steps" aria-label="Launch progress">${['Your game','Your builder','Review'].map((label,index)=>`<span class="${state.step===index+1?'is-current':state.step>index+1?'is-complete':''}"${state.step===index+1?' aria-current="step"':''}><b>${state.step>index+1?'✓':index+1}</b>${label}</span>`).join('')}</nav><div class="rl-form-content">${content}</div></section>${preview()}</div></main>`;
  }
  function capture(form){const fields=Object.fromEntries(new FormData(form));if(fields.tokenImage&&!fields.tokenImage.size)delete fields.tokenImage;state.draft={...state.draft,...fields};}
  function captureBuilder(form){capture(form);for(const key of ['includeConcept','includeThumbnail','includeVisualReview']){const input=form.querySelector('[name="'+key+'"]');if(input)state.draft[key]=input.checked===true;}}
  function updatePreview(){
    const d=state.draft;for(const [selector,value] of [['[data-launch-preview-name]',d.name||'Your game name'],['[data-launch-preview-ticker]',d.ticker?'$'+d.ticker.toUpperCase():'$TICKER'],['[data-launch-preview-brief]',d.brief||'An original Roblox game, built by your AI agent']]){const node=body.querySelector(selector);if(node)node.textContent=value;}
  }
  function artState(){
    const artwork=state.artwork,generating=state.artBusy||['queued','generating'].includes(artwork?.status),kind=state.artTab==='coinIcon'?'coinIcon':'thumbnail',url=assetUrl(artwork?.[kind]?.url);
    const estimate=state.artConfig?.estimateUsd??state.artConfig?.estimatedCostUsd??state.artConfig?.maxEstimateUsd;
    const available=state.artConfig?.available===true||state.artConfig?.configured===true;
    return `<section class="rl-artwork"><div class="rl-section-title"><div><h3>Game artwork</h3><p>A game cover and matching coin icon</p></div><span class="rl-optional">Required for launch</span></div><div class="rl-art-tabs" role="tablist" aria-label="Artwork preview"><button type="button" role="tab" data-art-tab="thumbnail" aria-selected="${kind==='thumbnail'}">Game cover</button><button type="button" role="tab" data-art-tab="coinIcon" aria-selected="${kind==='coinIcon'}">Coin icon</button></div><div class="rl-art-preview ${url?"has-art":""} ${kind==='coinIcon'?'is-icon':''}">${url?`<img src="${esc(url)}" alt="Generated ${kind==='coinIcon'?'coin icon':'game cover'}">`:`<div><span aria-hidden="true">✧</span><p>${generating?'Creating your artwork':'Your idea, illustrated'}</p><small>${generating?'This can take a few minutes':'Generated images appear here'}</small></div>`}</div><button class="button rl-art-generate" type="button" data-launch-generate-art${generating||!available?' disabled':''}>${generating?'Generating artwork…':artwork?.status==='ready'?'Update artwork':'Generate artwork'}</button><p class="rl-help">${available?`Uses paid AI compute${Number.isFinite(Number(estimate))?' · Up to '+usd(estimate)+' estimated':''} · Requires creator wallet verification`:'Artwork generation is unavailable until the service is configured'}</p>${artwork&&['queued','generating','needs_review','failed'].includes(artwork.status)?`<button class="rl-text-button" type="button" data-launch-check-art>Check saved artwork</button>`:''}${state.artError?`<p class="rl-error" role="status">${esc(state.artError)}</p>`:''}</section>`;
  }
  function renderForm(){
    if(state.step===2)return renderBuilder();state.step=1;const d=state.draft;
    frame(`<h2>What do you want to build?</h2><p class="rl-intro">Describe an original Roblox game Your agent will use this as its brief</p><form id="r-solana-launch-form"><label>Game prompt<textarea name="brief" minlength="12" maxlength="2400" rows="5" required placeholder="A rooftop parkour game with timed runs, hidden shortcuts, collectible stars and a bright futuristic city">${esc(d.brief||'')}</textarea></label><div class="rl-pair"><label>Game / coin name<input name="name" minlength="2" maxlength="32" required value="${esc(d.name||d.gameName||'')}" placeholder="Skyline Circuit"></label><label>Coin symbol<input name="ticker" pattern="[A-Za-z][A-Za-z0-9]{1,9}" maxlength="10" required value="${esc(d.ticker||'')}" placeholder="SKY"></label></div><details class="rl-details"${d.inspiration||d.artDirection?' open':''}><summary>Add references and art direction <span>Optional</span></summary><label>Games you like<textarea name="inspiration" maxlength="1200" rows="2" placeholder="The mechanics you like and your original twist">${esc(d.inspiration||'')}</textarea></label><label>Art direction<input name="artDirection" maxlength="600" value="${esc(d.artDirection||'')}" placeholder="Soft sunlight, floating gardens, clean playful shapes"></label></details>${artState()}<details class="rl-details"><summary>Use your own artwork <span>Optional</span></summary><label>Upload token image<input name="tokenImage" type="file" accept="image/png,image/jpeg"></label>${d.tokenImage?.size?`<p class="rl-help">Selected: ${esc(d.tokenImage.name||'Token image')}</p>`:''}<label>Public image URL<input name="imageUrl" type="url" value="${esc(d.imageUrl||'')}" placeholder="https://…/icon.png"></label><label>Existing metadata URI<input name="metadataUri" type="url" value="${esc(d.metadataUri||'')}" placeholder="https://…/metadata.json"></label><p class="rl-help">An existing metadata URI overrides generated token artwork Public hosting is required for mainnet metadata</p></details><div class="rl-form-footer"><button class="rl-text-button" type="button" data-solana-saved>Resume saved launch</button><button class="button primary" type="submit"${state.artBusy?' disabled':''}>Choose builder →</button></div><p data-solana-feedback role="status"></p></form>`);
    const form=body.querySelector('form');
    form.oninput=()=>{capture(form);updatePreview();};
    form.onsubmit=event=>{event.preventDefault();capture(form);state.step=2;renderBuilder();};
    body.querySelector('[data-solana-saved]').onclick=showSaved;
    body.querySelector('[data-launch-generate-art]').onclick=async()=>{capture(form);if(form.reportValidity&&!form.reportValidity())return;await generateArtwork();};
    body.querySelector('[data-launch-check-art]')?.addEventListener('click',checkArtwork);
    body.querySelectorAll('[data-art-tab]').forEach(button=>button.onclick=()=>{capture(form);state.artTab=button.dataset.artTab;renderForm();});
  }
  function workerLabel(){
    if(!state.pool)return 'Studio availability will be checked when you start the builder';
    const workers=(state.pool.workers||[]).filter(worker=>worker.online===true&&worker.agentCompatible===true&&worker.dedicatedStudio===true&&worker.oneBuildPerStudio===true&&worker.agentProtocol===1&&(worker.planSchema==='scene-v1'||worker.planSchema==='scene-v2'&&worker.projectProtocol===1)&&Number.isFinite(worker.capabilitySeenAt)&&Date.now()-worker.capabilitySeenAt>=0&&Date.now()-worker.capabilitySeenAt<45000);
    const idle=workers.filter(worker=>worker.status==='idle'&&!worker.buildId).length;
    return idle?`${idle} compatible Studio worker${idle===1?'':'s'} reported idle · Rechecked when the build starts`:'No compatible idle Studio worker reported · Your game can wait for a worker';
  }
  function renderBuilder(){
    state.step=2;const d=state.draft,main=d.cluster==='mainnet-beta';
    frame(`<h2>Choose your builder</h2><p class="rl-intro">An advanced model to design and improve your Roblox game</p><form id="r-solana-launch-form"><fieldset class="rl-models"><legend class="rl-sr-only">Builder model</legend>${state.models.length?state.models.map(model=>`<label class="rl-model-card"><input type="radio" name="modelId" value="${esc(model.id)}" required${d.modelId===model.id?' checked':''}><img src="assets/model-logos/${model.id.startsWith('anthropic/')?'anthropic':'openai'}.svg" alt=""><span><strong>${esc(modelName(model.id))}</strong><small>${model.id.startsWith('anthropic/')?'Anthropic':'OpenAI'}</small></span><i aria-hidden="true"></i></label>`).join(''):'<p class="rl-error">Advanced builder models are currently unavailable</p>'}</fieldset><div class="rl-budget"><label>Initial AI spending limit <span>USD</span><input name="budgetUsd" type="number" min="0.01" max="${state.maxBudget||0}" step="0.01" value="${esc(d.budgetUsd)}"${state.maxBudget?' required':' disabled'}></label><p class="rl-help">${state.maxBudget?'Maximum '+usd(state.maxBudget)+' per run · You approve starting the builder after the coin is confirmed':'AI budget service is unavailable · Coin creation does not start a paid build'}</p></div><div class="rl-availability"><span aria-hidden="true">◷</span><p>${esc(workerLabel())}</p></div><div data-launch-roblox-account></div><details class="rl-details"><summary>Build options</summary><label class="rl-checkbox"><input type="checkbox" name="includeConcept"${d.includeConcept===false?'':' checked'}>Generate a visual target</label><label class="rl-checkbox"><input type="checkbox" name="includeThumbnail"${d.includeThumbnail===false||state.artwork?.thumbnail?'':' checked'}>Generate a game thumbnail${state.artwork?.thumbnail?' · Existing launch artwork can be used':''}</label><label class="rl-checkbox"><input type="checkbox" name="includeVisualReview"${d.includeVisualReview===false?'':' checked'}>Review Studio screenshots and improve once</label><p class="rl-help">These steps share the same spending limit Full gameplay review and Roblox publication stay with the creator</p></details><label>Launch network<select name="cluster"><option value="devnet"${main?'':' selected'}>Solana devnet · Test tokens</option><option value="mainnet-beta"${main?' selected':''}${state.config.mainnetAvailable?'':' disabled'}>Pump · Solana mainnet${state.config.mainnetAvailable?'':' · Not configured'}</option></select></label><p class="rl-network-note">${main?'Solana mainnet uses real SOL The next screen shows the exact transaction before approval':'Devnet is a test launch Test tokens have no monetary value or trading market'}</p><div class="rl-form-footer"><button class="rl-text-button" type="button" data-launch-back>← Your game</button><button class="button primary" type="submit"${state.models.length?'':' disabled'}>${state.wallet?'Review launch':'Connect wallet to continue'} →</button></div><p data-solana-feedback role="status"></p></form>`);
    window.RopadRobloxAccount?.mount(body.querySelector('[data-launch-roblox-account]'));
    const form=body.querySelector('form');
    const save=()=>captureBuilder(form);
    form.querySelector('[name="cluster"]').onchange=()=>{save();renderBuilder();};
    body.querySelector('[data-launch-back]').onclick=()=>{save();state.step=1;renderForm();};
    form.onsubmit=async event=>{event.preventDefault();save();if(!state.wallet){walletPicker();return;}await prepare(state.draft);};
  }
  async function generateArtwork(){
    if(state.artBusy)return;if(!state.wallet){walletPicker('Connect your creator wallet, then return to generate artwork');return;}
    const d=state.draft,version=state.version,identity=JSON.stringify([d.name,d.ticker,d.brief,d.inspiration,d.artDirection]);
    state.artBusy=true;state.artError='';renderForm();
    try{
      await authenticate();const owner=check().address,epoch=state.epoch;
      if(!active(version))return;
      if(!state.artKey||state.artKey.identity!==identity||state.artwork?.status==='ready')state.artKey={identity,key:crypto.randomUUID()};
      state.artwork=null;delete state.draft.artworkId;
      const result=await api('/api/launch-artwork',{name:d.name,ticker:d.ticker,brief:d.brief,inspiration:d.inspiration||'',artDirection:d.artDirection||'',idempotencyKey:state.artKey.key});
      check(owner);if(epoch!==state.epoch||!active(version))return;
      state.artwork=result.artwork||null;if(state.artwork?.id)state.draft.artworkId=state.artwork.id;
      if(!state.artwork)throw Error('Artwork service returned no saved record');
      if(['failed','needs_review'].includes(state.artwork.status))state.artError=state.artwork.error?.message||state.artwork.error||'Artwork needs review before retrying';
    }catch(error){if(active(version))state.artError=error.message+' Check saved artwork before another generation if the request was interrupted';}
    finally{if(active(version)){state.artBusy=false;renderForm();scheduleArtwork();}}
  }
  function scheduleArtwork(){clearTimeout(state.artTimer);if(state.mounted&&['queued','generating'].includes(state.artwork?.status))state.artTimer=setTimeout(()=>checkArtwork(true),5000);}
  async function checkArtwork(automatic=false){
    if(!state.artwork?.id||state.artBusy)return;const version=state.version;state.artBusy=true;state.artError='';
    try{if(automatic!==true)await authenticate();const owner=check().address,epoch=state.epoch,result=await api('/api/launch-artwork/'+encodeURIComponent(state.artwork.id));check(owner);if(epoch!==state.epoch||!active(version))return;state.artwork=result.artwork||state.artwork;if(['failed','needs_review'].includes(state.artwork.status))state.artError=state.artwork.error?.message||state.artwork.error||'Artwork requires review';}
    catch(error){if(active(version))state.artError=error.message;}finally{if(active(version)){state.artBusy=false;if(state.step===1)renderForm();if(!state.artError)scheduleArtwork();}}
  }

  async function prepare(input){
    const version=state.version,button=body.querySelector('button[type="submit"]');if(button)button.disabled=true;
    try{
      if(!input.launchId&&!(state.artwork?.status==='ready'&&assetUrl(state.artwork?.thumbnail?.url)&&assetUrl(state.artwork?.coinIcon?.url)))throw Error('Generate your game cover and coin icon in Your game before reviewing this launch');
      feedback('Verify your creator wallet, then review the exact transaction');await authenticate();const owner=check().address,request={...input,cluster:input.cluster||state.draft.cluster||state.config.cluster};
      if(request.cluster==='mainnet-beta'&&!request.launchId&&!request.metadataUri&&!request.artworkId){
        const image=request.tokenImage,art={name:request.name,symbol:request.ticker,description:request.brief,imageUrl:request.imageUrl};
        if(image?.size){if(image.size>2*1024*1024)throw Error('Choose a PNG or JPEG image smaller than 2 MB');art.imageBase64=base64(new Uint8Array(await image.arrayBuffer()));art.contentType=image.type;delete art.imageUrl;}
        const saved=await api('/api/solana/metadata',art);request.metadataUri=saved.metadataUri;state.draft.metadataUri=saved.metadataUri;
      }
      delete request.tokenImage;delete request.imageUrl;
      const intent=network(await api('/api/solana/launches/prepare',request));check(owner);if(intent.owner&&intent.owner!==owner)throw Error('The launch belongs to a different wallet');if(intent.cluster!==request.cluster)throw Error('The launch network changed; review a new quote');if(!active(version))return;state.intent=intent;renderQuote(intent);
    }catch(error){feedback(error.message,true);}finally{if(button?.isConnected)button.disabled=false;}
  }
  function renderQuote(intent){
    if(intent.status==='confirmed')return renderConfirmed(intent);
    const main=isMainnet(intent),prepared=intent.status==='prepared'&&typeof intent.transactionBase64==='string',money=value=>sol(value,intent.cluster);
    body.innerHTML='<div class="r-solana-launch"><span class="r-solana-network">'+(main?'PUMP / SOLANA MAINNET':'SOLANA DEVNET')+' / '+(prepared?'TRANSACTION REVIEW':'SAVED LAUNCH')+'</span><h2>'+ (prepared?(main?'Review your mainnet launch':'Review your test SOL transaction'):'Your launch is saved')+'</h2><p>'+esc(intent.mission?.name||state.draft.name||'Game coin')+' '+(intent.mission?.ticker?'· $'+esc(intent.mission.ticker):'')+'</p><div class="r-solana-quote-total"><span>ESTIMATED TOTAL REQUIRED</span><strong>'+money(intent.totalRequiredLamports)+'</strong></div><dl class="r-solana-quote"><div><dt>'+ (main?'Initial purchase':'Deposit')+'</dt><dd>'+money(intent.fundingLamports)+'</dd></div><div><dt>Account creation / rent</dt><dd>'+money(intent.rentLamports)+'</dd></div><div><dt>Estimated network fee</dt><dd>'+money(intent.estimatedNetworkFeeLamports)+'</dd></div><div><dt>Network</dt><dd>'+ (main?'Solana mainnet · Real SOL':'Solana devnet')+'</dd></div><div><dt>Mint</dt><dd><code>'+esc(intent.mint||'Pending')+'</code></dd></div><div><dt>Creator</dt><dd><code>'+esc(intent.owner||check().address)+'</code></dd></div>'+ (main?'<div><dt>Metadata</dt><dd><code>'+esc(intent.metadataUri||state.draft.metadataUri||'Verified by server')+'</code></dd></div>':'')+'</dl><p class="r-solana-note">'+ (main?'Your wallet signs this reviewed Pump coin creation transaction on mainnet It spends real SOL on account creation and network fees There is no bundled buy, platform-token purchase or automatic AI charge':'Your wallet approves only this test transaction The server verifies it on devnet before linking the coin to your game No trading market or AI build starts automatically')+'</p><div class="r-solana-actions">'+ (prepared?'<button class="button primary" data-solana-approve>'+ (main?'Approve mainnet launch in wallet':'Approve test SOL launch in wallet')+' ↗</button>':'<button class="button primary" data-solana-status>Check saved launch ↻</button>')+'<button class="button" data-solana-edit>'+ (prepared?'Back to game brief':'Open saved launches')+'</button></div>'+ (main?'':'<a class="b-text-button" href="https://faucet.solana.com/" target="_blank" rel="noopener">Get free test SOL ↗</a>')+'<p data-solana-feedback role="status"></p></div>';
    state.step=3;const quote=body.innerHTML;frame(quote+`<section class="rl-review-builder"><h3>Your builder</h3><div><span>Model</span><strong>${esc(modelName(state.draft.modelId))}</strong></div><div><span>Initial AI limit</span><strong>${state.maxBudget?usd(state.draft.budgetUsd):'Set in workspace'}</strong></div><p>The AI limit is separate from this SOL transaction Starting the builder requires a separate action and available provider funding Your game publishes to your own Roblox account or group after review</p></section>`);
    body.querySelector('[data-solana-approve]')?.addEventListener('click',()=>submit(intent));const statusButton=body.querySelector('[data-solana-status]');if(statusButton)statusButton.onclick=['failed','expired'].includes(intent.status)&&intent.launchId?()=>prepare({launchId:intent.launchId,cluster:intent.cluster}):()=>status(intent);body.querySelector('[data-solana-edit]').onclick=prepared?renderBuilder:showSaved;
    if(['failed','expired'].includes(intent.status)&&intent.launchId){body.querySelector('[data-solana-status]').textContent='Prepare a fresh quote ↗';feedback('The previous quote '+intent.status+' Review a fresh quote before another wallet approval',true);}
    if(intent.status==='submission_unknown')feedback('The submission outcome is unknown Check the saved launch before approving anything again',true);
  }
  async function submit(intent){
    const version=state.version,button=body.querySelector('[data-solana-approve]');button.disabled=true;let submissionAttempted=false;
    try{
      network(intent);await authenticate();if(!active(version))return;const wallet=check(intent.owner),epoch=state.epoch,lib=window.solanaWeb3;
      if(typeof wallet.provider.signTransaction!=='function'||!lib?.Transaction)throw Error('A desktop Solana wallet and transaction library are required');
      const versioned=intent.transactionVersion==='v0',transaction=versioned?lib.VersionedTransaction.deserialize(unbase64(intent.transactionBase64)):lib.Transaction.from(unbase64(intent.transactionBase64));
      const payer=versioned?transaction.message.staticAccountKeys[0]?.toString():transaction.feePayer?.toString();if(payer!==wallet.address)throw Error('The transaction fee payer does not match the connected creator');
      feedback('Review the '+(isMainnet(intent)?'mainnet':'devnet')+' transaction in '+wallet.name);const signed=await wallet.provider.signTransaction(transaction);check(wallet.address);if(epoch!==state.epoch)throw Error('Wallet changed before submission');
      const signedTransactionBase64=base64(signed.serialize());submissionAttempted=true;feedback('Submitting the signed transaction to Solana '+(isMainnet(intent)?'mainnet':'devnet'));
      const result=network(await api('/api/solana/launches/submit',{intentId:intent.intentId,signedTransactionBase64}));if(active(version)){state.intent=result;renderQuote(result);}
    }catch(error){if(active(version)){if(submissionAttempted){state.intent={...intent,status:'submission_unknown'};renderQuote(state.intent);feedback(error.message+' Check the saved launch before another wallet approval',true);}else feedback(error.message,true);}}finally{if(button.isConnected)button.disabled=false;}
  }
  async function status(intent){const version=state.version;try{feedback('Checking the saved transaction');await authenticate();if(intent.owner)check(intent.owner);if(!active(version))return;const result=network(await api('/api/solana/launches/status',{intentId:intent.intentId,launchId:intent.launchId}));if(active(version)){state.intent=result;renderQuote(result);}}catch(error){if(active(version))feedback(error.message,true);}}
  function renderConfirmed(result){
    const main=isMainnet(result),id=result.buildSession?.id,url=result.mint?'https://explorer.solana.com/address/'+encodeURIComponent(result.mint)+(main?'':'?cluster=devnet'):'';
    body.innerHTML='<div class="r-solana-launch"><span class="r-solana-network">VERIFIED / '+(main?'PUMP MAINNET':'SOLANA DEVNET')+'</span><h2>Your game coin is confirmed</h2><p>'+ (id?'The verified coin is linked to its Roblox builder workspace':'Your coin is confirmed Workspace linking is still pending')+'</p><dl class="r-solana-quote"><div><dt>Token mint</dt><dd><code>'+esc(result.mint||'Unavailable')+'</code></dd></div><div><dt>Trading</dt><dd>'+ (main?'Pump bonding curve':'No market or liquidity pool')+'</dd></div></dl><div class="r-solana-actions">'+ (id?'<a class="button primary" data-solana-open-build href="#/token/'+encodeURIComponent(id)+'">Open game coin ↗</a>':'')+(url?'<a class="button" href="'+url+'" target="_blank" rel="noopener">View '+(main?'mainnet':'devnet')+' token ↗</a>':'')+'</div><p class="r-solana-note">'+ (main?'Your game still needs its AI build, Studio playtest and creator publication':'This is a test coin with no monetary value Generate your advanced AI plan and review it before starting a Studio worker')+'</p></div>';
    state.step=3;const confirmation=body.innerHTML;frame(confirmation+(id?`<section class="rl-review-builder"><h3>Ready for your builder</h3><p>Start a bounded AI build with a ${state.maxBudget?usd(state.draft.budgetUsd):'reviewed'} spending limit This spends available AI allowance and may wait for a compatible Studio worker</p><button class="button primary" data-launch-start-builder${state.maxBudget&&state.builder?.autonomousBuilds===true?'':' disabled'}>Start builder →</button><p data-solana-feedback role="status"></p><a class="rl-text-button" href="#/workspace/${encodeURIComponent(id)}">Open creator workspace</a></section>`:'<div class="r-solana-launch"><p>'+esc(result.buildError||'The game workspace is still being linked')+'</p><button class="button" data-solana-recover-build>Recover confirmed workspace ↻</button><p data-solana-feedback role="status"></p></div>'));
    if(!id)body.querySelector('[data-solana-recover-build]').onclick=()=>status(result);
    body.querySelector('[data-launch-start-builder]')?.addEventListener('click',()=>startBuilder(id));window.ParallaxBuilders?.refresh();
  }
  async function startBuilder(id){
    const button=body.querySelector('[data-launch-start-builder]'),version=state.version;if(button)button.disabled=true;
    try{await authenticate();const owner=check().address,epoch=state.epoch;const [config,current]=await Promise.all([api('/api/builds/config'),api('/api/builds/'+encodeURIComponent(id)+'/agent')]);check(owner);if(!active(version)||epoch!==state.epoch)return;
      if(current.build?.canManage!==true)throw Error('Verify this project’s creator wallet before starting the builder');
      if(config.autonomousBuilds!==true)throw Error('The builder service is not available');
      if(current.agent||current.build?.agent)throw Error('This game already has a saved build run Open its workspace to review or resume it');
      const cap=Number(state.draft.budgetUsd);if(!Number.isFinite(cap)||cap<=0||cap>Number(config.maxAgentBudgetUsd))throw Error('The reviewed AI limit is no longer available Set a budget in your workspace');
      feedback('Starting your builder');await api('/api/builds/'+encodeURIComponent(id)+'/agent/start',{budgetUsd:cap,includeConcept:state.draft.includeConcept!==false,includeThumbnail:state.draft.includeThumbnail!==false&&!state.artwork?.thumbnail,includeVisualReview:state.draft.includeVisualReview!==false});check(owner);if(!active(version)||epoch!==state.epoch)return;window.location.hash='#/workspace/'+encodeURIComponent(id);
    }catch(error){if(active(version))feedback(error.message,true);}finally{if(button?.isConnected)button.disabled=false;}
  }
  async function showSaved(){
    if(!state.wallet){walletPicker();return;}const version=state.version;try{await authenticate();const owner=check().address,epoch=state.epoch,result=await api('/api/solana/launches'),records=Array.isArray(result.data)?result.data:[];check(owner);if(!active(version)||epoch!==state.epoch)return;
      body.innerHTML='<div class="r-solana-launch"><span class="r-solana-network">YOUR SOLANA LAUNCHES</span><h2>Pick up where you left off</h2><div class="r-solana-saved">'+ (records.length?records.map((r,i)=>'<button class="r-solana-saved-row" data-solana-record="'+i+'"><span><strong>'+esc(r.mission?.name||'Game coin')+'</strong><small>'+esc(r.cluster+' · '+r.status)+'</small></span><b>Inspect ↗</b></button>').join(''):'<p>No saved launches for this wallet</p>')+'</div><button class="button" data-solana-new>New game coin ↗</button><p data-solana-feedback role="status"></p></div>';
      frame(body.innerHTML);body.querySelectorAll('[data-solana-record]').forEach(button=>button.onclick=()=>{const r=records[Number(button.dataset.solanaRecord)];if(r.intentId)status(r);else prepare({launchId:r.launchId||r.id,cluster:r.cluster});});body.querySelector('[data-solana-new]').onclick=()=>{state.step=1;renderForm();};
    }catch(error){feedback(error.message,true);}
  }
  window.RopadLaunchPage={mount,unmount};
  window.RopadSolana={get:()=>state.wallet,connect,authenticate,check,whenInvalidated:()=>state.invalidating,refreshLabel:dispatch};
  window.openBuilderWallet=()=>walletPicker();window.openWallet=()=>walletPicker();window.openRobloxLaunch=openLaunch;window.openLaunch=openLaunch;
})();

(() => {
  const state={config:null,session:{authenticated:false,address:null},agents:[],active:null,player:null,timer:null,routeVersion:0,requesting:false,walletAddress:connectedWallet?.address||null,authInvalidation:Promise.resolve(),pending:new Map()};
  const short=value=>value?value.slice(0,6)+'…'+value.slice(-5):'—';
  const usd=value=>'$'+Number(value||0).toFixed(4);
  const html=escapeHtml;
  const explorer=(value,type='address')=>'https://explorer.solana.com/'+type+'/'+encodeURIComponent(value)+'?cluster=devnet';
  const asBase64=bytes=>{let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);};
  const fromBase64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  const statusName=value=>({draft:'Awaiting launch',active:'Observing',paused:'Paused',budget_exhausted:'Allowance used',pending:'Confirming launch'})[value]||value||'Awaiting launch';
  async function api(path,body){
    const options={credentials:'same-origin',headers:{}};
    if(body!==undefined){
      const response=await fetch('/api/status',{credentials:'same-origin'});
      if(!response.ok)throw new Error('The local server is unavailable');
      const status=await response.json();
      options.method='POST';options.headers={'Content-Type':'application/json','X-Parallax-Token':status.csrf};options.body=JSON.stringify(body);
    }
    const response=await fetch(path,options);let result;try{result=await response.json();}catch{throw new Error('The server returned an unreadable response');}
    if(!response.ok){const error=new Error(result.error||result.message||'The request could not be completed');error.status=response.status;throw error;}return result;
  }
  async function config(){if(!state.config)state.config=await api('/api/devnet/config');if(state.config.cluster!=='devnet')throw new Error('This launch flow only supports Solana devnet');return state.config;}
  function missionFrom(response){return response.mission||response;}
  function currentCamera(id){return cameraDirectory.data.find(c=>c.id===id)||liveState.cameras.find(c=>c.id===id);}
  async function cameraFor(id){let camera=currentCamera(id);if(camera)return camera;const list=await api('/api/camera-catalog');return list.data.find(c=>c.id===id);}
  function messageFor(error){return error?.code===4001||/reject|cancel|declin/i.test(error?.message||'')?'Wallet approval cancelled Your saved mission can be resumed when you are ready':error?.message||'Something went wrong Please try again';}
  async function authenticate(){
    await state.authInvalidation;
    if(!connectedWallet)throw new Error('Connect Phantom or Solflare to continue');
    const wallet=connectedWallet,address=wallet.address;
    state.session=await api('/api/auth/session');
    if(state.session.authenticated&&state.session.address===address)return;
    if(typeof wallet.provider.signMessage!=='function')throw new Error('This wallet does not support message signing Open this site in Phantom or Solflare');
    const challenge=await api('/api/auth/challenge',{address});
    const signed=await wallet.provider.signMessage(new TextEncoder().encode(challenge.message),'utf8');
    if(connectedWallet?.address!==address)throw new Error('Your wallet account changed Sign in with the intended account');
    const signature=signed.signature||signed;
    state.session=await api('/api/auth/verify',{id:challenge.id,signatureBase64:asBase64(signature)});
    if(!state.session.authenticated||state.session.address!==address)throw new Error('Wallet sign-in could not be verified');
    refreshAgents();
  }
  const agentSection=document.createElement('section');agentSection.className='devnet-agents';agentSection.id='my-agents';
  agentSection.innerHTML='<div class="section-heading"><div><span class="eyebrow">SOLANA DEVNET / YOUR MISSIONS</span><h2>Give an agent a place to watch</h2></div><button class="button" id="agent-sign-in">Connect wallet</button></div><div id="saved-agents"><p class="devnet-empty">Connect your wallet to find your saved agents and launch a test coin</p></div><p class="devnet-footnote">Test SOL and test tokens have no monetary value · AI uses a sponsored AI allowance while this local server is running</p>';
  document.querySelector('#explore').before(agentSection);
  const agentPage=document.createElement('section');agentPage.id='devnet-agent-page';document.querySelector('main').append(agentPage);
  const nav=document.createElement('button');nav.className='nav-link';nav.id='agents-nav';nav.textContent='My agents';document.querySelector('#models-nav').after(nav);
  nav.onclick=()=>{leaveAgent();exitToken();showHome();history.pushState(null,'','#my-agents');agentSection.scrollIntoView({behavior:'smooth'});refreshAgents();};
  document.querySelector('#agent-sign-in').onclick=async()=>{if(!connectedWallet){openWallet();return;}const button=document.querySelector('#agent-sign-in');button.disabled=true;try{await authenticate();await refreshAgents();}catch(error){document.querySelector('#saved-agents').innerHTML='<p class="devnet-error">'+html(messageFor(error))+'</p>';}finally{button.disabled=false;}};
  async function refreshAgents(){
    try{
      state.session=await api('/api/auth/session');
      const button=document.querySelector('#agent-sign-in');button.textContent=state.session.authenticated?'Refresh agents':connectedWallet?'Sign in with wallet':'Connect wallet';
      const payload=await api('/api/missions');state.agents=payload.data||[];
      const mine=state.agents.filter(m=>m.mine||(state.session.authenticated&&m.owner===state.session.address));
      document.querySelector('#saved-agents').innerHTML=mine.length?'<div class="saved-agent-grid">'+mine.map(m=>'<button class="saved-agent" data-saved-agent="'+html(m.id)+'"><span class="saved-agent-avatar">'+html(m.name[0].toUpperCase())+'</span><span><b>$'+html(m.ticker)+' <em>'+html(m.name)+'</em></b><small>'+html(statusName(m.status))+' · '+html(m.modelId)+'</small><small>'+usd(m.remainingUsd)+' sponsored compute remaining</small></span><span>↗</span></button>').join(''):'<p class="devnet-empty">'+(state.session.authenticated?'No saved agents yet Choose a camera and launch your first devnet mission':'Connect and sign in with your wallet to see your saved agents')+'</p>';
      document.querySelectorAll('[data-saved-agent]').forEach(button=>button.onclick=()=>openAgent(button.dataset.savedAgent));
    }catch(error){document.querySelector('#saved-agents').innerHTML='<p class="devnet-empty">Agent service unavailable · '+html(messageFor(error))+'</p>';}
  }
  window.addEventListener('parallax-wallet-change',event=>{
    const address=event.detail.address;
    if(address!==state.walletAddress){
      state.walletAddress=address;state.session={authenticated:false,address:null};
      state.authInvalidation=state.authInvalidation.catch(()=>{}).then(()=>api('/api/auth/logout',{})).catch(()=>{});
      state.authInvalidation.then(()=>{refreshAgents();if(state.active)refreshActive();});
    }
    const review=document.querySelector('#devnet-launch-approve');if(review&&!state.requesting)review.textContent=address?'Approve devnet launch':'Connect wallet to continue';
  });
  openLaunch=function(seed={}){
    const name=seed?.name||'',ticker=seed?.ticker||'',brief=seed?.brief||'';
    const body=document.querySelector('#launch-body');
    body.innerHTML='<span class="devnet-chip">SOLANA DEVNET · TEST COINS</span><h2>Give your coin a mission</h2><p>Choose a camera and an AI model Your agent keeps its observations with the source evidence</p><form id="launch-form"><div class="form-grid"><label>Coin name<input name="name" required minlength="2" maxlength="40" placeholder="e.g. Freightwatch" value="'+html(name)+'"></label><label>Ticker<input name="ticker" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" maxlength="10" placeholder="e.g. WATCH" value="'+html(ticker)+'"><small>2–10 letters or numbers, starting with a letter</small></label><label class="full">Monitoring mission<textarea name="brief" required minlength="12" maxlength="500" placeholder="Observe road obstructions, visible smoke and changing traffic conditions">'+html(brief)+'</textarea></label><label>Camera region<select name="region">'+regions.map(r=>'<option value="'+r.id+'"'+(r.id===(seed?.region||selectedRegion)?' selected':'')+'>'+html(r.name)+'</option>').join('')+'</select></label><label>Observation frequency<select name="interval"><option value="5">Every 5 minutes</option><option value="15">Every 15 minutes</option><option value="30">Every 30 minutes</option></select></label><label>Number of cameras<input name="cameras" type="number" value="1"></label><div class="launch-allowance"><span>SPONSORED COMPUTE</span><b>$0.10</b><small>Real AI credits after a 0.01 test SOL deposit</small></div></div><div class="estimate"><div><span>OBSERVATIONS / DAY</span><b id="estimate-obs">—</b></div><div><span>TOKEN COST / DAY</span><b id="estimate-day">—</b></div><div><span>NETWORK</span><b>Devnet</b></div></div><small class="estimate-assumptions">Estimate uses 1,500 input + 250 output tokens per observation Image and provider charges may differ Actual usage debits the sponsored allowance and the shared $1 daily guard Test SOL has no monetary value and is not converted into dollars</small><div class="form-footer"><span>Review everything before your wallet signs</span><button class="button primary" type="submit">Review devnet launch ↗</button></div><div class="error-text" id="form-error" role="alert"></div></form>';
    document.querySelector('#launch-dialog .eyebrow').textContent='MISSION CONTROL / DEVNET LAUNCH';
    document.querySelector('#launch-dialog').showModal();const form=document.querySelector('#launch-form');
    window.initLaunchModels(form,{...seed,modelId:seed?.modelId||liveState.status?.defaultModel||'google/gemma-3-4b-it'});window.initLaunchCamera(form,seed);
    if(seed?.intervalMinutes&&[...form.elements.interval.options].some(o=>Number(o.value)===Number(seed.intervalMinutes)))form.elements.interval.value=String(seed.intervalMinutes);
    form.querySelector('#selected-model').onclick=()=>{document.querySelector('#picker-search').value='';document.querySelector('#picker-filter').value='vision';pickerLimit=30;renderPicker();picker.showModal();};
    function update(){const obs=1440/Number(form.elements.interval.value),day=window.modelDailyEstimate(form,obs);document.querySelector('#estimate-obs').textContent=Math.round(obs).toLocaleString();document.querySelector('#estimate-day').textContent=Number.isFinite(day)?'$'+day.toFixed(4):'Variable';}
    form.addEventListener('input',update);update();
    form.onsubmit=async event=>{
      event.preventDefault();if(!window.validateLaunchCamera(form))return;
      const model=catalog.data.find(m=>m.id===form.elements.modelId.value);
      if(!model||!canSee(model)||!isAgentModel(model)){document.querySelector('#form-error').textContent='Choose a model with image input and text output for this camera mission';return;}
      const mission={name:form.elements.name.value.trim(),ticker:form.elements.ticker.value.trim().toUpperCase(),brief:form.elements.brief.value.trim(),cameraId:form.elements.cameraId.value,modelId:model.id,intervalMinutes:Number(form.elements.interval.value)};
      if(mission.name.length<2||mission.brief.length<12){document.querySelector('#form-error').textContent='Add a name and a monitoring mission of at least 12 characters';return;}
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;
      try{await config();showLaunchReview(mission,form.selectedCamera);}catch(error){document.querySelector('#form-error').textContent=messageFor(error);}finally{submit.disabled=false;}
    };
  };
  function showLaunchReview(input,camera,savedMission=null){
    const c=state.config,model=catalog.data.find(m=>m.id===input.modelId),deposit=Number(c.fundingLamports||10000000)/1e9;
    let mission=savedMission;
    document.querySelector('#launch-body').innerHTML='<span class="devnet-chip">REVIEW / SOLANA DEVNET</span><h2>Your agent is ready for a test flight</h2><p>Use a browser with Phantom or Solflare installed Enable testnet mode and select Solana devnet Then approve a sign-in message and review one devnet transaction</p><div class="devnet-review-identity"><span class="saved-agent-avatar">'+html(input.name[0].toUpperCase())+'</span><div><h3>'+html(input.name)+' <span>$'+html(input.ticker)+'</span></h3><p>'+html(input.brief)+'</p></div></div><dl class="devnet-review-grid"><div><dt>Camera</dt><dd>'+html(camera?.name||input.cameraId)+'</dd></div><div><dt>AI model</dt><dd>'+html(model?modelName(model):input.modelId)+'</dd></div><div><dt>Frequency</dt><dd>Every '+input.intervalMinutes+' minutes</dd></div><div><dt>Test token supply</dt><dd>'+Number(c.supply||1000000).toLocaleString()+' · '+Number(c.decimals||6)+' decimals</dd></div><div><dt>Test SOL deposit</dt><dd>'+deposit+' test SOL <small>Plus network fees and account rent</small></dd></div><div><dt>Sponsored AI allowance</dt><dd>$'+Number(c.allowanceUsd||.1).toFixed(2)+' <small>Real AI compute · shared $1/day guard</small></dd></div></dl><div class="devnet-destination"><span>DEVNET DEPOSIT ADDRESS</span><a href="'+explorer(c.depositAddress)+'" target="_blank" rel="noopener">'+html(c.depositAddress)+'</a></div><div class="dialog-note">Test SOL and this token have no monetary value No trading pool or trading fees are created Your selected camera and mission will run while the local server is on</div><div class="devnet-review-actions"><button class="button" id="devnet-review-back">Edit mission</button><button class="button primary" id="devnet-launch-approve">'+(connectedWallet?'Approve devnet launch':'Connect wallet to continue')+'</button></div><a class="devnet-faucet" href="https://faucet.solana.com/" target="_blank" rel="noopener">Need test SOL? Open the Solana faucet ↗</a><div id="devnet-launch-progress" class="devnet-progress" role="status"></div><div id="devnet-launch-error" class="error-text" role="alert"></div>';
    document.querySelector('#devnet-review-back').onclick=()=>openLaunch({...input,region:camera?.region});
    document.querySelector('#devnet-launch-approve').onclick=async()=>{
      if(!connectedWallet){openWallet();return;}
      if(state.requesting)return;
      state.requesting=true;const button=document.querySelector('#devnet-launch-approve'),back=document.querySelector('#devnet-review-back');button.disabled=true;back.disabled=true;
      const progress=value=>{const element=document.querySelector('#devnet-launch-progress');if(element)element.textContent=value;};
      document.querySelector('#devnet-launch-error').textContent='';
      try{
        progress('1 / 4 · Approve the sign-in message in your wallet');await authenticate();
        progress('2 / 4 · Saving the camera, model and mission');if(!mission)mission=missionFrom(await api('/api/missions',input));
        progress('3 / 4 · Preparing your devnet transaction');
        const result=await launchSavedMission(mission,progress);
        if(result.status==='pending')state.pending.set(mission.id,result);else state.pending.delete(mission.id);
        mission=result.mission||mission;
        document.querySelector('#launch-dialog').close();openAgent(mission.id);
      }catch(error){
        progress(mission?'Mission saved · You can safely retry this launch':'');
        const errorBox=document.querySelector('#devnet-launch-error');if(errorBox)errorBox.textContent=messageFor(error);
        button.textContent=mission?'Resume devnet launch':'Try again';
        if(mission&&!document.querySelector('#open-saved-agent')){const view=document.createElement('button');view.className='text-button';view.id='open-saved-agent';view.textContent='Open saved mission';view.onclick=()=>{document.querySelector('#launch-dialog').close();openAgent(mission.id);};errorBox.after(view);}
      }finally{state.requesting=false;button.disabled=false;back.disabled=false;refreshAgents();}
    };
  }
  async function launchSavedMission(mission,progress){
    const wallet=connectedWallet;if(!wallet)throw new Error('Connect your wallet to launch this mission');const signingAddress=wallet.address;
    const intent=await api('/api/missions/'+encodeURIComponent(mission.id)+'/prepare',{});
    if(intent.status==='confirmed'||intent.status==='pending'||!intent.transactionBase64){
      if(!intent.intentId)throw new Error('No recoverable launch transaction was returned');
      progress('4 / 4 · Checking the existing transaction on devnet');
      return api('/api/missions/'+encodeURIComponent(mission.id)+'/confirm',{intentId:intent.intentId});
    }
    if(!window.solanaWeb3?.Transaction)throw new Error('The Solana transaction library is unavailable Refresh the page and try again');
    if(typeof wallet.provider.signTransaction!=='function')throw new Error('Your wallet cannot sign transactions here Use its browser extension or in-app browser');
    if(connectedWallet?.address!==mission.owner)throw new Error('Connect the wallet that owns this mission');
    const transaction=solanaWeb3.Transaction.from(fromBase64(intent.transactionBase64));
    progress('3 / 4 · Review the exact test SOL total below');
    await reviewTransactionQuote(intent);
    if(connectedWallet?.address!==signingAddress)throw new Error('Wallet account changed Review this launch with the mission owner');
    progress('3 / 4 · Approve the devnet transaction in '+wallet.config.name);
    const signed=await wallet.provider.signTransaction(transaction);
    if(connectedWallet?.address!==signingAddress)throw new Error('Wallet account changed before submission Reconnect the mission owner');
    progress('4 / 4 · Submitting the signed transaction to Solana devnet');
    return api('/api/missions/'+encodeURIComponent(mission.id)+'/submit',{intentId:intent.intentId,signedTransactionBase64:asBase64(signed.serialize())});
  }
  function reviewTransactionQuote(intent){
    return new Promise((resolve,reject)=>{
      const dialog=document.querySelector('#launch-dialog');
      if(!dialog.open){reject(new Error('Launch review was closed Open the saved mission to resume'));return;}
      document.querySelector('#devnet-transaction-quote')?.remove();
      const format=value=>(Number(value)/1e9).toFixed(8).replace(/0+$/,'').replace(/\.$/,'')+' test SOL';
      const quote=document.createElement('section');quote.id='devnet-transaction-quote';quote.className='devnet-transaction-quote';
      quote.innerHTML='<span class="eyebrow">EXACT TRANSACTION / DEVNET ONLY</span><h3>'+format(intent.totalRequiredLamports)+'</h3><dl><div><dt>Compute activation deposit</dt><dd>'+format(intent.fundingLamports)+'</dd></div><div><dt>Mint + token account rent</dt><dd>'+format(intent.rentLamports)+'</dd></div><div><dt>Estimated network fee</dt><dd>'+format(intent.estimatedNetworkFeeLamports)+'</dd></div></dl><p>Creates 1,000,000 test tokens in your wallet Mint authority is revoked after issuance The quoted transaction expires shortly if it is not signed</p><div><button class="button" id="devnet-quote-cancel">Not now</button><button class="button primary" id="devnet-quote-approve">Sign this devnet transaction ↗</button></div>';
      document.querySelector('#devnet-launch-progress').after(quote);
      const close=()=>{cleanup();reject(new Error('Launch review cancelled Your mission is saved'));};
      const cleanup=()=>{dialog.removeEventListener('close',close);quote.remove();};
      dialog.addEventListener('close',close,{once:true});
      quote.querySelector('#devnet-quote-cancel').onclick=close;
      quote.querySelector('#devnet-quote-approve').onclick=()=>{cleanup();resolve();};
      quote.scrollIntoView({behavior:'smooth',block:'nearest'});quote.querySelector('#devnet-quote-approve').focus();
    });
  }
  function leaveAgent(){state.routeVersion++;state.player?.destroy();state.player=null;clearInterval(state.timer);state.timer=null;state.active=null;document.body.classList.remove('devnet-mode');}
  async function openAgent(id,changeUrl=true){
    leaveAgent();const version=state.routeVersion;exitToken();showHome();cameraDirectory.players.forEach(p=>p.destroy());cameraDirectory.players=[];
    document.body.classList.add('devnet-mode');if(changeUrl&&location.hash!=='#/agent/'+id)history.pushState(null,'','#/agent/'+id);window.scrollTo({top:0,behavior:'instant'});
    agentPage.innerHTML='<button class="token-back" id="agent-back">← My agents</button><div class="devnet-empty">Loading your camera agent</div>';document.querySelector('#agent-back').onclick=goToAgents;
    try{
      const response=await api('/api/missions/'+encodeURIComponent(id));if(version!==state.routeVersion)return;
      const mission=missionFrom(response);mission.reports=response.reports||mission.reports||[];state.active=mission;
      let camera=null;try{camera=await cameraFor(mission.cameraId);}catch{}if(version!==state.routeVersion)return;
      renderAgent(mission,camera);state.timer=setInterval(refreshActive,10000);
    }catch(error){if(version===state.routeVersion)agentPage.innerHTML='<button class="token-back" id="agent-back">← My agents</button><h2>Agent unavailable</h2><p>'+html(messageFor(error))+'</p>';document.querySelector('#agent-back').onclick=goToAgents;}
  }
  function goToAgents(){leaveAgent();showHome();history.pushState(null,'','#my-agents');agentSection.scrollIntoView({behavior:'smooth'});renderCameraDirectory();refreshAgents();}
  function renderAgent(m,camera){
    const model=catalog.data.find(v=>v.id===m.modelId);
    agentPage.innerHTML='<button class="token-back" id="agent-back">← My agents</button><div class="token-identity"><span class="token-symbol">'+html(m.name[0].toUpperCase())+'</span><div><h1>$'+html(m.ticker)+' <span>'+html(m.name)+'</span></h1><p>'+html(m.brief)+'</p></div><span class="devnet-chip">SOLANA DEVNET</span></div><div class="token-owner"><span>Creator '+html(short(m.owner))+'</span><span>Test coin · no monetary value</span></div><div class="devnet-agent-stats"><div><span>AGENT STATUS</span><strong id="agent-state">'+html(statusName(m.status))+'</strong><small id="agent-next-check"></small></div><div><span>COMPUTE REMAINING</span><strong id="agent-remaining">'+usd(m.remainingUsd)+'</strong><small>Sponsored USD allowance</small></div><div><span>COMPUTE USED</span><strong id="agent-used">'+usd(m.spentUsd)+'</strong><small>Usage + reserved charges</small></div><div><span>OBSERVATIONS</span><strong id="agent-observations">'+Number(m.totals?.count||m.reports.length)+'</strong><small>Evidence attached</small></div></div><div class="devnet-agent-workspace"><div class="devnet-agent-camera"><div class="observer-toolbar"><span>▧ '+html(camera?.name||m.cameraId)+'</span><span>'+html(camera?.city||'')+'</span></div><div id="agent-camera-player"></div><div class="observation-sampling"><span>ONE CAMERA / ONE MISSION</span><p>AI inspects the provider’s snapshots every '+m.intervalMinutes+' minutes Source timestamps and uncertainty stay attached to its observations</p></div></div><aside class="devnet-agent-settings"><span class="eyebrow">THE MIND BEHIND THIS MISSION</span><div class="token-model-link">'+logoHtml(m.modelId)+'<span><b>'+html(model?modelName(model):m.modelId)+'</b><small>via '+html((m.inferenceProvider||'openrouter')==='orbio'?'Orbio':'OpenRouter')+'</small></span></div><dl><div><dt>Network</dt><dd>Solana devnet</dd></div><div><dt>Token mint</dt><dd id="agent-mint"></dd></div><div><dt>Launch transaction</dt><dd id="agent-transaction"></dd></div><div><dt>Supply</dt><dd>1,000,000 test tokens</dd></div><div><dt>Market cap</dt><dd>No market · test token</dd></div></dl><div id="agent-actions" class="agent-actions"></div><div id="agent-action-status" class="devnet-progress" role="status"></div><div id="agent-error" class="error-text" role="alert"></div><a class="devnet-faucet" href="https://faucet.solana.com/" target="_blank" rel="noopener">Get test SOL from the faucet ↗</a></aside></div><div class="devnet-agent-findings"><div class="token-section-heading"><h2>What the agent observes</h2><span>ORIGINAL FRAMES + AI FINDINGS</span></div><div id="agent-report-list"></div></div><p class="devnet-footnote">Runs while this local server and computer are on · Real AI charges use the mission allowance and shared $1 daily guard · Observations need human review and do not establish a crime or identify a suspect</p>';
    document.querySelector('#agent-back').onclick=goToAgents;
    if(camera)state.player=createCameraPlayer(document.querySelector('#agent-camera-player'),camera);else document.querySelector('#agent-camera-player').innerHTML='<div class="devnet-empty">Camera preview unavailable The saved mission retains its source</div>';
    updateAgent(m);
  }
  function updateAgent(m){
    if(!document.querySelector('#agent-state'))return;
    const pending=state.pending.get(m.id);
    document.querySelector('#agent-state').textContent=pending?'Confirming launch':statusName(m.status);
    document.querySelector('#agent-next-check').textContent=m.enabled?(m.nextCheckAt?'Next check '+new Date(m.nextCheckAt).toLocaleTimeString():'Waiting for the next source check'):m.mint?'Monitoring is paused':'Launch to activate observations';
    document.querySelector('#agent-remaining').textContent=usd(m.remainingUsd);document.querySelector('#agent-used').textContent=usd(m.spentUsd);
    document.querySelector('#agent-observations').textContent=m.totals?.count??m.reports.length;
    document.querySelector('#agent-mint').innerHTML=m.mint?'<a href="'+explorer(m.mint)+'" target="_blank" rel="noopener">'+html(short(m.mint))+' ↗</a>':'Not minted';
    const launchSignature=m.signature||pending?.signature;document.querySelector('#agent-transaction').innerHTML=launchSignature?'<a href="'+explorer(launchSignature,'tx')+'" target="_blank" rel="noopener">'+(pending?'Confirmation pending':'View transaction')+' ↗</a>':'Awaiting launch';
    const owns=m.mine||(state.session.authenticated&&state.session.address===m.owner);
    const actions=document.querySelector('#agent-actions');
    if(!state.requesting){
      actions.innerHTML=owns?(m.mint?'<button class="button primary" id="agent-toggle"'+(Number(m.remainingUsd)<=0?' disabled':'')+'>'+(m.enabled?'Pause agent':'Resume agent')+'</button>':'<button class="button primary" id="agent-launch">Resume devnet launch ↗</button>'):'<button class="button" id="agent-owner-login">'+(connectedWallet?'Sign in as owner':'Connect owner wallet')+'</button>';
      if(document.querySelector('#agent-toggle'))document.querySelector('#agent-toggle').onclick=()=>agentAction(async()=>{await authenticate();return api('/api/missions/'+encodeURIComponent(m.id)+'/state',{enabled:!m.enabled});});
      if(document.querySelector('#agent-launch'))document.querySelector('#agent-launch').onclick=async()=>{try{await config();document.querySelector('#launch-dialog').showModal();showLaunchReview(m,currentCamera(m.cameraId),m);}catch(error){document.querySelector('#agent-error').textContent=messageFor(error);}};
      if(document.querySelector('#agent-owner-login'))document.querySelector('#agent-owner-login').onclick=async()=>{if(!connectedWallet){openWallet();return;}await agentAction(async()=>{await authenticate();if(state.session.address!==m.owner)throw new Error('This mission belongs to a different wallet');return api('/api/missions/'+encodeURIComponent(m.id));});};
    }
    if(!state.requesting)document.querySelector('#agent-error').textContent=m.lastError||'';
    const reports=m.reports||[];
    document.querySelector('#agent-report-list').innerHTML=reports.length?reports.map(r=>'<button class="devnet-evidence" data-agent-report="'+html(r.id)+'">'+(r.evidence?.image?'<img src="'+html(r.evidence.image)+'" alt="Source frame used in this observation">':'')+'<span><small>'+html(new Date(r.completedAt).toLocaleString())+' · '+html(r.model||m.modelId)+'</small><pre class="record-summary">'+html(r.text||'')+'</pre><em>Inspect original frame and evidence ↗</em></span></button>').join(''):'<div class="devnet-empty">'+(m.mint?'The first observation appears after the next scheduled camera check':'Launch this saved mission to begin scheduled camera observations')+'</div>';
    document.querySelectorAll('[data-agent-report]').forEach(button=>button.onclick=()=>inspectObservation(reports.find(r=>r.id===button.dataset.agentReport)));
  }
  async function agentAction(operation){
    if(state.requesting)return;state.requesting=true;document.querySelectorAll('#agent-actions button').forEach(b=>b.disabled=true);document.querySelector('#agent-error').textContent='';
    let actionError='';try{await operation();}catch(error){actionError=messageFor(error);}finally{state.requesting=false;await refreshActive();if(actionError&&document.querySelector('#agent-error'))document.querySelector('#agent-error').textContent=actionError;refreshAgents();}
  }
  async function refreshActive(){
    if(!state.active||document.hidden||state.requesting)return;const id=state.active.id;
    try{const pending=state.pending.get(id);if(pending&&state.active.mine){const result=await api('/api/missions/'+encodeURIComponent(id)+'/confirm',{intentId:pending.intentId});if(result.status==='confirmed'||result.status==='failed'||result.status==='expired')state.pending.delete(id);else state.pending.set(id,result);}const response=await api('/api/missions/'+encodeURIComponent(id));if(state.active?.id!==id)return;const mission=missionFrom(response);mission.reports=response.reports||mission.reports||[];state.active=mission;updateAgent(mission);}catch(error){if(state.active?.id===id)document.querySelector('#agent-error').textContent=messageFor(error);}
  }
  function route(){const match=/^#\/agent\/([A-Za-z0-9_-]+)$/.exec(location.hash);if(match)openAgent(match[1],false);else if(document.body.classList.contains('devnet-mode')){leaveAgent();renderCameraDirectory();}}
  window.addEventListener('hashchange',route);window.addEventListener('popstate',route);
  document.querySelectorAll('.brand,[data-nav],#models-nav').forEach(button=>button.addEventListener('click',()=>{if(document.body.classList.contains('devnet-mode')){leaveAgent();if(location.hash.startsWith('#/agent/'))history.replaceState(null,'','#');renderCameraDirectory();}},{capture:true}));
  openHow=()=>openInfo('PARALLAX / DEVNET PILOT','<h2>A mission you can test end to end</h2><div class="steps"><div class="dialog-section"><h3>Choose a camera and model</h3><p>Pick a provider source, describe visible conditions to watch for, and select an image-capable model</p></div><div class="dialog-section"><h3>Launch on Solana devnet</h3><p>Connect Phantom or Solflare Sign in with a wallet message, then approve a transaction that creates your test token and deposits 0.01 test SOL</p></div><div class="dialog-section"><h3>Fund real observations</h3><p>A confirmed launch activates $0.10 of sponsored AI compute Actual use debits that allowance under the shared $1 daily guard Test SOL is not converted into dollars</p></div><div class="dialog-section"><h3>Inspect the evidence</h3><p>Your server-saved mission runs while the local server is on Each observation retains its source frame and timestamps Pause the agent from its page</p></div></div><div class="dialog-note">Devnet coins have no monetary value A trading pool, trading fee distribution and public 24/7 hosting are not included in this pilot</div>');
  refreshAgents();route();
})();


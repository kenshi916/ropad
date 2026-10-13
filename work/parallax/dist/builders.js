(() => {
  'use strict';
  const mount = document.getElementById('builder-app');
  if (!mount) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const state = { pool: null, poolError: '', builds: [], build: null, preview: null, route: '', tab: 'activity', file: '', filter: 'all', provider: 'all', query: '', sort: 'newest', includePreviews: false, request: 0, loading: true, error: '', signature: '', studioViews: ['', ''], followWorkers: true, viewSignatures: ['', ''], sourceCache: new Map(), composerDrafts: new Map(), modelCatalog: null, modelCatalogPromise: null, viewerMode: 'studio', captureView: 'overview' };
  const advancedModelIds = ['anthropic/claude-opus-5.5', 'openai/gpt-6-astra'];
  const providers = {
    openai: { name: 'OpenAI', logo: 'openai.svg', model: 'GPT-6 Astra', modelId: 'openai/gpt-6-astra' },
    anthropic: { name: 'Anthropic', logo: 'anthropic.svg', model: 'Claude Opus 5.5', modelId: 'anthropic/claude-opus-5.5' },
    google: { name: 'Google', logo: 'google.svg', model: 'Gemini' },
    'x-ai': { name: 'xAI', logo: 'x-ai.svg', model: 'Grok' }
  };
  const icon = '<img class="ropad-mark" src="assets/ropad-logo.svg" alt="">';
  const arrow = '<span aria-hidden="true">↗</span>';
  const short = value => String(value || '').length > 14 ? String(value).slice(0, 6) + '…' + String(value).slice(-4) : String(value || '');
  const time = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
  const age = value => { const date = new Date(value).getTime(); if (!Number.isFinite(date)) return 'Time unavailable'; const seconds = Math.max(0, Math.floor((Date.now() - date) / 1000)); return seconds < 10 ? 'Just now' : seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  function toast(message) { const element = document.getElementById('toast'); if (!element) return; element.textContent = message; element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3500); }
  function invoke(name, ...arguments_) { if (typeof window[name] === 'function') return window[name](...arguments_); toast('The workspace tools are still loading Try again in a moment'); }
  function modelProvider(modelId) { const key = String(modelId || '').split('/')[0]; return providers[key] ? key : ''; }
  function modelMeta(modelId) { const provider = providers[modelProvider(modelId)]; return provider || { name: modelId ? 'Other model' : 'Model not selected', logo:'openrouter.svg', model:'Choose a model' }; }
  function modelLogo(modelId) { const meta = modelMeta(modelId); return '<img src="assets/model-logos/' + meta.logo + '" alt="' + meta.name + '">'; }
  function modelName(build) { return build.modelName || ({'anthropic/claude-opus-5.5':'Claude Opus 5.5','openai/gpt-6-astra':'GPT-6 Astra'})[build.modelId] || String(build.modelId || '').split('/').pop() || 'Choose a model'; }
  function header() { return `<header class="b-header s-header rp-discover-header rp-simple-header"><div class="b-header-inner"><a class="brand" href="#/">${icon}Ropad</a><nav class="s-nav" aria-label="Main navigation"><a href="#/" data-home-section="builds"${state.route==='home'?' aria-current="page"':''}>Games</a><a href="#/trending"${state.route==='trending'?' aria-current="page"':''}>Trending</a><a href="#/studio"${state.route === 'studio' ? ' aria-current="page"' : ''}>Studio</a></nav><div class="b-header-end"><button class="button rp-launch-button" data-builder-action="launch">Launch agent</button><button class="button small b-wallet" data-open="wallet" data-builder-action="wallet"><img src="assets/wallets/phantom.svg" alt=""><span>Connect wallet</span></button></div></div></header>`; }
  function footer() { return '<footer class="b-footer s-footer rp-simple-footer"><span>Independent platform · Not affiliated with Roblox</span><nav aria-label="Resources"><button data-builder-action="how">How it works</button><button data-builder-action="models">AI models</button><a href="https://create.roblox.com/" target="_blank" rel="noopener">Creator Hub ↗</a></nav></footer>'; }

  function walletLabel() { const wallet = window.RopadSolana?.get?.(),label=document.querySelector('.b-wallet span'),icon=document.querySelector('.b-wallet img');if(label)label.textContent=wallet?short(wallet.address):'Connect wallet';if(icon)icon.src=wallet?.id==='solflare'?'assets/model-logos/solflare-wallet.svg':'assets/wallets/phantom.svg'; }
  const agentConflicts=['project-edit','publish','update','new-from-build','thumbnail','concept','design','enqueue','cancel-queue'];
  const agentActive=build=>Boolean(window.RopadBuildAgent?.isActive(build||{}));
  function bindCommon() {
    document.querySelectorAll('[data-builder-action]').forEach(button => button.onclick = async () => {
      const action = button.dataset.builderAction;
      if(agentActive(state.build)&&agentConflicts.includes(action))return toast('Pause the agent and wait for the current step before making manual changes');
      if (action === 'fee-sharing' && state.build) window.RopadFeeSharing?.open(state.build.id);
      if (action === 'project-edit' && state.build) window.RopadProjectTools?.edit(state.build.id);
      if (action === 'publish' && state.build) window.RopadProjectTools?.publish(state.build.id);
      if (action === 'wallet') invoke('openBuilderWallet');
      if (action === 'legacy-wallet') invoke('openEvmWallet');
      if (action === 'verify-owner') { const wallet=tokenOf(state.build||{}).chainId===4663?window.RopadWallet:window.RopadSolana;if(typeof wallet?.authenticate!=='function')return toast('Wallet verification is still loading');button.disabled=true;try{await wallet.authenticate();await refresh();}catch(error){toast(error.message||'Wallet verification did not complete');}finally{if(button.isConnected)button.disabled=false;} }
      if (action === 'launch') invoke('openRobloxLaunch', state.build ? { buildId: state.build.id, gameName: buildName(state.build), name: buildName(state.build), brief: state.build.brief, inspiration: state.build.inspiration || '', modelId: state.build.modelId } : {});
      if (action === 'create') invoke('createRobloxWorkspace', {});
      if (action === 'new-from-build' && state.build) invoke('updateRobloxGame', state.build.id);
      if (action === 'update' && state.build) invoke('updateRobloxGame', state.build.id);
      if (action === 'thumbnail') invoke('openRobloxThumbnail', state.build?.id);
      if (action === 'concept') invoke('openRobloxConcept', state.build?.id);
      if (action === 'review' && state.build) invoke('reviewRobloxGame', state.build.id);
      if (action === 'readiness') { state.tab = 'readiness'; renderPanel(); document.getElementById('b-work-panel')?.scrollIntoView({behavior:'smooth',block:'start'}); }
      if (action === 'orbio') invoke('openRobloxLaunch');
      if (action === 'connect') invoke('openRobloxConnection', state.build?.id);
      if (action === 'design') invoke('designRobloxGame', state.build?.id);
      if (action === 'enqueue') invoke('queueRobloxBuild', state.build?.id, button);
      if (action === 'cancel-queue') invoke('cancelRobloxQueue', state.build?.id, button);
      if (action === 'stop-screen') invoke('stopRobloxScreen', state.build?.id);
      if (action === 'x') toast('X profile coming soon');
      if (action === 'retry') refresh();
      if (action === 'models') showModels();
      if (action === 'how') showHow();
      if (action === 'workspaces') { state.includePreviews = false; state.filter = 'all'; state.provider = 'all'; state.query = ''; if (state.route === 'home') home(); else location.hash = '#/'; }
    });
    document.querySelectorAll('[data-builder-action]').forEach(button=>{if(!agentConflicts.includes(button.dataset.builderAction))return;if(agentActive(state.build)){button.disabled=true;button.dataset.agentLocked='true';button.title='Pause the agent before making manual changes';}else if(button.dataset.agentLocked){button.disabled=false;delete button.dataset.agentLocked;button.title='';}});
    document.querySelectorAll('[data-home-section]').forEach(link => link.onclick = event => { event.preventDefault(); if (state.route !== 'home') { location.hash = '#/'; } else document.getElementById('b-builds')?.scrollIntoView({ behavior: 'smooth' }); });
    walletLabel();
  }
  function showHow() {
    invoke('openInfo', 'ROPAD / HOW IT WORKS', '<div class="build-modal s-info"><h2>One coin, one project, your game</h2><p class="b-flow-label">Prompt → design → Studio → test → improve → release</p><div class="s-info-steps"><section><b>01 / Describe your game</b><p>Create a workspace or launch a test game coin on Solana devnet with Phantom or Solflare Describe the full game and any reference games Choose Opus 5.5 or GPT-6 Astra for its design</p></section><section><b>02 / Join the Studio queue</b><p>Send a prepared plan to the shared worker pool Each Studio worker takes one project at a time Jobs wait when every worker is busy or offline You can also connect your own Studio bridge</p></section><section><b>03 / Follow the actual build</b><p>The workspace shows reported object creation, connection status and real screen frames when the worker supplies them A claimed job is not a completed game</p></section><section><b>04 / Improve and release</b><p>Download the generated .rbxlx project and open it in Roblox Studio Inspect the source and request game updates with a prompt Each update creates a new version Test it, record your review, then publish to your own Roblox account or group Each creator connects their own destination Solana test coins have no monetary value and no trading pool</p></section></div><p class="build-modal-note">The current engine builds bounded obstacle courses, collection + upgrades and timed courses Coin launch does not spend AI credits or publish a game Every version needs real Studio tests and creator approval</p><button class="button primary" data-builder-action="create">Create your game workspace ↗</button></div>');
    bindCommon();
  }
  async function showModels() {
    invoke('openInfo', 'ROPAD / BUILDER MODELS', '<div class="build-modal s-info"><h2>Advanced builder models</h2><p>Loading the available planning models</p></div>');
    const host = document.querySelector('#info-body'); if (!host) return;
    const loading = host.firstElementChild;
    try {
      const payload = await get('/api/builds/models'); if (!loading?.isConnected || !document.querySelector('#info-dialog')?.open) return;
      const models = advancedModelIds.map(id => (Array.isArray(payload.data) ? payload.data : []).find(model => model.id === id)).filter(Boolean);
      host.innerHTML = `<div class="build-modal s-info"><h2>Advanced builder models</h2><p>${esc(payload.providerName || 'Configured provider')} · ${models.length} available · Claude Opus 5.5 / GPT-6 Astra</p><label>Search models<input id="s-model-search" type="search" placeholder="Search model or provider"></label><p id="s-model-result-count" class="build-modal-note" role="status"></p><div id="s-model-options" class="s-model-options"></div><button class="button" id="s-model-more">Show more models ↓</button><p class="build-modal-note">Choose an advanced model to start a workspace with your current game brief Availability is checked against the provider catalog Selection does not start a paid request</p></div>`;
      const modelSeed = state.build ? { gameName:buildName(state.build), name:buildName(state.build), brief:state.build.brief, inspiration:state.build.inspiration||'' } : {};
      let limit = 32;
      const render = () => {
        const query = host.querySelector('#s-model-search').value.toLowerCase();
        const found = models.filter(model => [model.id,model.name].join(' ').toLowerCase().includes(query));
        host.querySelector('#s-model-result-count').textContent = `Showing ${Math.min(limit, found.length)} of ${found.length} matching models`;
        host.querySelector('#s-model-options').innerHTML = found.slice(0,limit).map(model => `<button class="s-model-option" data-model-choice="${esc(model.id)}" title="Start a workspace with this model">${modelLogo(model.id)}<span>${esc(model.name || model.id)}<small>${esc(model.id)}</small></span><span>↗</span></button>`).join('') || (models.length ? '<p>No matching models</p>' : '<p>Neither advanced model is available in the current provider catalog Try again when Claude Opus 5.5 or GPT-6 Astra is available</p>');
        host.querySelectorAll('[data-model-choice]').forEach(button => button.onclick = () => invoke('createRobloxWorkspace', { ...modelSeed, modelId:button.dataset.modelChoice }));
        host.querySelector('#s-model-more').hidden = found.length <= limit;
      };
      host.querySelector('#s-model-search').oninput = () => { limit = 32; render(); };
      host.querySelector('#s-model-more').onclick = () => { limit += 32; render(); };
      render();
    } catch (error) { if (loading?.isConnected && document.querySelector('#info-dialog')?.open) host.innerHTML = `<div class="build-modal"><h2>Model catalog unavailable</h2><p>${esc(error.message)}</p></div>`; }
  }

  function buildName(build) { return build.gameName || build.name || 'Untitled game'; }
  function connected(build) { return build.studio?.connected === true || build.studioConnected === true || build.connection?.connected === true; }
  function frameAt(build) { return build.screenshot?.capturedAt || build.screen?.updatedAt || build.screen?.lastFrameAt || build.screen?.capturedAt || build.screenUpdatedAt || ''; }
  function screenAvailable(build) { return Boolean(build.screenshot) || build.screen?.available === true || build.screen?.hasFrame === true || Boolean(frameAt(build)); }
  function screenFresh(build) { const stamp = new Date(frameAt(build)).getTime(); return Number.isFinite(stamp) && Date.now() - stamp < 15000; }
  function tokenOf(build) { return build.token || build.coin || {}; }
  function hasToken(build) { const token = tokenOf(build); return Boolean(token.address || token.tokenAddress); }
  function progressOf(build) { const progress = build.progress; return progress && Number.isInteger(progress.completed) && Number.isInteger(progress.total) && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total ? progress : null; }
  function poolCounts() {
    const pool = state.pool;
    return pool ? { capacity:Number.isInteger(pool.capacity) ? pool.capacity : 0, online:(pool.workers || []).filter(worker => worker.online === true).length, active:Number(pool.active) || 0, queued:Number(pool.queued) || 0, compatible:queueGate().compatible,idle:queueGate().idle } : null;
  }
  function queueGate(build=state.route===state.build?.id?state.build:null){return window.RopadStudioQueue?.availability(state.workerConfig,state.pool,build)||{ready:false,compatible:0,idle:0,reason:'Studio worker validation is unavailable'};}
  function queueState(build) { return build.queue?.state || ''; }
  function canEnqueue(build) { return Boolean(queueGate(build).ready && build.canManage && build.plan && !['queued','claimed','completed','failed'].includes(queueState(build)) && !['building','ready','failed'].includes(build.status)); }
  function deliveryUrl(build) {
    const value = build.delivery?.available && build.delivery?.format === 'rbxlx' ? build.delivery.url : '';
    return typeof value === 'string' && value === '/api/builds/' + build.id + '/artifact?format=rbxlx' ? value : '';
  }
  function renderPool() {
    const slot = document.getElementById('b-pool-status'); if (!slot) return;
    const counts = poolCounts();
    slot.innerHTML = counts ? `<span class="b-pool-title"><i class="${queueGate().ready ? 'online' : ''}"></i>STUDIO WORKER POOL</span><span><strong>${counts.online}</strong> connections / ${counts.capacity} slots</span><span><strong>${counts.idle}</strong> compatible idle</span><span><strong>${counts.active}</strong> building</span><span><strong>${counts.queued}</strong> queued</span><small>${esc(queueGate().reason)}</small>` : `<span class="b-pool-title">STUDIO WORKER POOL</span><small>${state.poolError ? 'Worker status unavailable' : 'Checking worker availability'}</small>`;
    if (state.pool?.recovery?.previousHistoryUnavailable) slot.insertAdjacentHTML('beforeend', '<p class="b-history-recovery">Earlier workspace history could not be recovered Existing game files and captures were preserved New builds are saved here</p>');
  }
  function queuePanel(build) {
    const queued = queueState(build), counts = poolCounts(),gate=queueGate(build);
    const labels = { queued:'Waiting in queue', claimed:'Assigned to Studio', completed:'Worker reported completion', failed:'Worker needs attention', cancelled:'Removed from queue' };
    const explanation = build.status === 'ready' && !queued ? 'Studio reported scene assembly complete Inspect and playtest before publishing' : queued === 'queued' ? gate.ready?'A compatible dedicated worker can claim this project in queue order':gate.reason : queued === 'claimed' ? 'The assigned worker is applying the plan Follow its reported progress and screen below' : queued === 'completed' ? 'Studio reported scene assembly complete Inspect and playtest before publishing' : queued === 'failed' || build.status === 'failed' ? 'Review the recorded error, then create a game update to attempt another build This execution remains closed' : build.plan?gate.reason:'Prepare a plan, then validate the server and a dedicated Studio worker before queueing';
    return `<section class="b-queue-panel"><div><span class="b-eyebrow">STUDIO BUILD QUEUE</span><h2>${labels[queued] || (build.status === 'ready' ? 'Assembled in Studio' : build.status === 'failed' ? 'Build execution closed' : build.plan ? gate.ready?'Plan prepared for Studio':'Plan prepared / worker validation required' : 'Prepare a build plan')}</h2><p>${esc(explanation)}</p></div><dl>${queued === 'queued' ? `<div><dt>Queue position</dt><dd>${Number.isInteger(build.queue.position) ? '#' + build.queue.position : 'Waiting'}</dd></div>` : ''}${queued === 'claimed' ? `<div><dt>Worker</dt><dd>${esc(build.queue.workerId || 'Assigned')}</dd></div>` : ''}<div><dt>Pool</dt><dd>${counts ? counts.online + ' connections · ' + counts.idle + ' compatible idle' : 'Status unavailable'}</dd></div></dl>${build.canManage ? `<div class="b-queue-actions">${canEnqueue(build) ? '<button class="button primary" data-builder-action="enqueue">Queue Studio build ↗</button>' : !build.plan ? '<button class="button" data-builder-action="design">Prepare a build plan ↗</button>' : !['queued','claimed','completed','failed'].includes(queued)&&!['building','ready','failed'].includes(build.status)?'<button class="button" disabled>Worker validation required</button>':''}${queued === 'queued' ? '<button class="button" data-builder-action="cancel-queue">Cancel queued build</button>' : ''}${queued === 'failed' || build.status === 'failed' ? '<button class="button" data-builder-action="new-from-build">Create a game update ↗</button>' : ''}<button class="b-text-button" data-builder-action="connect">Studio setup ↗</button></div>` : ''}</section>`;
  }
  function deliveryPanel(build) {
    const url = deliveryUrl(build);
    return `<section class="b-delivery-panel"><span class="b-eyebrow">TAKE THE GAME WITH YOU</span><h2>${url ? 'Your Roblox project' : 'Game project download'}</h2><p>${url ? 'A generated Studio place containing the planned scene and gameplay source' : 'Prepare a scene plan to generate a downloadable Roblox Studio project'}</p>${url ? `<a class="button primary" href="${esc(url)}" download>Download game .rbxlx ↓</a>` : ''}<dl><div><dt>Delivery</dt><dd>${url ? 'Generated project' : 'Awaiting plan'}</dd></div><div><dt>Creator review</dt><dd>${build.readiness?.readyForCreatorPublish ? 'Creator approved' : 'Still needed'}</dd></div>${build.playtestReport ? `<div><dt>Worker smoke test</dt><dd>${esc(({passed:'Reported pass',smoke_passed:'Reported pass',failed:'Reported failure',smoke_failed:'Reported failure',not_run:'Not run'})[build.playtestReport.result] || 'Not verified')}</dd></div>` : ''}<div><dt>Publishing</dt><dd>Your Roblox account</dd></div></dl><small>Open the file in Studio, inspect and playtest it, then publish The download is generated from the plan, not an export of later manual Studio edits</small></section>`;
  }
  function readinessLabel(build) {
    return ({draft:'Design needed',planned:'Ready for Studio',building:'Building in Studio',needs_fixes:'Changes required',needs_review:'Creator review needed',creator_approved:'Creator approved'})[build.readiness?.stage] || 'Review not assessed';
  }
  function readinessSummary(build) {
    return `<section class="b-readiness-summary"><span class="b-eyebrow">SHIP READINESS / V${Number(build.lineage?.version)||1}</span><h2>${esc(readinessLabel(build))}</h2><p>${build.readiness?.readyForCreatorPublish ? 'Checks recorded and creator approval saved Publishing is still a separate action in Roblox' : 'Follow the build evidence, outstanding requirements and creator review for this version'}</p><button class="button" data-builder-action="readiness">Inspect release checks ↗</button></section>`;
  }
  function renderReadiness(panel, build) {
    const readiness=build.readiness,design=build.plan?.design,checks=Array.isArray(readiness?.checks)?readiness.checks:[],blockers=Array.isArray(readiness?.blockers)?readiness.blockers:[];
    const sourceLabel=value=>({creator_attestation:'Creator attestation',creator:'Creator attestation',worker:'Worker report',studio_worker:'Worker report',model:'AI plan',model_design_report:'AI design report',plan:'Plan validation',plan_validation:'Plan validation',studio_worker_report:'Worker smoke test',system:'System check'})[value]||String(value||'Recorded evidence').replaceAll('_',' ');
    const publication=readiness?.publication;
    const publishedUrl=window.RopadPlayPage?.publicationUrl?.(build)||'';
    panel.innerHTML=`<div class="b-panel-heading"><span>SHIP READINESS</span><span>Version ${Number(build.lineage?.version)||1} · Evidence + creator review</span></div><div class="b-readiness-content"><h2>${esc(readinessLabel(build))}</h2><p class="b-readiness-note">A passing smoke test confirms basic execution Full gameplay and release checks require the creator’s playtest</p>${checks.length?`<div class="b-release-checks">${checks.map(check=>`<div class="b-release-check${check.passed?' passed':''}"><span aria-hidden="true">${check.passed?'✓':'○'}</span><div><strong>${esc(check.label)}</strong><small>${esc(sourceLabel(check.source))}</small></div><b>${check.passed?'Recorded':'Pending'}</b></div>`).join('')}</div>`:'<p class="b-readiness-note">Release checks are unavailable until the updated build service is active</p>'}${blockers.length?`<section class="b-release-blockers"><h3>Before release</h3><ul>${blockers.map(value=>`<li>${esc(value)}</li>`).join('')}</ul></section>`:''}${design?`<section class="b-release-design"><span class="b-eyebrow">GAME DESIGN FROM YOUR PROMPT</span><dl>${[['Core loop',design.coreLoop],['Objective',design.objective],['Progression',design.progression],['Reference direction',design.inspiration]].filter(([,value])=>value).map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${Array.isArray(design.acceptanceCriteria)&&design.acceptanceCriteria.length?`<h3>Playtest against these requirements</h3><ul>${design.acceptanceCriteria.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:''}${Array.isArray(design.unsupportedFeatures)&&design.unsupportedFeatures.length?`<h3>Requested features still unsupported</h3><ul>${design.unsupportedFeatures.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:''}${Array.isArray(design.limitations)&&design.limitations.length?`<h3>Implementation limits</h3><ul>${design.limitations.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:''}</section>`:''}${build.creatorReview?`<section class="b-creator-record"><span class="b-eyebrow">CREATOR ATTESTATION</span><p>${esc(build.creatorReview.notes||'No additional notes')}</p><small>Recorded ${esc(new Date(build.creatorReview.reviewedAt).toLocaleString())} · Not an independent certification</small></section>`:''}${publishedUrl?`<p><a class="button" href="${esc(publishedUrl)}" target="_blank" rel="noopener">${publication?.source==='roblox_open_cloud'?'Open published version ↗':'Open creator supplied game ↗'}</a><small class="b-publication-note">${publication?.source==='roblox_open_cloud'?'Roblox confirmed the upload · Player access still needs verification':'Creator reported · Publication and ownership have not been verified'}</small></p>`:''}<div class="b-release-actions">${build.canManage?`<button class="button primary" data-builder-action="update">Improve this version ↗</button>${build.status==='ready'&&['passed','smoke_passed'].includes(build.playtestReport?.result)?'<button class="button" data-builder-action="review">Record creator review ↗</button>':''}`:''}<a class="button" href="https://create.roblox.com/dashboard/creations" target="_blank" rel="noopener">Roblox Creator Hub ↗</a></div></div>`;
    bindCommon();
  }
  function renderVersions(panel, build) {
    const revisions=Array.isArray(build.revisions)?build.revisions:[{id:build.id,version:Number(build.lineage?.version)||1,status:build.status,createdAt:build.createdAt}],parent=build.lineage?.parentBuildId;
    panel.innerHTML=`<div class="b-panel-heading"><span>PROJECT VERSIONS</span><span>Same project · Same coin</span></div><div class="b-versions-content"><p>Every update gets its own prompt, plan, source and Studio execution Earlier versions remain available for inspection and download</p><div class="b-version-list">${revisions.slice().sort((a,b)=>b.version-a.version).map(version=>`<a href="#/build/${encodeURIComponent(version.id)}" class="b-version-row${version.id===build.id?' current':''}"><strong>V${Number(version.version)||1}</strong><span>${esc(version.gameName||build.gameName)}<small>${esc(version.status==='ready'?'Assembled in Studio':String(version.status||'Draft').replaceAll('_',' '))}</small></span><span>${version.id===build.id?'Current view':'Inspect ↗'}</span></a>`).join('')}</div><section class="b-version-brief"><span class="b-eyebrow">THIS VERSION’S PROMPT</span><p>${esc(build.brief)}</p>${build.inspiration?`<span class="b-eyebrow">REFERENCE DIRECTION</span><p>${esc(build.inspiration)}</p>`:''}${parent?`<a href="#/build/${encodeURIComponent(parent)}">Compare with previous version ↗</a><small>Open the previous prompt and source to inspect changes No automatic code comparison is available</small>`:''}</section>${build.canManage?'<button class="button primary" data-builder-action="update">Create a game update ↗</button>':''}<p class="b-readiness-note">Edit downloaded scripts directly in Roblox Studio for full code control Browser updates regenerate from the prompt and do not import manual Studio edits</p></div>`;
    bindCommon();
  }
  function statusLabel(build) { if (queueState(build) === 'queued') return Number.isInteger(build.queue.position) ? `Queue #${build.queue.position}` : 'Queued for Studio'; if (queueState(build) === 'claimed' && build.status !== 'building') return 'Assigned to Studio'; if (queueState(build) === 'failed') return 'Worker needs attention'; const progress = progressOf(build); if (build.status === 'building') return progress ? `Building · ${progress.completed}/${progress.total} objects` : 'Building in Studio'; if (build.status === 'failed') return 'Build needs attention'; if (build.status === 'ready') return 'Assembled in Studio'; if (screenAvailable(build) && screenFresh(build)) return 'Screen shared'; if (connected(build)) return 'Studio connected'; return ({queued:'Workspace created',waiting_for_studio:'Awaiting Studio'})[build.status] || String(build.status || 'Workspace ready').replace(/_/g, ' '); }
  function home() {
    state.build = null; state.preview = null; state.signature = '';
    document.title='Ropad — AI builders for Roblox';
    mount.innerHTML = header() + `<main class="b-main s-main rp-discover rp-simple-discovery"><section class="rp-discover-intro"><div><h1>Explore games</h1><p>Roblox games built by AI agents, with a coin behind every project</p></div><button class="rp-text-link" data-builder-action="create">Create a workspace ↗</button></section><section class="s-directory" id="b-builds" aria-label="Game directory"><div class="rp-discovery-controls"><label class="rp-header-search"><span aria-hidden="true">⌕</span><input id="b-search" type="search" placeholder="Search games" aria-label="Search agents and games" value="${esc(state.query)}"></label><label class="s-sort"><select id="s-sort" aria-label="Sort agents"><option value="newest">Newest first</option><option value="status">Connection status</option><option value="name">Name A–Z</option></select></label><details class="rp-discovery-filters"${state.filter!=='all'||state.provider!=='all'?' open':''}><summary>Filters</summary><div class="rp-filter-popover"><span>Project status</span><div class="s-list-tabs" aria-label="Filter workspaces"><button data-build-filter="all">All games <span id="s-count-all">—</span></button><button data-build-filter="connected">Studio connected <span id="s-count-connected">—</span></button><button data-build-filter="coins">Coin linked <span id="s-count-coins">—</span></button></div><span>Builder model</span><div class="s-provider-filters" aria-label="Filter by model provider"><button data-model-provider="all">All models</button>${Object.entries(providers).filter(([,item]) => item.modelId).map(([id,item]) => `<button data-model-provider="${id}"><img src="assets/model-logos/${item.logo}" alt="">${item.name}</button>`).join('')}</div></div></details></div><div class="rp-directory-summary"><span id="s-directory-note">Loading games</span><span id="rp-total-games">—</span></div><div id="s-directory-alert" role="status"></div><div id="b-build-list" class="s-stream-grid" aria-live="polite"></div><details class="rp-service-details"><summary>Studio worker availability</summary><div id="b-pool-status" class="b-pool-status" role="status"></div></details></section></main>` + footer();
    bindCommon();
    document.querySelectorAll('[data-build-filter]').forEach(button => { button.classList.toggle('active', state.filter === button.dataset.buildFilter); button.onclick = () => { state.filter = button.dataset.buildFilter; document.querySelectorAll('[data-build-filter]').forEach(item => item.classList.toggle('active', item === button)); renderBuilds(); }; });
    document.querySelectorAll('[data-model-provider]').forEach(button => { button.classList.toggle('active', state.provider === button.dataset.modelProvider); button.onclick = () => { state.provider = button.dataset.modelProvider; document.querySelectorAll('[data-model-provider]').forEach(item => item.classList.toggle('active', item === button)); renderBuilds(); }; });
    document.getElementById('b-search').oninput = event => { state.query = event.target.value; renderBuilds(); };
    document.getElementById('s-sort').value = state.sort;
    document.getElementById('s-sort').onchange = event => { state.sort = event.target.value; renderBuilds(); };
    renderBuilds();
  }
  function studioShell() {
    state.build = null; state.preview = null; state.viewSignatures = ['', ''];
    mount.innerHTML = header() + `<main class="b-main s-main b-studio-main"><section class="s-intro"><div class="s-title-row"><div><span class="s-kicker">THE STUDIO FLOOR / MULTIPLE VIEWS</span><h1>Two worlds taking shape</h1><p class="s-tagline">Watch actual Studio captures side by side and inspect each agent’s recorded work</p></div><div class="s-intro-actions"><button class="button" data-builder-action="models">Choose a model ↗</button><button class="button primary" data-builder-action="create">Build a custom game +</button></div></div></section><div id="b-pool-status" class="b-pool-status" role="status"></div><div class="b-studio-toolbar"><div><span class="b-eyebrow">ACTUAL WORKSPACE FRAMES</span><p>Workers capture frames as they build These views refresh when a new frame arrives</p></div><label><input type="checkbox" id="b-follow-workers" ${state.followWorkers ? 'checked' : ''}> Follow active builds</label></div><div id="b-studio-alert" role="status"></div><div class="b-studio-grid">${[0,1].map(index => `<section class="b-studio-view" aria-label="Studio view ${index + 1}"><div class="b-studio-picker"><span>VIEW / 0${index + 1}</span><label for="b-studio-select-${index}">Workspace</label><select id="b-studio-select-${index}" aria-label="Workspace for view ${index + 1}"><option value="">Loading workspaces</option></select></div><div id="b-studio-panel-${index}"></div></section>`).join('')}</div><section class="b-studio-next"><div><span class="b-eyebrow">FROM YOUR BRIEF TO YOUR STUDIO</span><h2>Your next game starts here</h2><p>Describe the world, choose a planning model, review its scene plan, then queue a Studio worker Download the generated project from its workspace</p></div><button class="button" data-builder-action="create">New custom workspace ↗</button></section><p class="b-studio-footnote">Build activity and images come from the assigned worker or an owner screen share Completed views retain their last captured frame Full gameplay testing and publishing remain in Roblox Studio</p></main>` + footer();
    document.getElementById('b-follow-workers').onchange = event => { state.followWorkers = event.target.checked; renderStudio(); };
    for (const index of [0,1]) document.getElementById('b-studio-select-' + index).onchange = event => { state.studioViews[index] = event.target.value; state.followWorkers = false; document.getElementById('b-follow-workers').checked = false; renderStudio(); };
    bindCommon(); renderStudio();
  }
  function studioViewPanel(build, index) {
    if (!build) return `<div class="b-studio-empty"><span aria-hidden="true">▦</span><h2>${state.loading ? 'Loading Studio workspaces' : 'A place for your next build'}</h2><p>${state.loading ? 'Reading the workspace directory' : state.builds.length ? 'Select another workspace or create a custom game for this view' : 'Create a workspace, prepare a plan and queue a Studio worker Its actual captures will appear here'}</p>${state.loading ? '' : '<button class="button" data-builder-action="create">Create a workspace +</button>'}</div>`;
    const href = '#/build/' + encodeURIComponent(build.id), available = screenAvailable(build), working = ['claimed'].includes(queueState(build)) || build.status === 'building', activity = events(build).slice(-3).reverse(), planSource = build.planSource === 'model' ? 'AI generated plan' : build.planSource === 'starter_template' ? 'Historical template' : build.plan ? 'Prepared plan' : 'Awaiting plan';
    const progress = progressOf(build), capture = frameAt(build), stamp = new Date(capture), exact = Number.isFinite(stamp.getTime()) ? stamp.toLocaleString() : 'Time unavailable';
    return `<div class="b-studio-view-heading"><div><h2><a href="${href}">${esc(buildName(build))} ↗</a></h2><span>${esc(planSource)}${build.planSource === 'model' ? ' · ' + esc(modelName(build)) : ''}</span></div><span class="b-studio-state${working ? ' working' : ''}"><i></i>${esc(statusLabel(build))}</span></div><a class="b-studio-frame" href="${href}" aria-label="Inspect ${esc(buildName(build))} Studio workspace">${available ? `<img src="/api/builds/${encodeURIComponent(build.id)}/screen?v=${encodeURIComponent(capture)}" alt="Actual captured Studio frame for ${esc(buildName(build))}"><div class="b-studio-frame-error" hidden>Captured frame unavailable<br>Open the workspace to inspect its status</div><span class="b-studio-frame-tag">${working ? 'LATEST WORKER CAPTURE' : 'LAST CAPTURED FRAME'}</span>` : `<div class="b-studio-frame-wait"><span aria-hidden="true">⌘</span><strong>${queueState(build) === 'queued' ? 'Waiting for a Studio worker' : working ? 'Waiting for the first capture' : 'No captured screen yet'}</strong><p>${queueState(build) === 'queued' ? 'The assigned worker will send actual frames once building begins' : 'Open this workspace to prepare a plan or connect Studio'}</p></div>`}<span class="b-studio-frame-open">Inspect workspace ↗</span></a><div class="b-studio-frame-meta"><span>${available ? build.screenshot?.source === 'owner_screen_share' ? 'Owner screen share' : 'Studio worker capture' : 'Source not connected'}</span>${available ? `<time data-frame-age="${esc(Number.isFinite(stamp.getTime()) ? stamp.toISOString() : '')}" datetime="${esc(Number.isFinite(stamp.getTime()) ? stamp.toISOString() : '')}" title="${esc(exact)}">${esc(age(capture))} · ${esc(time(capture))}</time>` : '<span>No illustrative screen</span>'}</div>${progress ? `<div class="b-studio-progress"><span>Scene objects</span><span>${progress.completed} / ${progress.total}</span><progress value="${progress.completed}" max="${progress.total}" aria-label="Scene objects assembled"></progress></div>` : ''}<div class="b-studio-brief"><span>GAME BRIEF</span><p>${esc(build.brief || 'No game brief provided')}</p></div><div class="b-studio-activity"><div><span>RECORDED ACTIVITY</span><a href="${href}">Full workspace ↗</a></div>${activity.length ? `<ol>${activity.map(event => `<li><time>${esc(time(event.createdAt || event.timestamp || event.at))}</time><p>${esc(event.message || event.title || event.summary || 'Workspace updated')}</p></li>`).join('')}</ol>` : '<p class="b-studio-no-events">Worker actions appear here when reported</p>'}</div>`;
  }
  function renderStudio() {
    if (!document.getElementById('b-studio-panel-0')) return;
    renderPool();
    const ranked = state.builds.slice().sort((a,b) => {
      const rank = item => queueState(item) === 'claimed' || item.status === 'building' ? 0 : queueState(item) === 'queued' ? 1 : screenAvailable(item) ? 2 : 3;
      return rank(a) - rank(b) || (new Date(b.updatedAt || b.createdAt).getTime() || 0) - (new Date(a.updatedAt || a.createdAt).getTime() || 0);
    });
    if (state.followWorkers) state.studioViews = [ranked[0]?.id || '', ranked[1]?.id || ''];
    document.getElementById('b-studio-alert').innerHTML = state.error ? `<div class="s-directory-error">Workspace updates paused · ${esc(state.error)} <button data-builder-action="retry">Retry ↻</button></div>` : '';
    for (const index of [0,1]) {
      const selected = state.studioViews[index], other = state.studioViews[1 - index], select = document.getElementById('b-studio-select-' + index), panel = document.getElementById('b-studio-panel-' + index);
      const options = `<option value="">${state.loading ? 'Loading workspaces' : 'Choose a workspace'}</option>` + ranked.map(build => `<option value="${esc(build.id)}"${build.id === selected ? ' selected' : ''}${build.id === other ? ' disabled' : ''}>${esc(buildName(build))} · ${esc(statusLabel(build))}</option>`).join('');
      if (select.dataset.options !== options && document.activeElement !== select) { select.innerHTML = options; select.value = selected; select.dataset.options = options; }
      const build = ranked.find(item => item.id === selected), signature = JSON.stringify([build || null, state.loading]);
      if (signature !== state.viewSignatures[index]) {
        state.viewSignatures[index] = signature; panel.innerHTML = studioViewPanel(build, index);
        const image = panel.querySelector('.b-studio-frame img');
        if (image) { image.onerror = () => { image.hidden = true; panel.querySelector('.b-studio-frame-error').hidden = false; }; image.onload = () => { image.hidden = false; panel.querySelector('.b-studio-frame-error').hidden = true; }; }
      }
    }
    document.querySelectorAll('[data-frame-age]').forEach(element => { element.textContent = age(element.dataset.frameAge) + ' · ' + time(element.dataset.frameAge); });
    bindCommon();
  }
  function marketLabel(build) {
    const token=tokenOf(build);if(token.chain!=='solana'||token.cluster!=='mainnet-beta'||token.verified!==true||!(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(token.address||''))return '—';
    try{const snapshot=window.RopadSolanaMarket?.snapshot(build),market=snapshot?.market,value=market?.marketCapSol;if(snapshot?.error||market?.available!==true||market.cluster!=='mainnet-beta'||market.mint!==token.address||!Number.isSafeInteger(market.slot)||market.slot<0||!Number.isFinite(market.checkedAt)||market.checkedAt<Date.now()-300000||market.checkedAt>Date.now()+60000||typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value)||!Number.isFinite(Number(value))||Number(value)<=0)return '—';return Number(value).toLocaleString([],{maximumFractionDigits:2})+' SOL';}catch{return '—';}
  }
  function streamCard(item, preview) {
    const modelId = item.modelId || '', meta = modelMeta(modelId), name = preview ? item.name : buildName(item), starter = !preview && item.planSource === 'starter_template';
    const href = preview ? '#/preview/' + item.id : '#/token/' + encodeURIComponent(item.id);
    const playtest=!preview&&!visualImageUrl(item,'thumbnail')&&window.RopadLivePlaytest?.cachedPreview(item), shared = !preview && screenAvailable(item), recent = shared && screenFresh(item),thumbnail=visualImageUrl(item,'thumbnail');
    const status = playtest ? 'LAST PLAYTEST FRAME' : thumbnail ? 'AI GENERATED KEY ART' : preview ? 'PREVIEW' : queueState(item) === 'queued' ? 'QUEUED' : queueState(item) === 'claimed' ? 'WORKER ASSIGNED' : recent ? 'SCREEN SHARED' : shared ? 'LAST FRAME' : connected(item) ? 'STUDIO CONNECTED' : 'AWAITING STUDIO';
    const ticker = item.ticker || tokenOf(item).symbol;
    return `<article ${preview?'':'data-preview-build="'+esc(item.id)+'"'} class="s-stream-card${preview ? ' s-concept-card' : ''}"><a class="s-screen-link" href="${href}" aria-label="Open ${esc(name)} ${preview ? 'preview' : 'token page'}"><div class="s-screen-surface">${playtest?`<img class="s-shared-frame" src="${esc(playtest.url)}" alt="Last actual Studio playtest frame for ${esc(name)}" loading="lazy">`:thumbnail?`<img class="s-game-thumbnail" src="${esc(thumbnail)}" alt="AI generated game thumbnail for ${esc(name)}" loading="lazy">`:shared ? `<img class="s-shared-frame" src="/api/builds/${encodeURIComponent(item.id)}/screen?v=${encodeURIComponent(frameAt(item))}" alt="Latest shared Studio screen for ${esc(name)}" loading="lazy">` : '<div class="s-awaiting-frame"><span>⌘</span><strong>Awaiting a Studio capture</strong></div>'}<div class="s-screen-badges"><span class="s-screen-status${recent&&!thumbnail&&!playtest ? ' connected' : ''}">${status}</span></div></div></a><div class="s-card-content"><div class="s-token-row"><div><a href="${href}" class="s-token-name">${esc(name)}</a>${ticker?`<span class="s-token-symbol">$${esc(ticker)}</span>`:''}</div><div class="s-mcap" title="${hasToken(item)?'Verified market capitalization, when available':'Coin has not launched'}"><span>MCAP</span><strong>${preview ? '—' : marketLabel(item)}</strong></div></div><div class="s-card-meta"><span>${preview ? 'Preview' : esc(statusLabel(item))}</span></div><div class="s-card-footer"><span>${starter ? '<span aria-hidden="true">⌘</span>' : modelLogo(modelId)}${esc(starter ? 'Historical template' : preview ? meta.model : modelName(item))}</span><a href="${href}" aria-label="Open ${esc(name)}">View game ↗</a></div></div></article>`;
  }
  function renderBuilds() {
    const list = document.getElementById('b-build-list'); if (!list) return;
    renderPool();
    const projects = new Map();
    for (const build of state.builds) { const projectId=build.lineage?.projectId||build.id,current=projects.get(projectId);if(!current||(Number(build.lineage?.version)||1)>(Number(current.lineage?.version)||1))projects.set(projectId,build); }
    const directoryBuilds=[...projects.values()],connectedCount = directoryBuilds.filter(connected).length, coinsCount = directoryBuilds.filter(hasToken).length;
    document.getElementById('rp-total-games').textContent=state.loading?'':state.filter!=='all'||state.provider!=='all'||state.query.trim()?directoryBuilds.length+' total':'';
    for (const [id,count] of [['all',directoryBuilds.length],['connected',connectedCount],['coins',coinsCount]]) document.getElementById('s-count-' + id).textContent = state.loading ? '—' : count;
    document.getElementById('s-directory-alert').innerHTML = state.error ? `<div class="s-directory-error">Workspace updates unavailable · ${esc(state.error)} <button data-builder-action="retry">Retry ↻</button></div>` : '';
    const match = item => (state.provider === 'all' || modelProvider(item.modelId) === state.provider) && [item.name, item.gameName, item.ticker, tokenOf(item).symbol, item.brief, item.template, item.modelId].join(' ').toLowerCase().includes(state.query.trim().toLowerCase());
    let builds = directoryBuilds.filter(build => (state.filter !== 'connected' || connected(build)) && (state.filter !== 'coins' || hasToken(build)) && match(build));
    const rank = item => screenFresh(item) ? 0 : connected(item) ? 1 : item.status === 'failed' ? 3 : 2;
    builds.sort((a,b) => state.sort === 'name' ? buildName(a).localeCompare(buildName(b)) : state.sort === 'status' ? rank(a) - rank(b) : (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
    document.getElementById('s-directory-note').textContent = state.loading ? 'Loading games' : `${builds.length} game${builds.length === 1 ? '' : 's'}`;
    if (!builds.length) { list.innerHTML = `<div class="b-empty"><div><h3>${state.loading ? 'Loading workspaces' : 'No matching agents'}</h3><p>${state.loading ? 'Reading the build directory' : 'Try another filter or create the first workspace for this view'}</p></div><button class="button" data-builder-action="create">New workspace +</button></div>`; bindCommon(); return; }
    list.innerHTML = builds.map(item => streamCard(item, false)).join('');
    list.querySelectorAll('.s-shared-frame').forEach(image => image.onerror = () => { image.replaceWith(Object.assign(document.createElement('div'), { className:'b-card-frame-error', textContent:'Shared frame unavailable' })); });
    document.querySelectorAll('.rp-discover [data-preview-build]').forEach(card=>{const item=directoryBuilds.find(build=>build.id===card.dataset.previewBuild);if(!item)return;window.RopadLivePlaytest?.preview(item,card,frame=>{const surface=card.querySelector('.s-screen-surface');if(!surface)return;surface.innerHTML=`<img class="s-shared-frame" src="${esc(frame.url)}" alt="Last actual Studio playtest frame for ${esc(buildName(item))}"><div class="s-screen-badges"><span class="s-screen-status"><i></i>LAST PLAYTEST FRAME</span></div><span class="s-screen-open">↗</span>`;});});
    bindCommon();
  }

  function detailShell() {
    mount.innerHTML = header() + `<main class="b-main b-detail-main"><a class="b-back" href="#/">← All builds</a><div id="b-detail-heading"></div><div class="b-token-market-grid"><section data-build-market-slot aria-label="Game coin market"></section><aside data-build-trade-slot id="b-primary-trade" aria-label="Buy or sell game coin"></aside></div><div id="b-detail-queue"></div><div class="b-workspace-grid"><section class="b-workspace"><div class="b-viewer"><div class="b-screen-top"><span><span class="b-square"></span> AGENT WORKSPACE / ROBLOX STUDIO</span><span id="b-screen-status">NOT CONNECTED</span></div><div class="b-view-switch" role="tablist" aria-label="Workspace view"><button type="button" data-view-mode="studio" role="tab" aria-selected="true">Studio <span>Actual capture</span></button><button type="button" data-view-mode="live-playtest" role="tab" aria-selected="false">Live playtest <span>Agent test client</span></button><button type="button" data-view-mode="concept" role="tab" aria-selected="false">Concept <span>Design target</span></button><button type="button" data-view-mode="compare" role="tab" aria-selected="false">Compare <span>Target + capture</span></button></div><div id="b-capture-views" class="b-capture-views" aria-label="Captured Studio camera views" hidden></div><div id="b-screen-content" class="b-screen-content"></div><div class="b-screen-footer"><span id="b-screen-note">Source screen appears when an owner shares it</span><button data-builder-action="connect">Connect Studio ${arrow}</button></div></div><div class="b-work-tabs" role="tablist" aria-label="Build workspace"><button data-build-tab="activity" role="tab" class="active" aria-selected="true">Activity <span id="b-event-count">0</span></button><button data-build-tab="plan" role="tab" aria-selected="false">Build plan</button><button data-build-tab="versions" role="tab" aria-selected="false">Versions</button><button data-build-tab="readiness" role="tab" aria-selected="false">Ship readiness</button><button data-build-tab="files" role="tab" aria-selected="false">Files <span id="b-file-count">0</span></button></div><div id="b-work-panel" class="b-work-panel" role="tabpanel"></div></section><aside class="b-build-sidebar" id="b-build-sidebar"></aside></div></main>` + footer();
    bindCommon();
    document.querySelectorAll('[data-view-mode]').forEach(button => button.onclick=()=>{state.viewerMode=button.dataset.viewMode;updateScreen();});
    document.querySelectorAll('[data-build-tab]').forEach(button => button.onclick = () => { state.tab = button.dataset.buildTab; renderPanel(); });
  }
  function events(build) { return Array.isArray(build.events) ? build.events : Array.isArray(build.actions) ? build.actions : []; }
  function files(build) { if (Array.isArray(build.files)) return build.files; if (build.files && typeof build.files === 'object') return Object.entries(build.files).map(([path, content]) => ({ path, content })); return []; }
  function agentRail(build) {
    const activity=events(build).slice(-3).reverse(),draft=state.composerDrafts.get(build.id),generating=draft?.busy===true;
    return `<section class="b-agent-rail"><div class="b-rail-heading"><span class="b-eyebrow">THE BUILDER</span><span class="b-agent-state${generating?' active':''}"><i></i>${generating?'Planning update':esc(statusLabel(build))}</span></div><div class="b-agent-identity">${modelLogo(build.modelId)}<div><strong>${esc(modelName(build))}</strong><small>${build.planSource==='model'?'Model recorded for this version':'Selected planning model'}</small></div></div><div class="b-rail-activity"><span class="b-eyebrow">RECORDED ACTIVITY</span>${activity.length?`<ol>${activity.map(event=>`<li><i></i><div><p>${esc(event.message||event.title||'Workspace updated')}</p><time>${esc(age(event.createdAt||event.timestamp||event.at))} · ${esc(time(event.createdAt||event.timestamp||event.at))}</time></div></li>`).join('')}</ol>`:'<p class="b-rail-muted">The agent’s reported work will appear here</p>'}</div><small class="b-agent-evidence-note">Actual server and worker events</small></section>`;
  }
  function composerDraft(build) {
    if(!state.composerDrafts.has(build.id))state.composerDrafts.set(build.id,{brief:build.brief||'',modelId:advancedModelIds.includes(build.modelId)?build.modelId:advancedModelIds[0],busy:false,error:''});
    return state.composerDrafts.get(build.id);
  }
  function ownerComposer(build) {
    if(!build.canManage){const legacy=tokenOf(build).chainId===4663,wallet=legacy?window.RopadWallet?.get?.():window.RopadSolana?.get?.();return `<section class="b-agent-composer b-composer-readonly"><span class="b-eyebrow">CREATOR CONTROL</span><h2>The creator directs this agent</h2><p>Watch its work and inspect the source Verify the launching wallet to make game updates Token holders do not receive edit access</p><button class="button" data-builder-action="${wallet?'verify-owner':legacy?'legacy-wallet':'wallet'}">${wallet?'Verify creator wallet':'Connect creator wallet'} ↗</button></section>`;}
    if(agentActive(build))return '<section class="b-agent-composer b-composer-readonly"><span class="b-eyebrow">PROMPT YOUR AGENT</span><h2>The agent is working</h2><p>Pause the workflow and wait for its current step to finish before changing the brief Your current version stays available for inspection</p></section>';
    const draft=composerDraft(build);
    return `<section class="b-agent-composer"><div class="b-rail-heading"><span class="b-eyebrow">PROMPT YOUR AGENT</span><span class="b-owner-chip">CREATOR</span></div><h2>Build the next version</h2><p>Update the full game brief and tell the agent what to improve</p><form id="b-agent-prompt-form"><label for="b-agent-prompt">Updated game prompt</label><textarea id="b-agent-prompt" name="brief" rows="5" minlength="12" maxlength="2400" required${draft.busy?' disabled':''}>${esc(draft.brief)}</textarea><label for="b-agent-model">Builder model</label><select id="b-agent-model" name="modelId" required disabled><option value="">Checking advanced models</option></select><p class="b-agent-price" id="b-agent-price">Checking AI compute availability</p><button class="button primary" type="submit" disabled>${draft.busy?'Agent is preparing an update':'Send update to agent ↗'}</button><p class="b-agent-feedback${draft.error?' is-error':''}" role="status">${esc(draft.error||'')}</p><small>Creates a new version and generates its AI plan Review the result before starting Studio The coin stays linked</small></form></section>`;
  }
  async function modelCatalog() {
    if(state.modelCatalog&&Date.now()-state.modelCatalog.loadedAt<60000)return state.modelCatalog;
    if(!state.modelCatalogPromise)state.modelCatalogPromise=Promise.all([get('/api/builds/models'),get('/api/builds/config')]).then(([catalog,config])=>{state.modelCatalog={...catalog,config,loadedAt:Date.now()};return state.modelCatalog;}).finally(()=>{state.modelCatalogPromise=null;});
    return state.modelCatalogPromise;
  }
  async function bindOwnerComposer(build) {
    const form=document.getElementById('b-agent-prompt-form');if(!form||!build.canManage)return;
    const draft=composerDraft(build),textarea=form.querySelector('textarea'),select=form.querySelector('select'),button=form.querySelector('button[type="submit"]'),note=form.querySelector('#b-agent-price'),feedback=form.querySelector('.b-agent-feedback');
    textarea.oninput=()=>{draft.brief=textarea.value;};select.onchange=()=>{draft.modelId=select.value;};
    form.onsubmit=async event=>{event.preventDefault();if(draft.busy)return;draft.brief=textarea.value;draft.modelId=select.value;draft.busy=true;draft.error='';button.disabled=true;select.disabled=true;textarea.disabled=true;button.textContent='Agent is preparing an update';feedback.textContent='Saving the next version, then requesting its AI plan';
      try{await window.promptRobloxAgent(build.id,{brief:draft.brief,modelId:draft.modelId});state.composerDrafts.delete(build.id);}catch(error){draft.error=error.message;if(form.isConnected){feedback.textContent=error.message;feedback.classList.add('is-error');}}finally{draft.busy=false;if(form.isConnected){button.disabled=false;select.disabled=false;textarea.disabled=false;button.textContent='Send update to agent ↗';}}
    };
    try{const catalog=await modelCatalog();if(!form.isConnected)return;const models=advancedModelIds.map(id=>(catalog.data||[]).find(model=>model.id===id)).filter(Boolean),selected=models.some(model=>model.id===draft.modelId)?draft.modelId:models[0]?.id||'';draft.modelId=selected;select.innerHTML=models.length?models.map(model=>`<option value="${esc(model.id)}"${model.id===selected?' selected':''}>${esc(model.name||model.id)}</option>`).join(''):'<option value="">Advanced models unavailable</option>';
      const ready=catalog.config?.apiVersion>=2&&catalog.config?.revisions===true&&catalog.config?.creationMode==='prompt';
      select.disabled=draft.busy||!selected;button.disabled=draft.busy||!selected||!catalog.configured||!ready;
      note.textContent=!ready?'Restart the local Ropad server to activate agent updates':!selected?'Opus 5.5 and GPT-6 Astra are currently unavailable':!catalog.configured?'Configure AI compute on the server to send an update':`Uses paid AI compute · Up to $${Number(catalog.maxPlanEstimateUsd||0.75).toFixed(2)} estimated per plan · Daily budget applies`;
    }catch(error){if(form.isConnected){note.textContent=error.message;button.disabled=true;}}
  }
  function tradeFallback(build) {
    const token=tokenOf(build),address=token.address||token.tokenAddress;
    return `<section class="b-coin-panel"><span class="b-eyebrow">THE GAME COIN</span><h2>${address?esc(token.symbol?'$'+token.symbol:'Coin linked'):'A coin for your game'}</h2><div class="b-market"><span>MARKET CAP</span><strong>${marketLabel(build)}</strong></div>${address?'<p class="b-panel-footnote">Trading tools are loading No wallet transaction has been requested</p>':'<button class="button primary" data-builder-action="launch">Launch an agent coin ↗</button><p class="b-panel-footnote">Review the launch fee before approving in your wallet</p>'}</section>`;
  }
  function artAssetsPanel(build) {
    const imageUrl=visualImageUrl(build,'thumbnail'),thumbnail=build.thumbnail||{};
    return `<section class="b-art-assets"><div class="b-rail-heading"><span class="b-eyebrow">GAME ARTWORK</span><span class="b-art-ratio">16:9</span></div>${imageUrl?`<a class="b-thumbnail-preview" href="${esc(imageUrl)}" target="_blank" rel="noopener"><img src="${esc(imageUrl)}" alt="AI generated thumbnail for ${esc(buildName(build))}"><span>AI GENERATED KEY ART</span></a>`:'<div class="b-thumbnail-empty"><span>✧</span><p>Your game’s first impression</p><small>Generate original key art from your brief</small></div>'}${thumbnail.status==='generating'?'<p class="b-art-status">Generating a thumbnail</p>':thumbnail.status==='failed'?`<p class="b-art-status is-error">${esc(thumbnail.error||'The latest thumbnail request failed')}</p>`:''}${build.canManage?`<div class="b-art-actions"><button class="button" data-builder-action="thumbnail">${imageUrl?'Regenerate thumbnail':'Generate game thumbnail'} ↗</button><button class="b-text-button" data-builder-action="concept">Generate a concept target ↗</button></div>`:''}<small class="b-art-note">Artwork and design targets stay separate from actual Studio captures</small></section>`;
  }
  function renderDetail(build) {
    const authorizationChanged=state.build?.canManage!==build.canManage;
    state.build = build;
    document.title=buildName(build)+' — Creator studio on Ropad';
    document.getElementById('b-detail-heading').innerHTML = `<div class="b-detail-title"><span class="b-game-avatar b-avatar-${esc(({obby:'lime',tycoon:'violet',racing:'orange'})[build.template] || 'lime')}">${esc(buildName(build).slice(0,1).toUpperCase())}</span><div><span class="b-eyebrow">VERSION ${Number(build.lineage?.version) || 1} / ROBLOX GAME AGENT</span><h1>${esc(buildName(build))}<span>${esc(build.ticker || tokenOf(build).symbol ? '$' + (build.ticker || tokenOf(build).symbol) : '')}</span></h1></div><span class="b-detail-state"><i></i>${esc(statusLabel(build))}</span></div>`;
    if (build.canManage) document.getElementById('b-detail-heading').insertAdjacentHTML('beforeend', `<div class="b-owner-controls"><span>Your workspace · Version ${Number(build.lineage?.version) || 1}</span><button class="button primary" data-builder-action="update">Update game ↗</button><button class="button" data-builder-action="readiness">Ship readiness ↗</button>${build.plan ? '' : '<button class="button" data-builder-action="design">✦ Design with AI</button>'}<button class="button" data-builder-action="project-edit">Edit code ↗</button><a class="button" href="#/release/${encodeURIComponent(build.id)}">Release & earnings ↗</a><button class="button" data-builder-action="publish">Publish ↗</button><button class="button" data-builder-action="fee-sharing">Creator fees ↗</button><button class="button" data-builder-action="connect">Connect Studio ↗</button></div>`);
    document.getElementById('b-detail-queue').innerHTML = queuePanel(build);
    document.getElementById('b-detail-heading').insertAdjacentHTML('beforeend',`<nav class="rp-workspace-links" aria-label="Game pages"><a href="#/token/${encodeURIComponent(build.id)}">← Token page</a><a href="#/play/${encodeURIComponent(build.id)}">Game page ↗</a><span>Creator studio / build controls</span></nav>`);
    const token = tokenOf(build), address = token.address || token.tokenAddress;
    const market = typeof token.marketCapUsd === 'number' && Number.isFinite(token.marketCapUsd) ? '$' + token.marketCapUsd.toLocaleString([], { maximumFractionDigits: 0 }) : 'Unavailable';
    const sidebar=document.getElementById('b-build-sidebar'),editingSidebar=!authorizationChanged&&sidebar.contains(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if(authorizationChanged)state.composerDrafts.delete(build.id);
    state.sidebarDirty=editingSidebar;
    if(!editingSidebar){sidebar.innerHTML = `${agentRail(build)}<div class="b-workflow-stack"><div data-build-agent-slot>${window.RopadBuildAgent?.panel(build)||''}</div><div data-build-compute-slot>${window.RopadCompute?.panel(build)||''}</div></div>${ownerComposer(build)}${artAssetsPanel(build)}${readinessSummary(build)}${deliveryPanel(build)}<section class="b-brief-panel"><span class="b-eyebrow">THE GAME DIRECTION</span><p>${esc(build.brief || 'No brief provided')}</p>${build.inspiration?`<span class="b-eyebrow">REFERENCES</span><p>${esc(build.inspiration)}</p>`:''}${build.canManage?'<button class="b-text-button" data-builder-action="concept">Set a visual target ↗</button>':''}</section>`;
    bindOwnerComposer(build);
    const agentSlot=document.querySelector('[data-build-agent-slot]');if(agentSlot)window.RopadBuildAgent?.wire(build,agentSlot);
    const computeSlot=document.querySelector('[data-build-compute-slot]');if(computeSlot)window.RopadCompute?.wire(build,computeSlot);
    }
    const marketSlot=document.querySelector('[data-build-market-slot]');
    if(marketSlot&&window.RopadTokenMarket){marketSlot.innerHTML=window.RopadTokenMarket.panel(build);window.RopadTokenMarket.wire(build,marketSlot);}
    const tradeSlot=document.getElementById('b-primary-trade');
    const editingTrade=tradeSlot?.contains(document.activeElement)&&['INPUT','SELECT'].includes(document.activeElement?.tagName);
    if(tradeSlot&&!editingTrade){tradeSlot.innerHTML=typeof window.ParallaxOrbio?.buildTradePanel==='function'?window.ParallaxOrbio.buildTradePanel(build):tradeFallback(build);window.ParallaxOrbio?.wireBuildTradePanel?.(build,tradeSlot);}
    bindCommon();
    document.getElementById('b-copy-address')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(address); toast('Token address copied'); } catch { toast('Select the token address to copy it'); } });
    renderPanel(); updateScreen();
  }
  function renderPanel() {
    if (!state.build) return;
    document.querySelectorAll('[data-build-tab]').forEach(button => { const active = button.dataset.buildTab === state.tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    const activity = events(state.build), sourceFiles = files(state.build), panel = document.getElementById('b-work-panel');
    document.getElementById('b-event-count').textContent = activity.length; document.getElementById('b-file-count').textContent = sourceFiles.length;
    if (state.tab === 'activity') {
      const failedEvent = event => /(?:^|_)(?:failed|error)$/.test(event.type || event.kind || '');
      panel.innerHTML = `<div class="b-panel-heading"><span>BUILD ACTIVITY</span><span>Recorded actions · No simulated events</span></div>${activity.length ? `<div class="b-event-list">${activity.slice().reverse().map(event => `<article class="b-event${failedEvent(event) ? ' b-event-error' : ''}"><span class="b-event-marker">${failedEvent(event) ? '!' : '↗'}</span><div><span class="b-event-type">${esc(String(event.type || event.kind || 'activity').replace(/_/g, ' '))}</span><h3>${esc(event.message || event.title || event.summary || 'Workspace updated')}</h3>${event.detail || event.description ? `<p>${esc(event.detail || event.description)}</p>` : ''}</div><time>${esc(time(event.createdAt || event.timestamp || event.at))}</time></article>`).join('')}</div>` : '<div class="b-panel-empty"><span>⌁</span><h3>The build log is ready</h3><p>Plan generation, worker actions, and connection updates will appear here when they happen</p></div>'}`;
    } else if (state.tab === 'versions') {
      renderVersions(panel, state.build);
    } else if (state.tab === 'readiness') {
      renderReadiness(panel, state.build);
    } else if (state.tab === 'plan') {
      if (Array.isArray(state.build.plan?.parts)) {
        const plan = state.build.plan, source = ({starter_template:'HISTORICAL TEMPLATE',custom_plan:'CUSTOM PLAN',model:'AI GENERATED PLAN'})[state.build.planSource] || 'SCENE PLAN';
        panel.innerHTML = `<div class="b-panel-heading"><span>${source}</span><span>Review before applying in Studio</span></div><div class="b-scene-summary"><div><strong>${plan.parts.length}</strong><span>SCENE OBJECTS</span></div><p>${esc(plan.summary || 'A scene blueprint for Roblox Studio')}</p></div>${Array.isArray(plan.design?.unsupportedFeatures)&&plan.design.unsupportedFeatures.length?`<section class="b-release-blockers"><h3>Requested features still unsupported</h3><ul>${plan.design.unsupportedFeatures.map(value=>`<li>${esc(value)}</li>`).join('')}</ul><button class="b-text-button" data-builder-action="readiness">Inspect release requirements ↗</button></section>`:''}<div class="b-scene-note">${state.build.status === 'ready' ? 'Studio reported this scene assembled Playtesting and publishing are separate steps' : 'This is a plan The connected worker must apply it in Studio before it exists in your game'}</div><div class="b-scene-parts">${plan.parts.map((part, index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><strong>${esc(part.name || part.id)}</strong><small>${esc(part.behavior || part.material || 'Part')}</small><code>${esc(Array.isArray(part.size) ? part.size.join(' × ') : '')}</code></div>`).join('')}</div>`;
        bindCommon();return;
      }
      const plan = state.build.plan?.steps || state.build.plan?.tasks || state.build.plan;
      panel.innerHTML = `<div class="b-panel-heading"><span>BUILD PLAN</span><span>Review before applying in Studio</span></div>${Array.isArray(plan) && plan.length ? `<div class="b-plan-list">${plan.map((item, index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><section><h3>${esc(typeof item === 'string' ? item : item.title || item.name || item.description)}</h3>${typeof item === 'object' && item.description && item.description !== item.title ? `<p>${esc(item.description)}</p>` : ''}<small>${esc(typeof item === 'object' ? item.status || 'Planned' : 'Planned')}</small></section></div>`).join('')}</div>` : typeof plan === 'string' && plan ? `<pre class="b-plan-text">${esc(plan)}</pre>` : '<div class="b-panel-empty"><span>▤</span><h3>A plan starts with your brief</h3><p>Generate a plan from the workspace controls to review your agent’s next steps</p></div>'}`;
    } else {
      if (!sourceFiles.some(file => (file.path || file.name) === state.file)) state.file = sourceFiles[0]?.path || sourceFiles[0]?.name || '';
      const file = sourceFiles.find(item => (item.path || item.name) === state.file);
      if (file?.name === 'game.rbxlx' && deliveryUrl(state.build)) {
        panel.innerHTML = `<div class="b-panel-heading"><span>ROBLOX STUDIO PROJECT</span><span>Generated from the prepared plan</span></div><div class="b-files"><nav aria-label="Workspace files">${sourceFiles.map(item => `<button data-source-file="${esc(item.path || item.name)}" class="${(item.path || item.name) === state.file ? 'active' : ''}">⌘ <span>${esc(item.path || item.name)}</span></button>`).join('')}</nav><div class="b-project-file"><span class="b-eyebrow">GAME.RBXLX</span><h3>Open your game in Studio</h3><p>This generated place includes the scene and gameplay source Inspect it and run a playtest before publishing from your Roblox account</p><a class="button primary" href="${esc(deliveryUrl(state.build))}" download>Download game .rbxlx ↓</a><small>Plan export · Not a recording of later manual Studio edits</small></div></div>`;
        panel.querySelectorAll('[data-source-file]').forEach(button => button.onclick = () => { state.file = button.dataset.sourceFile; renderPanel(); });
        return;
      }
      panel.innerHTML = `<div class="b-panel-heading"><span>WORKSPACE FILES</span><span>Source files · Inspect before running</span></div>${sourceFiles.length ? `<div class="b-files"><nav aria-label="Workspace files">${sourceFiles.map(item => `<button data-source-file="${esc(item.path || item.name)}" class="${(item.path || item.name) === state.file ? 'active' : ''}">⌘ <span>${esc(item.path || item.name)}</span></button>`).join('')}</nav><div class="b-code-view"><div><span>${esc(state.file)}</span><button id="b-copy-code">Copy source ↗</button></div><pre><code>${esc(file?.content || file?.source || 'File contents are unavailable')}</code></pre></div></div>` : '<div class="b-panel-empty"><span>⌘</span><h3>The first file is ahead</h3><p>Generated Luau and project files appear here when the model prepares a plan</p></div>'}`;
      panel.querySelectorAll('[data-source-file]').forEach(button => button.onclick = () => { state.file = button.dataset.sourceFile; renderPanel(); });
      const copySource = document.getElementById('b-copy-code');
      if (copySource) copySource.onclick = async () => { try { await navigator.clipboard.writeText(file?.content || file?.source || ''); toast('Source copied'); } catch { toast('Select the source text to copy it'); } };
      if (file?.url && /^\/api\/builds\/[a-f0-9-]+\/artifact\?format=(json|luau)$/.test(file.url)) {
        const sourceKey = state.build.id + ':' + (state.build.jobId || '') + ':' + state.file;
        const code = panel.querySelector('.b-code-view code');
        code.textContent = state.sourceCache.get(sourceKey) || 'Loading source…';
        const copy = document.getElementById('b-copy-code');
        copy.disabled = !state.sourceCache.has(sourceKey);
        copy.onclick = async () => { try { await navigator.clipboard.writeText(state.sourceCache.get(sourceKey) || ''); toast('Source copied'); } catch { toast('Select the source text to copy it'); } };
        const download = document.createElement('a'); download.href = file.url; download.download = file.path || file.name; download.textContent = 'Download ↗'; download.className = 'b-source-download'; panel.querySelector('.b-code-view>div').append(download);
        if (!state.sourceCache.has(sourceKey)) fetch(file.url, { credentials: 'same-origin', signal: AbortSignal.timeout(12000) }).then(async response => { if (!response.ok) throw new Error('Source unavailable'); const source = await response.text(); state.sourceCache.set(sourceKey, source); if (code.isConnected) { code.textContent = source; copy.disabled = false; } }).catch(() => { if (code.isConnected) code.textContent = 'The source file could not be loaded Try opening Files again'; });
      }
    }
  }
  function visualImageUrl(build,purpose='concept') {
    if(!['concept','thumbnail'].includes(purpose))return '';
    const raw=build[purpose]?.imageUrl,expected='/api/builds/'+encodeURIComponent(build.id)+'/'+purpose+'/image';
    if(typeof raw!=='string')return '';
    try{const url=new URL(raw,location.origin);return url.origin===location.origin&&url.pathname===expected?url.pathname+url.search:'';}catch{return '';}
  }
  function renderConceptScreen(build,content) {
    const concept=build.concept||{},imageUrl=visualImageUrl(build,'concept'),signature=JSON.stringify([concept,build.canManage]);
    document.getElementById('b-screen-status').textContent=concept.status==='generating'?'GENERATING DESIGN TARGET':imageUrl?'CONCEPT IMAGE':'NO CONCEPT YET';
    document.getElementById('b-screen-status').classList.remove('b-screen-on');
    document.getElementById('b-screen-note').textContent='AI concept artwork · Design direction only · Not a Studio screenshot';
    const progress=document.getElementById('b-build-progress');if(progress)progress.hidden=true;
    const stopButton=document.querySelector('.b-stop-screen');if(stopButton)stopButton.hidden=true;
    if(content.dataset.conceptSignature===signature&&content.firstElementChild)return;
    content.dataset.conceptSignature=signature;
    content.innerHTML=imageUrl?`<div class="b-concept-image"><img src="${esc(imageUrl)}" alt="AI concept artwork for ${esc(buildName(build))} — design target, not gameplay"><span class="b-concept-badge">DESIGN TARGET / NOT GAMEPLAY</span><div class="b-concept-caption"><div><strong>${esc(concept.title||'Visual target')}</strong><small>${esc(concept.modelName||concept.modelId||'AI generated')} · ${esc(age(concept.generatedAt||concept.createdAt))}</small></div>${build.canManage?'<button class="button" data-builder-action="concept">Revise concept ↗</button>':''}</div><div class="b-concept-load-error" hidden>Concept image unavailable Generate a new concept or try again</div></div>${concept.status==='generating'?'<p class="b-concept-status">Generating a new visual target The previous concept remains visible</p>':concept.status==='failed'?`<p class="b-concept-status is-error">The latest concept request failed ${esc(concept.error||'Try again from the concept editor')}</p>`:''}`:`<div class="b-concept-empty"><img src="assets/ropad-logo.svg" alt="Ropad"><span class="b-eyebrow">CONCEPT / VISUAL DIRECTION</span><h2>Set the scene before you build</h2><p>Create a concept image from your game brief and art direction Keep the target beside your actual Studio progress</p>${concept.status==='generating'?'<span class="b-concept-status">An image request is in progress</span>':build.canManage?'<button class="button primary" data-builder-action="concept">Generate concept image ↗</button>':'<span class="b-concept-status">The creator has not generated a visual target</span>'}${concept.error?`<p class="is-error">${esc(concept.error)}</p>`:''}<small>Concept artwork does not establish game completion</small></div>`;
    const image=content.querySelector('.b-concept-image>img');if(image){image.onerror=()=>{image.hidden=true;content.querySelector('.b-concept-load-error').hidden=false;};}
    bindCommon();
  }
  function capturedViews(build){
    return (Array.isArray(build.visualFrames)?build.visualFrames:[]).filter(frame=>['overview','spawn','finish'].includes(frame?.view)&&frame.source==='pooled_studio_worker'&&frame.jobId===build.jobId&&/^[a-f0-9]{64}$/.test(frame.hash||'')&&Number.isFinite(frame.capturedAt));
  }
  function captureUrl(build,frame){return '/api/builds/'+encodeURIComponent(build.id)+'/screen'+(frame?'?view='+encodeURIComponent(frame.view)+'&v='+encodeURIComponent(frame.hash):'?v='+encodeURIComponent(frameAt(build)));}
  function updateCaptureViews(build){
    const frames=capturedViews(build),bar=document.getElementById('b-capture-views');
    if(!frames.some(frame=>frame.view===state.captureView))state.captureView=frames[0]?.view||'overview';
    if(bar){
      bar.hidden=!frames.length||['concept','live-playtest'].includes(state.viewerMode);
      const signature=JSON.stringify([frames.map(frame=>[frame.view,frame.hash]),state.captureView]);
      if(bar.dataset.signature!==signature){
        bar.dataset.signature=signature;
        bar.innerHTML=frames.map(frame=>`<button type="button" data-capture-view="${frame.view}" aria-pressed="${String(frame.view===state.captureView)}">${esc(frame.view)} <span>Captured</span></button>`).join('');
        bar.querySelectorAll('[data-capture-view]').forEach(button=>button.onclick=()=>{state.captureView=button.dataset.captureView;updateScreen();});
      }
    }
    return frames.find(frame=>frame.view===state.captureView)||null;
  }
  function renderComparison(build,content,frame){
    const target=visualImageUrl(build,'concept'),actual=frame?captureUrl(build,frame):screenAvailable(build)?captureUrl(build):'',actualLabel=frame?'Actual Studio '+frame.view:build.screenshot?.source==='owner_screen_share'?'Owner-shared screen':'Actual Studio capture',signature=JSON.stringify([target,actual,frame?.capturedAt,actualLabel]);
    document.getElementById('b-screen-status').textContent='TARGET / STUDIO COMPARISON';
    document.getElementById('b-screen-status').classList.remove('b-screen-on');
    document.getElementById('b-screen-note').textContent='Compare generated art direction with the recorded Studio result';
    const progress=document.getElementById('b-build-progress');if(progress)progress.hidden=true;
    const stopButton=document.querySelector('.b-stop-screen');if(stopButton)stopButton.hidden=true;
    if(content.dataset.compareSignature===signature&&content.firstElementChild)return;
    content.dataset.compareSignature=signature;
    content.innerHTML=`<div class="b-visual-compare"><figure><figcaption><strong>Design target</strong><span>AI-generated concept</span></figcaption>${target?`<img src="${esc(target)}" alt="AI-generated concept target for ${esc(buildName(build))}">`:'<p>No concept image saved for this version</p>'}</figure><figure><figcaption><strong>${esc(actualLabel)}</strong><span>${actual?esc(age(frame?.capturedAt||frameAt(build))):'Awaiting captured evidence'}</span></figcaption>${actual?`<a href="${esc(actual)}" target="_blank" rel="noopener"><img src="${esc(actual)}" alt="Actual Studio capture for ${esc(buildName(build))}"></a>`:'<p>The worker has not supplied an actual capture</p>'}</figure><p class="b-compare-note">Concept artwork is a target Visual review assesses these captures and does not certify gameplay or release readiness</p></div>`;
    content.querySelectorAll('.b-visual-compare img').forEach(image=>image.onerror=()=>{image.replaceWith(Object.assign(document.createElement('p'),{textContent:'Recorded image unavailable'}));});
  }
  function updateScreen() {
    const build = state.build, content = document.getElementById('b-screen-content'); if (!build || !content) return;
    document.querySelectorAll('[data-view-mode]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.viewMode===state.viewerMode)));
    if(content.dataset.mode!==state.viewerMode){window.RopadLivePlaytest?.stop();content.innerHTML='';content.dataset.mode=state.viewerMode;}
    const connectButton=document.querySelector('.b-screen-footer [data-builder-action="connect"]');if(connectButton)connectButton.hidden=state.viewerMode!=='studio';
    const capture=updateCaptureViews(build);
    if(state.viewerMode==='live-playtest'){const stopButton=document.querySelector('.b-stop-screen');if(stopButton)stopButton.hidden=true;window.RopadLivePlaytest?.mount(build,content);return;}
    if(state.viewerMode==='concept'){renderConceptScreen(build,content);return;}
    if(state.viewerMode==='compare'){renderComparison(build,content,capture);return;}
    const available = Boolean(capture)||screenAvailable(build), fresh = !capture&&screenFresh(build);
    document.getElementById('b-screen-status').textContent = available ? (fresh ? 'SCREEN SHARED' : 'LAST SHARED FRAME') : 'AWAITING SCREEN';
    document.getElementById('b-screen-status').classList.toggle('b-screen-on', available && fresh);
    document.getElementById('b-screen-note').textContent = available ? (capture?'Studio '+capture.view+' capture':build.screenshot?.source === 'owner_screen_share' ? 'Owner-shared screen' : 'Studio worker screen') + ' · ' + age(capture?.capturedAt||frameAt(build)) : 'Worker screen appears when actual frames are received';
    const footer = document.querySelector('.b-screen-footer');
    let progressBox = document.getElementById('b-build-progress');
    if (!progressBox) { progressBox = document.createElement('div'); progressBox.id = 'b-build-progress'; progressBox.className = 'b-build-progress'; footer.before(progressBox); }
    const progress = progressOf(build);
    progressBox.hidden = !progress || !['building', 'ready', 'failed'].includes(build.status);
    if (!progressBox.hidden) progressBox.innerHTML = `<div><span>${build.status === 'ready' ? 'SCENE ASSEMBLED' : build.status === 'failed' ? 'BUILD STOPPED' : 'ASSEMBLING IN STUDIO'}</span><strong>${progress.completed} / ${progress.total} objects</strong></div><progress value="${progress.completed}" max="${progress.total}" aria-label="Studio worker reported build progress"></progress><small>Reported by the connected Studio worker${build.status === 'ready' ? ' · Playtesting and publishing still required' : ''}</small>`;
    let stopButton = footer.querySelector('[data-builder-action="stop-screen"]');
    if (!stopButton) { stopButton = document.createElement('button'); stopButton.dataset.builderAction = 'stop-screen'; stopButton.textContent = 'Stop sharing ×'; stopButton.className = 'b-stop-screen'; stopButton.onclick = () => invoke('stopRobloxScreen', state.build?.id); footer.append(stopButton); }
    stopButton.hidden = !(build.canManage && available && build.screenshot?.source === 'owner_screen_share');
    if (available) {
      let image = content.querySelector('img');
      if (!image) { content.innerHTML = '<img class="b-shared-screen" alt="Shared Studio screen for this Roblox build"><div class="b-screen-failure" hidden>Shared frame is unavailable Reconnect the screen source</div>'; image = content.querySelector('img'); image.onerror = () => { image.hidden = true; content.querySelector('.b-screen-failure').hidden = false; }; image.onload = () => { image.hidden = false; content.querySelector('.b-screen-failure').hidden = true; }; }
      const next = captureUrl(build,capture);
      image.alt='Actual Studio '+(capture?.view||'screen')+' capture for '+buildName(build);
      if (image.getAttribute('src') !== next) image.src = next;
    } else if (!content.querySelector('.b-screen-awaiting')) { content.innerHTML = `<div class="b-screen-awaiting"><div class="b-screen-empty-grid"></div><div class="b-screen-window"><span class="b-window-top"><i></i><i></i><i></i></span><span class="b-window-mark">⌘</span><span class="b-window-line"></span><span class="b-window-line short"></span></div><h2>Your agent’s screen belongs here</h2><p>Queue a prepared plan or connect your Studio<br>Actual worker frames will appear here when received</p><button class="button b-lime-button" data-builder-action="connect">Connect Studio ${arrow}</button><small>NO STUDIO SCREEN CONNECTED</small></div>`; bindCommon(); }
  }
  async function get(path) { const response = await fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(12000) }); let payload; try { payload = await response.json(); } catch { throw new Error('The workspace service could not be reached'); } if (!response.ok) throw new Error(payload.error || 'The workspace could not be loaded'); return payload; }
  async function getPool(){const [pool,config]=await Promise.all([get('/api/builds/pool'),get('/api/builds/config').catch(()=>null)]);state.workerConfig=config;return pool;}
  const pageHelpers={name:buildName,buildName,modelName,modelLogo,statusLabel,events,visualImageUrl,esc};
  function publicShell(){
    mount.innerHTML=header()+'<main class="rp-page-loading"><span>ROPAD / GAME AGENTS</span><h1>Opening your game</h1><p>Loading the latest project and token details</p></main>'+footer();
    bindCommon();
  }
  function renderCurrent(build){
    if(!['token','play','release'].includes(state.page)){renderDetail(build);return;}
    const module=({token:window.RopadTokenPage,play:window.RopadPlayPage,release:window.RopadReleaseCenter})[state.page],selector=state.page==='release'?'.rp-release-page':'.rp-'+state.page+'-page';
    if(!module)throw Error('The game page is still loading Refresh to get the latest update');
    const root=document.querySelector(selector);
    state.build=build;
    if(root&&typeof module.refresh==='function')module.refresh(build,root,pageHelpers);
    else{mount.innerHTML=header()+module.render(build,pageHelpers)+footer();module.wire?.(build,document.querySelector(selector),pageHelpers);}
    document.title=buildName(build)+(state.page==='release'?' — Release on Ropad':state.page==='play'?' — Play on Ropad':' — Token on Ropad');
    bindCommon();
  }
  function routeError(message){
    window.RopadLivePlaytest?.stop();window.RopadTrending?.destroy();state.request++;state.route='invalid';state.build=null;state.signature='';
    mount.innerHTML=header()+`<main class="rp-page-loading"><span>PAGE UNAVAILABLE</span><h1>This game link is incomplete</h1><p>${esc(message)}</p><a class="button" href="#/">Explore games ↗</a></main>`+footer();bindCommon();
  }
  async function refresh() {
    if (/^#\/launch\/?(?:\?[^#]*)?$/.test(location.hash)) {
      state.request++;
      if (state.route !== 'launch') {
        window.RopadLivePlaytest?.stop();window.RopadTrending?.destroy();
        state.route='launch';state.page='launch';state.build=null;state.preview=null;state.signature='';
        if(document.body)document.body.dataset.page='launch';document.title='Launch your game agent — Ropad';
        mount.innerHTML=header()+'<main id="rp-launch-page"></main>'+footer();bindCommon();
        window.RopadLaunchPage?.mount(document.getElementById('rp-launch-page'));
      }
      return;
    }
    if (state.route === 'launch') window.RopadLaunchPage?.unmount?.();
    const route=location.hash.match(/^#\/(build|workspace|token|play|release)\/([^/?#]+)\/?(?:\?[^#]*)?$/);
    let id='';try{id=route?decodeURIComponent(route[2]):'';}catch{routeError('Open a game from Explore to get its current link');return;}
    if((/^#\/(build|workspace|token|play|release)(?:\/|$)/.test(location.hash)&&!route)||(id&&!/^[A-Za-z0-9_-]{1,128}$/.test(id))){routeError('Open a game from Explore to get its current link');return;}
    const page=route&&['token','play','release'].includes(route[1])?route[1]:'workspace';
    if(document.body)document.body.dataset.page=id?page:/^#\/studio(?:\/|$)/.test(location.hash)?'workspace':/^#\/trending(?:\/|$)/.test(location.hash)?'trending':'home';
    const sequence = ++state.request;
    try{await Promise.all([window.RopadSolana?.whenInvalidated?.(),window.RopadWallet?.whenInvalidated?.()]);}catch(error){if(sequence===state.request)toast('Creator session could not be cleared '+error.message);return;}
    if(sequence!==state.request)return;
    if (/^#\/trending\/?(?:\?[^#]*)?$/.test(location.hash)) {
      if(state.route!=='trending'){window.RopadLivePlaytest?.stop();state.route='trending';state.page='trending';state.build=null;state.preview=null;state.signature='';document.title='Trending Roblox games — Ropad';mount.innerHTML=header()+'<main id="rp-trending-page"></main>'+footer();bindCommon();window.RopadTrending?.mount(document.getElementById('rp-trending-page'));}return;
    }
    if(state.route==='trending')window.RopadTrending?.destroy();
    if (/^#\/studio\/?(?:[?#].*)?$/.test(location.hash)) {
      if (state.route !== 'studio') { window.RopadLivePlaytest?.stop();state.route = 'studio'; studioShell(); }
      try { const [payload, pool] = await Promise.all([get('/api/builds'), getPool().catch(error => { state.poolError = error.message; return null; })]); if (sequence !== state.request) return; state.pool = pool; if (pool) state.poolError = ''; state.builds = Array.isArray(payload) ? payload : payload.builds || payload.data || []; state.error = ''; } catch (error) { if (sequence !== state.request) return; state.error = error.message; } finally { if (sequence === state.request) { state.loading = false; renderStudio(); } }
      return;
    }
    if (/^#\/preview\//.test(location.hash)) { location.hash = '#/'; return; }
    state.preview = null;
    if (id) {
      if (state.route !== id||state.page!==page) { window.RopadLivePlaytest?.stop();state.route = id;state.page=page; state.build = null; state.signature = '';state.sidebarDirty=false; state.tab = 'activity'; state.viewerMode = /[?&]view=live-playtest(?:&|$)/.test(location.hash)?'live-playtest':/[?&]view=concept(?:&|$)/.test(location.hash)?'concept':'studio'; state.captureView = 'overview';if(page==='workspace'){detailShell();document.getElementById('b-detail-heading').innerHTML='<div class="b-detail-loading">Opening workspace…</div>';}else publicShell();}
      try {
        const [payload,pool]=await Promise.all([get('/api/builds/'+encodeURIComponent(id)),page==='workspace'?getPool().catch(error=>{state.poolError=error.message;return null;}):Promise.resolve(null)]);
        if(sequence!==state.request)return;state.pool=pool;if(pool)state.poolError='';
        const build=payload.build||payload.data||payload;
        if(build.id!==id)throw Error('The returned game does not match this page');
        const signature=JSON.stringify([build,poolCounts(),queueGate()]);
        if(signature!==state.signature||state.sidebarDirty){state.signature=signature;renderCurrent(build);}else{state.build=build;if(page==='workspace')updateScreen();else if(page==='token')window.RopadTokenPage?.refresh?.(build,document.querySelector('.rp-token-page'),pageHelpers);}
        window.RopadSolanaMarket?.refresh?.(build);if(page==='workspace')window.RopadCompute?.refresh?.(build);
      }catch(error){
        if(sequence!==state.request)return;
        if(!state.build){const message=`<div class="b-detail-error"><h1>Game unavailable</h1><p>${esc(error.message)}</p><button class="button" data-builder-action="retry">Try again ↻</button><a class="button" href="#/">Explore games</a></div>`;if(page==='workspace')document.getElementById('b-detail-heading').innerHTML=message;else mount.innerHTML=header()+'<main class="rp-page-loading">'+message+'</main>'+footer();}
        else toast('Game updates paused '+error.message);bindCommon();
      }
    } else {
      if (state.route !== 'home') { window.RopadLivePlaytest?.stop();state.route = 'home'; home(); }
      try { const [payload, pool] = await Promise.all([get('/api/builds'), getPool().catch(error => { state.poolError = error.message; return null; })]); if (sequence !== state.request) return; state.pool = pool; if (pool) state.poolError = '';  state.builds = Array.isArray(payload) ? payload : payload.builds || payload.data || []; state.error = ''; } catch (error) { if (sequence !== state.request) return; state.error = error.message; } finally { if (sequence === state.request) { state.loading = false; renderBuilds(); } }
    }
  }
  window.ParallaxBuilders = { refresh, showView(mode,view){if(!['studio','live-playtest','concept','compare'].includes(mode))return;state.viewerMode=mode;if(['overview','spawn','finish'].includes(view))state.captureView=view;updateScreen();}, showConcept(id){if(state.page==='workspace'&&state.build?.id===id){state.viewerMode='concept';updateScreen();}else location.hash='#/workspace/'+encodeURIComponent(id)+'?view=concept';}, openBuild(id) { location.hash = '#/build/' + encodeURIComponent(id); if (state.route === id) refresh(); }, toast };
  window.addEventListener('hashchange', () => { window.RopadLivePlaytest?.stop();const requestedView=location.hash.match(/[?&]view=(live-playtest|concept)(?:&|$)/);if(requestedView)state.viewerMode=requestedView[1];refresh(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  function invalidateCreatorView(){
    state.request++;state.signature='';state.composerDrafts.clear();window.RopadCompute?.invalidate?.();window.RopadCreatorTools?.invalidate?.();
    if(state.build){const info=document.getElementById('info-dialog');if(info?.open&&info.querySelector('#builder-update-form,#builder-concept-form,#builder-review-form,#build-pairing'))info.close();renderCurrent({...state.build,canManage:false,agent:state.build.agent?{...state.build.agent,canManage:false}:null});}
    walletLabel();refresh();
  }
  window.addEventListener('ropad-solana-wallet-change', invalidateCreatorView);
  window.addEventListener('parallax-evm-wallet-invalidate', invalidateCreatorView);
  document.addEventListener('keydown',event=>{if(event.key==='/'&&state.route==='home'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!document.querySelector('dialog[open]')&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'')&&!document.activeElement?.isContentEditable){event.preventDefault();document.getElementById('b-search')?.focus();}});
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) refresh(); }, 5000);
  refresh();
})();

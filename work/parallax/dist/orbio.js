(() => {
  'use strict';
  const originalLaunch = window.openLaunch;
  const launchDialog = document.querySelector('#launch-dialog');
  const launchBody = document.querySelector('#launch-body');
  if (!launchDialog || !launchBody || typeof originalLaunch !== 'function') return;

  const STORAGE = 'parallax.orbio.handoffs.v1';
  const OFFICIAL_LAUNCH = 'https://www.orbio.so/launchpad/launch';
  const html = value => escapeHtml(String(value ?? ''));
  const state = { seed: {}, status: null, models: [], modelLoading: false, drafts: [], activeDraft: null, agents: [], selectedAgent: null, view: 'prepare', version: 0, lookupVersion: 0, listVersion: 0, evmWallet: null, walletEpoch: 0, intent: null, launchBusy: false, authInvalidation: Promise.resolve() };
  const advancedModelIds = ['anthropic/claude-opus-5.5', 'openai/gpt-6-astra'];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || '[]');
    if (Array.isArray(saved)) state.drafts = saved.filter(d => d && typeof d.id === 'string' && typeof d.modelId === 'string' && (d.kind === 'roblox' ? typeof d.brief === 'string' : typeof d.cameraId === 'string')).slice(0, 20);
  } catch {}
  state.activeDraft = state.drafts[0] || null;

  async function read(path) {
    const response = await fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('The integration service returned an unreadable response'); }
    if (!response.ok) throw new Error(payload.error || 'The integration service is unavailable');
    return payload;
  }
  async function post(path, body) {
    const status = await read('/api/status');
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Parallax-Token': status.csrf }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('The integration service returned an unreadable response'); }
    if (!response.ok) throw Object.assign(new Error(payload.error || 'The request could not be completed'), { code: payload.code, status: response.status });
    return payload;
  }
  function safeLink(value, fallback = OFFICIAL_LAUNCH) {
    try { const url = new URL(value); return url.protocol === 'https:' ? url.href : fallback; } catch { return fallback; }
  }
  function exactUnits(value, decimals, maxFraction = decimals) {
    if (value === null || value === undefined || !/^\d+$/.test(String(value))) return '—';
    const raw = String(value).replace(/^0+(?=\d)/, '').padStart(decimals + 1, '0');
    const integer = decimals ? raw.slice(0, -decimals) : raw;
    const fraction = decimals ? raw.slice(-decimals).slice(0, maxFraction).replace(/0+$/, '') : '';
    return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
  }
  function money(value, maxFraction = 6) { const formatted = exactUnits(value, 6, maxFraction); return formatted === '—' ? formatted : '$' + formatted; }
  function timestamp(value) { if (value === null || value === undefined) return 'Awaiting source'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Awaiting source' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function short(value) { return value ? String(value).slice(0, 7) + '…' + String(value).slice(-5) : '—'; }
  function feedback(message, error = false) {
    const target = launchBody.querySelector('[data-orbio-feedback]');
    if (target) { target.textContent = message; target.classList.toggle('is-error', error); }
  }
  function openShell(kicker) {
    state.version++;
    launchDialog.classList.add('orbio-dialog');
    launchDialog.querySelector('.dialog-head .eyebrow').textContent = kicker;
    if (!launchDialog.open) launchDialog.showModal();
  }
  launchDialog.addEventListener('close', () => { state.version++; state.lookupVersion++; launchDialog.classList.remove('orbio-dialog'); });

  function chooseDestination(seed = {}) {
    state.seed = seed && typeof seed === 'object' ? seed : {};
    if (state.seed.kind === 'roblox') return openIntegration(state.seed);
    openShell('MISSION CONTROL / LAUNCH DESTINATION');
    launchBody.innerHTML = `<div class="orbio-destination-intro"><span class="orbio-small-label">ONE MISSION · CHOOSE YOUR NETWORK</span><h2>Where will your agent begin?</h2><p>Keep testing on Solana or prepare a camera mission for the Orbio launchpad</p></div><div class="orbio-destinations"><button class="orbio-destination" data-orbio-destination="solana"><span class="orbio-destination-mark">◎</span><span class="orbio-destination-badge">TEST ENVIRONMENT</span><h3>Solana devnet</h3><p>Launch a test token and run a camera agent through this local server</p><div><span>Test SOL · Phantom / Solflare</span><b>Continue testing ↗</b></div></button><button class="orbio-destination orbio-destination-live" data-orbio-destination="orbio"><span class="orbio-destination-mark">O</span><span class="orbio-destination-badge">MAINNET / REAL ETH</span><h3>Orbio + Pons</h3><p>Prepare your mission and review an Orbio launch on Robinhood Chain</p><div><span>Real ETH fee + gas · chain 4663</span><b>Prepare with Orbio ↗</b></div></button></div><p class="orbio-quiet">Orbio launches require a separate real ETH wallet approval Camera handoffs stay local until runtime integration is verified</p>`;
    launchBody.querySelector('[data-orbio-destination="solana"]').onclick = () => {
      launchDialog.close();
      originalLaunch(state.seed);
    };
    launchBody.querySelector('[data-orbio-destination="orbio"]').onclick = () => openIntegration(state.seed);
  }

  function renderTerms() {
    const host = launchBody.querySelector('#orbio-terms');
    if (!host) return;
    const s = state.status;
    if (!s) { host.innerHTML = '<span class="orbio-small-label">SOURCE CHECK</span><strong>Checking live terms</strong><p>Reading the current Orbio launch configuration</p>'; return; }
    const ready = s.externalLaunchReady === true;
    const fee = s.launchFee?.eth !== undefined && s.launchFee?.eth !== null ? html(s.launchFee.eth) + ' ETH' : '—';
    const feeBps = s.terms?.feeBps;
    const feePercent = feeBps === null || feeBps === undefined || !Number.isFinite(Number(feeBps)) ? '—' : (Number(feeBps) / 100).toLocaleString(undefined, { maximumFractionDigits: 4 }) + '%';
    host.innerHTML = `<div class="orbio-terms-heading"><span class="orbio-small-label">CURRENT LAUNCH TERMS</span><span class="orbio-availability ${ready ? 'ready' : ''}">${ready ? 'Available at Orbio' : 'Check required'}</span></div><div class="orbio-term-grid"><div><span>LAUNCH FEE</span><strong>${fee}</strong><small>Real ETH + network gas</small></div><div><span>ORBIO FEE SHARE</span><strong>${feePercent}</strong><small>Of collected creator fees</small></div><div><span>NETWORK</span><strong>Robinhood Chain</strong><small>Mainnet · 4663</small></div></div><div class="orbio-terms-bottom"><span>Checked ${html(timestamp(s.checkedAt))}</span><span>Orbio testnet launch unavailable</span></div>${s.errors?.length ? '<p class="orbio-source-error">' + html(s.errors.join(' · ')) + '</p>' : ''}`;
    updateExternalLaunch();
  }
  function updateExternalLaunch() {
    const link = launchBody.querySelector('#orbio-official-launch');
    if (!link) return;
    const ready = state.status?.externalLaunchReady === true;
    if (ready) { link.href = OFFICIAL_LAUNCH; link.removeAttribute('aria-disabled'); }
    else { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); }
    const note = launchBody.querySelector('#orbio-handoff-availability');
    if (note) note.textContent = ready ? 'Review the current ETH fee and gas on Orbio before approving a transaction' : 'Live launch availability is not confirmed Refresh the source check before continuing';
  }
  async function loadTerms(version) {
    try { const payload = await read('/api/integrations/orbio'); if (version !== state.version || !launchDialog.open) return; state.status = payload; renderTerms(); }
    catch (error) {
      if (version !== state.version || !launchDialog.open) return;
      state.status = { externalLaunchReady: false, errors: [error.message], checkedAt: null };
      renderTerms();
    }
  }
  async function openIntegration(seed = {}) {
    state.seed = seed && typeof seed === 'object' ? seed : {};
    const roblox = state.seed.kind === 'roblox';
    if ((state.activeDraft?.kind === 'roblox') !== roblox) state.activeDraft = state.drafts.find(d => (d.kind === 'roblox') === roblox) || null;
    state.view = 'prepare';
    openShell(roblox ? 'ROPAD / ROBLOX AGENT LAUNCH' : 'ROPAD / ORBIO LAUNCH HANDOFF');
    const version = state.version;
    if (roblox) {
      launchBody.innerHTML = '<div class="build-modal"><h2>Preparing your builder launch</h2></div>';
      try {
        const config = await read('/api/builds/config');
        if (version !== state.version || !launchDialog.open) return;
        if (config.apiVersion !== 2 || config.creationMode !== 'prompt') throw new Error('Restart the local Ropad server to activate prompt builds and updates');
      } catch (error) {
        if (version === state.version && launchDialog.open) launchBody.innerHTML = `<div class="build-modal"><h2>Prompt launches need the updated service</h2><p>${html(error.message)}</p></div>`;
        return;
      }
    }
    launchBody.innerHTML = `<div class="orbio-hub-heading"><div><span class="orbio-small-label">CAMERA INTELLIGENCE × ONCHAIN AGENTS</span><h2>A mission for your Orbio agent</h2><p>Choose a source Review the real ETH launch Inspect the public agent when it is onchain</p></div><button type="button" class="orbio-back" id="orbio-destinations-back">Change network ↗</button></div><div class="orbio-brand-strip"><b>ORBIO</b><span>Launchpad</span><i>+</i><b>PONS</b><span>Agent infrastructure</span><i>/</i><b>ROBINHOOD CHAIN</b></div><section id="orbio-terms" class="orbio-terms" aria-live="polite"></section><div class="orbio-tabs" role="tablist" aria-label="Orbio integration"><button type="button" role="tab" aria-selected="true" data-orbio-tab="prepare">01 <span>Prepare mission</span></button><button type="button" role="tab" aria-selected="false" data-orbio-tab="agents">02 <span>Find launched agent</span></button><button type="button" id="orbio-refresh-status" class="orbio-refresh">Refresh terms ↻</button></div><div id="orbio-workspace"></div>`;
    if (roblox) {
      const heading = launchBody.querySelector('.orbio-hub-heading');
      heading.querySelector('.orbio-small-label').textContent = 'ROBLOX BUILDERS × ONCHAIN AGENTS';
      heading.querySelector('h2').textContent = 'Give your agent a game to build';
      heading.querySelector('p').textContent = 'Describe your game Choose an advanced model Review the coin launch and build from your prompt';
      const back = launchBody.querySelector('#orbio-destinations-back');
      back.textContent = 'Back to builders ↗'; back.onclick = () => launchDialog.close();
    } else launchBody.querySelector('#orbio-destinations-back').onclick = () => chooseDestination(state.seed);
    launchBody.querySelector('#orbio-refresh-status').onclick = () => { state.status = null; renderTerms(); loadTerms(state.version); };
    launchBody.querySelectorAll('[data-orbio-tab]').forEach(button => { button.onclick = () => switchTab(button.dataset.orbioTab); });
    renderTerms();
    state.models = []; state.modelLoading = true;
    renderPrepare();
    loadTerms(version);
    loadModels(version);
  }
  function switchTab(view) {
    state.view = view;
    state.lookupVersion++; state.listVersion++;
    launchBody.querySelectorAll('[data-orbio-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.orbioTab === view)));
    if (view === 'agents') renderAgents(); else renderPrepare();
  }

  async function loadModels(version) {
    try {
      const roblox = state.seed.kind === 'roblox';
      const payload = await read(roblox ? '/api/orbio/models?kind=roblox' : '/api/orbio/models');
      if (version !== state.version || !launchDialog.open) return;
      const compatible = (payload.data || []).filter(m => m.architecture?.output_modalities?.includes('text') && (roblox || m.architecture?.input_modalities?.includes('image')));
      state.models = roblox ? advancedModelIds.map(id => compatible.find(model => model.id === id)).filter(Boolean) : compatible;
      state.modelLoading = false;
      populateModels();
    } catch (error) {
      if (version !== state.version || !launchDialog.open) return;
      state.modelLoading = false;
      const note = launchBody.querySelector('#orbio-model-note');
      if (note) note.textContent = 'Orbio model catalog unavailable · ' + error.message;
    }
  }
  function populateModels() {
    const select = launchBody.querySelector('#orbio-model');
    if (!select) return;
    const previous = select.value || state.seed.modelId || state.activeDraft?.modelId;
    const query = (launchBody.querySelector('#orbio-model-search')?.value || '').toLowerCase().trim();
    const models = state.models.filter(m => [m.name, m.id].join(' ').toLowerCase().includes(query));
    const roblox = state.seed.kind === 'roblox';
    select.innerHTML = '<option value="">' + (roblox ? 'Choose a model for your builder' : 'Choose an image-capable model') + '</option>' + models.map(m => `<option value="${html(m.id)}">${html(m.name || m.id)}</option>`).join('');
    if (models.some(m => m.id === previous)) select.value = previous;
    else if (roblox) select.value = advancedModelIds.find(id => models.some(model => model.id === id)) || '';
    launchBody.querySelector('#orbio-model-note').textContent = state.models.length ? models.length + ' matching models from Orbio · ' + (roblox ? 'Advanced models only · Claude Opus 5.5 / GPT-6 Astra' : 'Image input + text output') : state.modelLoading ? 'Loading the Orbio model catalog' : roblox ? 'Neither Claude Opus 5.5 nor GPT-6 Astra is available in the Orbio catalog' : 'No compatible models were returned by Orbio';
    select.disabled = !models.length;
    launchBody.querySelector('#orbio-save-handoff').disabled = !models.length;
  }
  function renderPrepare() {
    if (state.seed.kind === 'roblox') return renderRobloxPrepare();
    const workspace = launchBody.querySelector('#orbio-workspace');
    if (!workspace) return;
    const d = { ...(state.activeDraft || {}), ...state.seed };
    workspace.innerHTML = `<div class="orbio-prepare-layout"><form id="orbio-handoff-form"><div class="orbio-field-pair"><label>Agent name<input name="name" maxlength="60" minlength="2" required placeholder="e.g. Harborwatch" value="${html(d.name || '')}"></label><label>Token symbol<input name="ticker" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{1,9}" required placeholder="e.g. HARBOR" value="${html(d.ticker || '')}"></label></div><label>What should this camera help observe?<textarea name="brief" minlength="12" maxlength="500" rows="3" required placeholder="Watch for visible road obstructions, smoke and changes in traffic flow">${html(d.brief || '')}</textarea></label><div class="orbio-model-heading"><label for="orbio-model">Agent model <span>Orbio catalog</span></label><input type="search" id="orbio-model-search" aria-label="Search Orbio models" placeholder="Search models"></div><select id="orbio-model" name="modelId" required><option value="">Loading the Orbio model catalog</option></select><small id="orbio-model-note">Only models that accept images and return text are shown</small><label>Observation interval<select name="interval"><option value="5">Every 5 minutes</option><option value="10">Every 10 minutes</option><option value="15">Every 15 minutes</option><option value="30">Every 30 minutes</option></select></label><label hidden>Region<select name="region"><option value="${html(d.region || 'california')}">${html(d.region || 'California')}</option></select></label><label hidden>Camera count<input name="cameras" value="1"></label><div class="orbio-form-footer"><small>Saved in this browser · No wallet signature</small><button class="button primary" id="orbio-save-handoff" type="submit" disabled>Save launch handoff ↗</button></div><p data-orbio-feedback role="status" class="orbio-feedback"></p></form><aside class="orbio-process"><span class="orbio-small-label">HOW IT CONNECTS</span><ol><li><b>Choose the observation</b><p>Your selected camera, model and mission stay together in a local handoff</p></li><li><b>Review the ETH launch</b><p>Connect an Ethereum wallet Review the quote and approve the Orbio transaction</p></li><li><b>Inspect the agent</b><p>Look up the public agent and associate it with this camera draft</p></li></ol><div class="orbio-boundary-note"><b>Camera handoff only</b><p>This step does not verify agent ownership, connect its camera to Orbio or fund AI compute</p></div>${state.drafts.length ? '<button type="button" class="button small" id="orbio-view-handoff">View saved handoff ↗</button>' : ''}</aside></div>`;
    const form = workspace.querySelector('#orbio-handoff-form');
    window.initLaunchCamera(form, d);
    const nameCount = document.createElement('small'); nameCount.className = 'orbio-name-count'; form.elements.name.after(nameCount);
    const validateName = () => { const bytes = new TextEncoder().encode(form.elements.name.value.trim()).length; nameCount.textContent = bytes + ' / 32 UTF-8 bytes'; form.elements.name.setCustomValidity(bytes > 32 ? 'Use a name of no more than 32 UTF-8 bytes' : ''); };
    form.elements.name.maxLength = 32; form.elements.name.addEventListener('input', validateName); validateName();
    if (d.intervalMinutes && [...form.elements.interval.options].some(option => Number(option.value) === Number(d.intervalMinutes))) form.elements.interval.value = String(d.intervalMinutes);
    workspace.querySelector('#orbio-model-search').oninput = populateModels;
    workspace.querySelector('#orbio-view-handoff')?.addEventListener('click', () => renderHandoff(state.activeDraft));
    populateModels();
    form.onsubmit = event => {
      event.preventDefault();
      const camera = form.selectedCamera;
      const model = state.models.find(m => m.id === form.elements.modelId.value);
      if (new TextEncoder().encode(form.elements.name.value.trim()).length > 32) return feedback('Use an agent name of no more than 32 UTF-8 bytes', true);
      if (!camera) return feedback('Choose a connected camera before saving', true);
      if (!model) return feedback('Choose a current image-capable model from Orbio', true);
      const draft = {
        id: crypto.randomUUID(), savedAt: new Date().toISOString(), chainId: 4663,
        name: form.elements.name.value.trim(), ticker: form.elements.ticker.value.trim().toUpperCase(), brief: form.elements.brief.value.trim(),
        cameraId: camera.id, cameraName: camera.name, cameraProvider: camera.provider, cameraCity: camera.city, cameraSource: camera.source, region: camera.region,
        modelId: model.id, modelName: model.name || model.id, intervalMinutes: Number(form.elements.interval.value),
        status: 'local_handoff', ownerVerified: false, runtimeConnected: false, agentId: null,
      };
      const drafts = [draft, ...state.drafts].slice(0, 20);
      try { localStorage.setItem(STORAGE, JSON.stringify(drafts)); }
      catch { return feedback('This browser could not save the handoff Enable local storage and retry', true); }
      state.drafts = drafts; state.activeDraft = draft; state.seed = draft;
      renderHandoff(draft);
    };
  }
  function renderRobloxPrepare() {
    const workspace = launchBody.querySelector('#orbio-workspace');
    if (!workspace) return;
    const d = { ...(state.activeDraft || {}), ...state.seed };
    workspace.innerHTML = `<div class="orbio-prepare-layout"><form id="orbio-handoff-form"><div class="orbio-field-pair"><label>Builder name<input name="name" maxlength="32" minlength="2" required placeholder="e.g. Orbit Builder" value="${html(d.name || '')}"></label><label>Token symbol<input name="ticker" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{1,9}" required placeholder="e.g. ORBIT" value="${html(d.ticker || '')}"></label></div><label>What should your agent build in Roblox?<textarea name="brief" minlength="12" maxlength="2000" rows="4" required placeholder="Build a neon rooftop obby with checkpoints, collectible coins and a finish timer">${html(d.brief || '')}</textarea></label><label>Reference games + original direction <span class="build-optional">Optional</span><textarea name="inspiration" maxlength="1200" rows="2" placeholder="Name games you admire, the mechanics to learn from and what makes your game different">${html(d.inspiration || '')}</textarea></label><p class="orbio-quiet"><a href="https://www.roblox.com/charts/top-playing-now" target="_blank" rel="noopener">Browse current Roblox charts ↗</a> Share mechanics and your original twist References are creator supplied</p><div class="orbio-model-heading"><label for="orbio-model">Builder model <span>Advanced models only</span></label><input type="search" id="orbio-model-search" aria-label="Search Orbio models" placeholder="Search models"></div><select id="orbio-model" name="modelId" required><option value="">Loading the Orbio model catalog</option></select><small id="orbio-model-note">Claude Opus 5.5 and GPT-6 Astra · Checked against the current Orbio catalog</small><div class="orbio-form-footer"><small>Save your brief before wallet approval</small><button class="button primary" id="orbio-save-handoff" type="submit" disabled>Review builder launch ↗</button></div><p data-orbio-feedback role="status" class="orbio-feedback"></p></form><aside class="orbio-process"><span class="orbio-small-label">FROM BRIEF TO BUILD</span><ol><li><b>Give the agent a direction</b><p>Describe the full experience and reference games Choose Opus 5.5 or GPT-6 Astra</p></li><li><b>Launch its coin</b><p>Connect your wallet Review the current ETH fee and approve the Orbio transaction</p></li><li><b>Open its build workspace</b><p>A confirmed launch links the coin to a workspace Generate the plan, queue Studio, then test and improve each version</p></li></ol><div class="orbio-boundary-note"><b>A launch creates the coin</b><p>A connected worker builds the supported mechanics from your prompt Creator playtesting and release approval are required Coin launch does not start or publish a game</p></div>${state.activeDraft?.kind === 'roblox' ? '<button type="button" class="button small" id="orbio-view-handoff">View saved builder ↗</button>' : ''}</aside></div>`;
    const form = workspace.querySelector('#orbio-handoff-form');
    const nameCount = document.createElement('small'); nameCount.className = 'orbio-name-count'; form.elements.name.after(nameCount);
    const validateName = () => { const bytes = new TextEncoder().encode(form.elements.name.value.trim()).length; nameCount.textContent = bytes + ' / 32 UTF-8 bytes'; form.elements.name.setCustomValidity(bytes > 32 ? 'Use a name of no more than 32 UTF-8 bytes' : ''); };
    form.elements.name.addEventListener('input', validateName); validateName();
    workspace.querySelector('#orbio-model-search').oninput = populateModels;
    workspace.querySelector('#orbio-view-handoff')?.addEventListener('click', () => renderHandoff(state.activeDraft));
    populateModels();
    form.onsubmit = event => {
      event.preventDefault();
      const model = state.models.find(m => m.id === form.elements.modelId.value);
      if (new TextEncoder().encode(form.elements.name.value.trim()).length > 32) return feedback('Use a builder name of no more than 32 UTF-8 bytes', true);
      if (!model) return feedback('Choose a current builder model from Orbio', true);
      const draft = {
        id: crypto.randomUUID(), savedAt: new Date().toISOString(), chainId: 4663, kind: 'roblox',
        name: form.elements.name.value.trim(), ticker: form.elements.ticker.value.trim().toUpperCase(), brief: form.elements.brief.value.trim(),
        template: 'auto', inspiration: form.elements.inspiration.value.trim(), modelId: model.id, modelName: model.name || model.id,
        status: 'local_handoff', ownerVerified: false, runtimeConnected: false, agentId: null,
      };
      const drafts = [draft, ...state.drafts].slice(0, 20);
      try { localStorage.setItem(STORAGE, JSON.stringify(drafts)); }
      catch { return feedback('This browser could not save the builder Enable local storage and retry', true); }
      state.drafts = drafts; state.activeDraft = draft; state.seed = draft;
      renderHandoff(draft);
    };
  }
  function handoffText(d) {
    if (d.kind === 'roblox') return `Builder: ${d.name}\nSymbol: ${d.ticker}\nGame brief: ${d.brief}\nReferences: ${d.inspiration || 'None supplied'}\nModel: ${d.modelId}\nNetwork: Robinhood Chain mainnet (4663)\n\nLocal launch plan only Roblox Studio worker and AI compute require setup`;
    return `Agent: ${d.name}\nSymbol: ${d.ticker}\nMission: ${d.brief}\nModel: ${d.modelId}\nCamera: ${d.cameraName}\nProvider: ${d.cameraProvider}\nSource: ${d.cameraSource}\nObservation interval: ${d.intervalMinutes} minutes\nNetwork: Robinhood Chain mainnet (4663)\n\nLocal planning handoff only Camera integration, owner verification and compute funding are not activated`;
  }
  function renderHandoff(d) {
    if (!d) return renderPrepare();
    if (d.kind === 'roblox') return renderRobloxHandoff(d);
    const workspace = launchBody.querySelector('#orbio-workspace');
    workspace.innerHTML = `<div class="orbio-handoff"><div class="orbio-handoff-identity"><span class="orbio-agent-avatar">${html(d.name?.charAt(0).toUpperCase() || 'O')}</span><div><span class="orbio-small-label">HANDOFF SAVED IN THIS BROWSER</span><h3>${html(d.name)} <span>$${html(d.ticker)}</span></h3><p>${html(d.brief)}</p></div></div><dl class="orbio-handoff-details"><div><dt>CAMERA SOURCE</dt><dd>${html(d.cameraName)}<small>${html(d.cameraProvider)}</small></dd></div><div><dt>CHOSEN MODEL</dt><dd>${html(d.modelName)}<small>${html(d.modelId)}</small></dd></div><div><dt>PLANNED INTERVAL</dt><dd>${html(d.intervalMinutes)} minutes</dd></div><div><dt>CAMERA CONNECTION</dt><dd>Local plan only<small>Owner and runtime not verified</small></dd></div></dl><p class="orbio-handoff-note">Review the integrated wallet launch below or use the official Orbio launchpad A saved handoff is not a launched token or a running camera agent</p><div class="orbio-handoff-actions"><button class="button" id="orbio-copy-handoff">Copy handoff</button><a class="button primary" id="orbio-official-launch" target="_blank" rel="noopener noreferrer">Open official Orbio launch ↗</a><button type="button" class="text-button" id="orbio-handoff-edit">Edit mission</button></div><p id="orbio-handoff-availability" class="orbio-quiet"></p><div class="orbio-after-launch"><span>Already launched?</span><button class="text-button" id="orbio-find-after-launch">Find your public agent ↗</button></div><p data-orbio-feedback role="status" class="orbio-feedback"></p></div>`;
    workspace.querySelector('#orbio-copy-handoff').onclick = async () => { try { await navigator.clipboard.writeText(handoffText(d)); feedback('Handoff copied'); } catch { feedback('Clipboard unavailable You can copy the displayed mission details manually', true); } };
    workspace.querySelector('#orbio-handoff-edit').onclick = renderPrepare;
    workspace.querySelector('#orbio-find-after-launch').onclick = () => switchTab('agents');
    updateExternalLaunch();
  }
  function renderRobloxHandoff(d) {
    const workspace = launchBody.querySelector('#orbio-workspace');
    workspace.innerHTML = `<div class="orbio-handoff"><div class="orbio-handoff-identity"><span class="orbio-agent-avatar">${html(d.name?.charAt(0).toUpperCase() || 'R')}</span><div><span class="orbio-small-label">BUILDER BRIEF / READY FOR REVIEW</span><h3>${html(d.name)} <span>$${html(d.ticker)}</span></h3><p>${html(d.brief)}</p></div></div><dl class="orbio-handoff-details"><div><dt>BUILD DIRECTION</dt><dd>Original prompt<small>${html(d.inspiration || 'No reference games supplied')}</small></dd></div><div><dt>BUILDER MODEL</dt><dd>${html(d.modelName)}<small>${html(d.modelId)}</small></dd></div><div><dt>BUILD WORKSPACE</dt><dd>Created after confirmation<small>Linked to the verified coin launch</small></dd></div><div><dt>STUDIO WORKER</dt><dd>Connection required<small>Execution and AI compute need setup</small></dd></div></dl><p class="orbio-handoff-note">Review the current quote before approving real ETH in your wallet Your game brief will be linked to the confirmed token A saved brief alone does not create a coin or run Roblox Studio</p><div class="orbio-handoff-actions"><button class="button" id="orbio-copy-handoff">Copy builder brief</button><button type="button" class="text-button" id="orbio-handoff-edit">Edit game brief</button></div><p data-orbio-feedback role="status" class="orbio-feedback"></p></div>`;
    workspace.querySelector('#orbio-copy-handoff').onclick = async () => { try { await navigator.clipboard.writeText(handoffText(d)); feedback('Builder brief copied'); } catch { feedback('Clipboard unavailable You can copy the displayed brief manually', true); } };
    workspace.querySelector('#orbio-handoff-edit').onclick = renderPrepare;
  }

  function renderAgents() {
    const workspace = launchBody.querySelector('#orbio-workspace');
    workspace.innerHTML = `<div class="orbio-agent-tools"><div><h3>Find the agent onchain</h3><p>Live public records from Orbio No wallet connection is needed to inspect them</p></div><form id="orbio-agent-lookup"><input name="agent" required placeholder="Agent ID or 0x token address" aria-label="Orbio agent ID or token address" autocomplete="off"><button class="button primary" type="submit">Look up ↗</button></form></div><p data-orbio-feedback role="status" class="orbio-feedback"></p><div id="orbio-agent-detail"></div><div class="orbio-agent-list-heading"><span class="orbio-small-label">PUBLIC AGENTS</span><button class="text-button" id="orbio-agents-refresh">Refresh ↻</button></div><div id="orbio-agent-list" class="orbio-agent-list"><p class="orbio-empty">Loading the public agent directory</p></div><p class="orbio-quiet">Market data is reported by Orbio Missing prices, caps and fees stay blank Draft associations below stay in this browser and do not establish ownership</p>`;
    workspace.querySelector('#orbio-agent-lookup').onsubmit = event => {
      event.preventDefault(); const value = new FormData(event.currentTarget).get('agent').trim();
      if (!/^\d{1,78}$/.test(value) && !/^0x[0-9a-fA-F]{40}$/.test(value)) return feedback('Enter a numeric Orbio agent ID or a 0x token address', true);
      lookupAgent(value);
    };
    workspace.querySelector('#orbio-agents-refresh').onclick = loadAgents;
    loadAgents();
  }
  async function loadAgents() {
    const version = ++state.listVersion;
    const host = launchBody.querySelector('#orbio-agent-list');
    if (!host) return;
    host.innerHTML = '<p class="orbio-empty">Reading Orbio public agents</p>';
    try {
      const payload = await read('/api/orbio/agents?limit=12&offset=0');
      if (version !== state.listVersion || !host.isConnected) return;
      state.agents = Array.isArray(payload.data) ? payload.data : [];
      host.innerHTML = state.agents.length ? state.agents.map((a, index) => `<button type="button" class="orbio-agent-card" data-orbio-agent-index="${index}"><span class="orbio-agent-avatar">${html((a.symbol || a.name || 'O').charAt(0))}</span><span><b>${html(a.name || 'Agent ' + a.agentId)}</b><small>${html(a.symbol ? '$' + a.symbol : 'Symbol unavailable')} · ID ${html(a.agentId)}</small></span><span class="orbio-agent-card-cap"><b>${money(a.price?.marketCapMicroUsd, 2)}</b><small>Market cap</small></span><span>↗</span></button>`).join('') : '<p class="orbio-empty">No public agents were returned</p>';
      host.querySelectorAll('[data-orbio-agent-index]').forEach(button => { button.onclick = () => lookupAgent(state.agents[Number(button.dataset.orbioAgentIndex)].agentId); });
    } catch (error) { if (version === state.listVersion && host.isConnected) host.innerHTML = '<p class="orbio-empty is-error">' + html(error.message) + '</p>'; }
  }
  async function lookupAgent(id) {
    const version = ++state.lookupVersion;
    const host = launchBody.querySelector('#orbio-agent-detail');
    if (!host) return;
    feedback('Reading agent ' + id);
    try {
      const payload = await read('/api/orbio/agents/' + encodeURIComponent(id));
      if (version !== state.lookupVersion || !host.isConnected) return;
      const agent = payload.data;
      if (!agent || agent.agentId === undefined || Number(agent.chainId ?? payload.chainId) !== 4663) throw new Error('Orbio returned an unrecognized agent record');
      state.selectedAgent = agent;
      renderAgentDetail(host, agent, payload.checkedAt);
      feedback('Public record loaded · No ownership claim has been verified');
      host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) { if (version === state.lookupVersion && host.isConnected) feedback(error.message, true); }
  }
  function renderAgentDetail(host, a, checkedAt) {
    const association = state.drafts.find(d => String(d.agentId) === String(a.agentId));
    host.innerHTML = `<article class="orbio-agent-detail"><div class="orbio-record-heading"><div><span class="orbio-small-label">PUBLIC ORBIO RECORD / ${html(a.agentId)}</span><h3>${html(a.name || 'Unnamed agent')} <span>${html(a.symbol ? '$' + a.symbol : '')}</span></h3><p>${html(a.description || 'No public description provided')}</p></div><span class="orbio-record-network">Robinhood Chain · 4663</span></div><div class="orbio-market-grid"><div><span>MARKET CAP</span><strong>${money(a.price?.marketCapMicroUsd, 2)}</strong></div><div><span>TOKEN PRICE</span><strong>${money(a.price?.priceMicroUsd)}</strong></div><div><span>CLAIMED FEES</span><strong>${exactUnits(a.stake?.claimedFeesWei, 18, 6)}</strong><small>ORBIO</small></div><div><span>PROTOCOL FEES</span><strong>${exactUnits(a.stake?.protocolFeeWei, 18, 6)}</strong><small>ORBIO</small></div></div><div class="orbio-record-source"><span>Source: ${html(a.price?.source || 'Orbio public API')} · ${html(timestamp(checkedAt))}</span><a href="${html(safeLink(a.links?.token))}" target="_blank" rel="noopener noreferrer">Inspect token ${html(short(a.token))} ↗</a>${a.links?.launchTx ? '<a href="' + html(safeLink(a.links.launchTx)) + '" target="_blank" rel="noopener noreferrer">Launch transaction ↗</a>' : ''}</div><div class="orbio-association"><div><b>${association ? 'Local mission association saved' : 'Link a saved mission draft'}</b><p>${association ? html(association.kind === 'roblox' ? association.template + ' builder' : association.cameraName) + ' · ' + html(association.modelName) : 'Select a saved mission draft to associate with this public record in your browser'}</p><small>Owner unverified · Runtime not connected · Compute not funded</small></div>${state.drafts.length ? '<div><select id="orbio-association-draft" aria-label="Mission draft to associate">' + state.drafts.map(d => '<option value="' + html(d.id) + '"' + (d.id === (association || state.activeDraft)?.id ? ' selected' : '') + '>' + html(d.name + ' · ' + (d.kind === 'roblox' ? d.template : d.cameraName)) + '</option>').join('') + '</select><button class="button small" id="orbio-associate">Save local association</button></div>' : '<button class="button small" id="orbio-prepare-association">Prepare an agent mission ↗</button>'}</div></article>`;
    host.querySelector('#orbio-prepare-association')?.addEventListener('click', () => switchTab('prepare'));
    host.querySelector('#orbio-associate')?.addEventListener('click', () => {
      const id = host.querySelector('#orbio-association-draft').value;
      const drafts = state.drafts.map(d => d.id === id ? { ...d, agentId: String(a.agentId), agentToken: a.token || null, associatedAt: new Date().toISOString(), ownerVerified: false, runtimeConnected: false } : d);
      try { localStorage.setItem(STORAGE, JSON.stringify(drafts)); } catch { return feedback('The association could not be saved in this browser', true); }
      state.drafts = drafts; state.activeDraft = drafts.find(d => d.id === id);
      renderAgentDetail(host, a, checkedAt);
      feedback('Local association saved · No runtime or compute balance changed');
    });
  }
  const EVM_CHAIN = '0x1237';
  const PENDING_STORAGE = 'parallax.orbio.pending.v1';
  const walletRecords = new Map();
  const walletBrands = {
    phantom: { name: 'Phantom', rdns: 'app.phantom', icon: 'assets/wallets/phantom.svg' },
    metamask: { name: 'MetaMask', rdns: 'io.metamask', icon: 'assets/wallets/metamask.svg' },
    rabby: { name: 'Rabby Wallet', rdns: 'io.rabby', icon: 'assets/wallets/rabby.svg' },
    coinbase: { name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet', icon: 'assets/wallets/coinbase.svg' },
    rainbow: { name: 'Rainbow', rdns: 'me.rainbow', icon: 'assets/wallets/rainbow.svg' },
  };
  const walletDialog = document.createElement('dialog');
  walletDialog.id = 'orbio-wallet-dialog';
  document.body.append(walletDialog);
  let walletConnecting = false;
  function normalizeChain(value) { try { return '0x' + BigInt(value).toString(16); } catch { return null; } }
  function currentAddress(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null; }
  function walletLogo(id, record) {
    const icon = record?.icon || walletBrands[id]?.icon;
    return icon ? `<img src="${html(icon)}" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${html((record?.name || walletBrands[id]?.name || 'W').slice(0, 1))}</span>` : `<span>${html((record?.name || 'W').slice(0, 1))}</span>`;
  }
  function updateEvmHeader() {
    document.querySelectorAll('.header [data-open="wallet"]').forEach(button => {
      const wallet = state.evmWallet;
      button.innerHTML = wallet ? `<span class="orbio-header-wallet-logo">${walletLogo(wallet.id, wallet)}</span><span>${html(short(wallet.address))}</span>` : '<img class="wallet-brand-icon" src="assets/model-logos/phantom-wallet.svg" alt="" aria-hidden="true"><span>Connect wallet</span>';
      button.title = wallet ? wallet.name + ' · Ethereum · ' + wallet.address : 'Connect an Ethereum wallet';
    });
  }
  function invalidateEvm(reason) {
    state.walletEpoch++; state.intent = null;
    state.authInvalidation = state.authInvalidation.catch(() => {}).then(() => post('/api/orbio/auth/logout', {}));
    state.authInvalidation.catch(() => {});
    const approve = launchBody.querySelector('#orbio-send-transaction');
    if (approve) { approve.disabled = true; feedback(reason + ' Review a fresh launch quote', true); }
    updateEvmHeader();
    window.dispatchEvent(new CustomEvent('parallax-evm-wallet-invalidate', { detail: { reason } }));
    window.dispatchEvent(new CustomEvent('parallax-evm-wallet-change', { detail: { address: state.evmWallet?.address || null, chainId: state.evmWallet?.chainId || null, id: state.evmWallet?.id || null } }));
    if (walletDialog.open) renderWalletPicker();
  }
  function detachEvm(wallet) {
    if (!wallet) return;
    wallet.provider.removeListener?.('accountsChanged', wallet.onAccounts);
    wallet.provider.removeListener?.('chainChanged', wallet.onChain);
    wallet.provider.removeListener?.('disconnect', wallet.onDisconnect);
  }
  function registerProvider(record) {
    if (!record || typeof record.id !== 'string' || !record.provider?.request) return;
    const old = walletRecords.get(record.id);
    walletRecords.set(record.id, { ...old, ...record });
    if (walletDialog.open) renderWalletPicker();
  }
  function discoverLegacy() {
    const candidates = [...(Array.isArray(window.ethereum?.providers) ? window.ethereum.providers : []), window.ethereum, window.phantom?.ethereum, window.coinbaseWalletExtension, window.rabby, window.rainbow].filter(Boolean);
    for (const provider of new Set(candidates)) {
      if (!provider.request) continue;
      const id = provider === window.phantom?.ethereum || provider.isPhantom ? 'phantom' : provider.isRabby ? 'rabby' : provider.isCoinbaseWallet ? 'coinbase' : provider.isRainbow ? 'rainbow' : provider.isMetaMask ? 'metamask' : null;
      if (id && !walletRecords.has(id)) registerProvider({ id, ...walletBrands[id], provider, status: 'detected' });
    }
  }
  window.addEventListener('eip6963:announceProvider', event => {
    const { info, provider } = event.detail || {};
    if (!info || !provider?.request) return;
    const rdns = String(info.rdns || '').toLowerCase();
    const brandByRdns = { 'app.phantom': 'phantom', 'io.metamask': 'metamask', 'io.metamask.flask': 'metamask', 'io.rabby': 'rabby', 'com.coinbase.wallet': 'coinbase', 'com.coinbase.wallet.extension': 'coinbase', 'me.rainbow': 'rainbow' };
    const id = brandByRdns[rdns] || 'announced-' + String(info.uuid || rdns).slice(0, 80);
    const announcedIcon = /^data:image\/(?:svg\+xml|png|webp|jpeg);/i.test(info.icon || '') ? info.icon : undefined;
    registerProvider({ id, name: walletBrands[id]?.name || String(info.name || 'Ethereum wallet').slice(0, 60), provider, icon: announcedIcon || walletBrands[id]?.icon, status: 'detected' });
  });
  function renderWalletPicker(message = '', isError = false) {
    const installed = [...walletRecords.values()].filter(r => r.id !== 'walletconnect' && r.status !== 'unconfigured' && r.status !== 'unavailable');
    const popular = Object.entries(walletBrands).filter(([id]) => !installed.some(r => r.id === id));
    function row(id, record, detected) {
      const name = record?.name || walletBrands[id].name;
      return `<button class="orbio-wallet-row" type="button" data-evm-wallet="${html(id)}" ${walletConnecting ? 'disabled' : ''}><span class="orbio-wallet-logo">${walletLogo(id, record)}</span><span><b>${html(name)}</b><small>${detected ? 'Detected in this browser' : 'Extension not detected'}</small></span><span class="orbio-wallet-row-status">${detected ? 'Connect ↗' : 'Not detected'}</span></button>`;
    }
    const wallet = state.evmWallet;
    walletDialog.innerHTML = `<div class="orbio-wallet-head"><span>WALLET / ETHEREUM</span><button type="button" aria-label="Close Ethereum wallet picker" id="evm-wallet-close">×</button></div><h2>${wallet ? 'Wallet connected' : 'Connect a wallet'}</h2><p>Choose an installed extension to connect its Ethereum account</p>${wallet ? `<div class="orbio-connected-wallet"><div class="orbio-wallet-logo">${walletLogo(wallet.id, wallet)}</div><div><b>${html(wallet.name)}</b><span>${html(wallet.address)}</span><small>${wallet.chainId === EVM_CHAIN ? 'Robinhood Chain · Mainnet · 4663' : 'Connected network · ' + html(wallet.chainId ? Number(BigInt(wallet.chainId)) : 'Unknown')}</small></div><button type="button" id="evm-disconnect">Disconnect</button></div>` : ''}${installed.length ? '<div class="orbio-wallet-group"><span>INSTALLED</span>' + installed.map(r => row(r.id, r, true)).join('') + '</div>' : ''}<div class="orbio-wallet-group"><span>${installed.length ? 'OTHER WALLETS' : 'DESKTOP WALLETS'}</span>${popular.map(([id]) => row(id, walletRecords.get(id), false)).join('')}</div><div class="orbio-wallet-status ${isError ? 'is-error' : ''}" role="status">${html(message || (installed.length ? 'Connection shares your public account Signing and transactions require separate approval' : 'No Ethereum extension was detected Open this localhost page in the browser where your wallet is installed'))}</div><div class="orbio-wallet-bottom"><span>Desktop wallet connections</span><button type="button" id="evm-detect-again">Detect again ↻</button></div>`;
    walletDialog.querySelector('#evm-wallet-close').onclick = () => walletDialog.close();
    walletDialog.querySelectorAll('[data-evm-wallet]').forEach(button => { button.onclick = () => connectEvm(button.dataset.evmWallet); });
    walletDialog.querySelector('#evm-detect-again').onclick = () => { discoverLegacy(); window.dispatchEvent(new Event('eip6963:requestProvider')); renderWalletPicker('Checking for Ethereum wallet extensions'); };
    walletDialog.querySelector('#evm-disconnect')?.addEventListener('click', () => { detachEvm(state.evmWallet); state.evmWallet = null; invalidateEvm('Wallet disconnected'); renderWalletPicker('Disconnected from this app'); });
  }
  async function connectEvm(id) {
    if (walletConnecting) return;
    discoverLegacy();
    const record = walletRecords.get(id);
    if (!record?.provider?.request || record.status === 'unconfigured' || record.status === 'unavailable') { renderWalletPicker(record?.message || (walletBrands[id]?.name || 'This wallet') + ' is not detected Open this site in a browser with that extension installed and enabled', true); return; }
    const epoch = state.walletEpoch;
    walletConnecting = true; renderWalletPicker('Approve the connection in ' + record.name);
    try {
      const accounts = await record.provider.request({ method: 'eth_requestAccounts' });
      const address = currentAddress(accounts?.[0]);
      if (!address) throw new Error('The wallet did not return an Ethereum account');
      const [currentAccounts, currentChain] = await Promise.all([record.provider.request({ method: 'eth_accounts' }), record.provider.request({ method: 'eth_chainId' })]);
      if (epoch !== state.walletEpoch || currentAddress(currentAccounts?.[0]) !== address) throw new Error('The wallet account changed during connection Choose the intended account and reconnect');
      const chainId = normalizeChain(currentChain);
      detachEvm(state.evmWallet);
      const wallet = { ...record, address, chainId };
      wallet.onAccounts = accounts => { if (state.evmWallet !== wallet) return; const address = currentAddress(accounts?.[0]); if (address === wallet.address) return; if (address) wallet.address = address; else { detachEvm(wallet); state.evmWallet = null; } invalidateEvm('The connected wallet account changed'); };
      wallet.onChain = chain => { if (state.evmWallet !== wallet) return; wallet.chainId = normalizeChain(chain); invalidateEvm('The wallet network changed'); };
      wallet.onDisconnect = () => { if (state.evmWallet !== wallet) return; detachEvm(wallet); state.evmWallet = null; invalidateEvm('Wallet disconnected'); };
      state.evmWallet = wallet;
      wallet.provider.on?.('accountsChanged', wallet.onAccounts); wallet.provider.on?.('chainChanged', wallet.onChain); wallet.provider.on?.('disconnect', wallet.onDisconnect);
      invalidateEvm('Wallet connected');
      renderWalletPicker('Connected to ' + record.name + ' Wallet approval is still required before signing or spending');
    } catch (error) { renderWalletPicker(error?.code === 4001 || /reject|cancel/i.test(error?.message || '') ? 'Connection cancelled You can try again when ready' : error.message || 'The wallet could not connect', true); }
    finally { walletConnecting = false; if (walletDialog.open) walletDialog.querySelectorAll('[data-evm-wallet]').forEach(button => { button.disabled = false; }); }
  }
  function openEvmWallet() {
    discoverLegacy(); window.dispatchEvent(new Event('eip6963:requestProvider')); renderWalletPicker();
    if (!walletDialog.open) walletDialog.showModal();
  }
  async function checkWallet(wallet, { requireChain = true } = {}) {
    if (!wallet || state.evmWallet !== wallet) throw new Error('Reconnect the Ethereum wallet for this launch');
    const [accounts, chain] = await Promise.all([wallet.provider.request({ method: 'eth_accounts' }), wallet.provider.request({ method: 'eth_chainId' })]);
    if (currentAddress(accounts?.[0]) !== wallet.address) throw new Error('The wallet account changed Review the launch again');
    if (requireChain && normalizeChain(chain) !== EVM_CHAIN) throw new Error('Select Robinhood Chain mainnet in your wallet before continuing');
    return wallet.address;
  }
  async function authenticateEvm(wallet) {
    await state.authInvalidation;
    await checkWallet(wallet);
    const epoch = state.walletEpoch;
    const session = await read('/api/orbio/auth/session');
    if (session.authenticated && currentAddress(session.address) === wallet.address) return;
    const challenge = await post('/api/orbio/auth/challenge', { address: wallet.address });
    const message = '0x' + [...new TextEncoder().encode(challenge.message)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = await wallet.provider.request({ method: 'personal_sign', params: [message, wallet.address] });
    if (epoch !== state.walletEpoch) throw new Error('The wallet changed during sign-in Start again with the intended account');
    await checkWallet(wallet);
    const verified = await post('/api/orbio/auth/verify', { id: challenge.id, signature });
    if (epoch !== state.walletEpoch || !verified.authenticated || currentAddress(verified.address) !== wallet.address) throw new Error('The Ethereum wallet sign-in could not be verified');
    window.ParallaxBuilders?.refresh();
  }
  async function switchToRobinhood() {
    const wallet = state.evmWallet;
    if (!wallet) return openEvmWallet();
    try {
      try { await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: EVM_CHAIN }] }); }
      catch (error) {
        if (error.code !== 4902) throw error;
        await wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: EVM_CHAIN, chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robin.etherscan.io'] }] });
      }
      wallet.chainId = normalizeChain(await wallet.provider.request({ method: 'eth_chainId' }));
      updateEvmHeader();
      feedback(wallet.chainId === EVM_CHAIN ? 'Robinhood Chain selected You can now review the ETH launch' : 'Select Robinhood Chain in your wallet', wallet.chainId !== EVM_CHAIN);
    } catch (error) { feedback(error?.code === 4001 ? 'Network change cancelled' : error.message || 'The network could not be selected', true); }
  }
  function readPending() { try { const values = JSON.parse(localStorage.getItem(PENDING_STORAGE) || '[]'); return Array.isArray(values) ? values.filter(p => p && typeof p.intentId === 'string' && (/^0x[0-9a-fA-F]{64}$/.test(p.hash || '') || p.stage === 'wallet_request')).slice(0, 40) : []; } catch { return []; } }
  function rememberRequested(intent) {
    const pending = [{ intentId: intent.intentId, stage: 'wallet_request', owner: intent.owner, chainId: 4663, savedAt: new Date().toISOString() }, ...readPending().filter(p => p.intentId !== intent.intentId)].slice(0, 40);
    localStorage.setItem(PENDING_STORAGE, JSON.stringify(pending));
  }
  function rememberHash(intent, hash, manualHash = false) {
    const pending = [{ intentId: intent.intentId, hash, manualHash, owner: intent.owner, chainId: 4663, savedAt: new Date().toISOString() }, ...readPending().filter(p => p.intentId !== intent.intentId)].slice(0, 40);
    localStorage.setItem(PENDING_STORAGE, JSON.stringify(pending));
  }
  function forgetHash(intentId) { try { localStorage.setItem(PENDING_STORAGE, JSON.stringify(readPending().filter(p => p.intentId !== intentId))); } catch {} }
  async function prepareMainnet(draft) {
    if (state.launchBusy) return;
    if (draft.kind === 'roblox' && !advancedModelIds.includes(draft.modelId)) { feedback('Edit this game brief and choose Claude Opus 5.5 or GPT-6 Astra before reviewing its launch', true); return; }
    const wallet = state.evmWallet;
    if (!wallet) { openEvmWallet(); return; }
    if (wallet.chainId !== EVM_CHAIN) { feedback('This launch uses real ETH on Robinhood Chain Select the network first', true); launchBody.querySelector('#orbio-switch-network')?.removeAttribute('hidden'); return; }
    const ownPending = readPending().find(p => currentAddress(p.owner) === wallet.address);
    if (ownPending) { renderPending(ownPending, 'A submitted transaction is saved Check its result before preparing another launch'); return; }
    const version = state.version, epoch = state.walletEpoch;
    state.launchBusy = true;
    feedback('Approve the sign-in message Then the server will simulate and quote this launch');
    try {
      await authenticateEvm(wallet);
      const mission = draft.kind === 'roblox'
        ? { kind: 'roblox', name: draft.name, ticker: draft.ticker, brief: draft.brief, modelId: draft.modelId, template: 'auto', inspiration: draft.inspiration || '' }
        : { name: draft.name, ticker: draft.ticker, brief: draft.brief, cameraId: draft.cameraId, modelId: draft.modelId, intervalMinutes: draft.intervalMinutes };
      const intent = await post('/api/orbio/launches/prepare', { mission, agentWallet: wallet.address });
      if (version !== state.version || epoch !== state.walletEpoch || !launchDialog.open) return;
      if (intent.status === 'confirmed') { forgetHash(intent.intentId); renderConfirmed(intent); return; }
      if (intent.status === 'pending') {
        if (/^0x[0-9a-fA-F]{64}$/.test(intent.hash || '')) rememberHash(intent, intent.hash);
        renderPending(intent, 'This mission already has a submitted transaction Check that launch instead of signing another');
        return;
      }
      if (intent.status !== 'prepared' || normalizeChain(intent.transaction?.chainId) !== EVM_CHAIN || currentAddress(intent.transaction?.from) !== wallet.address || intent.quote?.realFunds !== true) throw new Error('The launch quote does not match this wallet and network');
      if (intent.quote.simulation !== 'passed' || typeof intent.quote.publicMetadata?.description !== 'string' || !intent.quote.publicMetadata.description) throw new Error('The complete simulated launch and public description are required before wallet approval Refresh the launch quote');
      state.intent = intent;
      renderMainnetReview(intent, draft);
    } catch (error) { if (version === state.version) feedback(error?.code === 4001 || /reject|cancel/i.test(error?.message || '') ? 'Wallet approval cancelled No launch was sent' : error.message, true); }
    finally { state.launchBusy = false; }
  }
  function renderMainnetReview(intent, draft) {
    const quote = intent.quote;
    const workspace = launchBody.querySelector('#orbio-workspace');
    const fee = exactUnits(quote.launchFeeWei, 18, 18), gas = exactUnits(quote.estimatedGasWei, 18, 18), total = exactUnits(quote.estimatedTotalWei, 18, 18);
    workspace.innerHTML = `<div class="orbio-real-launch"><span class="orbio-real-money">MAINNET / REAL ETH</span><h3>Review your Orbio launch</h3><p>${html(draft.name)} · $${html(draft.ticker)} · Robinhood Chain 4663</p><div class="orbio-real-total"><span>ESTIMATED TOTAL</span><strong>${total} ETH</strong><small>Includes the launch fee and estimated network gas</small></div><dl class="orbio-real-quote"><div><dt>Launch fee</dt><dd>${fee} ETH</dd></div><div><dt>Estimated gas</dt><dd>${gas} ETH</dd></div><div><dt>Agent wallet</dt><dd>${html(intent.agentWallet)}</dd></div><div><dt>Launch contract</dt><dd>${html(intent.transaction.to)}</dd></div><div><dt>Base curve trading fee</dt><dd>${quote.baseTradeFeeBps == null ? "—" : html(Number(quote.baseTradeFeeBps) / 100) + "%"}</dd></div><div><dt>Additional creator tax</dt><dd>${quote.creatorTaxBps == null ? "—" : html(Number(quote.creatorTaxBps) / 100) + "%"}</dd></div><div><dt>Orbio share of creator fees</dt><dd>${quote.protocolFeeBps == null ? "—" : html(Number(quote.protocolFeeBps) / 100) + "%"}</dd></div><div><dt>Public token description</dt><dd class="orbio-public-description record-summary">${html(quote.publicMetadata?.description || "Not supplied")}</dd></div><div><dt>Simulation</dt><dd>Passed · not yet a launch</dd></div><div><dt>Quote expires</dt><dd>${html(new Date(intent.expiresAt).toLocaleTimeString())}</dd></div></dl><div class="orbio-real-boundary"><b>This uses real funds</b><p>Name, symbol and the displayed token description are published onchain The full ${draft.kind === 'roblox' ? 'game brief' : 'camera plan'} stays on this server ${draft.kind === 'roblox' ? 'Roblox Studio execution and AI compute require setup' : 'AI runtime still requires setup'} and this launch does not fund a Ropad compute balance</p></div><label class="orbio-real-ack"><input type="checkbox" id="orbio-real-ack">I understand this spends real ETH on Robinhood Chain mainnet</label><div class="orbio-handoff-actions"><button class="button" id="orbio-quote-back">Back to mission</button><button class="button primary" id="orbio-send-transaction" disabled>Approve real ETH launch in wallet ↗</button></div><p data-orbio-feedback role="status" class="orbio-feedback"></p></div>`;
    workspace.querySelector('#orbio-quote-back').onclick = () => { state.intent = null; renderHandoff(draft); };
    workspace.querySelector('#orbio-real-ack').onchange = event => { workspace.querySelector('#orbio-send-transaction').disabled = !event.target.checked || state.intent !== intent; };
    workspace.querySelector('#orbio-send-transaction').onclick = () => sendMainnet(intent, draft);
  }
  async function sendMainnet(intent, draft) {
    if (state.launchBusy || state.intent !== intent || !launchBody.querySelector('#orbio-real-ack')?.checked) return;
    const wallet = state.evmWallet, epoch = state.walletEpoch;
    const approve = launchBody.querySelector('#orbio-send-transaction');
    state.launchBusy = true; approve.disabled = true;
    try {
      const expiresAt = new Date(intent.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt || intent.quoteExpired) throw new Error('This quote expired Return to the mission and prepare a fresh quote');
      await checkWallet(wallet);
      if (wallet.address !== currentAddress(intent.owner) || epoch !== state.walletEpoch) throw new Error('The wallet changed Review a fresh launch quote');
      try { rememberRequested(intent); } catch { throw new Error('Browser storage is unavailable A launch cannot be sent without saving its recovery record'); }
      feedback('Review the real ETH transaction in ' + wallet.name);
      let hash;
      try { hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [intent.transaction] }); }
      catch (error) {
        if (error?.code === 4001) { forgetHash(intent.intentId); throw error; }
        state.intent = null;
        renderPending(intent, 'The wallet did not provide a definite submission result Check wallet activity and enter its transaction hash before attempting another launch');
        return;
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) { state.intent = null; renderPending(intent, 'The wallet returned no transaction hash Check wallet activity to recover the submitted transaction'); return; }
      // Preserve a returned hash before any network/account check or confirmation call
      try { rememberHash(intent, hash); } catch { renderPending({ ...intent, hash }, 'The transaction was submitted but browser recovery storage failed Save the transaction hash below'); return; }
      const pending = { ...intent, hash };
      if (epoch !== state.walletEpoch) { renderPending(pending, 'Wallet state changed after submission Reconnect the original account and check confirmation'); return; }
      try { await checkWallet(wallet); } catch { renderPending(pending, 'Wallet account or network changed after submission The transaction is saved for recovery'); return; }
      renderPending(pending, 'Submitted to the wallet Awaiting verified onchain confirmation');
      await confirmMainnet(pending, draft);
    } catch (error) {
      feedback(error?.code === 4001 || /reject|cancel/i.test(error?.message || '') ? 'Transaction approval cancelled No launch was confirmed' : error.message, true);
      if (approve.isConnected) approve.disabled = state.intent !== intent;
    } finally { state.launchBusy = false; }
  }
  function renderPending(intent, message) {
    const workspace = launchBody.querySelector('#orbio-workspace');
    const editableHash = !intent.hash || intent.manualHash === true;
    workspace.innerHTML = `<div class="orbio-pending-launch"><span class="orbio-real-money">WALLET REQUEST / CONFIRMATION REQUIRED</span><h3>Check this launch before retrying</h3><p>${html(message)}</p>${intent.hash ? '<a class="orbio-pending-hash" href="https://robin.etherscan.io/tx/' + html(intent.hash) + '" target="_blank" rel="noopener noreferrer">' + html(intent.hash) + ' ↗</a>' : '<label class="orbio-recovery-label">Transaction hash from wallet activity<input id="orbio-recovery-hash" placeholder="0x…" autocomplete="off"></label>'}<p class="orbio-quiet">A transaction hash is not proof of a successful launch We verify the sender, contract, call data, amount and launch event before showing confirmation</p><button class="button primary" id="orbio-check-confirmation">Check launch confirmation ↻</button><p data-orbio-feedback role="status" class="orbio-feedback"></p></div>`;
    workspace.querySelector('#orbio-check-confirmation').onclick = () => {
      if (editableHash) {
        const hash = workspace.querySelector('#orbio-recovery-hash')?.value.trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) return feedback('Enter the 0x transaction hash shown in your wallet activity', true);
        try { rememberHash(intent, hash, true); } catch { return feedback('The recovery transaction could not be saved', true); }
        intent = { ...intent, hash, manualHash: true };
      }
      confirmMainnet(intent, state.activeDraft);
    };
    if (editableHash && intent.hash) {
      workspace.querySelector('.orbio-pending-hash')?.remove();
      const label = document.createElement('label'); label.className = 'orbio-recovery-label'; label.textContent = 'Transaction hash from wallet activity';
      const input = document.createElement('input'); input.id = 'orbio-recovery-hash'; input.value = intent.hash; input.autocomplete = 'off'; label.append(input);
      workspace.querySelector('#orbio-check-confirmation').before(label);
    }
  }
  async function confirmMainnet(intent, draft) {
    const button = launchBody.querySelector('#orbio-check-confirmation');
    if (button) button.disabled = true;
    try {
      const wallet = state.evmWallet;
      if (!wallet) { openEvmWallet(); throw new Error('Connect the wallet that submitted this transaction'); }
      if (wallet.address !== currentAddress(intent.owner)) throw new Error('Connect the original launch wallet to confirm this transaction');
      await authenticateEvm(wallet);
      feedback('Checking the transaction and its launch event on Robinhood Chain');
      const result = await post('/api/orbio/launches/confirm', { intentId: intent.intentId, hash: intent.hash });
      if (result.status === 'reverted' && result.finalized === true) {
        forgetHash(intent.intentId); state.intent = null;
        const workspace = launchBody.querySelector('#orbio-workspace');
        workspace.innerHTML = `<div class="orbio-pending-launch"><span class="orbio-real-money">FINALIZED / REVERTED</span><h3>The launch reverted onchain</h3><p>No agent was created by this transaction Network gas may have been spent</p><a class="orbio-pending-hash" href="https://robin.etherscan.io/tx/${html(intent.hash)}" target="_blank" rel="noopener noreferrer">${html(intent.hash)} ↗</a><button class="button" id="orbio-review-after-revert">Return to mission for a fresh review</button><p data-orbio-feedback role="status" class="orbio-feedback"></p></div>`;
        workspace.querySelector('#orbio-review-after-revert').onclick = () => draft ? renderHandoff(draft) : renderPrepare();
        return;
      }
      if (result.status !== 'confirmed') {
        if (result.hash && /^0x[0-9a-fA-F]{64}$/.test(result.hash)) { rememberHash(result, result.hash); renderPending(result, result.message || 'The transaction matches this launch and is waiting for finalized confirmation'); }
        else feedback(result.message || 'The transaction is still pending Check this same launch again shortly');
        return;
      }
      forgetHash(intent.intentId);
      state.intent = null;
      renderConfirmed(result);
    } catch (error) { feedback(error.message || 'Confirmation could not be completed The saved transaction can be checked again', true); }
    finally { if (button?.isConnected) button.disabled = false; }
  }
  function renderConfirmed(result) {
    const workspace = launchBody.querySelector('#orbio-workspace');
    if (!workspace) return;
    workspace.innerHTML = `<div class="orbio-confirmed-launch"><span class="orbio-small-label">VERIFIED ONCHAIN / ROBINHOOD CHAIN</span><h3>Orbio launch confirmed</h3><p>The server verified the launch transaction and its agent event</p><dl class="orbio-real-quote"><div><dt>Agent ID</dt><dd>${html(result.agentId)}</dd></div><div><dt>Token address</dt><dd>${html(result.token)}</dd></div></dl><div class="orbio-handoff-actions"><a class="button primary" href="${html(safeLink(result.explorerUrl))}" target="_blank" rel="noopener noreferrer">View verified transaction ↗</a><button class="button" id="orbio-inspect-new-agent">Inspect public agent</button></div><p class="orbio-quiet">Camera runtime, ownership linking and Ropad compute funding are separate from this confirmed token launch</p></div>`;
    workspace.querySelector('#orbio-inspect-new-agent').onclick = () => { switchTab('agents'); lookupAgent(result.agentId); };
    if (result.mission?.kind === 'roblox') {
      workspace.querySelector('.orbio-quiet').textContent = 'Your coin launch is verified Connect the Roblox Studio worker and configure AI compute to start building Publishing remains a separate action';
      if (typeof result.buildSession?.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(result.buildSession.id)) {
        const button = document.createElement('a'); button.className = 'button primary'; button.href = '#/build/' + encodeURIComponent(result.buildSession.id); button.textContent = 'Open builder workspace ↗'; button.onclick = () => launchDialog.close();
        workspace.querySelector('.orbio-handoff-actions').prepend(button);
      }
    }
    window.dispatchEvent(new CustomEvent('parallax:orbio-launch-confirmed', { detail: result }));
  }
  function enhanceHandoff() {
    const actions = launchBody.querySelector('.orbio-handoff-actions');
    if (!actions || !state.activeDraft || launchBody.querySelector('#orbio-review-mainnet')) return;
    const review = document.createElement('button'); review.type = 'button'; review.className = 'button primary'; review.id = 'orbio-review-mainnet'; review.textContent = 'Review ETH launch in wallet ↗';
    review.disabled = state.status?.integratedSigningAvailable !== true;
    review.onclick = () => prepareMainnet(state.activeDraft);
    actions.prepend(review);
    const network = document.createElement('button'); network.type = 'button'; network.className = 'button'; network.id = 'orbio-switch-network'; network.textContent = 'Switch to Robinhood Chain'; network.hidden = !state.evmWallet || state.evmWallet.chainId === EVM_CHAIN; network.onclick = switchToRobinhood;
    actions.after(network);
  }
  const originalRenderHandoff = renderHandoff;
  renderHandoff = function (draft) { originalRenderHandoff(draft); enhanceHandoff(); };
  const originalUpdateExternal = updateExternalLaunch;
  updateExternalLaunch = function () { originalUpdateExternal(); const review = launchBody.querySelector('#orbio-review-mainnet'); if (review) review.disabled = state.status?.integratedSigningAvailable !== true; };
  window.openEvmWallet = openEvmWallet;
  window.getEvmWallet = () => state.evmWallet;
  window.RopadWallet = { get: () => state.evmWallet, connect: openEvmWallet, switchChain: switchToRobinhood, whenInvalidated: () => state.authInvalidation, authenticate: async () => { if (!state.evmWallet) throw new Error('Connect the creator wallet first'); await authenticateEvm(state.evmWallet); }, check: async () => { if (!state.evmWallet) throw new Error('Connect a wallet first'); return checkWallet(state.evmWallet); } };
  window.parallaxRegisterEvmProvider = registerProvider;
  for (const provider of window.parallaxPendingEvmProviders || []) registerProvider(provider);
  discoverLegacy(); window.dispatchEvent(new Event('eip6963:requestProvider'));
  window.addEventListener('parallax-wallet-change', updateEvmHeader);
  document.querySelectorAll('.header [data-open="wallet"]').forEach(button => { button.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); openEvmWallet(); }, { capture: true }); });
  updateEvmHeader();
  window.openOrbioIntegration = openIntegration;
  window.openRobloxLaunch = (seed = {}) => openIntegration({ ...(seed && typeof seed === 'object' ? seed : {}), kind: 'roblox' });
  window.openLaunch = chooseDestination;
})();


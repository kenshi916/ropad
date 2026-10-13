(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : '';
  function modelInfo(build) {
    const id = typeof build.modelId === 'string' ? build.modelId : '', provider = id.split('/')[0];
    const name = build.modelName || ({'anthropic/claude-opus-5.5':'Claude Opus 5.5','openai/gpt-6-astra':'GPT-6 Astra'})[id] || id || 'Model not selected';
    const logo = ({anthropic:'anthropic.svg',openai:'openai.svg',google:'google.svg','x-ai':'x-ai.svg'})[provider] || 'openrouter.svg';
    return {name,logo};
  }
  function excerpt(value, limit) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (text.length <= limit) return text;
    const start = text.slice(0, limit - 1), boundary = start.search(/\s+\S*$/);
    return (boundary > 0 ? start.slice(0,boundary).trimEnd() : '') + '…';
  }
  function gameDescription(build) {
    return [build.plan?.summary,build.plan?.design?.coreLoop,build.plan?.design?.objective,build.brief].find(value => typeof value === 'string' && value.trim()) || 'The creator has not added a game description yet';
  }

  function publicationUrl(build) {
    const raw = build?.readiness?.publication?.url;
    if (typeof raw !== 'string' || raw.length > 500) return '';
    const match = /^https:\/\/(?:www\.)?roblox\.com\/games\/([1-9]\d*)(?:\/[a-zA-Z0-9_-]+)?\/?$/.exec(raw);
    return match ? 'https://www.roblox.com/games/' + match[1] : '';
  }
  function artwork(build, id) {
    const prefix = '/api/builds/' + id, raw = build.thumbnail?.imageUrl;
    if (typeof raw === 'string' && raw.split('?')[0] === prefix + '/thumbnail/image' && /^\?v=[a-zA-Z0-9_-]{1,128}$/.test(raw.slice(raw.indexOf('?')))) return {url:raw,label:'AI-generated game artwork',kind:'ARTWORK'};
    const frame = (Array.isArray(build.visualFrames) ? build.visualFrames : []).find(item => item?.view === 'overview' && item.source === 'pooled_studio_worker' && item.jobId === build.jobId && /^[a-f0-9]{64}$/.test(item.hash || ''));
    if (frame) return {url:prefix + '/screen?view=overview&v=' + frame.hash,label:'Captured Roblox Studio view',kind:'STUDIO CAPTURE'};
    if (build.screenshot?.url === prefix + '/screen') return {url:prefix + '/screen',label:'Captured Roblox Studio view',kind:'STUDIO CAPTURE'};
    return null;
  }
  function render(build = {}, helpers = {}) {
    const id = safeId(build.id);
    if (!id) return '<main class="rp-play-page"><div class="rp-play-unavailable"><span class="rp-play-kicker">GAME UNAVAILABLE</span><h1>This game could not be opened</h1><a class="rp-play-button" href="#/">Explore games <span aria-hidden="true">↗</span></a></div></main>';
    const name = build.gameName || build.name || 'Untitled game', model = modelInfo(build), link = publicationUrl(build), art = artwork(build,id);
    const version = Number.isSafeInteger(build.lineage?.version) && build.lineage.version > 0 ? build.lineage.version : 1;
    const owner = build.canManage === true, reviewEligible = owner && build.status === 'ready' && ['passed','smoke_passed'].includes(build.playtestReport?.result);
    const download = build.delivery?.available === true && build.delivery.format === 'rbxlx' && build.delivery.url === '/api/builds/' + id + '/artifact?format=rbxlx' ? build.delivery.url : '';
    const description = excerpt(gameDescription(build),1000), shortDescription = excerpt(description,260);
    const uploaded = build.readiness?.publication?.source==='roblox_open_cloud' && build.publicationReceipt?.status==='published';
    const stateLabel = uploaded ? 'ROBLOX UPLOAD CONFIRMED' : link ? 'RELEASE LINK ADDED' : build.status === 'ready' ? 'AWAITING RELEASE' : 'IN DEVELOPMENT';
    const blankTitle = build.status === 'ready' ? 'The next stop is Roblox' : 'A new world is taking shape';
    const empty = `<div class="rp-play-placeholder"${art?' hidden':''} data-play-image-fallback><div class="rp-play-scene" aria-hidden="true"><i></i><i></i><i></i><span>R</span></div><div><span class="rp-play-kicker">${art?'IMAGE UNAVAILABLE':'YOUR NEXT WORLD'}</span><h2>${art?'The saved image could not load':blankTitle}</h2><p>${art?'You can still inspect this project and its release details':'Game artwork and captured Studio views appear here when the creator adds them'}</p></div></div>`;
    return `<main class="rp-play-page" aria-label="Game page">
      <nav class="rp-play-nav" aria-label="Game navigation"><a href="#/token/${id}"><span aria-hidden="true">←</span> Back to token</a><span>ROPAD / GAMES</span>${owner?`<a href="#/workspace/${id}">Open creator workspace <span aria-hidden="true">↗</span></a>`:`<a href="#/">Explore games <span aria-hidden="true">↗</span></a>`}</nav>
      <div class="rp-play-heading"><div><span class="rp-play-kicker">BUILT WITH ROPAD</span><h1>${esc(name)}</h1><p>${esc(shortDescription)}</p></div><span class="rp-play-version">Version ${version}</span></div>
      <div class="rp-play-layout"><div class="rp-play-feature"><figure class="rp-play-art">${art?`<img data-play-image src="${esc(art.url)}" alt="${esc(art.label)} for ${esc(name)}" decoding="async">`:''}${empty}<figcaption><span data-play-image-label>${art?esc(art.label):'Artwork pending'}</span><span>${art?esc(art.kind):'GAME PROJECT'}</span></figcaption></figure>
        <section class="rp-play-about"><span class="rp-play-kicker">THE EXPERIENCE</span><h2>About this game</h2><p>${esc(description)}</p>${typeof build.plan?.design?.objective==='string'&&build.plan.design.objective.trim()?`<div class="rp-play-objective"><span>YOUR OBJECTIVE</span><p>${esc(excerpt(build.plan.design.objective,600))}</p></div>`:''}</section></div>
        <aside class="rp-play-launch"><div class="rp-play-state"><i aria-hidden="true"></i>${stateLabel}</div><h2>${link?'Ready to explore?':build.status==='ready'?'Not published yet':'Your game is taking shape'}</h2><p>${link?'Open the creator’s game link on Roblox to check access and join the experience':build.status==='ready'?'The scene is assembled The creator still needs to finish their review and add a Roblox release link':'Follow the agent’s progress on the token page The game will open on Roblox once its creator adds a release link'}</p>
          ${link?`<a class="rp-play-button primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open in Roblox <span aria-hidden="true">↗</span></a><p class="rp-play-release-note">${uploaded?'Roblox confirmed the upload · Player access not verified':'Creator supplied · Availability not verified'}</p>`:'<button type="button" class="rp-play-button primary" disabled>Play in Roblox <span aria-hidden="true">↗</span></button><p class="rp-play-release-note">No Roblox release link has been added</p>'}
          <a class="rp-play-button" href="#/release/${id}">Release &amp; earnings <span aria-hidden="true">↗</span></a><a class="rp-play-button" href="#/token/${id}">View token &amp; agent <span aria-hidden="true">↗</span></a>
          <div class="rp-play-model"><img src="assets/model-logos/${model.logo}" alt=""><div><span>BUILDER MODEL</span><strong>${esc(model.name)}</strong></div></div>
          <dl class="rp-play-facts"><div><dt>Platform</dt><dd>Roblox</dd></div><div><dt>Game version</dt><dd>V${version}</dd></div><div><dt>Release link</dt><dd>${uploaded?'Roblox version '+esc(build.publicationReceipt.versionNumber):link?'Creator supplied':'Not added'}</dd></div></dl>
          <p class="rp-play-access">Gameplay opens in Roblox Player Roblox controls sign-in, device support and access to the experience</p>
          ${owner?`<div class="rp-play-creator"><span class="rp-play-kicker">CREATOR CONTROLS</span>${reviewEligible?'<button type="button" class="rp-play-button" data-builder-action="review">Record release review <span aria-hidden="true">↗</span></button>':''}<a class="rp-play-button" href="#/workspace/${id}">Continue in your workspace <span aria-hidden="true">↗</span></a>${download?`<a class="rp-play-download" href="${esc(download)}" download>Download Studio project ↓</a><small>Generated from the saved plan Review and playtest in Studio before publishing</small>`:''}</div>`:''}
        </aside></div>
    </main>`;
  }
  function wire(build, root, helpers = {}) {
    const image = root?.querySelector('[data-play-image]'), fallback = root?.querySelector('[data-play-image-fallback]'), label = root?.querySelector('[data-play-image-label]');
    if (!image || !fallback) return;
    const originalLabel = label?.textContent || '';
    const showFailure = () => { image.hidden = true; fallback.hidden = false; if (label) label.textContent = 'Saved image unavailable'; };
    image.onerror = showFailure;
    image.onload = () => { image.hidden = false; fallback.hidden = true; if (label) label.textContent = originalLabel; };
    if (image.complete && image.naturalWidth === 0) showFailure();
  }
  window.RopadPlayPage = {render,wire,publicationUrl};
})();

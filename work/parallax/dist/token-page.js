(() => {
  'use strict';
  const mounts = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const solAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  const decimal = value => typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
  const nameOf = (build, helpers) => typeof helpers.name === 'function' ? helpers.name(build) : build.gameName || build.name || 'Untitled game';
  const tokenOf = build => build.token || build.coin || {};
  const href = (kind, build, helpers) => '#/' + kind + '/' + encodeURIComponent(build.id);
  function identity(build) {
    const token = tokenOf(build); let wallet;
    try { wallet = /^0x[0-9a-fA-F]{40}$/.test(token.address || '') && token.chain !== 'solana' ? window.RopadWallet?.get?.() : window.RopadSolana?.get?.(); } catch {}
    return JSON.stringify([build.id,token.chain,token.cluster,token.chainId,token.address,token.verified === true,token.symbol,wallet?.address || '',wallet?.id || '',wallet?.chainId || '']);
  }
  const label = build => ({building:'Building in Studio',ready:'Assembled in Studio',failed:'Build needs attention',waiting_for_studio:'Awaiting Studio',queued:'Workspace created'})[build.status] || 'Workspace created';
  function display(value) {
    if (!decimal(value)) return '—';
    const [whole,fraction=''] = value.split('.'), first = fraction.search(/[1-9]/);
    const precision = whole === '0' && first >= 0 ? Math.max(6,first + 4) : 6;
    const rest = fraction.slice(0,precision).replace(/0+$/,'');
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',') + (rest ? '.' + rest : '');
  }
  function network(build) {
    const token = tokenOf(build);
    if (token.chain === 'solana' && token.cluster === 'devnet') return 'Solana devnet';
    if (token.chain === 'solana' && token.cluster === 'testnet') return 'Solana testnet';
    if (token.chain === 'solana' && token.cluster === 'mainnet-beta' && token.verified === true && solAddress(token.address)) return 'Solana mainnet';
    if (/^0x[0-9a-fA-F]{40}$/.test(token.address || '')) return 'Legacy EVM coin';
    return token.address ? 'Coin unverified' : 'Pre-launch';
  }
  function observation(build) {
    const token = tokenOf(build);
    if (token.chain !== 'solana' || token.cluster !== 'mainnet-beta' || token.verified !== true || !solAddress(token.address)) return null;
    try {
      const snapshot = window.RopadSolanaMarket?.snapshot(build), market = snapshot?.market;
      return !snapshot?.error && market?.available === true && market.cluster === 'mainnet-beta' && market.mint === token.address && ['priceSol','marketCapSol','supply'].every(key => decimal(market[key])) && Number.isSafeInteger(market.slot) && market.slot >= 0 && Number.isFinite(market.checkedAt) && market.checkedAt > Date.now() - 300000 && market.checkedAt <= Date.now() + 60000 ? market : null;
    } catch { return null; }
  }
  function imageFor(build) {
    const expected = '/api/builds/' + encodeURIComponent(build.id) + '/thumbnail/image', raw = build.thumbnail?.imageUrl;
    if (typeof raw === 'string') {
      try { const url = new URL(raw, window.location?.origin || 'http://localhost'); if (url.origin === (window.location?.origin || 'http://localhost') && url.pathname === expected) return {url:url.pathname + url.search,label:'AI generated game artwork',kind:'artwork'}; } catch {}
    }
    const playtest=window.RopadLivePlaytest?.cachedPreview(build);if(playtest)return playtest;
    const timestamp = build.screenshot?.capturedAt || build.screen?.updatedAt || build.screen?.lastFrameAt || build.screen?.capturedAt || build.screenUpdatedAt;
    if (build.screenshot || build.screen?.available === true || build.screen?.hasFrame === true || timestamp) return {url:'/api/builds/' + encodeURIComponent(build.id) + '/screen?v=' + encodeURIComponent(timestamp || ''),label:'Last shared Studio capture',kind:'capture'};
    return null;
  }
  function coinImage(build) {
    const raw=build.coinIcon?.imageUrl;
    if(typeof raw!=='string')return '';
    try { const url=new URL(raw,window.location?.origin||'http://localhost');return url.origin===(window.location?.origin||'http://localhost')&&url.pathname==='/api/builds/'+encodeURIComponent(build.id)+'/coinIcon/image'?url.pathname+url.search:''; } catch {return '';}
  }
  function modelName(build, helpers) { return typeof helpers.modelName === 'function' ? helpers.modelName(build) : build.modelName || ({'anthropic/claude-opus-5.5':'Claude Opus 5.5','openai/gpt-6-astra':'GPT-6 Astra'})[build.modelId] || 'Model not selected'; }
  function modelLogo(build) { const provider = String(build.modelId || '').split('/')[0], file = ({anthropic:'anthropic',openai:'openai'})[provider] || 'openrouter'; return '<img src="assets/model-logos/' + file + '.svg" alt="">'; }
  function status(build, helpers) { return typeof helpers.statusLabel === 'function' ? helpers.statusLabel(build) : label(build); }
  function metrics(build) {
    const market = observation(build), hasCoin = Boolean(tokenOf(build).address);
    return `<div class="rp-token-price"><span>Token price</span><strong>${market ? esc(display(market.priceSol)) : '—'}<small>${market ? ' SOL' : ''}</small></strong><p>Market cap <b>${market ? esc(display(market.marketCapSol)) + ' SOL' : '—'}</b></p><span class="rp-price-source">${market ? 'Onchain observation · SOL' : hasCoin ? tokenOf(build).cluster === 'devnet' ? 'Test coin · No real market' : 'Verified market unavailable' : 'Market available after launch'}</span></div>`;
  }
  function heading(build, helpers) {
    const name = nameOf(build,helpers), token = tokenOf(build), symbol = token.symbol || build.ticker || '', image = coinImage(build)?{url:coinImage(build),kind:'artwork'}:imageFor(build);
    return `<div class="rp-token-identity"><div class="rp-token-avatar">${image?.kind === 'artwork' ? `<img src="${esc(image.url)}" alt="">` : `<span>${esc(name.slice(0,2).toUpperCase())}</span>`}</div><div><div class="rp-token-title"><h1>${esc(name)}</h1>${symbol ? `<span class="rp-token-ticker">$${esc(symbol)}</span>` : ''}</div><div class="rp-token-badges"><span><i class="rp-network-dot"></i>${esc(network(build))}</span></div></div></div><div class="rp-token-actions"><a class="rp-button rp-button-secondary" href="${href('workspace',build,helpers)}">Creator studio</a><a class="rp-button rp-button-primary" href="${href('play',build,helpers)}"><span aria-hidden="true">▷</span> Play game</a></div>`;
  }
  function game(build, helpers) {
    const image = imageFor(build), name = nameOf(build,helpers), description = [build.plan?.summary,build.plan?.design?.coreLoop,build.plan?.design?.objective,build.brief].find(value => typeof value === 'string' && value.trim()) || 'The creator’s game brief will appear here';
    const brief = description.length > 240 ? description.slice(0,237).replace(/\s+\S*$/,'').trimEnd() + '…' : description;
    return `<a class="rp-game-visual${image ? '' : ' rp-game-visual-empty'}" href="${href('play',build,helpers)}" aria-label="Open ${esc(name)} game page">${image ? `<img src="${esc(image.url)}" alt="${esc(image.label)} for ${esc(name)}" loading="lazy"><span class="rp-game-image-label">${esc(image.label)}</span>` : `<div><span class="rp-game-empty-icon" aria-hidden="true">⌘</span><strong>A new world starts here</strong><p>The game’s artwork or a real Studio capture will appear as the creator builds</p></div>`}</a><div class="rp-game-content"><h2>About this game</h2><p>${esc(brief)}</p></div>`;
  }
  function agent(build, helpers) {
    const progress = build.progress, completed = Number.isInteger(progress?.completed) && Number.isInteger(progress?.total) && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total ? progress : null;
    return `<div class="rp-agent-model">${modelLogo(build)}<div><span>AI builder</span><strong>${esc(modelName(build,helpers))}</strong></div></div><div class="rp-agent-state"><i></i><span>${esc(status(build,helpers))}</span></div>${completed && completed.completed < completed.total ? `<div class="rp-build-progress"><div><span>Scene assembly</span><span>${completed.completed} / ${completed.total}</span></div><progress value="${completed.completed}" max="${completed.total}">${Math.round(completed.completed / completed.total * 100)}%</progress></div>` : ''}${build.canManage ? '<button class="rp-button rp-button-secondary" data-builder-action="update">Prompt an update <span aria-hidden="true">↗</span></button>' : ''}`;
  }
  function activity(build, helpers) {
    const events = typeof helpers.events === 'function' ? helpers.events(build) : Array.isArray(build.events) ? build.events : Array.isArray(build.actions) ? build.actions : [];
    const rows = events.slice(-4).reverse();
    return `${rows.length ? `<div class="rp-activity-list">${rows.map(event => { const date = new Date(event.createdAt || event.timestamp || event.at), dateLabel = Number.isFinite(date.getTime()) ? date.toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''; return `<article><span class="rp-activity-marker" aria-hidden="true">↗</span><div><p>${esc(event.message || event.title || event.summary || 'Workspace updated')}</p><span>${esc(String(event.type || event.kind || 'Build update').replace(/_/g,' '))}</span></div>${dateLabel ? `<time datetime="${esc(date.toISOString())}">${esc(dateLabel)}</time>` : ''}</article>`; }).join('')}</div>` : '<div class="rp-activity-empty"><p>No recorded activity yet</p></div>'}<a class="rp-text-link" href="${href('workspace',build,helpers)}">View full build history ↗</a>`;
  }
  function details(build) {
    const token = tokenOf(build), market = observation(build), address = token.address, cluster = token.cluster;
    const explorer = token.chain === 'solana' && solAddress(address) && ['mainnet-beta','devnet','testnet'].includes(cluster) ? 'https://explorer.solana.com/address/' + address + (cluster === 'mainnet-beta' ? '' : '?cluster=' + cluster) : '';
    return `<div data-rp-price>${metrics(build)}</div><dl class="rp-token-details"><div><dt>Network</dt><dd>${esc(network(build))}</dd></div><div><dt>Supply</dt><dd>${market ? esc(display(market.supply)) : '—'}</dd></div><div class="rp-token-mint"><dt>Mint address</dt><dd>${address ? `<code>${esc(address)}</code>${explorer ? `<a href="${esc(explorer)}" target="_blank" rel="noopener noreferrer" aria-label="View token on Solana explorer">↗</a>` : ''}` : '<span>Assigned after launch</span>'}</dd></div></dl>`;
  }
  function fallbackTrade() { return '<section class="rp-trade-loading"><h2>Buy / Sell</h2><p>Trading tools are loading</p><span>A verified market and a wallet signature are required to trade</span></section>'; }
  function render(build, helpers = {}) {
    return `<main class="rp-token-page rp-token-simple"><nav class="rp-token-breadcrumb" aria-label="Breadcrumb"><a href="#/">← All games</a></nav><header class="rp-token-header" data-rp-heading>${heading(build,helpers)}</header><div class="rp-token-grid"><div class="rp-token-main"><section class="rp-game-card" id="rp-token-game" data-rp-game>${game(build,helpers)}</section><div data-rp-market>${window.RopadTokenMarket?.panel(build) || '<section class="rp-market-loading"><h2>Market overview</h2><p>Market observations will appear here</p></section>'}</div><div class="rp-project-details"><details class="rp-disclosure"><summary>Latest activity</summary><div data-rp-activity>${activity(build,helpers)}</div></details><details class="rp-disclosure"><summary>Token details</summary><div data-rp-details>${details(build)}</div></details><a class="rp-release-link" href="#/release/${encodeURIComponent(build.id)}">Release & earnings ↗</a></div></div><aside class="rp-token-sidebar" aria-label="Trade and game agent"><div data-rp-trade>${window.ParallaxOrbio?.buildTradePanel?.(build) || fallbackTrade()}</div><section class="rp-agent-card" data-rp-agent>${agent(build,helpers)}</section></aside></div></main>`;
  }
  function replace(root, selector, html) { const node = root.querySelector(selector); if (node && node.innerHTML !== html) node.innerHTML = html; }
  function remember(build, root, helpers) {
    for (const [node] of mounts) if (node.isConnected === false) mounts.delete(node);
    const entry = mounts.get(root) || {}; entry.build = build; entry.helpers = helpers; mounts.set(root,entry); return entry;
  }
  function previewGame(build,root,helpers) {
    window.RopadLivePlaytest?.preview(build,root,()=>{const current=mounts.get(root)?.build;if(current?.id!==build.id||current?.jobId!==build.jobId)return;replace(root,'[data-rp-game]',game(current,helpers));});
  }
  function wire(build, root, helpers = {}) {
    if (!root || root.isConnected === false) return;
    const entry = remember(build,root,helpers), market = root.querySelector('[data-rp-market]'), trade = root.querySelector('[data-rp-trade]');
    previewGame(build,root,helpers);
    if (market) window.RopadTokenMarket?.wire(build,market);
    if (trade && entry.tradeRoot !== trade) { window.ParallaxOrbio?.wireBuildTradePanel?.(build,trade); entry.tradeRoot = trade; entry.tradeIdentity = identity(build); entry.tradeReady = typeof window.ParallaxOrbio?.wireBuildTradePanel === 'function'; }
  }
  function refresh(build, root, helpers = {}) {
    if (!root || root.isConnected === false) return;
    const entry = remember(build,root,helpers);
    replace(root,'[data-rp-heading]',heading(build,helpers)); replace(root,'[data-rp-game]',game(build,helpers)); replace(root,'[data-rp-agent]',agent(build,helpers)); replace(root,'[data-rp-activity]',activity(build,helpers)); replace(root,'[data-rp-details]',details(build));
    const market = root.querySelector('[data-rp-market]');
    if (market && window.RopadTokenMarket) { replace(root,'[data-rp-market]',window.RopadTokenMarket.panel(build)); window.RopadTokenMarket.wire(build,market); }
    refreshTrade(build,root,entry);previewGame(build,root,helpers);
  }
  function refreshTrade(build,root,entry) {
    const trade = root.querySelector('[data-rp-trade]');
    // The trading module owns input state, quotes and wallet requests. Build polling
    // leaves its DOM intact; only a changed token identity replaces that panel.
    if (trade && (entry.tradeRoot !== trade || entry.tradeIdentity !== identity(build) || !entry.tradeReady)) { trade.innerHTML = window.ParallaxOrbio?.buildTradePanel?.(build) || fallbackTrade(); window.ParallaxOrbio?.wireBuildTradePanel?.(build,trade); entry.tradeRoot=trade; entry.tradeIdentity=identity(build); entry.tradeReady=typeof window.ParallaxOrbio?.wireBuildTradePanel === 'function'; }
  }
  for (const event of ['ropad-solana-wallet-change','parallax-evm-wallet-change']) window.addEventListener(event, () => {
    for (const [root,entry] of mounts) {
      if (root.isConnected === false) { mounts.delete(root); continue; }
      // The trading modules invalidate quotes for every wallet event, including
      // reconnecting the same account, so the visible quote must invalidate too.
      entry.tradeIdentity = null;
      refreshTrade(entry.build,root,entry);
    }
  });
  window.addEventListener('ropad-market-update', event => {
    for (const [root,entry] of mounts) {
      if (root.isConnected === false) { mounts.delete(root); continue; }
      if (entry.build.id === event.detail?.buildId) { replace(root,'[data-rp-price]',metrics(entry.build)); replace(root,'[data-rp-details]',details(entry.build)); }
    }
  });
  window.RopadTokenPage = Object.freeze({render,wire,refresh});
})();

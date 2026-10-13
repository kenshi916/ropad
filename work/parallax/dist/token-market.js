(() => {
  'use strict';
  const states = new Map(), mounts = new Map(), MAX_SAMPLES = 720;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const solAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  const evmAddress = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
  const decimal = value => typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
  const keyFor = build => JSON.stringify([build.id,build.token?.chain,build.token?.cluster,build.token?.chainId,build.token?.address,build.token?.verified === true]);
  const verified = build => build.token?.chain === 'solana' && build.token.cluster === 'mainnet-beta' && build.token.verified === true && solAddress(build.token.address);
  function stateFor(build) {
    const key = keyFor(build);
    if (!states.has(key)) {
      if (states.size >= 40) states.delete(states.keys().next().value);
      states.set(key,{metric:'marketCapSol',range:'session',samples:[]});
    }
    return states.get(key);
  }
  function inspect(build) {
    const state = stateFor(build);
    let source = {};
    if (verified(build)) {
      try { source = window.RopadSolanaMarket?.snapshot(build) || {}; } catch { source = {error:'Market source unavailable'}; }
    }
    const market = source.market;
    const valid = verified(build) && market?.cluster === 'mainnet-beta' && market.mint === build.token.address && market.available === true && ['priceSol','marketCapSol','supply'].every(field => decimal(market[field])) && Number.isSafeInteger(market.slot) && market.slot >= 0 && Number.isFinite(market.checkedAt) && market.checkedAt > Date.now() - 300000 && market.checkedAt <= Date.now() + 60000;
    const last = state.samples.at(-1);
    if (valid && (!last || market.slot > last.slot && market.checkedAt > last.checkedAt)) {
      state.samples.push({priceSol:market.priceSol,marketCapSol:market.marketCapSol,supply:market.supply,slot:market.slot,checkedAt:market.checkedAt});
      if (state.samples.length > MAX_SAMPLES) state.samples.shift();
    }
    // Completed curves still return their old reserves; they are not a migrated-market price feed.
    const unavailable = verified(build) && market?.mint === build.token.address && market.cluster === 'mainnet-beta' && market.available === false;
    const problem = source.error || (unavailable ? market.reason || 'This market is not supported by the current source' : market && !valid ? 'The market snapshot could not be verified' : '');
    return {state,source,problem,unavailable,latest:state.samples.at(-1)};
  }
  function display(value) {
    if (!decimal(value)) return '—';
    let [whole,fraction=''] = value.split('.');
    const first = fraction.search(/[1-9]/), precision = whole === '0' && first >= 0 ? Math.max(6,first + 4) : 6;
    const kept = fraction.slice(0,precision).replace(/0+$/,'');
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',') + (kept ? '.' + kept : '');
  }
  const time = value => new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const axisLabel = value => value > 0 && value < .00001 ? value.toExponential(2) : value.toLocaleString('en-US',{maximumSignificantDigits:5});
  const rangeMillis = range => range === '5m' ? 300000 : range === '1h' ? 3600000 : 0;
  function rangeReady(state,range) {
    return range === 'session' || state.samples.length >= 2 && state.samples.at(-1).checkedAt - state.samples[0].checkedAt >= rangeMillis(range);
  }
  function chart(state) {
    const latest = state.samples.at(-1), cutoff = latest.checkedAt - rangeMillis(state.range);
    const samples = state.range === 'session' ? state.samples : state.samples.filter(sample => sample.checkedAt >= cutoff);
    if (samples.length < 2) return '';
    const values = samples.map(sample => Number(sample[state.metric]));
    const lo = Math.min(...values), hi = Math.max(...values), spread = hi - lo;
    const min = spread ? Math.max(0,lo - spread * .15) : lo * .9;
    const max = spread ? hi + spread * .15 : hi * 1.1;
    const start = samples[0].checkedAt, end = latest.checkedAt;
    const points = samples.map((sample,i) => `${(18 + (sample.checkedAt - start) / (end - start) * 574).toFixed(2)},${(18 + (max - values[i]) / (max - min) * 182).toFixed(2)}`);
    const label = state.metric === 'marketCapSol' ? 'Market cap' : 'Token price';
    return `<div class="r-market-plot" data-market-samples="${samples.length}"><svg viewBox="0 0 720 240" role="img" aria-label="${label} in SOL from ${samples.length} observed snapshots this session"><g class="r-market-grid">${[18,78.67,139.33,200].map(y=>`<line x1="18" y1="${y}" x2="592" y2="${y}"/>`).join('')}${[18,161.5,305,448.5,592].map(x=>`<line x1="${x}" y1="18" x2="${x}" y2="200"/>`).join('')}</g><g class="r-market-axis"><text x="610" y="22">${esc(axisLabel(max))}</text><text x="610" y="113">${esc(axisLabel((max+min)/2))}</text><text x="610" y="202">${esc(axisLabel(min))}</text><text x="18" y="229">${esc(time(start))}</text><text x="592" y="229" text-anchor="end">${esc(time(end))}</text></g><polyline class="r-market-line" points="${points.join(' ')}"/>${points.map(point=>{const [cx,cy]=point.split(',');return `<circle class="r-market-point" cx="${cx}" cy="${cy}" r="2"/>`;}).join('')}</svg></div>`;
  }
  function identity(build) {
    const token = build.token || {}, address = token.address;
    if (token.chain === 'solana' && solAddress(address)) {
      const cluster = token.cluster;
      return {address,chain:cluster === 'mainnet-beta' ? 'Solana mainnet' : cluster === 'devnet' ? 'Solana devnet' : cluster === 'testnet' ? 'Solana testnet' : 'Solana · network unknown',url:['mainnet-beta','devnet','testnet'].includes(cluster) ? `https://explorer.solana.com/address/${address}${cluster === 'mainnet-beta' ? '' : '?cluster='+cluster}` : null};
    }
    if (evmAddress(address)) {
      const robin = token.chainId === 4663, eth = token.chainId === 1;
      return {address,chain:robin ? 'Robinhood Chain · legacy' : eth ? 'Ethereum · legacy' : 'EVM token · legacy',url:robin ? `https://robin.etherscan.io/token/${address}` : eth ? `https://etherscan.io/token/${address}` : null};
    }
    return {address:null,chain:'Solana',url:null};
  }
  function emptyState(build,view) {
    const token = build.token || {}, legacy = evmAddress(token.address) && token.chain !== 'solana';
    if (legacy) return ['Legacy token market','This record belongs to an EVM network View its existing trade panel for market details'];
    if (token.cluster === 'devnet') return ['Devnet test token / no market','A test mint has no real trading price or market cap'];
    if (!token.address) return ['Market opens after launch','Your coin’s observed market will appear here once a supported mainnet launch is verified'];
    if (!verified(build)) return ['Coin verification required','A verified Solana mainnet mint is needed for market observations'];
    if (view.problem) return ['Market source unavailable',view.problem];
    if (view.latest && view.state.samples.length >= 2) return ['More observations needed','This range needs two observations Try Session to see the observations gathered so far'];
    if (view.latest) return ['Collecting observations','The first verified snapshot is in A chart begins with the next observed slot'];
    return [view.source.loading ? 'Loading market' : 'Waiting for market source','Real observations appear here as the connected market refreshes'];
  }
  function panel(build) {
    const view = inspect(build), {state,latest} = view, id = identity(build);
    if (!rangeReady(state,state.range)) state.range = 'session';
    const token = build.token || {}, mainnet = verified(build), legacy = evmAddress(token.address) && token.chain !== 'solana', show = mainnet && latest && !view.unavailable;
    const title = state.metric === 'marketCapSol' ? 'Market cap' : 'Token price';
    const [emptyTitle,emptyNote] = emptyState(build,view);
    const plotted = show && state.samples.length >= 2 ? chart(state) : '';
    const badge = legacy ? 'LEGACY EVM' : token.cluster === 'devnet' ? 'DEVNET' : mainnet ? 'MAINNET' : token.address ? 'UNVERIFIED' : 'PRE-LAUNCH';
    const metric = (key,label) => `<button type="button" data-market-metric="${key}" aria-pressed="${state.metric === key}">${label}</button>`;
    return `<section class="r-token-market" data-market-ready="${Boolean(show)}" aria-label="Token market overview"><header class="r-market-heading"><span>COIN OVERVIEW</span><span class="r-market-chain">${esc(id.chain)} <b>${badge}</b></span></header><div class="r-market-headline"><div><span>${view.problem && show ? 'Last observed ' + title.toLowerCase() : title}</span><h2 title="${show ? esc(latest[state.metric])+' SOL' : 'No verified market value'}">${show ? esc(display(latest[state.metric])) : '—'} ${legacy ? '' : '<small>SOL</small>'}</h2></div><div class="r-market-facts"><span>Price <b title="${show ? esc(latest.priceSol) : ''}">${show ? esc(display(latest.priceSol))+' SOL' : '—'}</b></span><span>Supply <b title="${show ? esc(latest.supply) : ''}">${show ? esc(display(latest.supply)) : '—'}${show && token.symbol ? ' '+esc(token.symbol) : ''}</b></span></div></div><div class="r-market-toolbar"><div class="r-market-metrics" role="group" aria-label="Chart metric">${metric('marketCapSol','Market cap')}${metric('priceSol','Price')}</div><div class="r-market-ranges" role="group" aria-label="Observed chart range">${[['5m','5m'],['1h','1h'],['session','Session']].map(([range,label])=>`<button type="button" data-market-range="${range}" aria-pressed="${state.range === range}" ${rangeReady(state,range) ? '' : 'disabled title="This session has not gathered this much history yet"'}>${label}</button>`).join('')}</div></div>${plotted || `<div class="r-market-empty"><span class="r-market-empty-mark" aria-hidden="true">↗</span><strong>${esc(emptyTitle)}</strong><p>${esc(emptyNote)}</p></div>`}<div class="r-market-observed"><span><i></i> Observed this session${plotted ? ' · '+state.samples.length+' snapshots' : ''}</span><span>${show ? 'Slot '+esc(latest.slot)+' · '+esc(time(latest.checkedAt)) : 'No historical data'}</span></div>${view.problem && plotted ? `<p class="r-market-source-note" role="status">Source unavailable · Showing the last verified observations</p>` : ''}<footer class="r-market-address">${id.address ? `<span>${id.chain.includes('legacy') ? 'CONTRACT' : 'MINT'}</span><code title="${esc(id.address)}">${esc(id.address)}</code><button type="button" data-market-copy aria-label="Copy full token address">Copy</button>${id.url ? `<a href="${esc(id.url)}" target="_blank" rel="noopener noreferrer" aria-label="View token on chain explorer">↗</a>` : ''}<span class="r-market-copy-status" role="status" data-market-copy-status></span>` : '<span>MINT</span><code>Assigned after a verified launch</code>'}</footer></section>`;
  }
  function draw(build,root) {
    if (root.isConnected === false) return;
    root.innerHTML = panel(build);
    wire(build,root);
  }
  function wire(build,root) {
    const key = keyFor(build);
    for (const [entry,mount] of mounts) if (mount.root.isConnected === false || mount.root === root) mounts.delete(entry);
    mounts.set(key,{build,root});
    root.onclick = async event => {
      const button = event.target.closest?.('button');
      if (!button || !root.contains(button) || button.disabled) return;
      const state = stateFor(build), {marketMetric,marketRange} = button.dataset;
      if (['marketCapSol','priceSol'].includes(marketMetric)) { state.metric=marketMetric;draw(build,root); }
      else if (['5m','1h','session'].includes(marketRange) && rangeReady(state,marketRange)) { state.range=marketRange;draw(build,root); }
      else if (button.hasAttribute('data-market-copy')) {
        const address = identity(build).address;
        const status = root.querySelector('[data-market-copy-status]');
        try {
          if (!address || !window.navigator?.clipboard?.writeText) throw Error();
          await window.navigator.clipboard.writeText(address);
          if (status && status.isConnected !== false) status.textContent='Copied';
        } catch { if (status && status.isConnected !== false) status.textContent='Select the address to copy'; }
      }
    };
  }
  window.addEventListener('ropad-market-update',event => {
    for (const [key,mount] of [...mounts]) {
      if (mount.root.isConnected === false) { mounts.delete(key);continue; }
      if (mount.build.id === event.detail?.buildId) draw(mount.build,mount.root);
    }
  });
  window.RopadTokenMarket = Object.freeze({panel,wire});
})();

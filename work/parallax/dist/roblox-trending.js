(() => {
  'use strict';
  const mounts = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const compact = value => value === null ? '—' : new Intl.NumberFormat('en', {notation:'compact',maximumFractionDigits:1}).format(value);
  const full = value => value === null ? 'Unavailable' : new Intl.NumberFormat('en').format(value);
  function trustedUrl(value, image = false) {
    try {
      const url = new URL(value);
      const domain = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      const roblox = domain === 'roblox.com' || domain.endsWith('.roblox.com');
      const cdn = domain === 'rbxcdn.com' || domain.endsWith('.rbxcdn.com');
      return roblox || image && cdn ? url.href : '';
    } catch { return ''; }
  }
  function normalize(payload) {
    if (!payload || !Array.isArray(payload.games)) throw Error('Roblox returned an unreadable chart');
    const seen = new Set();
    const games = payload.games.slice(0,100).flatMap((item,index) => {
      const placeId = String(item?.placeId ?? '');
      const universeId = String(item?.universeId ?? '');
      if (!/^[1-9]\d{0,19}$/.test(placeId) || !/^[1-9]\d{0,19}$/.test(universeId) || seen.has(universeId)) return [];
      seen.add(universeId);
      return [{universeId,placeId,name:String(item.name || 'Untitled experience').slice(0,250),creatorName:String(item.creatorName || 'Creator unavailable').slice(0,200),playing:number(item.playing),visits:number(item.visits),rank:number(item.rank) || index + 1,thumbnailUrl:trustedUrl(item.thumbnailUrl,true),url:`https://www.roblox.com/games/${placeId}`,earningsUrl:trustedUrl(item.earnings?.sourceUrl)}];
    });
    if (payload.games.length && !games.length) throw Error('Roblox returned an unreadable chart');
    const date = new Date(payload.fetchedAt || '');
    return {games,source:{name:String(payload.source?.name || 'Roblox · Top Playing Now').slice(0,200),url:trustedUrl(payload.source?.url) || 'https://www.roblox.com/charts'},fetchedAt:Number.isFinite(date.getTime()) ? date.toISOString() : null,stale:payload.stale === true,snapshot:payload.snapshot === true};
  }
  function photo(game, className = '') {
    return `<div class="rt-cover ${className}"><span class="rt-cover-fallback" aria-hidden="true">${esc(game.name.slice(0,1))}</span>${game.thumbnailUrl ? `<img src="${esc(game.thumbnailUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</div>`;
  }
  function spotlight(game) {
    return `<a class="rt-spotlight" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer">${photo(game)}<div class="rt-spotlight-overlay"><span class="rt-chart-rank">Chart #${game.rank}</span><h2>${esc(game.name)}</h2><div><span class="rt-playing"><i aria-hidden="true"></i>${compact(game.playing)} playing</span><span class="rt-open">View on Roblox ↗</span></div></div></a>`;
  }
  function row(game) {
    return `<tr><td class="rt-rank" title="Position in the source chart">${game.rank}</td><td><a class="rt-game" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer">${photo(game)}<span><strong>${esc(game.name)}</strong><small>${esc(game.creatorName)}</small></span><span class="rt-game-arrow" aria-hidden="true">↗</span></a></td><td class="rt-number" title="${full(game.playing)} concurrent players"><span class="rt-mobile-label">Playing</span><strong>${compact(game.playing)}</strong></td><td class="rt-number" title="${full(game.visits)} lifetime visits"><span class="rt-mobile-label">Visits</span>${compact(game.visits)}</td><td class="rt-earnings"><span class="rt-mobile-label">Dev earnings</span><span title="The public Roblox API does not disclose this experience’s developer earnings">Not disclosed</span></td></tr>`;
  }
  function earningsContext() {
    return `<aside class="rt-economy" aria-label="Reported Roblox creator earnings"><div class="rt-economy-title"><span>CREATOR ECONOMY</span><strong>What Roblox creators earn</strong><a href="https://about.roblox.com/newsroom/2026/09/global-impact-of-creation-on-roblox" target="_blank" rel="noopener noreferrer">Roblox disclosure · Sep 3, 2026 ↗</a></div><div class="rt-economy-stat"><strong>$1.5B+</strong><span>Roblox-wide creator earnings</span><small>Calendar year 2025 · USD</small></div><div class="rt-economy-stat"><strong>~$1,500</strong><span>Median participating DevEx creator</span><small>12 months ended Jun 30, 2026 · USD</small></div><p>Platform-wide figures, separate from the games listed below · The median covers DevEx participants, not all creators</p></aside>`;
  }
  function shell() {
    return `<section class="rt-page" aria-labelledby="rt-title"><div class="rt-heading"><div><span class="rt-eyebrow">ROBLOX DISCOVERY</span><h1 id="rt-title">Trending on Roblox <span aria-hidden="true">↗</span></h1><p>Explore the most-played experiences and the creators behind them</p></div><a class="rt-back" href="#/">Explore Ropad agents <span aria-hidden="true">↗</span></a></div><div class="rt-source-bar"><span data-rt-source>Fetching the Roblox chart</span><button type="button" class="rt-refresh" data-rt-refresh>Refresh <span aria-hidden="true">↻</span></button></div><div data-rt-message role="status" aria-live="polite"></div><div class="rt-spotlights" data-rt-spotlights></div>${earningsContext()}<div class="rt-list-heading"><div><h2>Top played experiences</h2><span data-rt-count>Loading the chart</span></div><div class="rt-controls"><label class="rt-search"><span aria-hidden="true">⌕</span><input type="search" data-rt-search aria-label="Search Roblox games or creators" placeholder="Search games or creators" autocomplete="off"></label><label class="rt-sort"><span class="rt-visually-hidden">Sort Roblox games</span><select data-rt-sort><option value="playing">Concurrent players</option><option value="rank">Roblox chart order</option><option value="visits">Total visits</option></select></label></div></div><div data-rt-results aria-busy="true"><div class="rt-loading"><span class="rt-spinner" aria-hidden="true"></span>Loading top Roblox games</div></div><div class="rt-disclosure"><span class="rt-disclosure-icon" aria-hidden="true">i</span><div><strong>About developer earnings</strong><p>Roblox keeps each experience’s revenue in its creator’s private analytics, so earnings are shown as “Not disclosed” We don’t estimate income from player counts</p><a href="https://create.roblox.com/docs/production/analytics/monetization" target="_blank" rel="noopener noreferrer">How Roblox revenue analytics work ↗</a></div></div><p class="rt-scope">These are public Roblox experiences, separate from Ropad agent coins · Players are a snapshot, visits are lifetime totals</p></section>`;
  }
  function active(state) { return mounts.get(state.root) === state && state.root.isConnected !== false; }
  function update(state) {
    if (!active(state)) return;
    const root = state.root, data = state.data;
    const refresh = root.querySelector('[data-rt-refresh]');
    refresh.disabled = state.loading;
    refresh.innerHTML = state.loading ? 'Refreshing <span aria-hidden="true">↻</span>' : 'Refresh <span aria-hidden="true">↻</span>';
    const message = root.querySelector('[data-rt-message]');
    message.innerHTML = state.error ? `<div class="rt-warning">${esc(state.error)}${data ? ' · Showing the previous snapshot' : ''}<button type="button" data-rt-refresh${state.loading ? ' disabled' : ''}>Try again ↗</button></div>` : data?.snapshot ? '<div class="rt-warning">Saved snapshot · Live updates are unavailable here · Player counts reflect the retrieval time shown above</div>' : data?.stale ? '<div class="rt-warning">Roblox could not be refreshed · Showing the last available snapshot</div>' : '';
    const source = root.querySelector('[data-rt-source]');
    if (data) {
      const time = data.fetchedAt ? `<time datetime="${data.fetchedAt}">${esc(new Date(data.fetchedAt).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}))}</time>` : 'Snapshot time unavailable';
      source.innerHTML = `<span class="rt-snapshot-dot${data.stale || data.snapshot || state.error ? ' is-stale' : ''}" aria-hidden="true"></span><a href="${esc(data.source.url)}" target="_blank" rel="noopener noreferrer">${esc(data.source.name)} ↗</a><span class="rt-source-divider">·</span>${data.snapshot ? 'Saved ' : ''}${time}`;
    } else source.textContent = state.error ? 'Roblox chart unavailable' : 'Fetching the Roblox chart';
    const results = root.querySelector('[data-rt-results]');
    results.setAttribute('aria-busy',String(state.loading));
    if (!data) {
      root.querySelector('[data-rt-count]').textContent = state.error ? 'Source unavailable' : 'Loading the chart';
      results.innerHTML = state.error ? '<div class="rt-empty"><span aria-hidden="true">↻</span><h3>The chart couldn’t load</h3><p>Try again when the Roblox source is available</p></div>' : '<div class="rt-loading"><span class="rt-spinner" aria-hidden="true"></span>Loading top Roblox games</div>';
      return;
    }
    const all = data.games;
    const query = state.query.trim().toLocaleLowerCase();
    const games = all.filter(game => `${game.name} ${game.creatorName}`.toLocaleLowerCase().includes(query));
    games.sort(state.sort === 'rank' ? (a,b) => a.rank - b.rank : (a,b) => (b[state.sort] ?? -1) - (a[state.sort] ?? -1) || a.rank - b.rank);
    root.querySelector('[data-rt-count]').textContent = `${games.length}${query ? ` of ${all.length}` : ''} experiences · Source chart rank shown`;
    root.querySelector('[data-rt-spotlights]').innerHTML = !query ? [...all].sort((a,b) => (b.playing ?? -1) - (a.playing ?? -1) || a.rank - b.rank).slice(0,3).map(spotlight).join('') : '';
    results.innerHTML = games.length ? `<div class="rt-table-scroll"><table class="rt-table"><thead><tr><th scope="col" title="Position in the source chart">Chart #</th><th scope="col">Game / Creator</th><th scope="col">Players at snapshot</th><th scope="col">Total visits</th><th scope="col">Dev earnings</th></tr></thead><tbody>${games.map(row).join('')}</tbody></table></div>` : `<div class="rt-empty"><span aria-hidden="true">⌕</span><h3>${query ? 'No matching games' : 'No games returned'}</h3><p>${query ? 'Try another game or creator name' : 'Refresh to check the Roblox chart again'}</p></div>`;
    root.querySelectorAll('.rt-cover img').forEach(img => { img.onerror = () => { img.remove(); }; });
  }
  async function load(state) {
    if (!active(state) || state.loading) return;
    state.loading = true;
    state.error = '';
    const controller = new AbortController();
    state.controller = controller;
    let timedOut = false;
    state.timer = setTimeout(() => { timedOut = true; controller.abort(); },20000);
    update(state);
    try {
      let response = await fetch('/api/roblox/trending',{signal:controller.signal,headers:{Accept:'application/json'},cache:'no-store'});
      let savedSnapshot = false;
      if (response.status === 404) {
        response = await fetch('/data/roblox-trending.json',{signal:controller.signal,headers:{Accept:'application/json'},cache:'no-store'});
        savedSnapshot = true;
      }
      if (!response.ok) throw Error('The Roblox chart is temporarily unavailable');
      const payload = await response.json();
      if (active(state)) state.data = normalize({...payload,snapshot:savedSnapshot || payload.snapshot === true});
    } catch (error) {
      if (active(state) && (error.name !== 'AbortError' || timedOut)) state.error = timedOut ? 'Roblox took too long to respond' : 'The Roblox chart is temporarily unavailable';
    } finally {
      clearTimeout(state.timer);
      state.loading = false;
      state.controller = null;
      update(state);
    }
  }
  function destroy(root) {
    if (!root) { for (const element of [...mounts.keys()]) destroy(element); return; }
    const state = mounts.get(root);
    if (!state) return;
    mounts.delete(root);
    clearTimeout(state.timer);
    clearInterval(state.poll);
    state.controller?.abort();
    root.onclick = null;
    root.oninput = null;
    root.onchange = null;
  }
  function mount(root) {
    if (!root) return null;
    destroy();
    const state = {root,data:null,query:'',sort:'playing',loading:false,error:'',controller:null,timer:null,poll:null};
    mounts.set(root,state);
    root.innerHTML = shell();
    root.onclick = event => { if (event.target.closest('[data-rt-refresh]') && root.contains(event.target)) load(state); };
    root.oninput = event => { if (event.target.matches('[data-rt-search]')) { state.query = event.target.value; update(state); } };
    root.onchange = event => { if (event.target.matches('[data-rt-sort]')) { state.sort = ['playing','visits','rank'].includes(event.target.value) ? event.target.value : 'playing'; update(state); } };
    state.poll = setInterval(() => {
      if (active(state) && state.data && !state.data.snapshot && document.visibilityState === 'visible') return load(state);
    },120000);
    return {ready:load(state),refresh:() => load(state),destroy:() => destroy(root)};
  }
  window.RopadTrending = {mount,destroy};
})();

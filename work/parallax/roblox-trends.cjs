'use strict';

// Public Roblox chart data only. No Roblox cookie or creator analytics access is
// requested, and player counts must never be converted into claimed revenue.
const crypto = require('node:crypto');
const CHART_URL = 'https://apis.roblox.com/explore-api/v1/get-sort-content';
const GAMES_URL = 'https://games.roblox.com/v1/games';
const THUMBNAILS_URL = 'https://thumbnails.roblox.com/v1/games/multiget/thumbnails';
const EARNINGS_SOURCE = 'https://create.roblox.com/docs/production/analytics/monetization';
const CACHE_MS = 120000;
const MAX_STALE_MS = 15 * 60000;
const errorUnavailable = () => Object.assign(new Error('Roblox charts are temporarily unavailable; retry shortly'), {status: 503});
const id = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function thumbnailUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'rbxcdn.com' || url.hostname.endsWith('.rbxcdn.com')) ? url.href : null;
  } catch { return null; }
}

function createRobloxTrendsService({fetcher = fetch, now = Date.now, cacheMs = CACHE_MS, maxStaleMs = MAX_STALE_MS, timeoutMs = 8000} = {}) {
  let cached = null, pending = null, nextRetryAt = 0;
  const sessionId = crypto.randomUUID();
  async function read(url) {
    const response = await fetcher(url, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(timeoutMs), redirect: 'error'});
    if (!response.ok) throw errorUnavailable();
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw errorUnavailable();
    return payload;
  }
  function view(stale = false, warning = null) {
    const result = structuredClone(cached.data);
    result.stale = stale;
    result.cacheAgeSeconds = Math.max(0, Math.floor((now() - cached.time) / 1000));
    if (warning) result.warning = warning;
    return result;
  }
  async function refresh() {
    const chartUrl = new URL(CHART_URL);
    chartUrl.searchParams.set('sortId', 'top-playing-now');
    chartUrl.searchParams.set('sessionId', sessionId);
    const chart = await read(chartUrl.href);
    if (chart.sortId !== 'top-playing-now' || !Array.isArray(chart.games) || !chart.games.length) throw errorUnavailable();
    const seen = new Set();
    const candidates = chart.games.map((game, index) => ({...game, chartRank: index + 1})).filter(game => {
      const universeId = id(game?.universeId);
      if (!universeId || !id(game?.rootPlaceId) || !text(game?.name) || count(game?.playerCount) === null || game?.isSponsored === true || seen.has(universeId)) return false;
      seen.add(universeId); return true;
    }).slice(0, 50);
    if (!candidates.length) throw errorUnavailable();
    const ids = candidates.map(game => game.universeId).join(',');
    const detailsUrl = new URL(GAMES_URL); detailsUrl.searchParams.set('universeIds', ids);
    const imagesUrl = new URL(THUMBNAILS_URL);
    for (const [key, value] of Object.entries({universeIds: ids, countPerUniverse: '1', defaults: 'true', size: '768x432', format: 'Png', isCircular: 'false'})) imagesUrl.searchParams.set(key, value);
    const [detailsResult, imagesResult] = await Promise.allSettled([read(detailsUrl.href), read(imagesUrl.href)]);
    const details = new Map();
    if (detailsResult.status === 'fulfilled' && Array.isArray(detailsResult.value.data)) for (const game of detailsResult.value.data) if (id(game?.id)) details.set(Number(game.id), game);
    const images = new Map();
    if (imagesResult.status === 'fulfilled' && Array.isArray(imagesResult.value.data)) for (const game of imagesResult.value.data) {
      if (!id(game?.universeId) || !Array.isArray(game.thumbnails)) continue;
      const image = game.thumbnails.find(item => item?.state === 'Completed' && thumbnailUrl(item.imageUrl));
      if (image) images.set(Number(game.universeId), thumbnailUrl(image.imageUrl));
    }
    const diagnostics = [];
    if (!details.size) diagnostics.push('Creator details and total visits are temporarily unavailable');
    if (!images.size) diagnostics.push('Roblox game thumbnails are temporarily unavailable');
    const games = candidates.map(game => {
      const universeId = Number(game.universeId), detail = details.get(universeId), placeId = Number(game.rootPlaceId);
      return {
        universeId, placeId, name: text(detail?.name) || text(game.name),
        creatorName: text(detail?.creator?.name) || null, creatorType: ['Group', 'User'].includes(detail?.creator?.type) ? detail.creator.type : null,
        playing: count(game.playerCount), visits: count(detail?.visits), favorites: count(detail?.favoritedCount),
        genre: text(detail?.genre_l1) || text(game.genreL1) || null,
        thumbnailUrl: images.get(universeId) || null, url: 'https://www.roblox.com/games/' + placeId,
        rank: game.chartRank,
        earnings: {status: 'not_disclosed', amount: null, currency: null, period: null, sourceUrl: null}
      };
    });
    // Keep Roblox's own chart order and its matching player-count sample, rather
    // than merging timestamps into an invented platform-wide ranking.
    const fetchedAt = new Date(now()).toISOString();
    const data = {
      source: {name: 'Roblox · Top Playing Now', url: 'https://www.roblox.com/charts', apiUrl: CHART_URL + '?sortId=top-playing-now', scope: text(chart.subtitle) || 'Roblox public Top Playing Now chart'},
      fetchedAt, stale: false, refreshAfterSeconds: Math.ceil(cacheMs / 1000), rankedBy: 'concurrent_players',
      rankingNote: 'Roblox Top Playing Now chart order; counts are a public snapshot, not daily or total players',
      earningsNote: 'Individual game earnings are not published by these public APIs; revenue analytics require creator access',
      earningsSourceUrl: EARNINGS_SOURCE, games, diagnostics
    };
    cached = {time: now(), data}; nextRetryAt = 0;
    return view();
  }
  async function trending() {
    if (cached && now() - cached.time < cacheMs) return view();
    if (pending) return pending;
    if (now() < nextRetryAt) {
      if (cached && now() - cached.time <= maxStaleMs) return view(true, 'Roblox could not refresh; showing the last successful snapshot');
      throw errorUnavailable();
    }
    pending = refresh().catch(() => {
      nextRetryAt = now() + 15000;
      if (cached && now() - cached.time <= maxStaleMs) return view(true, 'Roblox could not refresh; showing the last successful snapshot');
      throw errorUnavailable();
    }).finally(() => {pending = null;});
    return pending;
  }
  return {trending};
}

module.exports = {createRobloxTrendsService, CACHE_MS, MAX_STALE_MS};

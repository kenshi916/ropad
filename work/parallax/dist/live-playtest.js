(() => {
  'use strict';
  const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const stamp = value => typeof value === 'number' ? value : Date.parse(value);
  const fresh = (value, now = Date.now()) => Number.isFinite(stamp(value)) && now >= stamp(value) && now - stamp(value) <= 5000;
  let active = null;
  const previews = new Map(), previewObservers = new Set();
  const previewKey = build => safeId(build?.id) && typeof build?.jobId === 'string' && build.jobId ? build.id + ':' + build.jobId : '';

  function cachedPreview(build) { return previews.get(previewKey(build))?.value || null; }
  function readPreview(build) {
    const key = previewKey(build);
    if (!key) return Promise.resolve(null);
    if (previews.has(key)) return previews.get(key).promise;
    const entry = { value: null, promise: null };
    previews.set(key, entry);
    entry.promise = (async () => {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch('/runtime-playtest/' + encodeURIComponent(build.id) + '/status.json', {cache:'no-store',credentials:'omit',signal:controller.signal});
        if (!response.ok) return null;
        const record = await response.json(), result = inspect(build,record);
        if (!result.hasFrame) return null;
        const url = '/runtime-playtest/' + encodeURIComponent(build.id) + '/frame.jpg?v=' + encodeURIComponent(result.frameId);
        // Keep the saved cover unless the actual capture image can be loaded.
        const available = await new Promise(resolve => {
          const image = new Image(), deadline = setTimeout(() => { image.onload = image.onerror = null; resolve(false); }, 4000);
          image.onload = () => { clearTimeout(deadline); resolve(true); };
          image.onerror = () => { clearTimeout(deadline); resolve(false); };
          image.src = url;
        });
        if (!available) return null;
        entry.value = {url,label:'Last Studio playtest frame',kind:'playtest',capturedAt:result.capturedAt,frameId:result.frameId};
        return entry.value;
      } catch { return null; }
      finally { clearTimeout(timeout); }
    })();
    return entry.promise;
  }
  function preview(build, target, apply) {
    if (!target || !previewKey(build)) return;
    for (const entry of previewObservers) if (!entry.target.isConnected) { entry.observer.disconnect(); previewObservers.delete(entry); }
    const load = () => readPreview(build).then(value => { if (value && target.isConnected !== false) apply(value); });
    if (cachedPreview(build) || typeof IntersectionObserver !== 'function') { load(); return; }
    const entry = {target,observer:null};
    entry.observer = new IntersectionObserver(rows => {
      if (!rows.some(row => row.isIntersecting)) return;
      entry.observer.disconnect(); previewObservers.delete(entry); load();
    },{rootMargin:'100px'});
    previewObservers.add(entry); entry.observer.observe(target);
  }
  window.addEventListener?.('hashchange', () => {
    previews.clear();
    for (const entry of previewObservers) entry.observer.disconnect();
    previewObservers.clear();
  });

  // Only a capture assigned to the exact current project execution is displayable.
  function inspect(build, record, now = Date.now()) {
    if (!safeId(build?.id) || typeof build?.jobId !== 'string' || !build.jobId || !record || record.buildId !== build.id || record.jobId !== build.jobId || typeof record.studioId !== 'string' || !record.studioId.trim() || record.mode !== 'playtest') return { kind: 'unavailable', message: 'Waiting for a capture assigned to this game version' };
    if (!['live', 'stopped', 'error'].includes(record.state)) return { kind: 'unavailable', message: 'The capture status could not be verified' };
    const hasFrame = safeId(String(record.frameId ?? '')) && Number.isFinite(stamp(record.capturedAt)) && stamp(record.capturedAt) <= now;
    const kind = record.state === 'error' ? 'error' : record.state === 'live' && hasFrame && fresh(record.capturedAt, now) ? 'live' : hasFrame ? 'last' : 'waiting';
    return { kind, hasFrame, frameId: hasFrame ? String(record.frameId) : '', capturedAt: hasFrame ? stamp(record.capturedAt) : null, action: typeof record.action === 'string' ? record.action.slice(0, 500) : '', message: kind === 'error' ? String(record.error || 'The capture connection stopped').slice(0, 300) : kind === 'live' ? 'Live Studio capture · refreshed images' : hasFrame ? 'Last frame · capture is stopped or delayed' : 'Waiting for the first Studio test capture' };
  }

  function stop() {
    const session = active;
    if (!session) return;
    active = null;
    clearTimeout(session.timer);
    clearInterval(session.clock);
    session.controller?.abort();
    document.removeEventListener('fullscreenchange', session.onFullscreen);
    document.removeEventListener('keydown', session.onKey);
    document.removeEventListener('visibilitychange', session.onVisibility);
    session.image.onload = null;
    session.image.onerror = null;
    if (document.fullscreenElement === session.root) Promise.resolve(document.exitFullscreen?.()).catch(() => {});
    if (session.theater) document.body.style.overflow = session.bodyOverflow;
    session.root.classList.remove('is-theater');
  }

  function mount(build, content) {
    if (!content) return;
    if (active && active.content === content && active.build.id === build.id && active.build.jobId === build.jobId && active.root.isConnected) return;
    stop();
    content.innerHTML = '<section class="rp-live-playtest" aria-label="Actual Studio playtest"><div class="rp-live-toolbar"><div><span class="rp-live-dot" aria-hidden="true"></span><strong data-live-state>Waiting for Studio</strong><span data-live-stamp>No frame received</span></div><button type="button" class="rp-live-fullscreen" aria-label="Expand Studio playtest to fullscreen" aria-pressed="false">Fullscreen ↗</button></div><div class="rp-live-stage"><img class="rp-live-image" alt="Actual Roblox Studio test client capture" hidden><div class="rp-live-empty"><span aria-hidden="true">⌘</span><h3>The actual test client</h3><p data-live-message>Waiting for a capture assigned to this game version</p><small>Frames appear here when the agent runs a Studio playtest</small></div><span class="rp-live-frame-tag" hidden>LAST FRAME</span></div><div class="rp-live-action"><span>Agent action</span><p data-live-action>No test action reported yet</p></div><div class="rp-live-disclosure">Live Studio capture · refreshed images<span>The agent controls the test client · Viewer only</span></div></section>';
    const root = content.querySelector('.rp-live-playtest');
    const session = { build: { id: build.id, jobId: build.jobId }, content, root, image: root.querySelector('img'), empty: root.querySelector('.rp-live-empty'), button: root.querySelector('button'), tag: root.querySelector('.rp-live-frame-tag'), record: null, displayed: null, lastImageId: '', fetchError: '', imageError: false, timer: null, clock: null, theater: false, bodyOverflow: document.body.style.overflow, controller: null };
    active = session;
    const query = selector => root.querySelector(selector);
    const activeHere = () => active === session && root.isConnected;
    function fullscreenLabel() {
      const expanded = session.theater || document.fullscreenElement === root;
      session.button.textContent = expanded ? 'Exit fullscreen ×' : 'Fullscreen ↗';
      session.button.setAttribute('aria-pressed', String(expanded));
      session.button.setAttribute('aria-label', expanded ? 'Exit fullscreen Studio playtest' : 'Expand Studio playtest to fullscreen');
    }
    function leaveTheater() {
      session.theater = false;
      root.classList.remove('is-theater');
      document.body.style.overflow = session.bodyOverflow;
      fullscreenLabel();
    }
    session.button.onclick = async () => {
      if (session.theater) { leaveTheater(); return; }
      if (document.fullscreenElement === root) { try { await document.exitFullscreen(); } catch {} return; }
      try { if (!root.requestFullscreen) throw Error('Fullscreen unavailable'); await root.requestFullscreen(); }
      catch { if (!activeHere()) return; session.theater = true; root.classList.add('is-theater'); document.body.style.overflow = 'hidden'; }
      fullscreenLabel();
    };
    session.onFullscreen = fullscreenLabel;
    session.onKey = event => { if (event.key === 'Escape' && session.theater) leaveTheater(); };
    function paint() {
      if (!activeHere()) return;
      const current = inspect(session.build, session.record);
      const displayed = session.displayed ? inspect(session.build, session.displayed) : null;
      const hasImage = Boolean(displayed?.hasFrame) && !session.imageError;
      const isLive = hasImage && displayed.kind === 'live' && current.kind === 'live' && !session.fetchError;
      const stateText = isLive ? 'Live playtest' : hasImage ? 'Last frame' : current.kind === 'error' || session.fetchError ? 'Capture unavailable' : 'Waiting for Studio';
      root.classList.toggle('is-live', isLive);
      session.image.hidden = !hasImage;
      session.empty.hidden = hasImage;
      session.tag.hidden = !hasImage || isLive;
      query('[data-live-state]').textContent = stateText;
      const time = displayed?.capturedAt;
      query('[data-live-stamp]').textContent = time ? 'Captured ' + new Date(time).toLocaleTimeString() : 'No frame received';
      query('[data-live-action]').textContent = current.action || 'No test action reported yet';
      query('[data-live-message]').textContent = session.imageError ? 'The latest image could not be loaded' : session.fetchError || current.message;
      const screenStatus = document.getElementById('b-screen-status');
      if (screenStatus) { screenStatus.textContent = stateText.toUpperCase(); screenStatus.classList.toggle('b-screen-on', isLive); }
      const note = document.getElementById('b-screen-note');
      if (note) note.textContent = session.fetchError || (current.kind === 'error' ? current.message : isLive ? 'Live Studio capture · refreshed images' : hasImage ? 'Last frame · capture is stopped or delayed' : current.message);
    }
    async function poll() {
      if (!activeHere()) { if (active === session) stop(); return; }
      if (document.hidden) { session.timer = setTimeout(poll, 1000); return; }
      if (!safeId(build.id) || typeof build.jobId !== 'string' || !build.jobId) { paint(); session.timer = setTimeout(poll, 1000); return; }
      const controller = new AbortController(); session.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch('/runtime-playtest/' + encodeURIComponent(build.id) + '/status.json', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!activeHere()) return;
        if (!response.ok) throw Error(response.status === 404 ? 'No Studio playtest is streaming for this game yet' : 'The capture connection is unavailable');
        const record = await response.json();
        if (!activeHere()) return;
        session.record = record;
        session.fetchError = '';
        const current = inspect(session.build, record);
        if (!current.hasFrame) { session.displayed = null; session.lastImageId = ''; session.image.removeAttribute('src'); session.imageError = false; }
        else if (session.lastImageId !== current.frameId || session.imageError) {
          session.lastImageId = current.frameId;
          session.image.onload = () => { if (!activeHere() || session.lastImageId !== current.frameId) return; session.displayed = record; session.imageError = false; paint(); };
          session.image.onerror = () => { if (!activeHere() || session.lastImageId !== current.frameId) return; session.imageError = true; paint(); };
          session.image.src = '/runtime-playtest/' + encodeURIComponent(build.id) + '/frame.jpg?v=' + encodeURIComponent(current.frameId);
        } else if (session.displayed?.frameId === record.frameId) session.displayed = record;
        paint();
      } catch (error) {
        if (activeHere()) { session.fetchError = error.name === 'AbortError' ? 'Capture refresh timed out' : error.message || 'The capture connection is unavailable'; paint(); }
      } finally {
        clearTimeout(timeout);
        if (activeHere()) { session.controller = null; session.timer = setTimeout(poll, 1000); }
      }
    }
    session.onVisibility = () => { paint(); };
    document.addEventListener('fullscreenchange', session.onFullscreen);
    document.addEventListener('keydown', session.onKey);
    document.addEventListener('visibilitychange', session.onVisibility);
    session.clock = setInterval(paint, 1000);
    paint(); poll();
  }
  window.RopadLivePlaytest = { mount, stop, inspect, preview, cachedPreview };
})();

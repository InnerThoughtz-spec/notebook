// InnerPersonal launcher — frontend logic
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Optional access token (set in Setup; stored in localStorage on the client)
function ipToken() { return localStorage.getItem('ip-token') || ''; }
function setIpToken(t) { if (t) localStorage.setItem('ip-token', t); else localStorage.removeItem('ip-token'); }

const API_BASE = (typeof window !== "undefined" && window.__API_BASE) || "";

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = ipToken();
  if (t) headers['x-ip-token'] = t;
  const r = await fetch(API_BASE + path, { ...opts, headers });
  if (r.status === 401) { promptForToken(); throw new Error('unauthorized'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || `HTTP ${r.status}`);
    err.status = r.status; err.body = body;
    throw err;
  }
  return body;
}

function promptForToken() {
  const v = prompt('This InnerPersonal is access-gated. Enter the access token:');
  if (v) { setIpToken(v); location.reload(); }
}

let state = { games: [], status: null };
let statusTimer = null;

function streamClientProfile() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const host = location.hostname.toLowerCase();
  const memory = navigator.deviceMemory || 0;
  const cores = navigator.hardwareConcurrency || 0;
  const effectiveType = String(connection.effectiveType || '').toLowerCase();
  return {
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio || 1,
    deviceMemory: memory,
    hardwareConcurrency: cores,
    downlink: connection.downlink || 0,
    effectiveType,
    saveData: connection.saveData === true,
    lowPower: connection.saveData === true || ['slow-2g', '2g', '3g'].includes(effectiveType) ||
      (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4),
    remote: !['localhost', '127.0.0.1', '::1'].includes(host),
  };
}

// --- View routing -------------------------------------------------------
// Each switch re-applies the viewIn animation by toggling the section's
// hidden attribute, which re-mounts it in the DOM order and re-triggers
// the CSS @keyframes.
function showView(name) {
  $$('section[data-view]').forEach(s => s.hidden = s.dataset.view !== name);
  // Only nav items that belong to that view light up — game-detail has no
  // nav entry (it's a leaf from clicking a card), so deactivate all.
  $$('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  if (name === 'tutorials')     renderTutorials();
  if (name === 'setup')         loadSetup();
  if (name === 'customization') loadCustomize();
  // Returning to the library? Make sure every card is visible — strip both
  // the click-feedback class and any leftover style.visibility="hidden" set
  // by the morph open animation (which would normally be restored on close,
  // but the user may have skipped the close by clicking a nav item).
  if (name === 'library') {
    $$('#library .card').forEach(c => {
      c.classList.remove('opening');
      c.style.visibility = '';
    });
    _sourceCard = null;
  }
  // Scroll back to top so the new view is visible
  document.querySelector('.main')?.scrollTo?.({ top: 0, behavior: 'instant' });
  window.scrollTo({ top: 0, behavior: 'instant' });
  syncMobileMore(name);
  closeMobileMore();
}
$$('.nav-item[data-view]').forEach(n => n.addEventListener('click', () => showView(n.dataset.view)));

const MOBILE_MORE_VIEWS = new Set(['tutorials', 'customization', 'music', 'phone']);
function closeMobileMore() {
  const menu = $('#mobile-more-menu');
  const button = $('#mobile-more');
  if (menu) menu.hidden = true;
  if (button) button.setAttribute('aria-expanded', 'false');
}
function syncMobileMore(view) {
  $('#mobile-more')?.classList.toggle('active', MOBILE_MORE_VIEWS.has(view));
}
$('#mobile-more')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#mobile-more-menu');
  const button = $('#mobile-more');
  if (!menu || !button) return;
  const opening = menu.hidden;
  menu.hidden = !opening;
  button.setAttribute('aria-expanded', String(opening));
});
$('#mobile-more-menu')?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeMobileMore);
$('#mobile-host-settings')?.addEventListener('click', () => {
  closeMobileMore();
  $('#nav-host-settings')?.click();
});
$('#mobile-refresh')?.addEventListener('click', () => {
  closeMobileMore();
  showView('library');
  loadLibrary(true);
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-goto]');
  if (t) { e.preventDefault(); showView(t.dataset.goto); }
});

// --- Status (Sunshine reachability) -------------------------------------
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const dot = $('#sun-dot'); const lbl = $('#sun-label');
    if (state.status.sunshine.reachable) { dot.className = 'status-dot ok'; lbl.textContent = 'Sunshine online'; }
    else if (state.status.sunshine.installed) { dot.className = 'status-dot warn'; lbl.textContent = 'Sunshine not paired'; }
    else { dot.className = 'status-dot bad'; lbl.textContent = 'Sunshine not installed'; }
    const readyLabel = $('#ready-label');
    const readyHost = $('#ready-host');
    if (readyLabel) readyLabel.textContent = 'Ready to stream';
    if (readyHost) readyHost.textContent = state.status.host || 'Online';
    $('.ready-panel')?.classList.add('is-ready');
  } catch {
    $('#sun-dot').className = 'status-dot bad';
    $('#sun-label').textContent = 'Server offline';
    if ($('#ready-label')) $('#ready-label').textContent = 'Host unavailable';
    if ($('#ready-host')) $('#ready-host').textContent = 'Offline';
    $('.ready-panel')?.classList.remove('is-ready');
  }
}

// --- Library ------------------------------------------------------------
async function loadLibrary(refresh = false) {
  $('#lib-sub').textContent = 'Scanning Steam library…';
  let data;
  try { data = await api(`/api/library${refresh ? '?refresh=1' : ''}`); }
  catch { return; }
  if (!data.ok) {
    $('#library').innerHTML = '';
    $('#lib-sub').textContent = data.error || 'Library scan failed';
    $('#library').appendChild(emptyCard(
      'Steam not detected',
      'Install Steam on the host PC and click Refresh. Non-Steam games can be added directly in the Sunshine web UI on the host.'
    ));
    return;
  }
  state.games = data.games;
  $('#lib-sub').textContent = `${data.games.length} games · ${data.libraryCount} library folders`;
  renderLibrary(state.games);
}

function emptyCard(title, body) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.innerHTML = `<h3>${title}</h3><p>${body}</p>`;
  div.style.gridColumn = '1 / -1';
  return div;
}

function renderLibrary(games) {
  const root = $('#library'); root.innerHTML = '';
  if (!games.length) { root.appendChild(emptyCard('No matches', 'Try a different search.')); return; }
  const fragment = document.createDocumentFragment();
  for (const g of games) {
    const c = document.createElement('div');
    c.className = 'card';
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    c.setAttribute('aria-label', `Open ${g.name}`);
    c.innerHTML = `
      <div class="card-art">
        <img class="card-art-img" src="${escapeHtml(g.header || '')}" alt="" loading="lazy" decoding="async" fetchpriority="low" />
        <span class="card-ready">READY</span>
        <span class="card-play" aria-hidden="true">▶</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(g.name)}</div>
        <div class="card-meta"><span>Steam</span><span>App ${g.appid}</span></div>
      </div>`;
    c.addEventListener('click', () => openGame(g, c));
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGame(g, c); }
    });
    fragment.appendChild(c);
  }
  root.appendChild(fragment);
}

let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = value.toLowerCase().trim();
    const filtered = q ? state.games.filter(g => g.name.toLowerCase().includes(q)) : state.games;
    renderLibrary(filtered);
  }, 100);
});
$('#nav-refresh').addEventListener('click', () => loadLibrary(true));

// --- Toast notifications -----------------------------------------------
// Tiny transient confirmation messages used by quick actions like Spotify.
function toast(msg, kind = '') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = `<span class="dot"></span><span>${escapeHtml(msg)}</span>`;
  container.appendChild(t);
  // CSS animation handles fade-out at 2.2s; remove from DOM shortly after
  setTimeout(() => t.remove(), 2700);
}

// (The old Spotify new-tab handler used to live here. It now navigates
// to the in-launcher Music view via data-view="music" on the nav item,
// same as any other view — no special handler needed.)

// "Host settings" — opens Apollo/Sunshine's web UI through our /host
// proxy in a new tab. Keeps the URL inside the launcher's domain (so it
// works through Tailscale Funnel without exposing port 47990 publicly).
$('#nav-host-settings')?.addEventListener('click', (e) => {
  e.currentTarget.classList.remove('active');
  const t = ipToken();
  const url = (API_BASE || '') + '/host/' + (t ? '?t=' + encodeURIComponent(t) : '');
  const win = window.open(url, '_blank', 'noopener');
  if (!win) toast('Browser blocked the new tab — allow popups for this site', 'bad');
});

// "Control PC" — opens a stream session WITHOUT launching a game. The host
// desktop shows up in the browser; user controls whatever is already there.
async function startDesktopStream() {
  const codec = document.querySelector('input[name="m-codec"]:checked')?.value || 'h264';
  try {
    const s = await api('/api/session/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameName: 'Desktop', codec, clientProfile: streamClientProfile() }),
    });
    if (!s.streamUrl) return alert('Server returned no stream URL.');
    const t = ipToken();
    location.href = (API_BASE ? (s.streamUrl.startsWith('/') ? s.streamUrl.slice(1) : s.streamUrl) : s.streamUrl) + (t ? `&t=${encodeURIComponent(t)}` : '');
  } catch (e) {
    alert('Failed to start: ' + e.message);
  }
}
$('#nav-control-pc')?.addEventListener('click', startDesktopStream);
$('#hero-control-pc')?.addEventListener('click', startDesktopStream);
$('#mobile-control-pc')?.addEventListener('click', startDesktopStream);

// --- Game detail view (2-step launch with morph animation) --------------
// Clicking a library card uses a FLIP transform so the detail container
// looks like it grows out of the card itself. Closing reverses it — the
// detail shrinks back into the same card before swapping views.

let _currentGame = null;
let _previousView = 'library';
let _sourceCard = null;            // the card we came from (for the close morph)

const MORPH_OPEN_MS  = 460;
const MORPH_CLOSE_MS = 340;
const MORPH_EASE     = 'cubic-bezier(0.22, 1, 0.36, 1)';   // ease-out-expo-ish
const MORPH_EASE_IN  = 'cubic-bezier(0.64, 0, 0.78, 0)';   // ease-in for close

function openGame(g, cardEl) {
  _currentGame = g;
  _previousView = 'library';
  _sourceCard = cardEl || null;

  populateDetail(g);

  // Capture the card's viewport position BEFORE switching views so the
  // morph starts visually exactly where the card was.
  const cardRect = cardEl?.getBoundingClientRect() || null;
  if (cardEl) cardEl.style.visibility = 'hidden';  // hide source during morph

  showView('game-detail');

  // Run the morph on the next frame, once the detail view is in the DOM
  // and laid out.
  requestAnimationFrame(() => {
    const detailEl = $('#game-detail');
    if (!detailEl) return;

    if (cardRect) {
      const detailRect = detailEl.getBoundingClientRect();
      const sx = cardRect.width  / detailRect.width;
      const sy = cardRect.height / detailRect.height;
      const dx = cardRect.left - detailRect.left;
      const dy = cardRect.top  - detailRect.top;

      const anim = detailEl.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: '14px' },
          { transform: 'translate(0, 0) scale(1, 1)',                      borderRadius: '14px' },
        ],
        { duration: MORPH_OPEN_MS, easing: MORPH_EASE, fill: 'both' }
      );
      // Fade in the title / codec / buttons once the geometry is committed
      anim.onfinish = () => {
        anim.cancel();   // release the animation's held state
        detailEl.classList.add('ready');
      };
    } else {
      // No source card (direct navigation) — just fade content in normally
      detailEl.classList.add('ready');
    }
  });
}

function closeDetail() {
  const cardEl = _sourceCard;
  const detailEl = $('#game-detail');
  const inDom = cardEl && document.body.contains(cardEl);

  // Strip the .ready class first so the inner content fades back out
  if (detailEl) detailEl.classList.remove('ready');

  // The fullscreen game-detail section sits on z-index:50 covering
  // everything. The library section is currently hidden (display:none),
  // which means cards inside have NO layout — getBoundingClientRect returns
  // zeros. Reveal the library section beneath the detail so we can compute
  // the source card's real viewport position for the reverse morph.
  // Visually nothing changes because the detail still overlays library.
  const librarySection = $('section[data-view="library"]');
  if (librarySection) librarySection.hidden = false;

  if (inDom && detailEl) {
    // Force a synchronous layout so the just-revealed library has real
    // dimensions before we read them.
    void cardEl.offsetHeight;

    const detailRect = detailEl.getBoundingClientRect();
    const cardRect   = cardEl.getBoundingClientRect();
    const sx = cardRect.width  / detailRect.width;
    const sy = cardRect.height / detailRect.height;
    const dx = cardRect.left - detailRect.left;
    const dy = cardRect.top  - detailRect.top;

    const anim = detailEl.animate(
      [
        { transform: 'translate(0, 0) scale(1, 1)' },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      ],
      { duration: MORPH_CLOSE_MS, easing: MORPH_EASE_IN, fill: 'forwards' }
    );
    anim.onfinish = () => {
      anim.cancel();
      cardEl.style.visibility = '';
      _sourceCard = null;
      showView('library');
    };
  } else {
    if (cardEl) cardEl.style.visibility = '';
    _sourceCard = null;
    showView(_previousView || 'library');
  }
}

// Quality-override presets used by the game detail picker. The 'low'
// preset is what BeamNG and other heavy games get by default; user can
// pick a different one per game.
const GAME_QUALITY_PRESETS = {
  low:    { width: 960,  height: 540,  framerate: 30, bitrateKbps: 1400, preset: 'p1' },
  medium: { width: 1280, height: 720,  framerate: 30, bitrateKbps: 2200, preset: 'p1' },
  high:   { width: 1280, height: 720,  framerate: 60, bitrateKbps: 3500, preset: 'p1' },
};

// Browser codec support is detected once at boot. WebRTC HEVC requires
// hardware decode + a recent Chrome/Edge/Safari; AV1 needs an even newer
// browser. We hide/disable codec radios that won't actually decode.
function detectCodecSupport() {
  try {
    const caps = window.RTCRtpReceiver?.getCapabilities?.('video');
    const mimes = (caps?.codecs || []).map(c => (c.mimeType || '').toLowerCase());
    return {
      h264: mimes.some(m => m === 'video/h264'),
      hevc: mimes.some(m => m === 'video/h265' || m === 'video/hevc'),
      av1:  mimes.some(m => m === 'video/av1'),
    };
  } catch { return { h264: true, hevc: false, av1: false }; }
}
const _codecSupport = detectCodecSupport();
let _streamCapabilities = null;

async function getStreamCapabilities() {
  if (_streamCapabilities) return _streamCapabilities;
  try {
    _streamCapabilities = await api('/api/stream/capabilities');
  } catch {
    _streamCapabilities = { codecs: { h264: true, hevc: false, av1: false } };
  }
  return _streamCapabilities;
}

async function populateDetail(g) {
  $('#detail-title').textContent = g.name;
  $('#detail-meta').textContent  = `Steam · App ${g.appid}${g.installPath ? '  ·  ' + g.installPath : ''}`;
  $('#detail-hero').style.backgroundImage = `url('${g.hero || g.header}')`;
  $('#detail-result').innerHTML = '';
  const d = $('#game-detail'); if (d) d.classList.remove('ready');

  // Disable codec radios the browser can't decode, with a clear hint.
  // If the user had a disabled codec selected, snap back to H.264.
  const hostCaps = await getStreamCapabilities();
  const codecRadios = document.querySelectorAll('input[name="d-codec"]');
  codecRadios.forEach(r => {
    const supported = _codecSupport[r.value] !== false && hostCaps.codecs?.[r.value] !== false;
    r.disabled = !supported;
    const label = r.closest('label');
    if (label) {
      label.style.opacity = supported ? '' : '0.4';
      label.style.cursor  = supported ? '' : 'not-allowed';
      label.title = supported ? '' : `${r.value.toUpperCase()} is not available on this browser/GPU. H.264 works everywhere.`;
      // Tidy the small "works everywhere" hint to reflect actual state
      const small = label.querySelector('small');
      if (small && !supported) small.textContent = 'unsupported in this browser';
    }
    if (r.checked && !supported) {
      const h264 = document.querySelector('input[name="d-codec"][value="h264"]');
      if (h264) h264.checked = true;
    }
  });

  // Load this game's quality override (if any) and check the matching radio
  try {
    const cfg = await api('/api/config');
    const ov = cfg.gameOverrides?.[String(g.appid)];
    let picked = 'inherit';
    if (ov) {
      for (const [name, p] of Object.entries(GAME_QUALITY_PRESETS)) {
        if (p.width === ov.width && p.height === ov.height && p.framerate === ov.framerate) {
          picked = name; break;
        }
      }
      // Override exists but doesn't match a preset → still mark as "low" so
      // the user knows it's overridden (closest match is "low" for any
      // settings under 1080p60).
      if (picked === 'inherit' && (ov.height < 1080 || ov.framerate < 60)) picked = 'low';
    }
    document.querySelectorAll('input[name="d-quality"]').forEach(r => {
      r.checked = (r.value === picked);
    });
  } catch (e) {
    console.warn('Could not load gameOverrides', e);
  }
}

// Save (or clear) a per-game quality override when the user picks a radio.
// Wired once, reads the current game's appid out of _currentGame.
document.addEventListener('change', async (e) => {
  if (!(e.target.matches?.('input[name="d-quality"]'))) return;
  if (!_currentGame?.appid) return;
  const val = e.target.value;
  try {
    const cfg = await api('/api/config');
    const overrides = { ...(cfg.gameOverrides || {}) };
    const key = String(_currentGame.appid);
    if (val === 'inherit') {
      delete overrides[key];
    } else {
      overrides[key] = { ...GAME_QUALITY_PRESETS[val], label: _currentGame.name };
    }
    await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameOverrides: overrides }),
    });
    if (typeof toast === 'function') {
      toast(val === 'inherit' ? `Override removed — using global quality` : `${_currentGame.name}: ${val} quality saved`, 'ok');
    }
  } catch (err) {
    console.error('save game override failed', err);
    if (typeof toast === 'function') toast('Failed to save: ' + err.message, 'bad');
  }
});

// Back button → reverse morph
$('#detail-back')?.addEventListener('click', closeDetail);

// Escape closes the detail view too
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('section[data-view="game-detail"]')?.hidden) {
    closeDetail();
  }
});

$('#detail-stream')?.addEventListener('click', async () => {
  const g = _currentGame; if (!g) return;
  const result = $('#detail-result');
  result.innerHTML = '<div class="notice">Starting session…</div>';
  try {
    const codec = document.querySelector('input[name="d-codec"]:checked')?.value || 'h264';
    const s = await api('/api/session/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameName: g.name, appid: g.appid, codec, clientProfile: streamClientProfile() }),
    });
    if (!s.streamUrl) {
      result.innerHTML = `<div class="notice bad">Server returned no stream URL.</div>`;
      return;
    }
    const t = ipToken();
    const tParam = t ? `&t=${encodeURIComponent(t)}` : '';
    location.href = (API_BASE ? (s.streamUrl.startsWith('/') ? s.streamUrl.slice(1) : s.streamUrl) : s.streamUrl) + tParam;
  } catch (e) {
    const hint = e.body && e.body.hint ? `<br><small>${escapeHtml(e.body.hint)}</small>` : '';
    result.innerHTML = `<div class="notice bad">${escapeHtml(e.message)}${hint}</div>`;
  }
});

$('#detail-register')?.addEventListener('click', async () => {
  const g = _currentGame; if (!g) return;
  const result = $('#detail-result');
  result.innerHTML = '<div class="notice">Registering with Sunshine…</div>';
  try {
    const r = await api('/api/sunshine/register-steam', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appid: g.appid, name: g.name }),
    });
    result.innerHTML = `<div class="notice ok">Registered via ${r.via}.${r.restartRequired ? ' Restart Sunshine to pick up the change.' : ''}</div>`;
  } catch (e) {
    const apiErr = e.body && e.body.apiError ? `<br><small>API: ${escapeHtml(e.body.apiError)}</small>` : '';
    const hint = e.body && e.body.hint ? `<br><small>${escapeHtml(e.body.hint)}</small>` : '';
    result.innerHTML = `<div class="notice bad">${escapeHtml(e.message)}${hint}${apiErr}</div>`;
  }
});

// Legacy modal handlers — modal is now hidden by default but keep them
// wired so any deep links or stale code paths don't error.
$('#m-close')?.addEventListener('click', () => $('#modal').hidden = true);
$('#modal')?.addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

// --- Tutorials ----------------------------------------------------------
const TUTORIALS = [
  { num: '01', title: 'Install Sunshine on your gaming PC', desc: 'Download Sunshine, install, and complete first-run pairing. ~5 minutes. Host-side only.', href: '/docs/01-host-setup.md' },
  { num: '02', title: 'Expose your PC with Cloudflare Tunnel', desc: 'Make your gaming PC reachable as an HTTPS site — works through school WiFi.', href: '/docs/02-cloudflare-tunnel.md' },
  { num: '03', title: 'Use it from any browser (Chromebook ready)', desc: 'Just open the URL. No install, no PWA, no extension. That\'s the whole guide.', href: '/docs/03-chromebook.md' },
  { num: '04', title: 'Optimize for low latency', desc: 'NVENC/AMF settings, bitrate, framerate, and codec tuning.', href: '/docs/04-optimize-latency.md' },
];
function renderTutorials() {
  const root = $('#tutor-grid'); root.innerHTML = '';
  for (const t of TUTORIALS) {
    const a = document.createElement('a');
    a.className = 'tutor'; a.href = t.href; a.target = '_blank';
    a.innerHTML = `<div class="num">STEP ${t.num}</div><h3>${t.title}</h3><p>${t.desc}</p>`;
    root.appendChild(a);
  }
}

// --- Setup --------------------------------------------------------------
async function loadSetup() {
  const cfg = await api('/api/config');
  $('#cfg-host').value = cfg.sunshineHost;
  $('#cfg-port').value = cfg.sunshinePort;
  $('#cfg-user').value = cfg.sunshineUser;
  $('#cfg-pass').value = '';
  $('#cfg-public').value = cfg.publicHost || '';
  $('#cfg-token').value = '';
  $('#cfg-turn-url').value = cfg.turnUrl || '';
  $('#cfg-turn-user').value = cfg.turnUsername || '';
  $('#cfg-turn-cred').value = '';   // never echo back the credential
  // Show whether TURN is currently set
  const r = $('#cfg-turn-result');
  if (cfg.turnUrl && cfg.turnUsername) r.textContent = '✓ Custom TURN configured';
  else r.textContent = 'Using public TURN (often blocked) — paste creds above';
  // Spotify Client ID (public identifier, safe to display)
  const spClientEl = $('#cfg-spotify-client');
  if (spClientEl) spClientEl.value = cfg.spotifyClientId || '';

  // Auto-refresh (master Cloudflare token) UI — guard for older cached HTML
  const cfTokenIdEl = $('#cfg-cf-token-id');
  const cfApiTokenEl = $('#cfg-cf-api-token');
  const rc = $('#cfg-cf-result');
  if (cfTokenIdEl && cfApiTokenEl && rc) {
    cfTokenIdEl.value = cfg.cloudflareTurnTokenId || '';
    cfApiTokenEl.value = '';   // never echo back the secret
    if (cfg.cloudflareTurnTokenId && cfg.cloudflareTurnApiToken) {
      const expiresIn = (cfg.turnExpiresAt || 0) - Date.now();
      if (expiresIn > 0) {
        const hrs = Math.floor(expiresIn / 3600000);
        const mins = Math.floor((expiresIn % 3600000) / 60000);
        rc.textContent = `✓ Auto-refresh on. Current credential expires in ${hrs}h ${mins}m.`;
      } else {
        rc.textContent = '✓ Auto-refresh configured. Will mint on next stream.';
      }
    } else {
      rc.textContent = 'Optional: paste master tokens so credentials refresh automatically.';
    }
  }
  await renderSetupStatus();
  await refreshPairStatus();
  // Refresh streaming-backend (Apollo/Sunshine) status if that section
  // is wired up. Done last because it can be slow (PowerShell spawn).
  if (typeof window.refreshBackendStatus === 'function') {
    window.refreshBackendStatus().catch(() => {});
  }
}
async function renderSetupStatus() {
  const s = await api('/api/status');
  const el = $('#setup-status');
  if (s.sunshine.reachable) { el.className = 'notice ok'; el.textContent = `Sunshine reachable at ${s.sunshine.apiHost}.`; }
  else if (s.sunshine.installed) { el.className = 'notice warn'; el.textContent = `Sunshine installed but API not reachable. Check credentials and that Sunshine is running.`; }
  else { el.className = 'notice bad'; el.textContent = 'Sunshine not detected. Install it from the tutorial in step 1.'; }
}
$('#cfg-save').addEventListener('click', async () => {
  await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sunshineHost: $('#cfg-host').value.trim(),
      sunshinePort: parseInt($('#cfg-port').value, 10) || 47990,
      sunshineUser: $('#cfg-user').value.trim(),
      sunshinePass: $('#cfg-pass').value,
    }),
  });
  await renderSetupStatus();
  await refreshStatus();
});
$('#cfg-public-save').addEventListener('click', async () => {
  await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicHost: $('#cfg-public').value.trim() }),
  });
  await renderSetupStatus();
});
// --- Pairing UI ---------------------------------------------------------
async function refreshPairStatus() {
  try {
    const s = await api('/api/pair/status');
    const el = $('#pair-status');
    if (s.paired && s.valid) { el.className = 'notice ok'; el.textContent = 'Paired with Sunshine ✓'; }
    else if (s.paired && !s.valid) { el.className = 'notice warn'; el.textContent = 'Paired, but Sunshine no longer recognizes us — re-pair.'; }
    else if (s.pinPending) { el.className = 'notice warn'; el.textContent = 'Waiting for PIN — Sunshine should be showing one now.'; $('#pair-pin-row').style.display = 'block'; }
    else { el.className = 'notice'; el.textContent = 'Not paired yet.'; }
  } catch (e) {
    $('#pair-status').className = 'notice bad';
    $('#pair-status').textContent = 'Bridge unavailable: ' + e.message;
  }
}
$('#pair-start').addEventListener('click', async () => {
  $('#pair-result').innerHTML = '';
  try {
    const r = await api('/api/pair/start', { method: 'POST' });
    $('#pair-pin-row').style.display = 'block';
    $('#pair-result').innerHTML = `<div class="notice">${escapeHtml(r.message)}</div>`;
    $('#pair-pin').focus();
    refreshPairStatus();
  } catch (e) {
    $('#pair-result').innerHTML = `<div class="notice bad">${escapeHtml(e.message)}</div>`;
  }
});
$('#pair-pin-submit').addEventListener('click', async () => {
  const pin = $('#pair-pin').value.trim();
  $('#pair-result').innerHTML = '<div class="notice">Submitting PIN…</div>';
  try {
    await api('/api/pair/pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    setTimeout(refreshPairStatus, 1500);  // give the handshake a moment
    $('#pair-result').innerHTML = '<div class="notice ok">PIN submitted. Finishing handshake…</div>';
  } catch (e) {
    $('#pair-result').innerHTML = `<div class="notice bad">${escapeHtml(e.message)}</div>`;
  }
});

$('#cfg-turn-save').addEventListener('click', async () => {
  const url = $('#cfg-turn-url').value.trim();
  const user = $('#cfg-turn-user').value.trim();
  const cred = $('#cfg-turn-cred').value;
  await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnUrl: url, turnUsername: user, turnCredential: cred }),
  });
  $('#cfg-turn-result').textContent = '✓ Saved. Next stream session will use these TURN servers.';
  setTimeout(() => loadSetup(), 1000);
});

// Guarded — if the user is on a cached index.html that lacks these elements,
// don't blow up the rest of the script.
{
  const cfSaveBtn = $('#cfg-cf-save');
  if (cfSaveBtn) cfSaveBtn.addEventListener('click', async () => {
    const tokenIdEl = $('#cfg-cf-token-id'); const apiTokenEl = $('#cfg-cf-api-token');
    const result = $('#cfg-cf-result');
    if (!tokenIdEl || !apiTokenEl || !result) return;
    const tokenId = tokenIdEl.value.trim();
    const apiToken = apiTokenEl.value;
    if (!tokenId || !apiToken) {
      result.textContent = '✗ Both Token ID and API Token required.';
      return;
    }
    result.textContent = 'Saving + minting…';
    try {
      await api('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudflareTurnTokenId: tokenId, cloudflareTurnApiToken: apiToken }),
      });
      // Now trigger a refresh by hitting /api/ice-servers — server-side
      // logic mints fresh creds if expired or absent.
      const ice = await api('/api/ice-servers');
      const hasTurn = (ice.iceServers || []).some(s => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some(u => /^turns?:/i.test(u)) && s.username;
      });
      if (hasTurn) {
        result.textContent = '✓ Saved + minted fresh credential. Auto-refresh is on.';
        setTimeout(() => loadSetup(), 800);
      } else {
        result.textContent = '⚠ Saved, but Cloudflare API did not return TURN creds. Check tokens.';
      }
    } catch (e) {
      result.textContent = '✗ ' + (e.message || 'failed');
    }
  });
}

$('#cfg-token-save').addEventListener('click', async () => {
  const t = $('#cfg-token').value;
  await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: t }),
  });
  // Save it in this browser too so the page keeps working immediately
  setIpToken(t);
  $('#cfg-token').value = '';
  alert('Saved. Other browsers will be asked for the token on first load.');
});

// --- utils --------------------------------------------------------------
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// --- Quality settings ---------------------------------------------------
const QUALITY_PRESETS = {
  potato: { width: 854,  height: 480,  framerate: 30, bitrateKbps: 900,  preset: 'p1' },
  low:    { width: 960,  height: 540,  framerate: 30, bitrateKbps: 1400, preset: 'p1' },
  medium: { width: 1280, height: 720,  framerate: 30, bitrateKbps: 2200, preset: 'p1' },
  high:   { width: 1280, height: 720,  framerate: 60, bitrateKbps: 3500, preset: 'p1' },
  max:    { width: 1920, height: 1080, framerate: 60, bitrateKbps: 6000, preset: 'p1' },
};

async function loadQuality() {
  const cfg = await api('/api/config');
  const w = cfg.streamWidth || 1280, h = cfg.streamHeight || 720;
  $('#q-res').value = `${w}x${h}`;
  $('#q-fps').value = String(cfg.streamFramerate || 60);
  $('#q-preset').value = cfg.streamPreset || 'p1';
  $('#q-bitrate').value = cfg.streamBitrateKbps || 3500;
  $('#q-bitrate-label').textContent = `${cfg.streamBitrateKbps || 3500} kbps`;
  const cpuEncode = $('#q-cpu-encode');
  if (cpuEncode) cpuEncode.checked = (cfg.useNvenc === false);
  const adaptive = $('#q-adaptive');
  if (adaptive) adaptive.checked = cfg.streamAdaptive !== false;
  const profile = streamClientProfile();
  const smartCopy = $('#q-smart-copy');
  if (smartCopy) {
    const network = profile.effectiveType || (profile.downlink ? `${profile.downlink} Mbps estimate` : 'network auto-detect');
    smartCopy.textContent = cfg.streamAdaptive !== false
      ? `On · ${network} · each device gets the fastest stable profile up to your saved ceiling.`
      : 'Off · every device receives the exact manual settings below.';
  }
  $('#q-current').innerHTML = `
    Mode:       <span style="color:var(--accent)">${cfg.streamAdaptive !== false ? 'Auto · per-device' : 'Manual'}</span><br>
    Resolution: <span style="color:var(--accent)">${w}×${h}</span><br>
    Framerate:  <span style="color:var(--accent)">${cfg.streamFramerate || 60} fps</span><br>
    Bitrate:    <span style="color:var(--accent)">${cfg.streamBitrateKbps || 3500} kbps</span><br>
    Preset:     <span style="color:var(--accent)">${cfg.streamPreset || 'p1'}</span><br>
    Encoder:    <span style="color:var(--accent)">${cfg.useNvenc === false ? 'libx264 (CPU)' : 'NVENC (GPU)'}</span>
  `;
  // Highlight matching preset (if exact match)
  document.querySelectorAll('.quality-preset').forEach(b => {
    const p = QUALITY_PRESETS[b.dataset.preset];
    const match = p && p.width === w && p.height === h
      && p.framerate === (cfg.streamFramerate || 60)
      && p.bitrateKbps === (cfg.streamBitrateKbps || 3500)
      && p.preset === (cfg.streamPreset || 'p1');
    b.classList.toggle('active', cfg.streamAdaptive === false && match);
  });
}

function bindQualityUI() {
  if (document._qualityBound) return;
  document._qualityBound = true;

  document.querySelectorAll('.quality-preset').forEach(b => {
    b.addEventListener('click', async () => {
      const p = QUALITY_PRESETS[b.dataset.preset];
      if (!p) return;
      await api('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamWidth: p.width, streamHeight: p.height,
          streamFramerate: p.framerate, streamBitrateKbps: p.bitrateKbps,
          streamPreset: p.preset, streamAdaptive: false,
        }),
      });
      await loadQuality();
      $('#q-save-result').textContent = `✓ Applied ${b.dataset.preset}`;
      setTimeout(() => { $('#q-save-result').textContent = ''; }, 2000);
    });
  });

  $('#q-bitrate').addEventListener('input', () => {
    $('#q-bitrate-label').textContent = `${$('#q-bitrate').value} kbps`;
  });

  $('#q-adaptive')?.addEventListener('change', async (e) => {
    await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamAdaptive: e.target.checked }),
    });
    await loadQuality();
    toast(e.target.checked ? 'Smart optimization enabled' : 'Manual quality enabled', 'ok');
  });

  $('#q-save').addEventListener('click', async () => {
    const [w, h] = $('#q-res').value.split('x').map(Number);
    await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamWidth: w, streamHeight: h,
        streamFramerate: parseInt($('#q-fps').value, 10),
        streamBitrateKbps: parseInt($('#q-bitrate').value, 10),
        streamPreset: $('#q-preset').value,
        streamAdaptive: $('#q-adaptive')?.checked !== false,
        // Checkbox checked means "use CPU" → useNvenc:false
        useNvenc: !($('#q-cpu-encode')?.checked),
      }),
    });
    await loadQuality();
    $('#q-save-result').textContent = '✓ Saved';
    setTimeout(() => { $('#q-save-result').textContent = ''; }, 2000);
  });
}

// --- Phone (scrcpy) -----------------------------------------------------
async function refreshPhoneStatus() {
  const el = $('#phone-status');
  if (!el) return;
  try {
    const s = await api('/api/phone/status');
    if (!s.installed) { el.className = 'notice bad'; el.textContent = 'scrcpy not installed at bin/scrcpy/scrcpy.exe'; }
    else if (s.running) { el.className = 'notice ok'; el.textContent = `scrcpy running (PID ${s.pid}). Open a Control PC stream to see the phone.`; }
    else { el.className = 'notice'; el.textContent = 'scrcpy ready. Click "Launch phone window" after ADB-connecting your phone.'; }
  } catch (e) {
    el.className = 'notice bad'; el.textContent = e.message;
  }
}
function bindPhoneUI() {
  const pair = $('#adb-pair-btn');
  if (!pair || pair._bound) return;
  pair._bound = true;

  pair.addEventListener('click', async () => {
    const host = $('#adb-host').value.trim();
    const port = $('#adb-pair-port').value.trim();
    const code = $('#adb-pair-code').value.trim();
    const out = $('#adb-pair-result');
    out.textContent = 'Pairing…';
    try {
      const r = await api('/api/phone/adb-pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, port, code }) });
      out.textContent = (r.ok ? '✓ ' : '✗ ') + r.output.split('\n').filter(l => l.trim()).pop();
    } catch (e) { out.textContent = '✗ ' + e.message; }
  });

  $('#adb-connect-btn').addEventListener('click', async () => {
    const host = $('#adb-conn-host').value.trim() || $('#adb-host').value.trim();
    const port = $('#adb-conn-port').value.trim();
    const out = $('#adb-conn-result');
    out.textContent = 'Connecting…';
    try {
      const r = await api('/api/phone/adb-connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, port }) });
      out.textContent = (r.ok ? '✓ ' : '✗ ') + (r.output || `exit ${r.exitCode}`);
    } catch (e) { out.textContent = '✗ ' + e.message; }
  });

  $('#phone-launch').addEventListener('click', async () => {
    try { await api('/api/phone/launch', { method: 'POST' }); } catch (e) { alert(e.message); }
    setTimeout(refreshPhoneStatus, 800);
  });
  $('#phone-stop').addEventListener('click', async () => {
    try { await api('/api/phone/stop', { method: 'POST' }); } catch {}
    setTimeout(refreshPhoneStatus, 400);
  });
}

let _spotifyLoadPromise = null;
function ensureSpotifyLoaded() {
  if (window.SP) return Promise.resolve(window.SP);
  if (_spotifyLoadPromise) return _spotifyLoadPromise;
  _spotifyLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/js/spotify.js';
    script.async = true;
    script.onload = () => resolve(window.SP);
    script.onerror = () => reject(new Error('Music player failed to load'));
    document.head.appendChild(script);
  });
  return _spotifyLoadPromise;
}

// Hook into showView to lazy-bind on first open
const _origShowView = showView;
showView = function(name) {
  _origShowView(name);
  if (name === 'phone')   { bindPhoneUI(); refreshPhoneStatus(); showQrIfPublic(); }
  if (name === 'quality') { bindQualityUI(); loadQuality(); }
  if (name === 'customization') { bindCustomizeUI(); }
  if (name === 'music') {
    ensureSpotifyLoaded()
      .then(() => { bindMusicUI(); loadMusic(); })
      .catch((error) => toast(error.message, 'bad'));
  }
  // The now-playing bar lives outside the music section (so position:fixed
  // anchors to the viewport, not a transformed parent). We control its
  // visibility from the view router.
  const nowBar = document.getElementById('sp-now');
  if (nowBar) nowBar.hidden = (name !== 'music');
};

// --- Spotify Music view --------------------------------------------------
// All the launcher-side glue for the Spotify player. window.SP (defined in
// spotify.js) handles auth + the Web Playback SDK + REST calls; this code
// drives the UI state machine and DOM updates.

let _spState = null;          // last state from spotify:state event
let _spSeekTracking = true;   // pause UI seek updates while user is dragging
let _spProgressTimer = null;

async function loadMusic() {
  if (!window.SP) return;
  const cfg = await api('/api/config').catch(() => ({}));
  const clientId = cfg.spotifyClientId || '';
  SP.setClientId(clientId);

  const needsSetup = $('#sp-needs-setup');
  const needsAuth  = $('#sp-needs-auth');
  const app        = $('#sp-app');
  const userBox    = $('#sp-user');

  // Hide everything first; we re-enable the right pane below
  needsSetup.hidden = true;
  needsAuth.hidden  = true;
  app.hidden        = true;
  userBox.hidden    = true;

  if (!clientId) {
    needsSetup.hidden = false;
    return;
  }
  // No local tokens? Try to bootstrap from server — the user might have
  // authed on another device and the server is holding the refresh token.
  if (!SP.isAuthenticated()) {
    await SP.bootstrapFromServer();
  }
  if (!SP.isAuthenticated()) {
    needsAuth.hidden = false;
    return;
  }

  // Authenticated — show the app and start the player
  app.hidden = false;
  userBox.hidden = false;
  try {
    const me = await SP.getMe();
    $('#sp-name').textContent = me?.display_name || 'Spotify';
    $('#sp-avatar').src = me?.images?.[0]?.url || '';
    $('#sp-avatar').style.display = me?.images?.[0]?.url ? 'block' : 'none';
  } catch (e) {
    console.error('[music] getMe failed', e);
  }

  // Initialize the SDK player in the background (idempotent)
  SP.initPlayer().catch((e) => {
    toast('Spotify player init failed: ' + e.message, 'bad');
  });

  // Populate the current tab (default: home)
  const activeTab = $('.sp-tab.active')?.dataset.spTab || 'home';
  populateSpTab(activeTab);
}

function bindMusicUI() {
  if (document._musicBound) return;
  document._musicBound = true;

  // --- Connect Spotify ---
  $('#sp-connect')?.addEventListener('click', async () => {
    try { await SP.startAuth(); }
    catch (e) { $('#sp-auth-error').textContent = e.message; }
  });

  // --- Logout ---
  $('#sp-logout')?.addEventListener('click', () => {
    SP.logout();
    loadMusic();
  });

  // --- Tab switching ---
  $$('.sp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.spTab;
      $$('.sp-tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('.sp-pane').forEach(p => p.hidden = p.dataset.spPane !== t);
      populateSpTab(t);
    });
  });

  // --- Search (debounced) ---
  let _searchT = null;
  $('#sp-search-input')?.addEventListener('input', (e) => {
    clearTimeout(_searchT);
    const q = e.target.value;
    _searchT = setTimeout(async () => {
      const root = $('#sp-search-results');
      root.innerHTML = '<div class="notice" style="margin:12px 0">Searching…</div>';
      try {
        const res = await SP.search(q);
        renderTracks(root, (res.tracks?.items || []), { context: null });
      } catch (err) {
        root.innerHTML = `<div class="notice bad">${escapeHtml(err.message)}</div>`;
      }
    }, 250);
  });

  // --- Playlist detail back button ---
  $('#sp-pl-back')?.addEventListener('click', () => {
    showSpPane('library');
  });

  // --- Now playing controls ---
  $('#sp-toggle')?.addEventListener('click', () => SP.toggle?.());
  $('#sp-next')  ?.addEventListener('click', () => SP.next());
  $('#sp-prev')  ?.addEventListener('click', () => SP.prev());

  const seek = $('#sp-seek');
  if (seek) {
    seek.addEventListener('input',  () => { _spSeekTracking = false; });
    seek.addEventListener('change', () => {
      const dur = _spState?.duration || 0;
      const ms  = Math.floor((parseFloat(seek.value) / 100) * dur);
      SP.seek(ms).finally(() => { _spSeekTracking = true; });
    });
  }
  const vol = $('#sp-volume');
  if (vol) {
    vol.addEventListener('change', () => SP.setVolume(parseInt(vol.value, 10)));
  }

  // --- Listen for SDK state updates ---
  document.addEventListener('spotify:state', (e) => {
    _spState = e.detail;
    renderNow(_spState);
  });
  // Make the now-playing bar refresh once we have a device
  document.addEventListener('spotify:ready', () => {
    // Auto-transfer playback to this device once the player is ready,
    // but don't auto-play — let the user start things.
    SP.transferToHere(false).catch(() => {});
  });

  // Smooth progress bar update — SDK only fires on state changes, not
  // continuously. Tick locally between state updates.
  if (!_spProgressTimer) {
    _spProgressTimer = setInterval(() => {
      if (!_spState || _spState.paused) return;
      _spState.position = (_spState.position || 0) + 500;
      if (_spState.duration && _spState.position > _spState.duration) {
        _spState.position = _spState.duration;
      }
      renderNow(_spState, true);
    }, 500);
  }
}

// Switch between Home / Library / Search / Playlist-Detail panes
function showSpPane(name) {
  $$('.sp-pane').forEach(p => p.hidden = p.dataset.spPane !== name);
  // Also update the tab highlight if it's a tabbed pane
  if (['home', 'library', 'search'].includes(name)) {
    $$('.sp-tab').forEach(b => b.classList.toggle('active', b.dataset.spTab === name));
  }
}

async function populateSpTab(tab) {
  try {
    if (tab === 'home')    await loadSpotifyHome();
    if (tab === 'library') await loadSpotifyLibrary();
    if (tab === 'search')  { /* search loads on input */ }
  } catch (e) {
    console.error('[music] populate', tab, e);
  }
}

async function loadSpotifyHome() {
  const recentRoot = $('#sp-recent');
  const topRoot    = $('#sp-top');
  recentRoot.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:8px">Loading…</div>';
  topRoot.innerHTML    = '<div style="color:var(--text-faint);font-size:12px;padding:8px">Loading…</div>';

  const [recent, top] = await Promise.all([
    SP.getRecent().catch(() => null),
    SP.getTopTracks().catch(() => null),
  ]);

  // Recently played — deduplicate by track and render as cards
  recentRoot.innerHTML = '';
  const seen = new Set();
  for (const it of (recent?.items || [])) {
    const tr = it.track; if (!tr || seen.has(tr.id)) continue; seen.add(tr.id);
    const card = document.createElement('div');
    card.className = 'sp-card';
    card.innerHTML = `
      <img src="${tr.album?.images?.[0]?.url || ''}" alt="" />
      <div class="sp-card-title">${escapeHtml(tr.name || '')}</div>
      <div class="sp-card-sub">${escapeHtml((tr.artists || []).map(a => a.name).join(', '))}</div>`;
    card.addEventListener('click', () => SP.play({ uris: [tr.uri] }).catch(e => toast(e.message, 'bad')));
    recentRoot.appendChild(card);
  }

  // Top tracks — render as full track rows
  renderTracks(topRoot, (top?.items || []), { context: null });
}

async function loadSpotifyLibrary() {
  const plRoot   = $('#sp-playlists');
  const likeRoot = $('#sp-liked');
  plRoot.innerHTML   = '<div style="color:var(--text-faint);font-size:12px;padding:8px">Loading playlists…</div>';
  likeRoot.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:8px">Loading liked songs…</div>';

  const [pls, liked] = await Promise.all([
    SP.getPlaylists().catch(() => null),
    SP.getSavedTracks().catch(() => null),
  ]);

  plRoot.innerHTML = '';
  for (const pl of (pls?.items || [])) {
    const card = document.createElement('div');
    card.className = 'sp-card';
    card.innerHTML = `
      <img src="${pl.images?.[0]?.url || ''}" alt="" />
      <div class="sp-card-title">${escapeHtml(pl.name || '')}</div>
      <div class="sp-card-sub">${pl.tracks?.total || 0} tracks · ${escapeHtml(pl.owner?.display_name || '')}</div>`;
    card.addEventListener('click', () => openPlaylist(pl));
    plRoot.appendChild(card);
  }
  if (!pls?.items?.length) plRoot.innerHTML = '<div class="notice">No playlists yet — make some in the Spotify app.</div>';

  // Saved tracks
  const likedTracks = (liked?.items || []).map(it => it.track).filter(Boolean);
  renderTracks(likeRoot, likedTracks, { context: null });
}

async function openPlaylist(pl) {
  showSpPane('playlist-detail');
  $('#sp-pl-art').src = pl.images?.[0]?.url || '';
  $('#sp-pl-title').textContent = pl.name;
  $('#sp-pl-meta').textContent  = `${pl.owner?.display_name || ''} · ${pl.tracks?.total || 0} tracks`;

  const tracksRoot = $('#sp-pl-tracks');
  tracksRoot.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:8px">Loading tracks…</div>';

  $('#sp-pl-play').onclick = () => SP.play({ contextUri: pl.uri }).catch(e => toast(e.message, 'bad'));

  try {
    const data = await SP.getPlaylistTracks(pl.id);
    // Defensively handle every shape Spotify might give back: items as
    // [{track:{}}], items as [{}], items missing entirely, or data wrapping
    // the array directly.
    const rawItems = Array.isArray(data?.items) ? data.items
                   : Array.isArray(data)        ? data
                   : [];
    const tracks = rawItems.map(it => it?.track || it).filter(t => t && t.uri);
    if (!tracks.length) {
      tracksRoot.innerHTML = `<div class="notice">This playlist is empty (or Spotify isn't returning its tracks). Try the Play button — it usually works even when reading the list doesn't.</div>`;
      return;
    }
    renderTracks(tracksRoot, tracks, { context: pl.uri });
  } catch (e) {
    const is403 = /\b403\b/.test(e.message);
    let body = `<div style="margin-bottom:8px">${escapeHtml(e.message)}</div>`;
    if (is403) {
      body = `
        <div style="line-height:1.6;font-size:13px;color:var(--text-dim)">
          <strong style="color:var(--text)">Can't show this playlist's track list — but you can still play it.</strong>
          <br>Hit the <strong>Play</strong> button above; Spotify's <em>playback</em> endpoint usually works even when the <em>read-tracks</em> endpoint doesn't. The track list and now-playing bar will populate as songs play.
          <br><br>
          <strong style="color:var(--text)">Why this happens:</strong> Spotify's API was tightened in late 2024. Apps in <em>Development Mode</em> (where yours is by default) lose read access to <code>/playlists/{id}/tracks</code>, <code>/me/player/recently-played</code>, and similar "content" endpoints — even for the app owner. Summary endpoints like the playlist list itself, your top tracks, and the player itself still work.
          <br><br>
          <strong style="color:var(--text)">Workarounds:</strong>
          <ul style="margin:6px 0 0;padding-left:20px">
            <li>Use the <strong>Play</strong> button — it routes through <code>/me/player/play</code>, which Spotify keeps open for dev apps.</li>
            <li>Apply for <a href="https://developer.spotify.com/dashboard" target="_blank">Extended Quota Mode</a> on your dev app (free, ~2-week review). Once approved, all endpoints work.</li>
          </ul>
          <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--text-faint)">Raw error</summary><div style="margin-top:6px;font-family:monospace;font-size:11px;color:var(--text-faint)">${escapeHtml(e.message)}</div></details>
        </div>`;
    }
    tracksRoot.innerHTML = `<div class="notice bad">${body}</div>`;
  }
}

function renderTracks(root, tracks, opts = {}) {
  root.innerHTML = '';
  if (!tracks.length) {
    root.innerHTML = '<div class="notice">No tracks.</div>';
    return;
  }
  for (const tr of tracks) {
    const row = document.createElement('div');
    row.className = 'sp-track';
    row.dataset.uri = tr.uri;
    row.innerHTML = `
      <img src="${tr.album?.images?.[0]?.url || ''}" alt="" />
      <div class="sp-track-meta">
        <div class="sp-track-title">${escapeHtml(tr.name || '')}</div>
        <div class="sp-track-artist">${escapeHtml((tr.artists || []).map(a => a.name).join(', '))}</div>
      </div>
      <div class="sp-track-album">${escapeHtml(tr.album?.name || '')}</div>
      <div class="sp-track-dur">${msToTime(tr.duration_ms || 0)}</div>`;
    row.addEventListener('click', () => {
      // If we have a playlist context, play from that context starting at this track.
      // Otherwise play just this URI.
      if (opts.context) {
        SP.play({ contextUri: opts.context, offsetUri: tr.uri }).catch(e => toast(e.message, 'bad'));
      } else {
        SP.play({ uris: [tr.uri] }).catch(e => toast(e.message, 'bad'));
      }
    });
    root.appendChild(row);
  }
}

function renderNow(state, silent) {
  if (!state) return;
  const nowBar = $('#sp-now');
  if (!nowBar) return;

  const tr = state.track_window?.current_track;
  if (tr) {
    const art = tr.album?.images?.[0]?.url;
    $('#sp-now-art').style.backgroundImage = art ? `url('${art}')` : '';
    $('#sp-now-title').textContent  = tr.name || '—';
    $('#sp-now-artist').textContent = (tr.artists || []).map(a => a.name).join(', ');
  }
  // Swap the play/pause SVG path based on playback state. Paths are
  // centroid-balanced at (8,8) within a 16x16 viewBox for clean centering.
  const icon = $('#sp-toggle-icon');
  if (icon) {
    icon.innerHTML = state.paused
      ? '<path d="M6 3l6 5l-6 5z"/>'                                  /* play  */
      : '<path d="M5 3h2v10H5zM9 3h2v10H9z"/>';                       /* pause */
  }

  // Progress bar
  const seek = $('#sp-seek');
  if (seek && _spSeekTracking && state.duration) {
    const pct = Math.max(0, Math.min(100, (state.position / state.duration) * 100));
    seek.value = pct.toFixed(2);
  }
  $('#sp-now-cur').textContent = msToTime(state.position || 0);
  $('#sp-now-dur').textContent = msToTime(state.duration || 0);

  // Highlight the now-playing track in any visible track list
  if (!silent) {
    $$('.sp-track').forEach(r => r.classList.toggle('now', tr && r.dataset.uri === tr.uri));
  }
}

function msToTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

// --- Setup tab: Spotify Client ID + Redirect URI helper ----------------
{
  const setRedirect = () => {
    const el = $('#sp-redirect-uri');
    if (el && window.SP) el.textContent = SP.redirectUri;
  };
  // Whenever Setup view opens, refresh the URI display
  document.addEventListener('DOMContentLoaded', setRedirect);
  setRedirect();
  $('#sp-copy-uri')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SP.redirectUri);
      toast('Redirect URI copied', 'ok');
    } catch {
      toast('Copy failed — select and copy manually', 'bad');
    }
  });
  $('#cfg-spotify-save')?.addEventListener('click', async () => {
    const id = $('#cfg-spotify-client').value.trim();
    const result = $('#cfg-spotify-result');
    if (!id) { result.textContent = '✗ Paste your Client ID first.'; return; }
    result.textContent = 'Saving…';
    try {
      await api('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spotifyClientId: id }),
      });
      result.textContent = '✓ Saved. Open the Music tab and click Connect Spotify.';
      SP.setClientId(id);
    } catch (e) {
      result.textContent = '✗ ' + e.message;
    }
  });

  // --- Streaming backend (Sunshine vs Apollo) -------------------------
  async function refreshBackendStatus() {
    const el = $('#cfg-backend-status');
    if (!el) return;
    try {
      const s = await api('/api/backend/status');
      const lines = [];
      const dotApollo   = s.apollo.installed   ? (s.apollo.Status   === 'Running' ? '●' : '○') : '·';
      const dotSunshine = s.sunshine.installed ? (s.sunshine.Status === 'Running' ? '●' : '○') : '·';
      lines.push(`${dotApollo}  Apollo:   ${s.apollo.installed   ? s.apollo.Status   + ' / ' + s.apollo.StartType   : 'not installed'}`);
      lines.push(`${dotSunshine}  Sunshine: ${s.sunshine.installed ? s.sunshine.Status + ' / ' + s.sunshine.StartType : 'not installed'}`);
      lines.push(`Active backend: ${s.active || 'none'}`);
      el.textContent = lines.join('\n');
      el.style.whiteSpace = 'pre';
      // Disable the button for the currently-active backend
      const sunBtn = $('#cfg-backend-sunshine');
      const apoBtn = $('#cfg-backend-apollo');
      if (sunBtn) sunBtn.disabled = (s.active === 'sunshine') || !s.sunshine.installed;
      if (apoBtn) apoBtn.disabled = (s.active === 'apollo')   || !s.apollo.installed;
    } catch (e) {
      el.textContent = 'Status unavailable: ' + e.message;
    }
  }

  async function switchBackend(backend) {
    const result = $('#cfg-backend-result');
    result.textContent = `Switching to ${backend}…`;
    try {
      const r = await api('/api/backend/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend }),
      });
      if (r.ok) {
        result.textContent = `✓ Now running ${backend} (status: ${r.status})`;
      } else {
        result.textContent = `✗ ${r.error || 'Switch failed'}`;
      }
    } catch (e) {
      result.textContent = '✗ ' + e.message + '. Server may need to run elevated — try restarting via install-service.bat.';
    }
    await refreshBackendStatus();
  }

  $('#cfg-backend-sunshine')?.addEventListener('click', () => switchBackend('sunshine'));
  $('#cfg-backend-apollo')?.addEventListener('click',   () => switchBackend('apollo'));

  // Expose so loadSetup() (module scope) can call it on Setup re-entry
  window.refreshBackendStatus = refreshBackendStatus;

  // First load
  refreshBackendStatus();
}

// --- Customization tab --------------------------------------------------
// Accent color, wallpaper, glass intensity — all stored in localStorage
// and applied as CSS variables on :root so they affect every surface
// (buttons, active nav indicators, glass blur radius, etc.).
const ACCENT_PRESETS = [
  '#6ab0ff', '#ffffff', '#e5e7eb',
  '#5eead4', '#34d399', '#a3e635',
  '#fbbf24', '#fb923c', '#f87171', '#fb7185',
  '#a78bfa', '#818cf8', '#60a5fa', '#22d3ee',
];

function applyAccent(hex) {
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  // Derive soft / glow variants by alpha-blending
  const rgb = hexToRgb(hex);
  if (rgb) {
    root.style.setProperty('--accent-soft', `rgba(${rgb.r},${rgb.g},${rgb.b},0.20)`);
    root.style.setProperty('--accent-glow', `rgba(${rgb.r},${rgb.g},${rgb.b},0.35)`);
  }
  try { localStorage.setItem('accent', hex); } catch {}
}
function applyGlass(px) {
  const amount = Math.min(44, Math.max(18, Number.isFinite(px) ? px : 32));
  document.documentElement.style.setProperty('--glass-blur', `blur(${amount}px) saturate(175%) contrast(0.96) brightness(1.08)`);
  try { localStorage.setItem('glassPx', String(amount)); } catch {}
}
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : null;
}

// Restore saved theme on boot, BEFORE the boot splash hides
(function restoreTheme() {
  try {
    const a = localStorage.getItem('accent'); if (a) applyAccent(a);
    const g = localStorage.getItem('glassPx');
    if (g !== null) {
      const savedGlass = parseInt(g, 10);
      applyGlass(Number.isFinite(savedGlass) ? savedGlass : 32);
    }
  } catch {}
})();

function loadCustomize() {
  // Build accent swatches
  const sw = $('#color-swatches'); if (!sw) return;
  if (!sw._built) {
    sw._built = true;
    for (const hex of ACCENT_PRESETS) {
      const dot = document.createElement('div');
      dot.className = 'color-swatch';
      dot.style.background = hex;
      dot.dataset.color = hex;
      dot.addEventListener('click', () => { applyAccent(hex); markActiveAccent(hex); });
      sw.appendChild(dot);
    }
  }

  // Build wallpaper grid
  const wg = $('#wall-grid'); if (wg && !wg._built) {
    wg._built = true;
    const list = (window.Wallpapers?.list?.() || []);
    for (const w of list) {
      const tile = document.createElement('div');
      tile.className = 'wall-tile';
      tile.dataset.wallpaper = w.id;
      tile.title = w.name;
      tile.innerHTML = `<div class="wall-tile-label">${escapeHtml(w.name)}</div>`;
      tile.addEventListener('click', () => {
        window.Wallpapers?.set?.(w.id);
        markActiveWallpaper(w.id);
      });
      wg.appendChild(tile);
    }
  }

  // Sync UI to current values
  const cur = localStorage.getItem('accent') || '#6ab0ff';
  markActiveAccent(cur);
  if ($('#custom-color')) $('#custom-color').value = cur.length === 7 ? cur : '#6ab0ff';
  markActiveWallpaper(window.Wallpapers?.current?.() || 'liquid');
  const gpx = parseInt(localStorage.getItem('glassPx') || '32', 10);
  if ($('#glass-intensity')) $('#glass-intensity').value = gpx;
  if ($('#glass-label')) $('#glass-label').textContent = gpx + ' px';
}

function markActiveAccent(hex) {
  $$('#color-swatches .color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color?.toLowerCase() === hex.toLowerCase());
  });
}
function markActiveWallpaper(id) {
  $$('#wall-grid .wall-tile').forEach(t => {
    t.classList.toggle('active', t.dataset.wallpaper === id);
  });
}

function bindCustomizeUI() {
  if (document._customizeBound) return;
  document._customizeBound = true;
  $('#custom-color')?.addEventListener('input', (e) => {
    applyAccent(e.target.value);
    markActiveAccent(e.target.value);
  });
  $('#glass-intensity')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    applyGlass(v);
    if ($('#glass-label')) $('#glass-label').textContent = v + ' px';
  });
  $('#cust-reset')?.addEventListener('click', () => {
    applyAccent('#6ab0ff');
    applyGlass(32);
    window.Wallpapers?.set?.('liquid');
    loadCustomize();
  });
}

// --- QR code for phone (uses Google's chart API, no extra deps) ---------
function showQrIfPublic() {
  const qrBlock = $('#qr-block');
  // Only show if we're being viewed from somewhere that's actually shareable.
  // localhost / 127.0.0.1 don't work as scan targets — phones can't reach them.
  const url = window.location.origin;
  const isLocalOnly = /^https?:\/\/(localhost|127\.|192\.168\.|10\.)/i.test(url);
  if (isLocalOnly) {
    // Look up publicHost from config to use a shareable URL instead
    api('/api/config').then(cfg => {
      if (cfg.publicHost) {
        const phoneUrl = `https://${cfg.publicHost}/`;
        $('#qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(phoneUrl)}`;
        $('#qr-host').textContent = phoneUrl.replace(/^https?:\/\//, '');
        qrBlock.style.display = 'block';
      }
    }).catch(() => {});
  } else {
    $('#qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
    $('#qr-host').textContent = url.replace(/^https?:\/\//, '');
    qrBlock.style.display = 'block';
  }
}

// --- boot ---------------------------------------------------------------
// Gate the entire app behind /api/auth/check. If login is required and
// the browser doesn't have a valid token, show the login overlay and
// don't fire any normal init. After successful POST /api/login, the
// overlay re-calls bootApp() which proceeds normally.

async function bootApp() {
  try {
    const r = await fetch(API_BASE + '/api/auth/check', {
      headers: ipToken() ? { 'x-ip-token': ipToken() } : {},
    });
    if (!r.ok) { showLogin(); return; }
  } catch {
    showLogin();
    return;
  }

  // Authenticated — hide login overlay if visible, kick off normal init.
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.hidden = true;

  refreshStatus();
  loadLibrary();
  clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    if (!document.hidden) refreshStatus();
  }, 15000);

  // Hash route on boot (e.g. /#music after Spotify OAuth callback)
  const v = (location.hash || '').replace(/^#/, '');
  const valid = ['library', 'tutorials', 'setup', 'quality', 'customization', 'phone', 'music'];
  if (valid.includes(v)) showView(v);
}

function showLogin() {
  const overlay = document.getElementById('login-overlay');
  const form    = document.getElementById('login-form');
  const userEl  = document.getElementById('login-user');
  const passEl  = document.getElementById('login-pass');
  const errEl   = document.getElementById('login-error');
  const submit  = document.getElementById('login-submit');
  if (!overlay || !form) return;

  overlay.hidden = false;
  // Always start blank — no pre-fill, no carry-over from previous attempts
  userEl.value = '';
  passEl.value = '';
  userEl.focus();

  if (form._bound) return;
  form._bound = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const r = await fetch(API_BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: userEl.value.trim(),
          password: passEl.value,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok && data.token) {
        // Save token. Reuse existing ip-token slot so api() picks it up
        // automatically on every gated call.
        setIpToken(data.token);
        bootApp();    // resume normal init
      } else {
        errEl.textContent = data.error || 'Login failed.';
        errEl.hidden = false;
        passEl.select();
      }
    } catch (err) {
      errEl.textContent = 'Network error: ' + (err.message || 'unknown');
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Log in';
    }
  });
}

bootApp();

// --- PWA-mode awareness -------------------------------------------------
// Adds a `pwa` class to <html> so CSS can adapt, and shows a one-time
// confirmation toast that the installed-app upgrades are active.
{
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    window.navigator.standalone === true;
  if (isStandalone) {
    document.documentElement.classList.add('pwa');
    if (!sessionStorage.getItem('pwa-greeted')) {
      sessionStorage.setItem('pwa-greeted', '1');
      setTimeout(() => {
        if (typeof toast === 'function') {
          toast('App mode active — wake lock + full keyboard capture enabled', 'ok');
        }
      }, 1500);
    }
  }
}

// Reveal the UI: brief splash, then fade to .app
(function bootReveal() {
  const splash = document.getElementById('boot-splash');
  const app = document.querySelector('.app');
  // Show .app underneath the splash so the transition feels seamless
  requestAnimationFrame(() => app?.classList.add('ready'));
  // Splash stays visible long enough to feel intentional (~1.3s),
  // then fades out. The CSS .gone class handles the opacity transition.
  setTimeout(() => {
    splash?.classList.add('gone');
    setTimeout(() => splash?.remove(), 700);
  }, 1300);
})();

const API_BASE = (typeof window !== "undefined" && window.__API_BASE) || "";
// ============================================================
// Spotify integration — runs entirely in the browser.
//
// - PKCE OAuth (no client secret), tokens kept in localStorage,
//   refreshed automatically when an API call gets a 401.
// - Web Playback SDK provides actual in-browser audio playback,
//   exposed to Spotify Connect as a device called "Cloud Play".
// - REST helpers wrap api.spotify.com/v1 endpoints.
//
// Exposes window.SP with the full surface needed by the Music
// view in app.js. Loading order matters: this script defines
// SP; the SDK is loaded lazily the first time the player is
// requested.
// ============================================================
(function () {
  const SCOPES = [
    'streaming',
    'user-read-email', 'user-read-private',
    'playlist-read-private', 'playlist-read-collaborative',
    'user-library-read',
    'user-modify-playback-state', 'user-read-playback-state',
    'user-read-currently-playing',
    'user-top-read',
  ].join(' ');

  const REDIRECT_URI = window.location.origin + '/spotify-callback.html';
  const TOKEN_KEY    = 'sp-tokens';
  const VERIFIER_KEY = 'sp-pkce-verifier';

  let clientId = null;
  let tokens   = loadTokens();
  let player   = null;
  let deviceId = null;
  let _refreshInFlight = null;
  let _sdkLoading      = null;
  let _sdkReadyPromise = null;

  // Pass the launcher's access token through to gated /api/* endpoints
  function ipTokenHeaders() {
    const t = localStorage.getItem('ip-token') || '';
    return t ? { 'x-ip-token': t } : {};
  }

  // ---- Tokens ---------------------------------------------------
  function loadTokens() {
    try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); }
    catch { return null; }
  }
  function saveTokens(t) {
    tokens = t;
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else   localStorage.removeItem(TOKEN_KEY);
  }
  function isAuthenticated() { return !!tokens?.access_token; }
  function logout() {
    saveTokens(null);
    try { player?.disconnect?.(); } catch {}
    player = null; deviceId = null;
    // Also wipe the server-side refresh token so other devices stop being
    // auto-authenticated. (If the user only wants per-device logout this is
    // wrong, but they explicitly asked for shared auth across devices, so
    // the inverse — shared logout — is consistent.)
    fetch(API_BASE + '/api/spotify/refresh-token', {
      method: 'DELETE', headers: ipTokenHeaders(),
    }).catch(() => {});
    document.dispatchEvent(new CustomEvent('spotify:auth', { detail: { authenticated: false } }));
  }

  // Server-side bootstrap: ask our server for an access token using its
  // stored refresh token. Used on every page load before we know if local
  // tokens exist. If the server has a refresh token, we get back a fresh
  // 1-hour access token — the user (or their friend's browser) is now
  // logged in with no OAuth dance.
  async function bootstrapFromServer() {
    try {
      const r = await fetch(API_BASE + '/api/spotify/access-token', { headers: ipTokenHeaders() });
      if (!r.ok) return false;
      const data = await r.json();
      if (!data.ok || !data.access_token) return false;
      saveTokens({
        access_token: data.access_token,
        expires_at:   Date.now() + (data.expires_in - 30) * 1000,
        scope:        data.scope,
        server_managed: true,    // marker — refresh goes via server, not Spotify directly
      });
      return true;
    } catch { return false; }
  }

  async function refreshAccessToken() {
    if (_refreshInFlight) return _refreshInFlight;
    _refreshInFlight = (async () => {
      try {
        // Two paths:
        //   - server_managed: server holds the refresh token; ask it for a
        //     fresh access token. Used on shared/visiting devices.
        //   - local refresh_token (legacy): refresh directly against
        //     accounts.spotify.com. Used right after OAuth completes.
        if (tokens?.server_managed || !tokens?.refresh_token) {
          const r = await fetch(API_BASE + '/api/spotify/access-token', { headers: ipTokenHeaders() });
          if (!r.ok) { console.error('[spotify] server refresh failed', r.status); return null; }
          const data = await r.json();
          if (!data.ok || !data.access_token) { console.error('[spotify] server refresh returned no token'); return null; }
          saveTokens({
            ...(tokens || {}),
            access_token: data.access_token,
            expires_at:   Date.now() + (data.expires_in - 30) * 1000,
            scope:        data.scope || tokens?.scope,
            server_managed: true,
          });
          return tokens.access_token;
        }
        // Legacy local path (right after OAuth, before server bootstrap kicks in)
        if (!clientId) return null;
        const body = new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        });
        const r = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (!r.ok) {
          console.error('[spotify] refresh failed', r.status);
          // Try the server bootstrap as a fallback before giving up
          if (await bootstrapFromServer()) return tokens.access_token;
          logout();
          return null;
        }
        const data = await r.json();
        saveTokens({
          access_token:  data.access_token,
          refresh_token: data.refresh_token || tokens.refresh_token,
          expires_at:    Date.now() + (data.expires_in - 30) * 1000,
          scope:         data.scope || tokens.scope,
        });
        return tokens.access_token;
      } finally {
        _refreshInFlight = null;
      }
    })();
    return _refreshInFlight;
  }

  // ---- PKCE auth start -----------------------------------------
  async function startAuth() {
    if (!clientId) throw new Error('No Spotify Client ID set — fill it in Setup first.');
    const verifier  = randomString(64);
    const challenge = await sha256base64url(verifier);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    window.location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
  }

  function randomString(n) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const buf = new Uint8Array(n); crypto.getRandomValues(buf);
    let s = ''; for (const b of buf) s += chars[b % chars.length];
    return s;
  }
  async function sha256base64url(s) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return base64url(new Uint8Array(hash));
  }
  function base64url(bytes) {
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---- API call helper -----------------------------------------
  async function api(path, opts = {}) {
    if (!tokens?.access_token) throw new Error('Spotify not authenticated');
    if (tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
      await refreshAccessToken();
    }
    const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
    const send = async () => {
      const headers = {
        'Authorization': 'Bearer ' + tokens.access_token,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      };
      return fetch(url, { ...opts, headers });
    };
    let r = await send();
    if (r.status === 401) {
      await refreshAccessToken();
      if (tokens?.access_token) r = await send();
    }
    if (r.status === 204) return null;
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Spotify ${r.status}: ${txt.slice(0, 200)}`);
    }
    return r.json().catch(() => null);
  }

  // ---- Web Playback SDK ----------------------------------------
  function loadSDK() {
    if (window.Spotify) return Promise.resolve();
    if (_sdkLoading) return _sdkLoading;
    _sdkLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.async = true;
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'));
      document.head.appendChild(s);
    });
    return _sdkLoading;
  }

  // Returns a promise that resolves with the device_id when ready.
  async function initPlayer() {
    if (deviceId) return deviceId;
    if (_sdkReadyPromise) return _sdkReadyPromise;
    if (!tokens?.access_token) throw new Error('Not authenticated');
    await loadSDK();

    _sdkReadyPromise = new Promise((resolve, reject) => {
      const create = () => {
        player = new window.Spotify.Player({
          name: 'Cloud Play',
          getOAuthToken: async (cb) => {
            if (tokens?.expires_at && Date.now() > tokens.expires_at - 60_000) {
              await refreshAccessToken();
            }
            cb(tokens?.access_token || '');
          },
          volume: 0.6,
        });

        player.addListener('ready', ({ device_id }) => {
          deviceId = device_id;
          console.log('[spotify] device ready:', device_id);
          document.dispatchEvent(new CustomEvent('spotify:ready', { detail: { deviceId } }));
          resolve(device_id);
        });
        player.addListener('not_ready', () => { deviceId = null; });
        player.addListener('initialization_error', ({ message }) => {
          console.error('[spotify] init error:', message); reject(new Error(message));
        });
        player.addListener('authentication_error', ({ message }) => {
          console.error('[spotify] auth error:', message); logout(); reject(new Error(message));
        });
        player.addListener('account_error', ({ message }) => {
          console.error('[spotify] account error:', message); reject(new Error(message + ' — Spotify Premium is required for in-browser playback.'));
        });
        player.addListener('player_state_changed', (state) => {
          if (!state) return;
          document.dispatchEvent(new CustomEvent('spotify:state', { detail: state }));
        });

        player.connect();
      };

      if (window.Spotify) create();
      else window.onSpotifyWebPlaybackSDKReady = create;
    });
    return _sdkReadyPromise;
  }

  // ---- Playback control ----------------------------------------
  // Transfer playback to our in-browser device. Use before play()
  // if Spotify is currently playing elsewhere (phone, desktop app).
  async function transferToHere(playImmediately = false) {
    if (!deviceId) await initPlayer();
    return api('/me/player', {
      method: 'PUT',
      body: JSON.stringify({ device_ids: [deviceId], play: !!playImmediately }),
    });
  }

  // Start playing a specific track URI, or a playlist/album context.
  async function play({ uris, contextUri, offsetUri, positionMs } = {}) {
    if (!deviceId) await initPlayer();
    const body = {};
    if (uris) body.uris = uris;
    if (contextUri) body.context_uri = contextUri;
    if (offsetUri)  body.offset = { uri: offsetUri };
    if (positionMs != null) body.position_ms = positionMs;
    return api(`/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    });
  }
  async function resume()  { return player?.resume?.()  ?? api('/me/player/play',  { method: 'PUT' }); }
  async function pause()   { return player?.pause?.()   ?? api('/me/player/pause', { method: 'PUT' }); }
  async function toggle()  { return player?.togglePlay?.() ?? api('/me/player', { method: 'GET' }); }
  async function next()    { return player?.nextTrack?.() ?? api('/me/player/next', { method: 'POST' }); }
  async function prev()    { return player?.previousTrack?.() ?? api('/me/player/previous', { method: 'POST' }); }
  async function seek(ms)  { return player?.seek?.(ms) ?? api('/me/player/seek?position_ms=' + Math.floor(ms), { method: 'PUT' }); }
  async function setVolume(percent) {
    // percent: 0..100. SDK takes 0..1.
    const v = Math.max(0, Math.min(100, percent));
    if (player?.setVolume) await player.setVolume(v / 100);
    else await api(`/me/player/volume?volume_percent=${Math.floor(v)}`, { method: 'PUT' });
  }

  // ---- Library / search ----------------------------------------
  function getMe()           { return api('/me'); }
  function getPlaylists()    { return api('/me/playlists?limit=50'); }
  function getPlaylist(id)   { return api('/playlists/' + id); }
  // Pull a clean array of track items from whatever Spotify gives us back.
  // The shape varies depending on which endpoint we hit:
  //   GET /playlists/{id}/tracks      → { items: [{ track, ... }] }
  //   GET /playlists/{id}             → { tracks: { items: [...] } }
  //   GET /playlists/{id}?fields=...  → { items: [{ track }] } (no `tracks` key)
  // The user-facing code wants a uniform { items: [<track-wrappers>] }.
  function _extractItems(r) {
    if (!r) return [];
    if (Array.isArray(r)) return r;
    if (Array.isArray(r.items)) return r.items;
    if (r.tracks && Array.isArray(r.tracks.items)) return r.tracks.items;
    return [];
  }

  async function getPlaylistTracks(id) {
    const pid = encodeURIComponent(id);
    // Try multiple URL shapes. Spotify's API gates differ across these in
    // ways that don't match the docs — accounts that 403 on one shape can
    // succeed on another. Attempt fastest/simplest first.
    const attempts = [
      `/playlists/${pid}/tracks?limit=100`,
      `/playlists/${pid}/tracks`,
      `/playlists/${pid}/tracks?market=US&limit=100`,
      `/playlists/${pid}/tracks?fields=${encodeURIComponent('items(track(uri,name,artists(name),album(name,images),duration_ms))')}&limit=100`,
      `/playlists/${pid}`,
    ];
    let lastErr = null;
    for (const url of attempts) {
      try {
        const r = await api(url);
        const items = _extractItems(r);
        console.log('[spotify] playlist tracks fetched via', url, '→', items.length, 'items');
        return { items };
      } catch (e) {
        console.warn('[spotify] failed:', url, e.message);
        lastErr = e;
      }
    }
    throw lastErr || new Error('All playlist tracks endpoints returned an error');
  }
  function getSavedTracks()  { return api('/me/tracks?limit=50'); }
  function getRecent()       { return api('/me/player/recently-played?limit=20'); }
  function getTopTracks()    { return api('/me/top/tracks?limit=20&time_range=short_term'); }
  async function search(q) {
    if (!q?.trim()) return { tracks: { items: [] } };
    // Use encodeURIComponent (produces %20 for spaces) — URLSearchParams
    // produces + which sometimes upsets Spotify's parser. Also pin limit
    // very low: some accounts trip "Invalid limit" at the docs-stated max
    // of 50 because of regional behavior the API doesn't publish.
    const qs = `q=${encodeURIComponent(q.trim())}&type=track&limit=10`;
    return api('/search?' + qs);
  }

  // ---- Public API ----------------------------------------------
  window.SP = {
    setClientId: (id) => { clientId = id || null; },
    getClientId: () => clientId,
    isAuthenticated, startAuth, logout,
    bootstrapFromServer,
    initPlayer, transferToHere,
    play, resume, pause, toggle, next, prev, seek, setVolume,
    getMe, getPlaylists, getPlaylist, getPlaylistTracks,
    getSavedTracks, getRecent, getTopTracks, search,
    getDeviceId: () => deviceId,
    getPlayer:   () => player,
    redirectUri: REDIRECT_URI,
  };
})();

// InnerPersonal — in-browser WebRTC stream client.
//
// What this is:
//   A thin wrapper around the browser's native WebRTC stack. It pulls session
//   metadata from the InnerPersonal server, opens an RTCPeerConnection, and
//   attaches the inbound video track to a <video> element. Inputs (keyboard,
//   mouse, gamepad) flow back to the host over a data channel.
//
// What it isn't:
//   A reimplementation of the GameStream protocol from scratch. The host-side
//   pairing, encoder negotiation, and RTP framing are handled by Sunshine on
//   the gaming PC; this file is the consumer.
//
// Why no install:
//   Everything in this file uses APIs every modern browser ships natively —
//   RTCPeerConnection, MediaStream, Gamepad API, Pointer Lock. Nothing to
//   download, no PWA install, no extension. Open the URL, get a stream.

(function () {
  const PATH_SIGNAL = '/api/signal';   // server-side WS signaling proxy to Sunshine
  const API_BASE = (typeof window !== "undefined" && window.__API_BASE) || "";
  const PATH_SESSION = '/api/session/';

  function ws(url, token) {
    const u = new URL(url, API_BASE || location.href);
    u.protocol = u.protocol.replace('http', 'ws');
    if (token) u.searchParams.set('t', token);
    return new WebSocket(u);
  }

  async function fetchSession(sessionId, token) {
    const headers = {};
    if (token) headers['x-ip-token'] = token;
    const r = await fetch(API_BASE + PATH_SESSION + sessionId, { headers });
    if (!r.ok) throw new Error('Session lookup failed (' + r.status + '). Re-launch from the library.');
    return r.json();
  }

  async function rtcConfig(token) {
    // Pull current ICE config from server. If user set custom TURN creds
    // (Setup → TURN section), those replace the public openrelay fallback.
    // Server also tells us iceTransportPolicy — 'relay' when forceRelay is
    // on, which prevents host/srflx candidates from being gathered at all
    // (no home IP leak, no UDP hole-punching visible to school filters).
    let iceServers;
    let iceTransportPolicy = 'all';
    try {
      const headers = token ? { 'x-ip-token': token } : {};
      const r = await fetch(API_BASE + '/api/ice-servers', { headers, cache: 'no-store' });
      if (!r.ok) throw new Error(`ICE config failed (${r.status})`);
      const j = await r.json();
      iceServers = j.iceServers;
      if (j.iceTransportPolicy === 'relay' || j.iceTransportPolicy === 'all') {
        iceTransportPolicy = j.iceTransportPolicy;
      }
    } catch {
      // Last-resort hardcoded fallback if server unreachable
      iceServers = [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ];
    }
    return {
      iceServers,
      iceTransportPolicy,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
  }

  // --- Input forwarding -------------------------------------------------
  // Keyboard, mouse delta, mouse buttons, scroll, and gamepad state get
  // packed into small messages over the data channel. The host (Sunshine)
  // injects them with ViGEm + SendInput.
  function attachInputs(video, channel, reliableChannel = channel) {
    if (!channel) return () => {};

    const counts = { m: 0, c: 0, k: 0 };
    const pressedKeys = new Set();
    const pressedButtons = new Set();
    const hudCounts = document.getElementById('hud-counts');
    const hud = document.getElementById('hud');
    let lastHudPaint = 0;
    function bumpHud() {
      const now = performance.now();
      if (hud?.classList.contains('hide') || now - lastHudPaint < 250) return;
      lastHudPaint = now;
      if (hudCounts) hudCounts.textContent = `m:${counts.m} c:${counts.c} k:${counts.k}`;
    }
    const send = (obj, { reliable = false, coalescible = false } = {}) => {
      const target = reliable && reliableChannel?.readyState === 'open' ? reliableChannel : channel;
      if (target.readyState !== 'open') return;
      // Motion and analog snapshots become stale quickly. Drop them when the
      // channel is backed up instead of adding seconds of input latency.
      if (coalescible && target.bufferedAmount > 32 * 1024) return;
      target.send(JSON.stringify(obj));
      if (obj.t === 'mm') counts.m++;
      else if (obj.t === 'mb') counts.c++;
      else if (obj.t === 'k') counts.k++;
      bumpHud();
    };

    // --- Keyboard (capture once pointer lock or focus is on the video) ---
    const onKey = (down) => (e) => {
      if (document.pointerLockElement !== video && document.activeElement !== video) return;
      if (down) pressedKeys.add(e.code); else pressedKeys.delete(e.code);
      send({ t: 'k', d: down ? 1 : 0, c: e.code, k: e.key, m: modBits(e) }, { reliable: true });
      e.preventDefault();
    };
    const kd = onKey(true), ku = onKey(false);
    document.addEventListener('keydown', kd, true);
    document.addEventListener('keyup',   ku, true);

    // --- Mouse: click for pointer lock, then forward deltas + buttons ---
    const onClick = () => { if (document.pointerLockElement !== video) video.requestPointerLock?.(); };
    video.addEventListener('click', onClick);
    // Virtual cursor + absolute-position input. ddagrab doesn't capture
    // Windows hardware cursors, so we render our own. We track its
    // viewport position from accumulated pointer-lock deltas, then map
    // that to absolute host pixel coordinates before sending — the host
    // calls SetCursorPos(x,y) and teleports its cursor there. This kills
    // any drift caused by Windows mouse acceleration: where you see the
    // virtual cursor is exactly where clicks land.
    const vCursor = document.getElementById('virtual-cursor');
    let vCursorX = window.innerWidth / 2;
    let vCursorY = window.innerHeight / 2;
    let cachedDisplayInfo = null;

    // Returns the actual on-screen rect occupied by the video bitmap
    // (accounts for object-fit:contain letterboxing) and the host's
    // displayed stream resolution.
    function videoDisplayInfo() {
      if (cachedDisplayInfo) return cachedDisplayInfo;
      const rect = video.getBoundingClientRect();
      const vw = video.videoWidth  || 1920;
      const vh = video.videoHeight || 1080;
      const aspectV = vw / vh, aspectR = rect.width / rect.height;
      let dispW, dispH, offX, offY;
      if (aspectR > aspectV) {            // letterbox left/right
        dispH = rect.height; dispW = dispH * aspectV;
        offY = 0;            offX = (rect.width - dispW) / 2;
      } else {                            // letterbox top/bottom
        dispW = rect.width;  dispH = dispW / aspectV;
        offX = 0;            offY = (rect.height - dispH) / 2;
      }
      cachedDisplayInfo = { rect, vw, vh, dispW, dispH, offX, offY,
        left: rect.left + offX, top: rect.top + offY };
      return cachedDisplayInfo;
    }

    function paintCursor() {
      if (!vCursor) return;
      // Clamp to the actual streamed area so the cursor never floats
      // over letterbox/HUD/border space. Use the full dispW/dispH range
      // (not -1) so the cursor can reach the absolute edge — relX=1.0
      // must be achievable, otherwise the host edge is unreachable.
      const d = videoDisplayInfo();
      vCursorX = Math.max(d.left, Math.min(d.left + d.dispW, vCursorX));
      vCursorY = Math.max(d.top,  Math.min(d.top  + d.dispH, vCursorY));
      vCursor.style.transform = `translate(${vCursorX}px, ${vCursorY}px)`;
    }
    function resetCursorToCenter() {
      const d = videoDisplayInfo();
      vCursorX = d.left + d.dispW / 2;
      vCursorY = d.top  + d.dispH / 2;
      paintCursor();
    }

    const onPointerLockChange = () => {
      if (!vCursor) return;
      const locked = document.pointerLockElement === video;
      vCursor.classList.toggle('show', locked);
      if (locked) resetCursorToCenter();
    };
    const onGeometryChange = () => {
      cachedDisplayInfo = null;
      if (document.pointerLockElement === video) requestAnimationFrame(paintCursor);
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('resize', onGeometryChange, { passive: true });
    document.addEventListener('fullscreenchange', onGeometryChange);
    video.addEventListener('loadedmetadata', onGeometryChange);

    let mouseRaf = 0;
    let lastMouseFlush = 0;
    const flushMouseMove = (now) => {
      if (now - lastMouseFlush < 14) {
        mouseRaf = requestAnimationFrame(flushMouseMove);
        return;
      }
      mouseRaf = 0;
      lastMouseFlush = now;
      if (document.pointerLockElement !== video) return;
      paintCursor();
      const d = videoDisplayInfo();
      const relX = Math.max(0, Math.min(1, (vCursorX - d.left) / d.dispW));
      const relY = Math.max(0, Math.min(1, (vCursorY - d.top) / d.dispH));
      send({ t: 'mm', x: relX, y: relY, abs: 1 }, { coalescible: true });
    };
    const onMove = (e) => {
      if (document.pointerLockElement !== video) return;
      vCursorX += e.movementX;
      vCursorY += e.movementY;
      if (!mouseRaf) mouseRaf = requestAnimationFrame(flushMouseMove);
    };
    const onBtn = (down) => (e) => {
      if (document.pointerLockElement !== video) return;
      if (down) pressedButtons.add(e.button); else pressedButtons.delete(e.button);
      send({ t: 'mb', d: down ? 1 : 0, b: e.button }, { reliable: true });
      e.preventDefault();
    };
    const md = onBtn(true), mu = onBtn(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', md);
    document.addEventListener('mouseup',   mu);

    // Browsers report wheel input in pixels, lines, or pages depending on
    // the device. Accumulate those deltas and send standard Windows wheel
    // units so mouse wheels and high-resolution trackpads both feel natural.
    const WHEEL_STEP_PX = 80;
    let wheelAccumX = 0;
    let wheelAccumY = 0;
    let wheelFlushTimer = null;
    const flushWheel = (force = false) => {
      let stepsX = Math.trunc(wheelAccumX / WHEEL_STEP_PX);
      let stepsY = Math.trunc(wheelAccumY / WHEEL_STEP_PX);

      if (force && !stepsX && Math.abs(wheelAccumX) >= 1) {
        stepsX = Math.sign(wheelAccumX);
        wheelAccumX = 0;
      }
      if (force && !stepsY && Math.abs(wheelAccumY) >= 1) {
        stepsY = Math.sign(wheelAccumY);
        wheelAccumY = 0;
      }

      stepsX = Math.max(-6, Math.min(6, stepsX));
      stepsY = Math.max(-6, Math.min(6, stepsY));
      if (!stepsX && !stepsY) return;

      if (wheelAccumX) wheelAccumX -= stepsX * WHEEL_STEP_PX;
      if (wheelAccumY) wheelAccumY -= stepsY * WHEEL_STEP_PX;
      send({ t: 'mw', x: stepsX * 120, y: stepsY * 120 }, { coalescible: true });
    };
    const queueWheel = (dx, dy) => {
      wheelAccumX += dx;
      wheelAccumY += dy;
      flushWheel();
      if (wheelFlushTimer) clearTimeout(wheelFlushTimer);
      wheelFlushTimer = setTimeout(() => {
        wheelFlushTimer = null;
        flushWheel(true);
      }, 60);
    };
    const onWheel = (e) => {
      if (document.pointerLockElement !== video) return;
      const scale = e.deltaMode === 1
        ? 40
        : e.deltaMode === 2
          ? Math.max(video.clientHeight, 800)
          : 1;
      queueWheel(e.deltaX * scale, e.deltaY * scale);
      e.preventDefault();
    };
    document.addEventListener('wheel', onWheel, { passive: false });

    // --- Touch (Android phones, iPad, Chromebook touchscreens) -----------
    // Pointer lock isn't a thing on touch devices, so we don't gate on it.
    // The video element itself is what we listen on.
    //
    //  1 finger drag → mouse move (relative deltas, just like trackpad)
    //  1 finger tap (<200ms, no move) → left click
    //  1 finger long-press (>500ms, no move) → right click
    //  2 fingers vertical drag → scroll wheel
    let touchStartT = 0;
    let touchStartX = 0, touchStartY = 0;
    let touchLastX = 0, touchLastY = 0;
    let touchMoved = false;
    let touchN = 0;
    let touchTwoLastY = 0;
    let longPressTimer = null;

    const onTouchStart = (e) => {
      if (e.target !== video) return;
      e.preventDefault();
      touchN = e.touches.length;
      touchStartT = Date.now();
      touchMoved = false;
      const t = e.touches[0];
      touchStartX = touchLastX = t.clientX;
      touchStartY = touchLastY = t.clientY;
      if (touchN === 2) {
        touchTwoLastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      } else if (touchN === 1) {
        // Long-press timer for right click
        longPressTimer = setTimeout(() => {
          if (!touchMoved) {
            send({ t: 'mb', b: 1, d: 1 }, { reliable: true });
            send({ t: 'mb', b: 1, d: 0 }, { reliable: true });
            longPressTimer = null;
          }
        }, 500);
      }
    };
    const onTouchMove = (e) => {
      if (e.target !== video) return;
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - touchLastX;
      const dy = t.clientY - touchLastY;
      // Movement threshold so a slight finger jiggle isn't counted
      if (Math.abs(t.clientX - touchStartX) > 8 || Math.abs(t.clientY - touchStartY) > 8) {
        touchMoved = true;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }
      if (touchN === 1 && touchMoved) {
        // Scale touch movement to feel like a trackpad
        send({ t: 'mm', dx: Math.round(dx * 1.5), dy: Math.round(dy * 1.5) }, { coalescible: true });
      } else if (touchN === 2 && e.touches.length === 2) {
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const scrollDy = midY - touchTwoLastY;
        queueWheel(0, -scrollDy * 2.2);
        touchTwoLastY = midY;
      }
      touchLastX = t.clientX;
      touchLastY = t.clientY;
    };
    const onTouchEnd = (e) => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      // Quick tap with no movement → left click
      if (touchN === 1 && !touchMoved && Date.now() - touchStartT < 200) {
        send({ t: 'mb', b: 0, d: 1 }, { reliable: true });
        send({ t: 'mb', b: 0, d: 0 }, { reliable: true });
      }
      touchN = 0;
    };
    video.addEventListener('touchstart', onTouchStart, { passive: false });
    video.addEventListener('touchmove',  onTouchMove,  { passive: false });
    video.addEventListener('touchend',   onTouchEnd);
    video.addEventListener('touchcancel', onTouchEnd);

    // Poll only while a gamepad is connected and the tab is visible. This
    // avoids a permanent 60 Hz timer on laptops that are using keyboard/mouse.
    const lastPad = new Map();
    let padRaf = 0;
    const pollPads = () => {
      padRaf = 0;
      if (document.visibilityState === 'hidden') return;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let found = false;
      for (const p of pads) {
        if (!p) continue;
        found = true;
        const axes = p.axes.map((a) => Math.abs(a) < 0.01 ? 0 : Math.round(a * 1000) / 1000);
        const buttons = p.buttons.map((b) => Math.round(b.value * 100) / 100);
        const previous = lastPad.get(p.index);
        const axesChanged = !previous || axes.length !== previous.axes.length || axes.some((v, i) => v !== previous.axes[i]);
        const buttonsChanged = !previous || buttons.length !== previous.buttons.length || buttons.some((v, i) => v !== previous.buttons[i]);
        if (!axesChanged && !buttonsChanged) continue;
        lastPad.set(p.index, { axes, buttons });
        send({
          t: 'gp', i: p.index,
          a: axes,
          b: buttons,
        }, { reliable: buttonsChanged, coalescible: !buttonsChanged });
      }
      if (found) padRaf = requestAnimationFrame(pollPads);
    };
    const startPadPolling = () => {
      if (!padRaf && document.visibilityState !== 'hidden') padRaf = requestAnimationFrame(pollPads);
    };
    const stopPadPolling = () => {
      if (padRaf) cancelAnimationFrame(padRaf);
      padRaf = 0;
    };
    const hasConnectedGamepad = () => Array.from(navigator.getGamepads?.() || []).some(Boolean);
    const onGamepadConnected = () => startPadPolling();
    const onGamepadDisconnected = (event) => {
      lastPad.delete(event.gamepad?.index);
      if (!hasConnectedGamepad()) stopPadPolling();
    };
    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
    if (hasConnectedGamepad()) startPadPolling();

    // Never leave a key or mouse button stuck on the host if the client
    // backgrounds, loses focus, or the data channel is about to close.
    const releaseAll = () => {
      for (const code of pressedKeys) send({ t: 'k', d: 0, c: code, k: '', m: 0 }, { reliable: true });
      for (const button of pressedButtons) send({ t: 'mb', d: 0, b: button }, { reliable: true });
      pressedKeys.clear();
      pressedButtons.clear();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        releaseAll();
        stopPadPolling();
      } else if (hasConnectedGamepad()) {
        startPadPolling();
      }
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      releaseAll();
      document.removeEventListener('keydown', kd, true);
      document.removeEventListener('keyup', ku, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', md);
      document.removeEventListener('mouseup', mu);
      document.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      window.removeEventListener('resize', onGeometryChange);
      document.removeEventListener('fullscreenchange', onGeometryChange);
      video.removeEventListener('loadedmetadata', onGeometryChange);
      video.removeEventListener('click', onClick);
      video.removeEventListener('touchstart', onTouchStart);
      video.removeEventListener('touchmove', onTouchMove);
      video.removeEventListener('touchend', onTouchEnd);
      video.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      document.removeEventListener('visibilitychange', onVisibility);
      if (wheelFlushTimer) clearTimeout(wheelFlushTimer);
      if (mouseRaf) cancelAnimationFrame(mouseRaf);
      stopPadPolling();
    };
  }

  function modBits(e) {
    return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  }

  // --- Stats: surface RTT + bitrate to the HUD --------------------------
  // Also reports observed throughput, packet loss and jitter back to the
  // bridge over the input data channel as `{t:"br", mbps, lossPct, jitterMs}`.
  // The bridge uses these for adaptive-bitrate decisions.
  function startStats(pc, onStats, getDc, streamSettings = {}) {
    let lastBytes = 0, lastTs = 0, lastLost = 0, lastReceived = 0;
    let lastDecoded = 0, lastDropped = 0, lastDecodeTime = 0;
    let lastFreezeCount = 0, lastFreezeDuration = 0;
    let lastJitterBufferDelay = 0, lastJitterBufferEmitted = 0;
    let smoothRtt = null, smoothMbps = null;
    const tick = async () => {
      try {
        const stats = await pc.getStats();
        let rtt = null, mbps = null, jitter = null, lossPct = null;
        let fps = null, dropped = 0, droppedPct = 0, decodeMs = null, path = 'unknown';
        let freezeCount = 0, freezeDurationMs = 0, jitterBufferMs = null;
        let availableIncomingBitrate = null;
        let lostInc = 0, receivedInc = 0, decodedInc = 0;
        let selectedPair = null;
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime != null) {
            rtt = s.currentRoundTripTime * 1000;
            if (s.nominated || !selectedPair) selectedPair = s;
          }
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            const now = s.timestamp || performance.now();
            const bytes = s.bytesReceived || 0;
            const lost = s.packetsLost || 0;
            const received = s.packetsReceived || 0;
            const decoded = s.framesDecoded || 0;
            const framesDropped = s.framesDropped || 0;
            const decodeTime = s.totalDecodeTime || 0;
            const totalFreezeCount = s.freezeCount || 0;
            const totalFreezeDuration = s.totalFreezesDuration || 0;
            const totalJitterBufferDelay = s.jitterBufferDelay || 0;
            const totalJitterBufferEmitted = s.jitterBufferEmittedCount || 0;
            if (lastTs && now > lastTs) {
              const bits = (bytes - lastBytes) * 8;
              const secs = (now - lastTs) / 1000;
              mbps = bits / secs / 1e6;
              lostInc = lost - lastLost;
              receivedInc = received - lastReceived;
              decodedInc = decoded - lastDecoded;
              fps = decodedInc / secs;
              dropped = Math.max(0, framesDropped - lastDropped);
              droppedPct = (decodedInc + dropped) > 0 ? dropped * 100 / (decodedInc + dropped) : 0;
              freezeCount = Math.max(0, totalFreezeCount - lastFreezeCount);
              freezeDurationMs = Math.max(0, (totalFreezeDuration - lastFreezeDuration) * 1000);
              const jitterEmitted = totalJitterBufferEmitted - lastJitterBufferEmitted;
              if (jitterEmitted > 0) {
                jitterBufferMs = Math.max(0, (totalJitterBufferDelay - lastJitterBufferDelay) * 1000 / jitterEmitted);
              }
              if (decodedInc > 0) decodeMs = Math.max(0, (decodeTime - lastDecodeTime) * 1000 / decodedInc);
            }
            lastBytes = bytes; lastTs = now; lastLost = lost; lastReceived = received;
            lastDecoded = decoded; lastDropped = framesDropped; lastDecodeTime = decodeTime;
            lastFreezeCount = totalFreezeCount; lastFreezeDuration = totalFreezeDuration;
            lastJitterBufferDelay = totalJitterBufferDelay; lastJitterBufferEmitted = totalJitterBufferEmitted;
            if (s.jitter != null) jitter = s.jitter * 1000;
          }
        });
        if (selectedPair) {
          const local = stats.get(selectedPair.localCandidateId);
          const remote = stats.get(selectedPair.remoteCandidateId);
          const types = [local?.candidateType, remote?.candidateType].filter(Boolean);
          path = types.includes('relay') ? 'relay' : types.includes('srflx') ? 'direct' : 'local';
          availableIncomingBitrate = selectedPair.availableIncomingBitrate || null;
        }
        if (mbps != null) {
          lossPct = (lostInc + receivedInc) > 0 ? (lostInc / (lostInc + receivedInc)) * 100 : 0;
          smoothMbps = smoothMbps == null ? mbps : smoothMbps * 0.72 + mbps * 0.28;
          if (rtt != null) smoothRtt = smoothRtt == null ? rtt : smoothRtt * 0.72 + rtt * 0.28;
          // Report back to bridge so it can adapt the encoder bitrate.
          const dc = getDc?.();
          if (dc && dc.readyState === 'open') {
            try {
              dc.send(JSON.stringify({
                t: 'br',
                mbps: +smoothMbps.toFixed(2),
                rttMs: smoothRtt != null ? +smoothRtt.toFixed(0) : null,
                lossPct: +lossPct.toFixed(2),
                jitterMs: jitter != null ? +jitter.toFixed(1) : null,
                targetFps: Number(streamSettings.framerate) || null,
                fps: fps != null ? +fps.toFixed(1) : null,
                droppedPct: +droppedPct.toFixed(2),
                decodeMs: decodeMs != null ? +decodeMs.toFixed(2) : null,
                freezeCount,
                freezeDurationMs: +freezeDurationMs.toFixed(0),
                jitterBufferMs: jitterBufferMs != null ? +jitterBufferMs.toFixed(1) : null,
                availableIncomingBitrate,
                path,
                visible: document.visibilityState === 'visible',
              }));
            } catch {}
          }
        }
        const quality = lossPct > 2 || (smoothRtt || 0) > 160 || (jitter || 0) > 35
          ? 'poor'
          : lossPct > 0.5 || (smoothRtt || 0) > 90 || (jitter || 0) > 20
            ? 'fair'
            : (smoothRtt || 0) > 45 || (jitter || 0) > 10 ? 'good' : 'excellent';
        onStats?.({
          rttMs: smoothRtt, mbps: smoothMbps, lossPct, jitterMs: jitter,
          fps, droppedFrames: dropped, droppedPct, decodeMs, freezeCount,
          freezeDurationMs, jitterBufferMs, path, quality,
        });
      } catch {}
    };
    return setInterval(tick, 1000);
  }

  // --- Public API -------------------------------------------------------
  async function connect({ sessionId, token, video, onState, onMeta, onStats, onDiag, onNetwork }) {
    const diag = {
      session: 'pending', signaling: 'pending', sdp: 'pending',
      iceGather: 'pending', iceConnect: 'pending', media: 'pending',
      iceCandidates: { host: 0, srflx: 0, relay: 0 },
      selectedPath: null,
    };
    const updateDiag = (key, value) => {
      diag[key] = value;
      onDiag?.(diag);
    };

    onState?.('connecting');
    let meta;
    try {
      meta = await fetchSession(sessionId, token);
      updateDiag('session', 'ok');
    } catch (error) {
      updateDiag('session', 'fail');
      onState?.('failed', { message: 'Session fetch failed: ' + error.message, diag });
      return null;
    }
    onMeta?.(meta);

    // The signaling socket owns the matching host-side BridgeSession. When
    // that socket drops the server closes its peer, so retrying ICE on the old
    // browser peer cannot work. Recovery must replace both objects together.
    const MAX_RECONNECTS = 3;
    let generation = 0;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let active = null;
    let stopped = false;
    let terminalError = false;

    const isCurrent = (attempt) => (
      !stopped && !attempt.disposed && active === attempt && attempt.id === generation
    );

    const teardownAttempt = (attempt) => {
      if (!attempt || attempt.disposed) return;
      attempt.disposed = true;
      clearInterval(attempt.statsTimer);
      clearTimeout(attempt.stableTimer);
      attempt.detachInputs?.();
      attempt.detachInputs = null;
      if (window.InnerPersonalStream?.dc === attempt.dc) window.InnerPersonalStream.dc = null;
      if (attempt.markMediaStarted) {
        video.removeEventListener('loadeddata', attempt.markMediaStarted);
        video.removeEventListener('playing', attempt.markMediaStarted);
      }
      for (const track of attempt.stream?.getTracks?.() || []) {
        try { track.stop(); } catch {}
      }
      if (video.srcObject === attempt.stream) video.srcObject = null;
      try { attempt.sock?.close(1000, 'reconnect'); } catch {}
      try { attempt.pc?.close(); } catch {}
    };

    const failPermanently = (message) => {
      if (terminalError || stopped) return;
      terminalError = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      updateDiag('iceConnect', 'fail');
      teardownAttempt(active);
      active = null;
      onState?.('failed', { message, diag });
    };

    let startAttempt;
    const scheduleReconnect = (reason, minimumDelay = 500) => {
      if (stopped || terminalError || reconnectTimer) return;
      if (reconnectAttempts >= MAX_RECONNECTS) {
        failPermanently('Connection could not recover after three fresh connection attempts. No compatible ICE path was found.');
        return;
      }
      onState?.('reconnecting', { attempt: reconnectAttempts + 1, reason, diag });
      updateDiag('iceConnect', 'checking');
      const backoff = Math.min(5000, 350 * (2 ** reconnectAttempts));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempts++;
        startAttempt(true).catch((error) => {
          if (!stopped && !terminalError) {
            scheduleReconnect(error.message || 'connection setup failed', 1000);
          }
        });
      }, Math.max(minimumDelay, backoff));
    };

    startAttempt = async (isRetry = false) => {
      const id = ++generation;
      const previous = active;
      active = null;
      teardownAttempt(previous);

      Object.assign(diag, {
        signaling: 'pending', sdp: 'pending', iceGather: 'pending',
        iceConnect: 'pending', media: 'pending', selectedPath: null,
        iceCandidates: { host: 0, srflx: 0, relay: 0 },
      });
      onDiag?.(diag);

      // Fetch ICE configuration for every generation so renewed TURN
      // credentials and network-policy changes apply without a page reload.
      const pc = new RTCPeerConnection(await rtcConfig(token));
      if (stopped || id !== generation) {
        try { pc.close(); } catch {}
        return;
      }

      const stream = new MediaStream();
      const sock = ws(`${PATH_SIGNAL}?session=${encodeURIComponent(sessionId)}`, token);
      const attempt = {
        id, pc, sock, stream, disposed: false,
        statsTimer: null, stableTimer: null, detachInputs: null,
        dc: null, reliableDc: null, mediaStarted: false,
        remoteDescriptionReady: false, pendingRemoteIce: [],
        markMediaStarted: null,
      };
      active = attempt;
      video.srcObject = stream;

      attempt.markMediaStarted = () => {
        if (!isCurrent(attempt) || attempt.mediaStarted) return;
        attempt.mediaStarted = true;
        updateDiag('media', 'ok');
        onState?.('streaming');
        clearTimeout(attempt.stableTimer);
        // Reset the retry budget only after sustained healthy playback. This
        // prevents a flapping path from creating an endless reconnect loop.
        attempt.stableTimer = setTimeout(() => {
          if (isCurrent(attempt) && attempt.mediaStarted) reconnectAttempts = 0;
        }, 10_000);
      };
      video.addEventListener('loadeddata', attempt.markMediaStarted);
      video.addEventListener('playing', attempt.markMediaStarted);

      pc.addEventListener('track', (event) => {
        if (!isCurrent(attempt)) return;
        stream.addTrack(event.track);
        if (event.track.kind === 'video') {
          try { event.track.contentHint = 'motion'; } catch {}
          updateDiag('media', 'track');
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        if (!isCurrent(attempt)) return;
        const state = pc.iceConnectionState;
        if (state === 'checking') updateDiag('iceConnect', 'checking');
        if (state === 'connected' || state === 'completed') updateDiag('iceConnect', 'ok');
        if (state === 'failed') updateDiag('iceConnect', 'fail');
      });
      pc.addEventListener('icegatheringstatechange', () => {
        if (isCurrent(attempt) && pc.iceGatheringState === 'complete') {
          updateDiag('iceGather', 'ok');
        }
      });

      pc.addEventListener('connectionstatechange', async () => {
        if (!isCurrent(attempt)) return;
        if (pc.connectionState === 'connected') {
          if (sock.readyState === WebSocket.OPEN) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          updateDiag('iceConnect', 'ok');
          if (attempt.mediaStarted) onState?.('streaming');
          return;
        }
        if (pc.connectionState === 'failed') {
          try {
            const stats = await pc.getStats();
            if (!isCurrent(attempt)) return;
            stats.forEach((stat) => {
              if (stat.type === 'candidate-pair' && stat.state === 'failed') {
                diag.selectedPath = `failed: ${stat.localCandidateId}->${stat.remoteCandidateId}`;
              }
            });
          } catch {}
          scheduleReconnect('ICE connection failed', 250);
        } else if (pc.connectionState === 'disconnected') {
          // Brief Wi-Fi handoffs can recover natively. Escalate only after a
          // grace period, then replace the complete peer/signaling generation.
          scheduleReconnect('connection interrupted', 3500);
        }
      });

      // Motion uses a low-latency unordered channel; key/button transitions
      // use a reliable channel so packet loss cannot leave a control stuck.
      const dc = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      const reliableDc = pc.createDataChannel('input-control', { ordered: true });
      attempt.dc = dc;
      attempt.reliableDc = reliableDc;
      dc.bufferedAmountLowThreshold = 8 * 1024;
      dc.addEventListener('open', () => {
        if (!isCurrent(attempt)) return;
        attempt.detachInputs = attachInputs(video, dc, reliableDc);
        window.InnerPersonalStream.dc = dc;
        console.log('[InnerPersonal] data channel OPEN, readyState=', dc.readyState);
      });
      dc.addEventListener('close', () => {
        if (!isCurrent(attempt)) return;
        attempt.detachInputs?.();
        attempt.detachInputs = null;
        if (window.InnerPersonalStream?.dc === dc) window.InnerPersonalStream.dc = null;
        console.log('[InnerPersonal] data channel CLOSED');
      });

      pc.addTransceiver('video', { direction: 'recvonly' });

      pc.addEventListener('icecandidate', (event) => {
        if (!isCurrent(attempt) || !event.candidate) return;
        const type = event.candidate.candidate?.match(/typ (\w+)/)?.[1];
        if (type === 'host')  diag.iceCandidates.host++;
        if (type === 'srflx') diag.iceCandidates.srflx++;
        if (type === 'relay') diag.iceCandidates.relay++;
        onDiag?.(diag);
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
        }
      });

      const sendOffer = async () => {
        if (!isCurrent(attempt) || sock.readyState !== WebSocket.OPEN || pc.signalingState !== 'stable') {
          throw new Error('signaling is not ready');
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!isCurrent(attempt) || sock.readyState !== WebSocket.OPEN) {
          throw new Error('signaling closed during offer');
        }
        sock.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
      };

      sock.addEventListener('open', async () => {
        if (!isCurrent(attempt)) return;
        updateDiag('signaling', 'ok');
        try {
          await sendOffer();
        } catch (error) {
          if (!isCurrent(attempt)) return;
          updateDiag('sdp', 'fail');
          scheduleReconnect('SDP offer failed: ' + error.message, 500);
        }
      });
      sock.addEventListener('error', () => {
        if (!isCurrent(attempt)) return;
        updateDiag('signaling', 'fail');
        scheduleReconnect('signaling WebSocket error', 500);
      });

      sock.addEventListener('message', async (event) => {
        if (!isCurrent(attempt)) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'answer') {
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            if (!isCurrent(attempt)) return;
            attempt.remoteDescriptionReady = true;
            updateDiag('sdp', 'ok');
            // Trickle candidates can race ahead of setRemoteDescription. Keep
            // them until the answer is installed instead of silently dropping
            // what may be the only viable relay candidate.
            const queued = attempt.pendingRemoteIce.splice(0);
            for (const candidate of queued) {
              try { await pc.addIceCandidate(candidate); } catch {}
            }
          } catch (error) {
            if (!isCurrent(attempt)) return;
            updateDiag('sdp', 'fail');
            scheduleReconnect('SDP answer rejected: ' + error.message, 500);
          }
        } else if (msg.type === 'ice' && msg.candidate) {
          if (!attempt.remoteDescriptionReady) {
            if (attempt.pendingRemoteIce.length < 128) {
              attempt.pendingRemoteIce.push(msg.candidate);
            }
          } else {
            try { await pc.addIceCandidate(msg.candidate); } catch {}
          }
        } else if (msg.type === 'network') {
          onNetwork?.(msg);
        } else if (msg.type === 'state' && msg.state === 'reconnecting') {
          onState?.('reconnecting', { attempt: reconnectAttempts + 1, diag });
        } else if (msg.type === 'error') {
          failPermanently(msg.message || 'Server signaling error');
        }
      });

      sock.addEventListener('close', () => {
        if (!isCurrent(attempt)) return;
        updateDiag('signaling', 'fail');
        // The server destroys its peer on close, so replace both sides.
        scheduleReconnect('signaling connection closed', 350);
      });

      attempt.statsTimer = startStats(pc, onStats, () => attempt.dc, meta.streamSettings || {});
      onState?.(isRetry ? 'reconnecting' : 'pairing', { attempt: reconnectAttempts, diag });
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      generation++;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      teardownAttempt(active);
      active = null;
      window.removeEventListener('beforeunload', stop);
    };
    window.addEventListener('beforeunload', stop);

    try {
      await startAttempt(false);
    } catch (error) {
      failPermanently('Connection setup failed: ' + error.message);
    }

    return {
      close: stop,
      reconnect: () => {
        if (stopped || terminalError) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        scheduleReconnect('manual retry', 0);
      },
    };
  }

  window.InnerPersonalStream = { connect };
})();

// ============================================================
// Wallpaper engine
// - Tracks mouse position globally and exposes it as CSS vars
//   (--mx, --my as % strings; --mx-norm, --my-norm as -1..1)
//   so any CSS wallpaper can be cursor-aware for free.
// - Most wallpapers are pure CSS (defined in wallpapers.css).
//   The handful needing real particles (galaxy/rain/bubbles)
//   mount a canvas inside #wallpaper here.
// - Exposes window.Wallpapers = { list, set(id), current() }
//   for the Customize tab UI.
// ============================================================

(function () {
  const WALLPAPERS = [
    { id: 'none',       name: 'Off / Pure black' },
    { id: 'liquid',     name: 'Liquid Glass' },
    { id: 'aurora',     name: 'Aurora' },
    { id: 'sunset',     name: 'Sunset' },
    { id: 'mint',       name: 'Mint' },
    { id: 'plasma',     name: 'Plasma' },
    { id: 'mesh-dots',  name: 'Dot grid' },
    { id: 'synthwave',  name: 'Synthwave' },
    { id: 'galaxy',     name: 'Galaxy',   canvas: 'galaxy' },
    { id: 'carbon',     name: 'Carbon' },
    { id: 'rain',       name: 'Rain',     canvas: 'rain' },
    { id: 'bubbles',    name: 'Bubbles',  canvas: 'bubbles' },
    { id: 'neon',       name: 'Neon rays' },
    { id: 'cyber',      name: 'Cyber grid' },
    { id: 'conic',      name: 'Conic spin' },
    { id: 'orbs',       name: 'Orbs' },
    { id: 'wave',       name: 'Wave' },
    { id: 'mesh',       name: 'Mesh' },
    { id: 'fire',       name: 'Fire' },
  ];

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const memory = navigator.deviceMemory || 0;
  const cores = navigator.hardwareConcurrency || 0;
  const effectiveType = String(connection.effectiveType || '').toLowerCase();
  const efficiencyMode = connection.saveData === true || ['slow-2g', '2g', '3g'].includes(effectiveType) ||
    (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4);
  document.body.classList.toggle('efficiency-mode', efficiencyMode);
  const wallpaperHost = document.getElementById('wallpaper');
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-hidden', document.hidden);
  });

  // ---- Mouse tracking → CSS vars ----------------------------
  // Updated at most once per RAF to avoid layout thrash.
  let pendingMx = 50, pendingMy = 50;     // last raw values (%)
  let renderedMx = -1, renderedMy = -1;
  let rafPending = false;
  function pump() {
    rafPending = false;
    if (pendingMx === renderedMx && pendingMy === renderedMy) return;
    renderedMx = pendingMx; renderedMy = pendingMy;
    const s = wallpaperHost?.style || document.body.style;
    s.setProperty('--mx', pendingMx + '%');
    s.setProperty('--my', pendingMy + '%');
    // Normalized -1..1 for transforms (cyber, conic, etc.)
    const mxNorm = (pendingMx - 50) / 50;
    const myNorm = (pendingMy - 50) / 50;
    s.setProperty('--mx-norm', mxNorm.toFixed(3));
    s.setProperty('--my-norm', myNorm.toFixed(3));
    s.setProperty('--mx-shift', `${(-18 * mxNorm).toFixed(2)}px`);
    s.setProperty('--my-shift', `${(-12 * myNorm).toFixed(2)}px`);
  }
  function onMove(clientX, clientY) {
    if (efficiencyMode && performance.now() - (onMove.lastUpdate || 0) < 33) return;
    onMove.lastUpdate = performance.now();
    pendingMx = (clientX / window.innerWidth) * 100;
    pendingMy = (clientY / window.innerHeight) * 100;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(pump);
    }
  }
  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY), { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY);
  }, { passive: true });

  // Center reset on leave so the wallpaper doesn't get stuck in a corner
  window.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) { pendingMx = 50; pendingMy = 50; if (!rafPending) { rafPending = true; requestAnimationFrame(pump); } }
  });

  // ---- Local highlights for interactive glass ----------------
  // Backdrop blur creates translucency; this moving specular highlight gives
  // controls a physical surface without continuously animating every element.
  const GLASS_TARGETS = [
    '.sidebar', '.search', '.btn', '.ready-panel', '.mobile-nav',
    '.mobile-more-menu', '.login-card', '.modal', '.toast', '.sp-now',
    '.stream-overlay', '.quality-preset', '.codec-opt', '.switch span',
    '.card-play', '.icon-btn'
  ].join(',');
  let glassTarget = null;
  let glassEvent = null;
  let glassRaf = 0;

  function paintGlassHighlight() {
    glassRaf = 0;
    const event = glassEvent;
    if (!event) return;
    const target = event.target.closest?.(GLASS_TARGETS) || null;
    if (glassTarget && glassTarget !== target) {
      glassTarget.style.removeProperty('--glass-x');
      glassTarget.style.removeProperty('--glass-y');
    }
    glassTarget = target;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    target.style.setProperty('--glass-x', `${event.clientX - rect.left}px`);
    target.style.setProperty('--glass-y', `${event.clientY - rect.top}px`);
  }

  document.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' || efficiencyMode) return;
    glassEvent = event;
    if (!glassRaf) glassRaf = requestAnimationFrame(paintGlassHighlight);
  }, { passive: true });

  document.addEventListener('pointerleave', () => {
    if (glassTarget) {
      glassTarget.style.removeProperty('--glass-x');
      glassTarget.style.removeProperty('--glass-y');
      glassTarget = null;
    }
  });

  // ---- Canvas renderers -------------------------------------
  let canvasEl = null, canvasCtx = null, canvasRaf = 0, canvasTeardown = null;
  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  function mountCanvas() {
    const host = document.getElementById('wallpaper');
    if (!host) return null;
    if (!canvasEl) {
      canvasEl = document.createElement('canvas');
      canvasEl.className = 'layer';
      host.appendChild(canvasEl);
      canvasCtx = canvasEl.getContext('2d');
    }
    resizeCanvas();
    return canvasEl;
  }
  function resizeCanvas() {
    if (!canvasEl) return;
    const mobileCap = efficiencyMode ? 1 : (window.matchMedia('(pointer: coarse)').matches ? 1.25 : 2);
    const dpr = Math.min(window.devicePixelRatio || 1, mobileCap);
    canvasEl.width  = Math.floor(window.innerWidth  * dpr);
    canvasEl.height = Math.floor(window.innerHeight * dpr);
    canvasEl.style.width  = window.innerWidth  + 'px';
    canvasEl.style.height = window.innerHeight + 'px';
    canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(resizeCanvas);
  }, { passive: true });

  function teardownCanvas() {
    cancelAnimationFrame(canvasRaf); canvasRaf = 0;
    if (canvasTeardown) { try { canvasTeardown(); } catch {} canvasTeardown = null; }
    if (canvasEl && canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl);
    canvasEl = null; canvasCtx = null;
  }

  // ---- Galaxy: starfield with mild parallax -----------------
  function startGalaxy() {
    const c = mountCanvas(); if (!c) return;
    const stars = [];
    const N = efficiencyMode ? 120 : 220;
    for (let i = 0; i < N; i++) {
      stars.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        z: Math.random() * 0.8 + 0.2,   // depth 0.2..1.0
        s: Math.random() * 1.2 + 0.3,   // size
        tw: Math.random() * Math.PI * 2,
      });
    }
    let lastFrame = 0;
    function tick(now = 0) {
      canvasRaf = requestAnimationFrame(tick);
      if (document.hidden || now - lastFrame < (efficiencyMode ? 48 : 32)) return;
      lastFrame = now;
      const w = window.innerWidth, h = window.innerHeight;
      canvasCtx.clearRect(0, 0, w, h);
      const mx = (pendingMx - 50) / 50;
      const my = (pendingMy - 50) / 50;
      const t = performance.now() * 0.001;
      for (const st of stars) {
        const px = st.x + mx * 24 * st.z;
        const py = st.y + my * 24 * st.z;
        const a = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.7 + st.tw));
        canvasCtx.fillStyle = `rgba(255,255,255,${(a * st.z).toFixed(3)})`;
        canvasCtx.beginPath();
        canvasCtx.arc(px, py, st.s * st.z, 0, Math.PI * 2);
        canvasCtx.fill();
      }
    }
    canvasTeardown = () => {};
    tick();
  }

  // ---- Rain: vertical streaks --------------------------------
  function startRain() {
    const c = mountCanvas(); if (!c) return;
    const drops = [];
    for (let i = 0; i < (efficiencyMode ? 70 : 120); i++) {
      drops.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        l: 12 + Math.random() * 24,
        v: 5 + Math.random() * 7,
        a: 0.15 + Math.random() * 0.35,
      });
    }
    let lastFrame = 0;
    function tick(now = 0) {
      canvasRaf = requestAnimationFrame(tick);
      if (document.hidden || now - lastFrame < (efficiencyMode ? 48 : 32)) return;
      lastFrame = now;
      const w = window.innerWidth, h = window.innerHeight;
      canvasCtx.clearRect(0, 0, w, h);
      const mx = (pendingMx - 50) / 50;
      canvasCtx.strokeStyle = 'rgba(125, 211, 252, 0.5)';
      canvasCtx.lineWidth = 1;
      for (const d of drops) {
        d.y += d.v;
        d.x += mx * 0.6;     // mouse tilts the rain a little
        if (d.y > h + 20) { d.y = -20; d.x = Math.random() * w; }
        canvasCtx.globalAlpha = d.a;
        canvasCtx.beginPath();
        canvasCtx.moveTo(d.x, d.y);
        canvasCtx.lineTo(d.x - mx * 1.2, d.y + d.l);
        canvasCtx.stroke();
      }
      canvasCtx.globalAlpha = 1;
    }
    canvasTeardown = () => {};
    tick();
  }

  // ---- Bubbles: rising orbs ---------------------------------
  function startBubbles() {
    const c = mountCanvas(); if (!c) return;
    const bubbles = [];
    for (let i = 0; i < (efficiencyMode ? 24 : 40); i++) {
      bubbles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        r: 6 + Math.random() * 28,
        v: 0.4 + Math.random() * 1.1,
        a: 0.15 + Math.random() * 0.30,
        dx: (Math.random() - 0.5) * 0.4,
      });
    }
    let lastFrame = 0;
    function tick(now = 0) {
      canvasRaf = requestAnimationFrame(tick);
      if (document.hidden || now - lastFrame < (efficiencyMode ? 48 : 32)) return;
      lastFrame = now;
      const w = window.innerWidth, h = window.innerHeight;
      canvasCtx.clearRect(0, 0, w, h);
      const mx = (pendingMx - 50) / 50;
      for (const b of bubbles) {
        b.y -= b.v;
        b.x += b.dx + mx * 0.4;
        if (b.y < -b.r) { b.y = h + b.r; b.x = Math.random() * w; }
        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        const grad = canvasCtx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        grad.addColorStop(0, `rgba(186, 230, 253, ${b.a.toFixed(2)})`);
        grad.addColorStop(0.7, `rgba(56, 189, 248, ${(b.a * 0.4).toFixed(2)})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        canvasCtx.fillStyle = grad;
        canvasCtx.beginPath();
        canvasCtx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        canvasCtx.fill();
      }
    }
    canvasTeardown = () => {};
    tick();
  }

  const CANVAS_RENDERERS = {
    galaxy:  startGalaxy,
    rain:    startRain,
    bubbles: startBubbles,
  };

  // ---- Public API -------------------------------------------
  function setWallpaper(id) {
    const w = WALLPAPERS.find(x => x.id === id) || WALLPAPERS[0];
    document.body.dataset.wallpaper = w.id;
    try { localStorage.setItem('wallpaper', w.id); } catch {}
    teardownCanvas();
    if (w.canvas && CANVAS_RENDERERS[w.canvas] && !reduceMotionQuery.matches) {
      CANVAS_RENDERERS[w.canvas]();
    }
  }

  function current() { return document.body.dataset.wallpaper || 'liquid'; }
  function list() { return WALLPAPERS.slice(); }

  // ---- Boot: restore saved wallpaper -----------------------
  try {
    let saved = localStorage.getItem('wallpaper');
    const materialVersion = 'liquid-glass-v1';
    if (localStorage.getItem('materialVersion') !== materialVersion) {
      // Move the previous quiet default to the new designed background once.
      // Any wallpaper explicitly chosen after this migration remains respected.
      if (!saved || saved === 'none' || saved === 'aurora' || saved === 'rain') {
        saved = 'liquid';
      }
      localStorage.setItem('materialVersion', materialVersion);
    }
    if (saved && WALLPAPERS.find(w => w.id === saved)) setWallpaper(saved);
    else setWallpaper(current());   // ensures canvas-mode starts if default needs it
  } catch {
    setWallpaper(current());
  }

  window.Wallpapers = { list, set: setWallpaper, current };
})();

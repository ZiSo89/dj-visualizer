// main.js — Application entry point (ES Module)
// ─────────────────────────────────────────────────────────────────
import { state, updateState } from './src/core/StateManager.js';
import { on, emit } from './src/core/EventBus.js';
import GraphicsEngine  from './src/engines/GraphicsEngine.js';
import AudioEngine     from './src/engines/AudioEngine.js';
import TrackingEngine  from './src/engines/TrackingEngine.js';

// ── DOM refs ────────────────────────────────────────────────────
const loadingScreenEl  = document.getElementById('loading-screen');
const startOverlayEl   = document.getElementById('start-overlay');
const startBtnEl       = document.getElementById('start-btn');
const fpsEl            = document.getElementById('fps-counter');

// ── Animation loop state ─────────────────────────────────────────
let lastTimestamp = 0;
let frameCount    = 0;
let fpsAccum      = 0;

// ── Per-stem finger control state ────────────────────────────────
// Left hand: thumb-finger distances → per-stem Volume
// Right hand: thumb-finger distances → per-stem Filter
// Cross-hand (L↔R fingertip distances) → per-stem Reverb
//   index=bass, middle=drums, ring=melody
let currentVols    = { bass: 0.7, drums: 0.7, melody: 0.7 };
let currentFilters = { bass: 15000, drums: 15000, melody: 15000 };
let currentReverbs = { bass: 0, drums: 0, melody: 0 };
const debugEl      = { el: null };

// ── Waveform canvas ─────────────────────────────────────────────
const waveCanvas = document.getElementById('wave-canvas');
const waveCtx    = waveCanvas ? waveCanvas.getContext('2d') : null;

// ── Fist progress rings (one per hand) ─────────────────────────
const fistProgress = { left: 0, right: 0 };

function drawFistRings() {
  for (const side of ['left', 'right']) {
    const prog = fistProgress[side];
    let el = document.getElementById(`fist-ring-${side}`);
    if (!el) {
      el = document.createElement('canvas');
      el.id = `fist-ring-${side}`;
      el.width = el.height = 48;
      el.style.cssText = `position:fixed;bottom:28px;${side==='left'?'left:28px':'right:28px'};z-index:9999;pointer-events:none;transition:opacity 0.2s;`;
      document.body.appendChild(el);
    }
    const c = el.getContext('2d');
    c.clearRect(0, 0, 48, 48);
    if (prog > 0) {
      el.style.opacity = '1';
      c.strokeStyle = side === 'right' ? '#00ffff' : '#ff88ff';
      c.lineWidth = 4;
      c.globalAlpha = 0.35;
      c.beginPath(); c.arc(24, 24, 18, 0, Math.PI * 2); c.stroke();
      c.globalAlpha = 1;
      c.beginPath();
      c.arc(24, 24, 18, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
      c.stroke();
      // Fist icon
      c.font = '16px serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = c.strokeStyle;
      c.fillText('✊', 24, 25);
    } else {
      el.style.opacity = '0';
    }
  }
}

function drawWaveforms() {
  if (!waveCtx) return;
  const W = 160, H = 120;
  waveCtx.clearRect(0, 0, W, H);
  waveCtx.fillStyle = 'rgba(0,0,0,0.6)';
  waveCtx.fillRect(0, 0, W, H);

  const waves = AudioEngine.getWaveforms?.();
  if (!waves) return;

  const tracks = [
    { key: 'bass',   color: '#ff8800', y: 15  },
    { key: 'drums',  color: '#ff4444', y: 45  },
    { key: 'melody', color: '#ffff00', y: 75  }
  ];

  for (const { key, color, y } of tracks) {
    const buf = waves[key];
    const laneH = 22;
    waveCtx.strokeStyle = color;
    waveCtx.lineWidth = 1.5;
    waveCtx.globalAlpha = 0.85;
    waveCtx.shadowColor = color;
    waveCtx.shadowBlur = 4;
    waveCtx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (buf.length - 1)) * W;
      const yv = y + buf[i] * laneH;
      i === 0 ? waveCtx.moveTo(x, yv) : waveCtx.lineTo(x, yv);
    }
    waveCtx.stroke();
    // Label
    waveCtx.shadowBlur = 0;
    waveCtx.font = '7px monospace';
    waveCtx.fillStyle = color;
    waveCtx.globalAlpha = 0.7;
    waveCtx.fillText(key.toUpperCase(), 3, y - 8);
  }
  waveCtx.globalAlpha = 1;
  waveCtx.shadowBlur = 0;

  // ── Volume bars (bottom section) ──
  const barTop = 95;
  const barH   = 20;
  const barW   = 40;
  const volBars = [
    { key: 'bass',   color: '#ff8800', x: 10  },
    { key: 'drums',  color: '#ff4444', x: 60  },
    { key: 'melody', color: '#ffff00', x: 110 },
  ];
  // Separator
  waveCtx.strokeStyle = 'rgba(255,255,255,0.18)';
  waveCtx.lineWidth = 0.5;
  waveCtx.beginPath();
  waveCtx.moveTo(0, barTop - 2); waveCtx.lineTo(W, barTop - 2);
  waveCtx.stroke();

  for (const { key, color, x } of volBars) {
    const vol = currentVols[key] ?? 0.7;
    const fillH = Math.max(1, vol * barH);
    // Background track
    waveCtx.fillStyle = 'rgba(255,255,255,0.07)';
    waveCtx.fillRect(x, barTop, barW, barH);
    // Filled portion (bottom-up)
    waveCtx.fillStyle = color;
    waveCtx.globalAlpha = 0.9;
    waveCtx.shadowColor = color;
    waveCtx.shadowBlur = 8;
    waveCtx.fillRect(x, barTop + barH - fillH, barW, fillH);
    waveCtx.globalAlpha = 1;
    waveCtx.shadowBlur = 0;
    // Label
    waveCtx.font = '7px monospace';
    waveCtx.fillStyle = color;
    waveCtx.globalAlpha = 0.6;
    waveCtx.textAlign = 'center';
    waveCtx.fillText(key.slice(0,3).toUpperCase(), x + barW / 2, barTop + barH + 9);
    waveCtx.globalAlpha = 1;
    waveCtx.textAlign = 'left';
  }
}

// ────────────────────────────────────────────────────────────────
// Loading progress helper
// ────────────────────────────────────────────────────────────────
function updateLoadingProgress(percent, message) {
  const bar    = document.getElementById('loading-progress');
  const status = document.getElementById('loading-status');
  if (bar)    bar.style.width    = percent + '%';
  if (status) status.textContent = message;
}

// ────────────────────────────────────────────────────────────────
// Main init
// ────────────────────────────────────────────────────────────────
async function init() {
  console.log('Initializing DJ Visualizer...');

  try {
    updateLoadingProgress(0, 'Loading graphics...');
    await GraphicsEngine.init(document.getElementById('main-canvas'));

    updateLoadingProgress(33, 'Loading audio...');
    await AudioEngine.init();

    updateLoadingProgress(66, 'Starting camera...');
    await TrackingEngine.init(document.getElementById('webcam'));

    updateLoadingProgress(100, 'Ready!');

    // Short pause so the user sees 100% before hiding
    await new Promise(r => setTimeout(r, 600));
    loadingScreenEl.style.opacity = '0';
    setTimeout(() => { loadingScreenEl.style.display = 'none'; }, 500);

    // Wire up EventBus → engine connections
    setupEventListeners();

    // DEV keyboard shortcuts
    setupKeyboard();

    // Start render loop
    requestAnimationFrame(loop);

    console.log('All systems ready.');

  } catch (err) {
    console.error('[init] Fatal error:', err);
    updateLoadingProgress(0, 'Error: ' + err.message);
    const bar = document.getElementById('loading-progress');
    if (bar) bar.style.background = '#ff4444';

    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.style.cssText =
      'margin-top:24px;padding:10px 28px;background:#00ffff;border:none;' +
      'cursor:pointer;font-size:1rem;font-family:monospace;border-radius:2px;';
    retryBtn.onclick = () => location.reload();
    document.querySelector('.loading-content')?.appendChild(retryBtn);
  }
}

// ────────────────────────────────────────────────────────────────
// Animation loop
// ────────────────────────────────────────────────────────────────
function loop(timestamp) {
  const deltaTime = Math.min((timestamp - lastTimestamp) / 1000, 0.1); // cap at 100ms
  lastTimestamp = timestamp;

  GraphicsEngine.update(deltaTime);
  AudioEngine.update(deltaTime);

  drawFistRings();
  drawWaveforms();

  // Debug overlay update (every ~500ms)
  if (fpsAccum >= 0.45) {
    if (!debugEl.el) debugEl.el = document.getElementById('debug-overlay');
    if (debugEl.el) {
      const ldet = state.hands.left.detected;
      const rdet = state.hands.right.detected;
      const sides = (ldet ? 'L' : '') + (rdet ? 'R' : '');
      const rv = (s) => Math.round(currentReverbs[s] * 100);
      debugEl.el.textContent =
        `Hand: ${sides || '-'}  (L=vol R=flt)\n` +
        `Bass:   V${currentVols.bass.toFixed(2)} F${currentFilters.bass.toFixed(0)} R${rv('bass')}%\n` +
        `Drums:  V${currentVols.drums.toFixed(2)} F${currentFilters.drums.toFixed(0)} R${rv('drums')}%\n` +
        `Melody: V${currentVols.melody.toFixed(2)} F${currentFilters.melody.toFixed(0)} R${rv('melody')}%\n` +
        `Play: ${state.isPlaying ? 'YES' : 'NO'}`;
    }
  }

  // FPS counter update every 500ms
  frameCount++;
  fpsAccum += deltaTime;
  if (fpsAccum >= 0.5) {
    fpsEl.textContent = Math.round(frameCount / fpsAccum) + ' fps';
    frameCount = 0;
    fpsAccum   = 0;
  }

  requestAnimationFrame(loop);
}

// ────────────────────────────────────────────────────────────────
// EventBus connections (engines talk through events)
// ────────────────────────────────────────────────────────────────
function setupEventListeners() {
  // ── Finger distances → per-stem volume (left) / filter (right) ──
  // Distance range: ~0.02 (pinched) to ~0.20 (open)
  on('gesture:fingers', ({ hand, distances }) => {
    for (const stem of ['bass', 'drums', 'melody']) {
      const dist = distances[stem];
      // Normalize: 0.02 → 0, 0.20 → 1
      const norm = Math.max(0, Math.min(1, (dist - 0.02) / 0.18));

      if (hand === 'left') {
        // Left hand → Volume
        currentVols[stem] = norm;
        AudioEngine.setVolume(stem, norm);
      } else {
        // Right hand → Filter (logarithmic 200–15000 Hz)
        const logMin = Math.log(200);
        const logMax = Math.log(15000);
        currentFilters[stem] = Math.exp(logMin + norm * (logMax - logMin));
        AudioEngine.setStemFilter(stem, currentFilters[stem]);
      }
    }
  });

  // ── Cross-hand finger distances → per-stem Reverb ──────────────
  // Distance range: ~0.05 (hands close) to ~0.50 (hands far apart)
  on('gesture:crossFingers', ({ distances }) => {
    for (const stem of ['bass', 'drums', 'melody']) {
      // Normalize: 0.05 → 0 (dry), 0.50 → 1 (full reverb)
      const norm = Math.max(0, Math.min(1, (distances[stem] - 0.05) / 0.45));
      currentReverbs[stem] = norm;
      AudioEngine.setStemReverb(stem, norm);
    }
  });

  // ── Fist gesture → navigate planets (left=prev, right=next) ────
  on('gesture:fist', ({ hand }) => {
    if (hand === 'right') GraphicsEngine.advanceScene();
    else GraphicsEngine.prevScene();
    AudioEngine.triggerLoopChange();
    // Show planet name
    const el = document.getElementById('hud-planet');
    if (el) {
      el.textContent = (state.camera.currentTarget ?? '').toUpperCase();
      el.style.opacity = '1';
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
    }
  });

  // ── Fist hold progress → visual ring feedback ─────────────────
  on('gesture:fistProgress', ({ hand, progress }) => {
    fistProgress[hand] = progress;
  });

  // ── Pinch → per-hand orbit + roll control ────────────────────────
  on('gesture:pinch', ({ hand, active }) => {
    if (active) {
      const h = state.hands[hand];
      GraphicsEngine.startPinch(hand, h.x, h.y);
    } else {
      GraphicsEngine.stopPinch(hand);
    }
  });

  // ── Hand position update → pinch orbit/roll + palm-distance zoom ──
  on('hands:update', () => {
    const L = state.hands.left;
    const R = state.hands.right;
    const bothPinching = L.detected && L.pinching && R.detected && R.pinching;

    if (bothPinching) {
      // Zoom: distance between the two pinching hands
      const dx = L.x - R.x, dy = L.y - R.y, dz = L.z - R.z;
      GraphicsEngine.setZoom(Math.sqrt(dx * dx + dy * dy + dz * dz));
      // Orbit + roll: both hands still drive pinch deltas simultaneously
      GraphicsEngine.updatePinch('left',  L.x, L.y);
      GraphicsEngine.updatePinch('right', R.x, R.y);
    } else {
      GraphicsEngine.stopZoom();
      // Single-hand pinch → orbit / tilt
      for (const side of ['left', 'right']) {
        if (state.hands[side].pinching) {
          GraphicsEngine.updatePinch(side, state.hands[side].x, state.hands[side].y);
        }
      }
    }
  });

  // HUD updates every 100ms (DOM is expensive — never update per-frame)
  setInterval(updateHUD, 100);
}

// ────────────────────────────────────────────────────────────────
// HUD
// ────────────────────────────────────────────────────────────────
function updateHUD() {
  // BPM
  const bpmEl = document.getElementById('hud-bpm');
  if (bpmEl) bpmEl.textContent = state.bpm + ' BPM';

  // Stem dots
  const playing = state.isPlaying;
  document.getElementById('stem-drums') ?.classList.toggle('active', playing);
  document.getElementById('stem-bass')  ?.classList.toggle('active', playing);
  document.getElementById('stem-melody')?.classList.toggle('active', playing);

  // Quality — removed (always max)

  // Hand dots
  document.getElementById('hand-left') ?.classList.toggle('active', state.hands.left.detected);
  document.getElementById('hand-right')?.classList.toggle('active', state.hands.right.detected);
}

// ────────────────────────────────────────────────────────────────
// DEV keyboard shortcuts
// ────────────────────────────────────────────────────────────────
function setupKeyboard() {
  let isPlaying = false;

  document.addEventListener('keydown', (e) => {
    // Don't fire inside input fields
    if (e.target.tagName === 'INPUT') return;

    switch (e.key) {
      case ' ':                          // DEV — toggle play/stop
        e.preventDefault();
        if (isPlaying) { AudioEngine.stop(); isPlaying = false; }
        else           { AudioEngine.play(); isPlaying = true;  }
        break;
      case 'h': case 'H':               // DEV — toggle HUD
        const hud = document.getElementById('ui-overlay');
        if (hud) hud.style.visibility =
          hud.style.visibility === 'hidden' ? 'visible' : 'hidden';
        break;
      case 'f': case 'F':               // DEV — toggle FPS counter
        fpsEl.style.display = fpsEl.style.display === 'none' ? '' : 'none';
        break;
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Boot — wait for user click (AudioContext policy), then init
// ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  startBtnEl.addEventListener('click', async () => {
    // Satisfy Chrome's "user gesture required" for AudioContext
    if (typeof Tone !== 'undefined') await Tone.start();

    // Hide start overlay
    startOverlayEl.style.opacity = '0';
    setTimeout(() => { startOverlayEl.style.display = 'none'; }, 400);

    init();
  }, { once: true });
});

// src/engines/TrackingEngine.js — Full Phase 2 implementation
// ─────────────────────────────────────────────────────────────────
// Webcam → OffscreenCanvas → ImageBitmap → Web Worker (MediaPipe)
// Worker returns landmarks → smooth → map to Three.js → State + Events
//
// Performance tuning (benchmark: ~15-17fps on this machine):
//   - Webcam resolution: 320×240 (reduced from 640×480)
//   - Backpressure: never send a new frame until the previous is done
//   - Frame skip: skip rAF ticks while worker is busy (automatic)
// ─────────────────────────────────────────────────────────────────
import { state, updateState } from '../core/StateManager.js';
import { emit }               from '../core/EventBus.js';
import { applySmoothing, isPinching, isFist, getPalmCenter, getFrameGesture, getFingerDistances, getCrossHandDistances }
  from '../utils/GestureDetector.js';
import { mediapipeToThreeJS } from '../utils/CoordinateMapper.js';

// Webcam resolution — lower = faster MediaPipe inference
const CAM_W = 320;
const CAM_H = 240;

const TrackingEngine = {
  cameraAvailable: false,
  worker:          null,
  workerBusy:      false,
  videoElement:    null,
  offscreenCanvas: null,
  offscreenCtx:    null,
  animFrameId:     null,
  stream:          null,
  camCanvas:       null,
  camCtx:          null,

  // Exponential-smoothing state for each hand's palm center
  prevPalm: {
    left:  { x: 0, y: 0, z: 0 },
    right: { x: 0, y: 0, z: 0 }
  },

  // Fist edge-detection: hold-timer based (3 seconds)
  wasFist:     { left: false, right: false },
  fistHoldStart: { left: 0, right: 0 },
  fistCooldown: 0,
  FIST_HOLD_MS: 3000,

  // Pinch edge-detection: only emit event on state change
  wasPinching: { left: false, right: false },

  // Smoothed frame gesture values
  prevFrameH: 0,
  prevFrameW: 0,

  // Smoothed finger distances per hand
  prevFingers: {
    left:  { bass: 0, drums: 0, melody: 0 },
    right: { bass: 0, drums: 0, melody: 0 }
  },

  // Smoothed cross-hand finger distances
  prevCross: { bass: 0, drums: 0, melody: 0 },

  // ── init ────────────────────────────────────────────────────────
  async init(videoElement) {
    this.videoElement = videoElement;

    // Request webcam
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: CAM_W, height: CAM_H, facingMode: 'user', frameRate: { ideal: 30, max: 30 } }
      });
    } catch (err) {
      console.warn('[TrackingEngine] Camera access denied — tracking disabled:', err.message);
      this.cameraAvailable = false;
      return; // don't crash — app continues without tracking
    }

    this.stream = stream;
    videoElement.srcObject = stream;
    await videoElement.play();
    this.cameraAvailable = true;

    // OffscreenCanvas — used to convert video frame → ImageBitmap
    this.offscreenCanvas = new OffscreenCanvas(CAM_W, CAM_H);
    this.offscreenCtx    = this.offscreenCanvas.getContext('2d');

    // Classic Worker — local bundle loaded via importScripts
    this.worker = new Worker('./src/workers/mediapipe.worker.js');

    // Handshake: wait for READY (or ERROR / 10s timeout)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('[TrackingEngine] MediaPipe Worker INIT timed out (10s)'));
      }, 10_000);

      const handler = (e) => {
        if (e.data.type === 'READY') {
          clearTimeout(timeout);
          this.worker.removeEventListener('message', handler);
          resolve();
        } else if (e.data.type === 'ERROR') {
          clearTimeout(timeout);
          this.worker.removeEventListener('message', handler);
          reject(new Error('MediaPipe Worker init error: ' + e.data.message));
        }
      };
      this.worker.addEventListener('message', handler);
      this.worker.postMessage({ type: 'INIT' });
    });

    // Ongoing message handler (after handshake is done)
    this.worker.onmessage = (e) => this._onWorkerMessage(e);
    this.workerBusy = false;

    // Start frame loop
    this._frameLoop();

    // Camera preview canvas
    const camEl = document.getElementById('cam-canvas');
    if (camEl) {
      this.camCanvas = camEl;
      this.camCtx = camEl.getContext('2d');
    }

    console.log(`[TrackingEngine] initialized — webcam ${CAM_W}×${CAM_H}, MediaPipe ready`);
  },

  // ── frame loop ─────────────────────────────────────────────────
  _frameLoop() {
    this.animFrameId = requestAnimationFrame(() => this._frameLoop());
    if (!this.cameraAvailable)      return;
    if (this.workerBusy)            return; // backpressure
    if (this.videoElement.readyState < 2) return; // video not decoded yet

    // Draw current video frame to OffscreenCanvas
    this.offscreenCtx.drawImage(this.videoElement, 0, 0, CAM_W, CAM_H);

    // Draw camera preview
    if (this.camCtx) {
      this.camCtx.drawImage(this.videoElement, 0, 0, 160, 120);
    }

    // Mark busy BEFORE the async createImageBitmap to prevent race conditions
    this.workerBusy = true;
    createImageBitmap(this.offscreenCanvas).then(bitmap => {
      if (!this.worker) { bitmap.close(); this.workerBusy = false; return; }
      // Transfer bitmap to worker (zero-copy — ownership moves to worker)
      this.worker.postMessage({ type: 'PROCESS', bitmap }, [bitmap]);
    });
  },

  // ── worker message handler ──────────────────────────────────────
  _mpFpsEl: null,

  _onWorkerMessage(e) {
    const { type, data } = e.data;
    if (type === 'LANDMARKS') {
      this.workerBusy = false;
      // Display MediaPipe processing FPS
      if (data.processingFps !== undefined) {
        if (!this._mpFpsEl) this._mpFpsEl = document.getElementById('mp-fps');
        if (this._mpFpsEl) this._mpFpsEl.textContent = `MP: ${data.processingFps} fps`;
      }
      // Draw landmarks on camera preview
      this._drawLandmarks(data);
      this._processLandmarks(data);
    } else if (type === 'ERROR') {
      this.workerBusy = false;
      console.warn('[TrackingEngine] Worker error:', e.data.message);
    }
  },

  // ── draw landmarks on camera preview ────────────────────────────
  _drawLandmarks({ left, right }) {
    // Camera preview shows only the raw video frame (no overlays)
    return;
    const ctx = this.camCtx;
    const W = 160, H = 120;

    // MediaPipe hand connections (finger bones)
    const CONNECTIONS = [
      [0,1],[1,2],[2,3],[3,4],       // thumb
      [0,5],[5,6],[6,7],[7,8],       // index
      [0,9],[9,10],[10,11],[11,12],  // middle
      [0,13],[13,14],[14,15],[15,16],// ring
      [0,17],[17,18],[18,19],[19,20],// pinky
      [5,9],[9,13],[13,17]           // palm
    ];

    for (const hand of [left, right]) {
      if (!hand || !hand.detected || !hand.landmarks) continue;
      const lm = hand.landmarks;
      const color = (hand === left) ? '#00ff00' : '#ff00ff';

      // Draw connections
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      for (const [a, b] of CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(lm[a].x * W, lm[a].y * H);
        ctx.lineTo(lm[b].x * W, lm[b].y * H);
        ctx.stroke();
      }

      // Draw joints
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      for (const pt of lm) {
        ctx.beginPath();
        ctx.arc(pt.x * W, pt.y * H, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // ── Draw frame quadrilateral if both hands visible ──────────
    if (left?.detected && left.landmarks && right?.detected && right.landmarks) {
      const lt = left.landmarks[4];   // left thumb
      const li = left.landmarks[8];   // left index
      const rt = right.landmarks[4];  // right thumb
      const ri = right.landmarks[8];  // right index

      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(lt.x * W, lt.y * H);
      ctx.lineTo(li.x * W, li.y * H);
      ctx.lineTo(ri.x * W, ri.y * H);
      ctx.lineTo(rt.x * W, rt.y * H);
      ctx.closePath();
      ctx.stroke();

      // Semi-transparent fill
      ctx.fillStyle = 'rgba(0, 255, 255, 0.08)';
      ctx.fill();
      ctx.globalAlpha = 1;

      // ── Lines between matching fingertips L↔R ──────────────────
      const CROSS_FINGERS = [
        { li: 8,  ri: 8,  color: '#ff8800', label: 'B' },  // index = bass
        { li: 12, ri: 12, color: '#ff4444', label: 'D' },  // middle = drums
        { li: 16, ri: 16, color: '#ffff00', label: 'M' },  // ring = melody
      ];
      const llm = left.landmarks;
      const rlm = right.landmarks;

      for (const { li: lIdx, ri: rIdx, color, label } of CROSS_FINGERS) {
        const lp = llm[lIdx];
        const rp = rlm[rIdx];
        const lx = lp.x * W, ly = lp.y * H;
        const rx = rp.x * W, ry = rp.y * H;

        // Solid thick line
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(rx, ry);
        ctx.stroke();

        // Glow effect — wider transparent line underneath
        ctx.lineWidth = 6;
        ctx.globalAlpha = 0.2;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(rx, ry);
        ctx.stroke();

        // Dots at endpoints
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        for (const [px, py] of [[lx, ly], [rx, ry]]) {
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Distance + reverb label at midpoint
        const mx = (lx + rx) / 2;
        const my = (ly + ry) / 2;
        const dist = Math.sqrt((lp.x - rp.x) ** 2 + (lp.y - rp.y) ** 2);
        // Reverb %: 0.05 (close) → 0, 0.50 (far) → 100%
        const revPct = Math.round(Math.max(0, Math.min(1, (dist - 0.05) / 0.45)) * 100);
        ctx.font = 'bold 8px monospace';
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.9;
        ctx.textAlign = 'center';
        // Dark background for readability
        const txt = `${label} ${revPct}%`;
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(mx - tw / 2 - 2, my - 9, tw + 4, 11);
        ctx.fillStyle = color;
        ctx.fillText(txt, mx, my - 1);
      }
      ctx.globalAlpha = 1;
    }

    // ── Draw finger distance bars per hand ──────────────────────
    const STEM_COLORS = { bass: '#ff8800', drums: '#ff4444', melody: '#ffff00' };
    const STEM_LABELS = { bass: 'B', drums: 'D', melody: 'M' };
    const barW = 4, barMaxH = 30, gap = 6;

    for (const [handObj, side, xBase] of [[left, 'left', 4], [right, 'right', W - 26]]) {
      if (!handObj?.detected || !handObj.landmarks) continue;
      const dists = this.prevFingers[side];
      const label = side === 'left' ? 'VOL' : 'FLT';

      ctx.font = '7px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#aaa';
      ctx.globalAlpha = 0.8;
      ctx.fillText(label, xBase + 10, 10);

      let i = 0;
      for (const stem of ['bass', 'drums', 'melody']) {
        // Normalize: 0.02 (closed) → 0.20 (open) → 0–1
        const norm = Math.max(0, Math.min(1, (dists[stem] - 0.02) / 0.18));
        const barH = norm * barMaxH;
        const x = xBase + i * gap;
        const y = 14;

        // Background bar
        ctx.fillStyle = '#333';
        ctx.globalAlpha = 0.4;
        ctx.fillRect(x, y, barW, barMaxH);

        // Filled bar (bottom-up)
        ctx.fillStyle = STEM_COLORS[stem];
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, y + barMaxH - barH, barW, barH);

        // Label
        ctx.fillStyle = STEM_COLORS[stem];
        ctx.globalAlpha = 0.7;
        ctx.fillText(STEM_LABELS[stem], x + barW / 2, y + barMaxH + 8);

        i++;
      }
      ctx.globalAlpha = 1;
    }
  },

  // ── process landmark data ───────────────────────────────────────
  _processLandmarks({ left, right }) {
    const handData  = { left, right };
    const activePalms = []; // Three.js positions of detected hands

    for (const side of ['left', 'right']) {
      const hand = handData[side];

      if (!hand || !hand.detected || !hand.landmarks) {
        // Hand lost — clear state
        updateState(`hands.${side}.detected`,  false);
        updateState(`hands.${side}.pinching`,  false);
        updateState(`hands.${side}.landmarks`, null);
        // Emit pinch-off edge if it was active
        if (this.wasPinching[side]) {
          this.wasPinching[side] = false;
          emit('gesture:pinch', { hand: side, active: false });
        }
        if (this.wasFist[side]) {
          this.wasFist[side] = false;
        }
        continue;
      }

      const { landmarks } = hand;

      // ── Smooth palm center ──────────────────────────────────────
      const rawPalm  = getPalmCenter(landmarks);
      const prev     = this.prevPalm[side];
      const smoothed = {
        x: applySmoothing(rawPalm.x, prev.x),
        y: applySmoothing(rawPalm.y, prev.y),
        z: applySmoothing(rawPalm.z, prev.z)
      };
      this.prevPalm[side] = smoothed;

      // ── Convert to Three.js world space ────────────────────────
      const threePos = mediapipeToThreeJS(smoothed.x, smoothed.y, smoothed.z);

      // ── Pinch detection (with hysteresis) ───────────────────────────
      const nowPinching = isPinching(landmarks, this.wasPinching[side]);

      // Update state (Object.assign merge — preserves any extra keys)
      updateState(`hands.${side}`, {
        detected:  true,
        x:         threePos.x,
        y:         threePos.y,
        z:         threePos.z,
        pinching:  nowPinching,
        landmarks
      });

      // Emit pinch only on rising/falling edge
      if (nowPinching !== this.wasPinching[side]) {
        this.wasPinching[side] = nowPinching;
        emit('gesture:pinch', { hand: side, active: nowPinching });
      }

      // ── Fist detection — must hold 3 seconds ─────────────────────
      const nowFist = isFist(landmarks);
      if (nowFist) {
        if (!this.wasFist[side]) {
          this.fistHoldStart[side] = Date.now();
        }
        const held = Date.now() - this.fistHoldStart[side];
        const progress = Math.min(1, held / this.FIST_HOLD_MS);
        // Emit progress for visual feedback
        emit('gesture:fistProgress', { hand: side, progress });
        if (held >= this.FIST_HOLD_MS && Date.now() - this.fistCooldown > 1500) {
          this.fistCooldown = Date.now();
          this.fistHoldStart[side] = Date.now(); // reset hold so it doesn't fire again immediately
          console.log(`gesture:fist (${side} hand)`);
          emit('gesture:fist', { hand: side });
        }
      } else if (this.wasFist[side]) {
        emit('gesture:fistProgress', { hand: side, progress: 0 });
      }
      this.wasFist[side] = nowFist;

      // ── Finger distances (thumb↔index/middle/ring) ─────────────
      const rawDist = getFingerDistances(landmarks);
      if (rawDist) {
        const prev = this.prevFingers[side];
        const smoothed = {
          bass:   applySmoothing(rawDist.bass,   prev.bass,   0.35),
          drums:  applySmoothing(rawDist.drums,  prev.drums,  0.35),
          melody: applySmoothing(rawDist.melody, prev.melody, 0.35)
        };
        this.prevFingers[side] = smoothed;
        emit('gesture:fingers', { hand: side, distances: smoothed });
      }

      activePalms.push(threePos);
    }

    // ── Frame gesture (both hands) ───────────────────────────────
    const leftLm  = handData.left?.detected  ? handData.left.landmarks  : null;
    const rightLm = handData.right?.detected ? handData.right.landmarks : null;
    const frame   = getFrameGesture(leftLm, rightLm);

    if (frame.active) {
      // Smooth height & width to reduce jitter
      this.prevFrameH = applySmoothing(frame.height, this.prevFrameH, 0.35);
      this.prevFrameW = applySmoothing(frame.width,  this.prevFrameW, 0.35);
      emit('gesture:frame', {
        active: true,
        height: this.prevFrameH,
        width:  this.prevFrameW,
        lt: frame.lt, li: frame.li, rt: frame.rt, ri: frame.ri
      });
    } else {
      emit('gesture:frame', { active: false, height: 0, width: 0 });
    }

    // ── Cross-hand finger distances (L↔R) → reverb ──────────────
    const crossDist = getCrossHandDistances(leftLm, rightLm);
    if (crossDist) {
      const prev = this.prevCross;
      this.prevCross = {
        bass:   applySmoothing(crossDist.bass,   prev.bass,   0.3),
        drums:  applySmoothing(crossDist.drums,  prev.drums,  0.3),
        melody: applySmoothing(crossDist.melody, prev.melody, 0.3)
      };
      emit('gesture:crossFingers', { distances: this.prevCross });
    }

    // ── Particle repulsion point ─────────────────────────────────
    if (activePalms.length === 0) {
      updateState('particles.repulsionStrength', 0);
    } else {
      const avgX = activePalms.reduce((s, p) => s + p.x, 0) / activePalms.length;
      const avgY = activePalms.reduce((s, p) => s + p.y, 0) / activePalms.length;
      updateState('particles.repulsionX',        avgX);
      updateState('particles.repulsionY',        avgY);
      updateState('particles.repulsionStrength', activePalms.length === 2 ? 3.0 : 2.5);
    }

    // ── Broadcast ────────────────────────────────────────────────
    emit('hands:update', { left: state.hands.left, right: state.hands.right });
  },

  // ── cleanup ─────────────────────────────────────────────────────
  destroy() {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.worker?.terminate();
    this.stream?.getTracks().forEach(t => t.stop());
    this.cameraAvailable = false;
    this.worker = null;
  }
};

export default TrackingEngine;

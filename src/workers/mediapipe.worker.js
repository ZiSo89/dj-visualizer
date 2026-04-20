// src/workers/mediapipe.worker.js — Full Phase 2 implementation
// ─────────────────────────────────────────────────────────────────
// Runs in a dedicated Web Worker thread — main thread never blocks.
//
// Protocol:
//   INCOMING: { type: 'INIT' }
//             { type: 'PROCESS', bitmap: ImageBitmap }  ← Transferable (zero-copy)
//   OUTGOING: { type: 'READY' }
//             { type: 'LANDMARKS', data: { left, right, processingFps } }
//             { type: 'ERROR', message: string }
//
// Handedness swap: MediaPipe 'Right' label = viewer's LEFT hand (mirror fix).
// ─────────────────────────────────────────────────────────────────

// Local bundle (from @mediapipe/tasks-vision@0.10.34, with CJS shim).
// Loaded via importScripts in a classic Worker — no module worker needed.
importScripts('./vision_bundle.js');

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';

let handLandmarker = null;
let frameTimestamps = [];

// Rolling FPS over the last 1 second of processed frames
function calcFps() {
  const now = performance.now();
  frameTimestamps = frameTimestamps.filter(t => now - t < 1000);
  frameTimestamps.push(now);
  return frameTimestamps.length;
}

async function createHandLandmarker(delegate) {
  const { HandLandmarker, FilesetResolver } = self;
  const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
      delegate
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.3
  });
}

self.onmessage = async function (e) {

  // ── INIT ──────────────────────────────────────────────────────
  if (e.data.type === 'INIT') {
    try {
      try {
        handLandmarker = await createHandLandmarker('GPU');
        console.log('[Worker] MediaPipe running on GPU delegate');
      } catch (_gpuErr) {
        // Silent fallback — GPU not available in this Worker context
        handLandmarker = await createHandLandmarker('CPU');
        console.log('[Worker] MediaPipe running on CPU delegate (GPU unavailable)');
      }
      self.postMessage({ type: 'READY' });
    } catch (err) {
      self.postMessage({ type: 'ERROR', message: String(err.message || err) });
    }
    return;
  }

  // ── PROCESS ───────────────────────────────────────────────────
  if (e.data.type === 'PROCESS') {
    const { bitmap } = e.data;

    if (!handLandmarker || !bitmap) {
      bitmap?.close();
      return;
    }

    try {
      // detectForVideo is synchronous — runs ML inference on current frame
      const result = handLandmarker.detectForVideo(bitmap, performance.now());
      bitmap.close(); // free GPU/CPU memory immediately

      const leftData  = { detected: false, landmarks: null };
      const rightData = { detected: false, landmarks: null };

      for (let i = 0; i < result.landmarks.length; i++) {
        // MediaPipe labels match physical hands when fed raw (un-mirrored) video
        const label     = result.handedness[i][0].categoryName; // 'Left' | 'Right'
        const landmarks = result.landmarks[i].map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));

        if (label === 'Left') {
          leftData.detected  = true;
          leftData.landmarks = landmarks;
        } else {
          rightData.detected  = true;
          rightData.landmarks = landmarks;
        }
      }

      self.postMessage({
        type: 'LANDMARKS',
        data: {
          left:          leftData.detected  ? leftData  : null,
          right:         rightData.detected ? rightData : null,
          processingFps: calcFps()
        }
      });

    } catch (err) {
      // bitmap may already be closed, so guard the close
      try { bitmap.close(); } catch (_) {}
      self.postMessage({ type: 'ERROR', message: String(err.message || err) });
    }
  }
};

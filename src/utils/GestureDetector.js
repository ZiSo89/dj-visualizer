// src/utils/GestureDetector.js
// ─────────────────────────────────────────────────────────────────
// Pure utility functions — no imports, no side effects.
// ─────────────────────────────────────────────────────────────────

/**
 * Detect pinch with hysteresis.
 * Engage at distance < 0.06, release at > 0.10.
 * @param {Array<{x,y,z}>|null} landmarks
 * @param {boolean} wasPinching — previous frame's pinch state
 * @returns {boolean}
 */
export function isPinching(landmarks, wasPinching = false) {
  if (!landmarks || landmarks.length < 9) return false;
  const t = landmarks[4];
  const i = landmarks[8];
  const dx = t.x - i.x;
  const dy = t.y - i.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Hysteresis: harder to release than to engage
  if (wasPinching) return dist < 0.10;
  return dist < 0.06;
}

/**
 * Detect fist: all 4 fingertips curled below their PIP joints.
 * Returns false if hand is near edge of frame (partial occlusion).
 * @param {Array<{x,y,z}>|null} landmarks
 * @returns {boolean}
 */
export function isFist(landmarks) {
  if (!landmarks || landmarks.length < 21) return false;

  // Guard: if wrist (0) is near edge of frame, landmarks are unreliable
  const wrist = landmarks[0];
  if (wrist.x < 0.08 || wrist.x > 0.92 || wrist.y < 0.08 || wrist.y > 0.92) return false;

  // Also check that at least 3 fingertips are visible (inside frame)
  const tips = [8, 12, 16, 20];
  const insideCount = tips.filter(i =>
    landmarks[i].x > 0.02 && landmarks[i].x < 0.98 &&
    landmarks[i].y > 0.02 && landmarks[i].y < 0.98
  ).length;
  if (insideCount < 3) return false;

  // All 4 fingertips below their PIP joints
  const curled =
    landmarks[8].y  > landmarks[6].y  &&
    landmarks[12].y > landmarks[10].y &&
    landmarks[16].y > landmarks[14].y &&
    landmarks[20].y > landmarks[18].y;
  return curled;
}

/**
 * Get the geometric center of the palm (base of all 5 fingers).
 * @param {Array<{x,y,z}>|null} landmarks
 * @returns {{x:number, y:number, z:number}}
 */
export function getPalmCenter(landmarks) {
  if (!landmarks) return { x: 0, y: 0, z: 0 };
  const indices = [0, 5, 9, 13, 17];
  let x = 0, y = 0, z = 0;
  for (const i of indices) {
    x += landmarks[i].x;
    y += landmarks[i].y;
    z += landmarks[i].z;
  }
  const n = indices.length;
  return { x: x / n, y: y / n, z: z / n };
}

/**
 * Exponential moving average — reduces landmark jitter.
 * @param {number} current
 * @param {number} previous
 * @param {number} [factor=0.45]
 * @returns {number}
 */
export function applySmoothing(current, previous, factor = 0.45) {
  return previous + (current - previous) * factor;
}

/**
 * Detect the "Frame" gesture: both hands form a quadrilateral with
 * left thumb+index and right thumb+index tips.
 *
 * Returns { active, height, width } where:
 *   - height: avg thumb-index distance per hand (0–1 normalized mediapipe coords)
 *   - width:  horizontal distance between hands (thumb-to-thumb and index-to-index avg)
 *
 * @param {Array<{x,y,z}>|null} leftLandmarks
 * @param {Array<{x,y,z}>|null} rightLandmarks
 * @returns {{ active: boolean, height: number, width: number,
 *             lt: {x,y}, li: {x,y}, rt: {x,y}, ri: {x,y} }}
 */
export function getFrameGesture(leftLandmarks, rightLandmarks) {
  const none = { active: false, height: 0, width: 0, lt: null, li: null, rt: null, ri: null };
  if (!leftLandmarks || !rightLandmarks ||
      leftLandmarks.length < 21 || rightLandmarks.length < 21) return none;

  // 4 corner points
  const lt = leftLandmarks[4];   // left thumb tip
  const li = leftLandmarks[8];   // left index tip
  const rt = rightLandmarks[4];  // right thumb tip
  const ri = rightLandmarks[8];  // right index tip

  // Height: avg of left thumb↔index dist and right thumb↔index dist
  const leftH  = Math.sqrt((lt.x - li.x) ** 2 + (lt.y - li.y) ** 2);
  const rightH = Math.sqrt((rt.x - ri.x) ** 2 + (rt.y - ri.y) ** 2);
  const height = (leftH + rightH) / 2;

  // Width: horizontal distance between the two hands
  // avg of thumb↔thumb and index↔index X distance
  const thumbW = Math.abs(lt.x - rt.x);
  const indexW = Math.abs(li.x - ri.x);
  const width  = (thumbW + indexW) / 2;

  return { active: true, height, width, lt, li, rt, ri };
}

/**
 * Get thumb-to-finger distances for 3 fingers: index, middle, ring.
 * Maps to stems: index=bass, middle=drums, ring=melody.
 * @param {Array<{x,y,z}>|null} landmarks
 * @returns {{ bass: number, drums: number, melody: number } | null}
 *   distances in normalized mediapipe coords (0–~0.3)
 */
export function getFingerDistances(landmarks) {
  if (!landmarks || landmarks.length < 21) return null;
  const thumb = landmarks[4];
  // index(8)=bass, middle(12)=drums, ring(16)=melody
  const tips = { bass: landmarks[8], drums: landmarks[12], melody: landmarks[16] };
  const result = {};
  for (const [stem, tip] of Object.entries(tips)) {
    const dx = thumb.x - tip.x;
    const dy = thumb.y - tip.y;
    result[stem] = Math.sqrt(dx * dx + dy * dy);
  }
  return result;
}

/**
 * Get distances between matching fingertips across two hands.
 *   L index(8)  ↔ R index(8)  = bass
 *   L middle(12) ↔ R middle(12) = drums
 *   L ring(16)  ↔ R ring(16)  = melody
 * @param {Array<{x,y,z}>|null} leftLm
 * @param {Array<{x,y,z}>|null} rightLm
 * @returns {{ bass: number, drums: number, melody: number } | null}
 */
export function getCrossHandDistances(leftLm, rightLm) {
  if (!leftLm || !rightLm || leftLm.length < 21 || rightLm.length < 21) return null;
  const pairs = { bass: 8, drums: 12, melody: 16 };
  const result = {};
  for (const [stem, tip] of Object.entries(pairs)) {
    const l = leftLm[tip];
    const r = rightLm[tip];
    result[stem] = Math.sqrt((l.x - r.x) ** 2 + (l.y - r.y) ** 2);
  }
  return result;
}

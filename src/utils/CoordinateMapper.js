// src/utils/CoordinateMapper.js
// ─────────────────────────────────────────────────────────────────
// Converts MediaPipe normalized coords (0–1) → Three.js world space.
// Full specification: roadmap.txt Section 3, Prompt 2.4
//
// Three.js scene bounds (FOV 75, camera at Z=5):
//   X ≈ -4.4 to +4.4  (at Z=0 plane)
//   Y ≈ -3.3 to +3.3
// ─────────────────────────────────────────────────────────────────

/**
 * Convert MediaPipe normalized hand position to Three.js world coordinates.
 * X axis is MIRRORED so the viewer's right hand appears on the right side of screen.
 *
 * @param {number} nx — 0.0 (left edge webcam) → 1.0 (right edge)
 * @param {number} ny — 0.0 (top) → 1.0 (bottom)
 * @param {number} nz — pseudo-depth from MediaPipe (closer = more negative)
 * @param {number} [depthScale=0.5]
 * @returns {{ x: number, y: number, z: number }}
 */
export function mediapipeToThreeJS(nx, ny, nz, depthScale = 0.5) {
  return {
    x: -(nx * 8.8 - 4.4),   // mirrored: viewer's right = scene right
    y: -(ny * 6.6 - 3.3),   // flipped: top of screen = positive Y
    z:  nz * depthScale      // subtle depth only
  };
}

/**
 * Convert MediaPipe normalized coords to CSS percentage (for UI overlay).
 * X is mirrored to match the visual layout.
 *
 * @param {number} nx
 * @param {number} ny
 * @returns {{ xPercent: number, yPercent: number }}
 */
export function mediapipeToScreenPercent(nx, ny) {
  return {
    xPercent: (1 - nx) * 100,
    yPercent: ny * 100
  };
}

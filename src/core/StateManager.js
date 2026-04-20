// src/core/StateManager.js — Singleton central state
// ─────────────────────────────────────────────────────────────────

export const state = {
  bpm: 120,
  isPlaying: false,

  hands: {
    left:  { detected: false, x: 0, y: 0, z: 0, pinching: false, landmarks: null },
    right: { detected: false, x: 0, y: 0, z: 0, pinching: false, landmarks: null }
  },

  audio: {
    drumsVolume:  0.8,
    bassVolume:   0.5,
    melodyVolume: 0.5,
    filterCutoff: 8000     // Hz
  },

  camera: {
    currentTarget: 'sun',  // 'sun' | 'earth' | 'mars' | 'jupiter' | 'saturn'
    isAnimating:   false
  },

  particles: {
    repulsionX:        0,
    repulsionY:        0,
    repulsionStrength: 0
  }
};

/**
 * Set a value by dot-notation path (up to 3 levels deep).
 * e.g. updateState("hands.left.x", 0.5)
 * Also accepts a plain object to merge at a path:
 * e.g. updateState("hands.left", { detected: true, x: 1, y: 0, z: 0 })
 */
export function updateState(path, value) {
  const keys = path.split('.');
  let target = state;

  for (let i = 0; i < keys.length - 1; i++) {
    if (target[keys[i]] === undefined) {
      console.warn(`[StateManager] Invalid path segment "${keys[i]}" in "${path}"`);
      return;
    }
    target = target[keys[i]];
  }

  const lastKey = keys[keys.length - 1];

  // If assigning a plain object, merge instead of replace (preserves extra keys like landmarks)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && typeof target[lastKey] === 'object' && target[lastKey] !== null) {
    Object.assign(target[lastKey], value);
  } else {
    target[lastKey] = value;
  }
}

/**
 * Get a value by dot-notation path.
 * e.g. getState("hands.left.detected") → false
 */
export function getState(path) {
  return path.split('.').reduce((obj, key) => obj?.[key], state);
}

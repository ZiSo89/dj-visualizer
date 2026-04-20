// src/core/EventBus.js — Singleton pub/sub event system
//
// Events used in this project:
//   'hands:update'        → { left, right }
//   'gesture:pinch'       → { hand: 'left'|'right', active: boolean }
//   'gesture:swipe'       → { direction: 'left'|'right' }
//   'audio:play'          → (no payload)
//   'audio:stop'          → (no payload)
//   'audio:volumeChange'  → { stem: string, value: number }
//   'audio:loopChange'    → (no payload) — triggered by swipe, drives camera fly-to
//   'graphics:quality'    → { level: string }

const _listeners = {};

/** Subscribe to an event. */
export function on(event, callback) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(callback);
}

/** Unsubscribe from an event. */
export function off(event, callback) {
  if (!_listeners[event]) return;
  _listeners[event] = _listeners[event].filter(cb => cb !== callback);
}

/** Publish an event synchronously to all subscribers. */
export function emit(event, data) {
  if (!_listeners[event]) return;
  for (const cb of _listeners[event]) {
    try {
      cb(data);
    } catch (err) {
      console.error(`[EventBus] Uncaught error in listener for "${event}":`, err);
    }
  }
}

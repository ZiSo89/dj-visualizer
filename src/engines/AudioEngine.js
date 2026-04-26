// src/engines/AudioEngine.js — Per-stem finger control
// ─────────────────────────────────────────────────────────────────
// All 3 stems play simultaneously.
// Left hand thumb-finger distances → per-stem Volume
// Right hand thumb-finger distances → per-stem Filter
// Cross-hand finger distances (L↔R) → per-stem Reverb
//   index=bass, middle=drums, ring=melody
//
// Tone.js is loaded as global (window.Tone) from CDN — no import needed.
// ─────────────────────────────────────────────────────────────────
import { state, updateState } from '../core/StateManager.js';
import { emit } from '../core/EventBus.js';

const AudioEngine = {
  samplesLoaded: false,
  stems: ['bass', 'drums', 'melody'],

  // Tone nodes (assigned in init)
  masterVol:    null,
  drumsVol:     null,
  bassVol:      null,
  melodyVol:    null,
  drums:        null,
  bass:         null,
  melody:       null,
  drumsFilter:  null,
  bassFilter:   null,
  melodyFilter: null,
  drumsReverb:  null,
  bassReverb:   null,
  melodyReverb: null,

  async init() {
    if (typeof Tone === 'undefined') {
      console.warn('[AudioEngine] Tone.js not found — check CDN script in index.html');
      return;
    }

    Tone.Transport.bpm.value = state.bpm;

    // ── Signal chain ──────────────────────────────────────────────
    // Compressor → Master volume (−6 dB headroom)
    this.compressor = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.003, release: 0.25 }).toDestination();
    this.masterVol = new Tone.Volume(-6).connect(this.compressor);

    // Drums → Volume → Filter → Reverb → Master
    this.drumsReverb = new Tone.Reverb({ decay: 2.5, wet: 0 }).connect(this.masterVol);
    this.drumsFilter = new Tone.Filter(15000, 'lowpass').connect(this.drumsReverb);
    this.drumsVol = new Tone.Volume(0).connect(this.drumsFilter);
    this.drums = new Tone.Player({
      url: 'assets/audio/drums.mp3',
      loop: true,
      autostart: false
    }).connect(this.drumsVol);

    // Bass → Volume → Filter → Reverb → Master
    this.bassReverb = new Tone.Reverb({ decay: 2.5, wet: 0 }).connect(this.masterVol);
    this.bassFilter = new Tone.Filter(15000, 'lowpass').connect(this.bassReverb);
    this.bassVol = new Tone.Volume(0).connect(this.bassFilter);
    this.bass = new Tone.Player({
      url: 'assets/audio/bass.mp3',
      loop: true,
      autostart: false
    }).connect(this.bassVol);

    // Melody → Volume → Filter → Reverb → Master
    this.melodyReverb = new Tone.Reverb({ decay: 2.5, wet: 0 }).connect(this.masterVol);
    this.melodyFilter = new Tone.Filter(15000, 'lowpass').connect(this.melodyReverb);
    this.melodyVol = new Tone.Volume(0).connect(this.melodyFilter);
    this.melody = new Tone.Player({
      url: 'assets/audio/melody.mp3',
      loop: true,
      autostart: false
    }).connect(this.melodyVol);

    // ── FFT analysers per stem (64 bins ≈ 344 Hz/bin) ─────────────
    this.drumsWave  = new Tone.FFT(64);
    this.bassWave   = new Tone.FFT(64);
    this.melodyWave = new Tone.FFT(64);
    this.drumsVol.connect(this.drumsWave);
    this.bassVol.connect(this.bassWave);
    this.melodyVol.connect(this.melodyWave);

    // Generate reverb impulse responses
    await this.drumsReverb.generate();
    await this.bassReverb.generate();
    await this.melodyReverb.generate();

    // Wait for all MP3s to be fetched and decoded
    await Tone.loaded();
    this.samplesLoaded = true;
    console.log('[AudioEngine] initialized — all samples loaded');
  },

  async play() {
    if (!this.samplesLoaded) return;
    await Tone.start();
    Tone.Transport.start();
    this.drums.start(0);
    this.bass.start(0);
    this.melody.start(0);
    updateState('isPlaying', true);
    emit('audio:play');
    console.log('[AudioEngine] play — all stems');
  },

  stop() {
    if (typeof Tone === 'undefined') return;
    Tone.Transport.stop();
    this.drums?.stop();
    this.bass?.stop();
    this.melody?.stop();
    updateState('isPlaying', false);
    emit('audio:stop');
    console.log('[AudioEngine] stop');
  },

  // ── Per-stem volume ────────────────────────────────────────────
  _lastVol: { drums: -1, bass: -1, melody: -1 },

  setVolume(stem, value) {
    const clamped = Math.max(0, Math.min(1, value));
    if (Math.abs(this._lastVol[stem] - clamped) < 0.015) return;
    this._lastVol[stem] = clamped;
    const db = clamped < 0.001 ? -Infinity : Tone.gainToDb(clamped);
    const node = { drums: this.drumsVol, bass: this.bassVol, melody: this.melodyVol }[stem];
    if (node) node.volume.rampTo(db, 0.08);
    updateState(`audio.${stem}Volume`, clamped);
  },

  // ── Per-stem filter ────────────────────────────────────────────
  _lastFilter: { drums: -1, bass: -1, melody: -1 },

  setStemFilter(stem, frequency) {
    const clamped = Math.max(200, Math.min(15000, frequency));
    if (Math.abs(this._lastFilter[stem] - clamped) < 30) return;
    this._lastFilter[stem] = clamped;
    const filter = { drums: this.drumsFilter, bass: this.bassFilter, melody: this.melodyFilter }[stem];
    if (filter) filter.frequency.rampTo(clamped, 0.1);
    updateState(`audio.${stem}Filter`, clamped);
  },

  // ── Per-stem reverb (wet 0–1) ──────────────────────────────────
  _lastReverb: { drums: -1, bass: -1, melody: -1 },

  setStemReverb(stem, wet) {
    const clamped = Math.max(0, Math.min(1, wet));
    if (Math.abs(this._lastReverb[stem] - clamped) < 0.02) return;
    this._lastReverb[stem] = clamped;
    const reverb = { drums: this.drumsReverb, bass: this.bassReverb, melody: this.melodyReverb }[stem];
    if (reverb) reverb.wet.rampTo(clamped, 0.1);
    updateState(`audio.${stem}Reverb`, clamped);
  },

  getWaveforms() {
    return {
      drums:  this.drumsWave?.getValue()  ?? new Float32Array(64),
      bass:   this.bassWave?.getValue()   ?? new Float32Array(64),
      melody: this.melodyWave?.getValue() ?? new Float32Array(64)
    };
  },

  triggerLoopChange() {
    if (typeof Tone === 'undefined' || !state.isPlaying) return;
    const nextBar = Tone.Transport.nextSubdivision('1m');
    Tone.Transport.scheduleOnce((time) => {
      this.drumsVol.volume.setValueAtTime(-18, time);
      this.drumsVol.volume.rampTo(0, 0.35, time + 0.05);
      emit('audio:loopChange');
    }, nextBar);
  },

  // ── Tap tempo ─────────────────────────────────────────────────
  _tapTimes: [],

  tapTempo() {
    if (typeof Tone === 'undefined') return;
    const now = Date.now();
    // Reset if more than 3 seconds since last tap
    if (this._tapTimes.length > 0 && now - this._tapTimes[this._tapTimes.length - 1] > 3000) {
      this._tapTimes = [];
    }
    this._tapTimes.push(now);
    if (this._tapTimes.length > 4) this._tapTimes.shift();
    if (this._tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < this._tapTimes.length; i++) {
        intervals.push(this._tapTimes[i] - this._tapTimes[i - 1]);
      }
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avgMs);
      const clamped = Math.max(60, Math.min(200, bpm));
      Tone.Transport.bpm.rampTo(clamped, 0.1);
      updateState('bpm', clamped);
      emit('audio:bpmChange', { bpm: clamped });
      console.log(`[AudioEngine] tap tempo → ${clamped} BPM`);
    }
  },

  update(deltaTime) {
    // Volume/filter controlled via gesture:fingers events in main.js
  },

  destroy() {
    if (typeof Tone === 'undefined') return;
    Tone.Transport.stop();
    this.drums?.dispose();
    this.bass?.dispose();
    this.melody?.dispose();
    this.drumsVol?.dispose();
    this.bassVol?.dispose();
    this.melodyVol?.dispose();
    this.drumsFilter?.dispose();
    this.bassFilter?.dispose();
    this.melodyFilter?.dispose();
    this.drumsReverb?.dispose();
    this.bassReverb?.dispose();
    this.melodyReverb?.dispose();
    this.masterVol?.dispose();
    this.compressor?.dispose();
  }
};

export default AudioEngine;

// Audio: user-uploaded MP3/WAV, Web Audio playback with volume/mute,
// autoplay-policy handling, and persistence of the last file in IndexedDB.
// Events: 'update'

const DB_NAME = 'humanTracker';
const STORE = 'audio';
const KEY = 'entrySound';

export class AudioManager extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.fileName = '';
    this.current = null;     // currently playing source
    this.volume = 0.8;
    this.muted = false;
    this.lastError = '';
    this.isBuiltin = false;
    this.builtin = null;     // {bytes, name}
    this.loop = null;        // {src, gain, start}
    this.bellTimes = []; this.voiceTimes = [];
  }

  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }
  get loaded() { return !!this.buffer; }

  _ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser.');
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this._applyGain();
      this.ctx.addEventListener('statechange', () => this._emit());
    }
    return this.ctx;
  }

  /** Must be called from a user gesture (click/keypress) to satisfy autoplay policy. */
  async unlock() {
    try {
      const ctx = this._ensureCtx();
      if (ctx.state !== 'running') await ctx.resume();
    } catch (e) { this.lastError = e.message; }
    this._emit();
    return this.unlocked;
  }

  _emit() { this.dispatchEvent(new Event('update')); }

  _applyGain() {
    if (this.gain) this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.01);
  }

  setVolume(v) { this.volume = Math.min(1, Math.max(0, v)); this._applyGain(); this._emit(); }
  setMuted(m) { this.muted = !!m; this._applyGain(); this._emit(); }

  async loadFile(file) {
    const okType = /^audio\/(mpeg|mp3|wav|x-wav|wave|vnd\.wave)$/.test(file.type) || /\.(mp3|wav)$/i.test(file.name);
    if (!okType) throw new Error('Please choose an MP3 or WAV file.');
    if (file.size > 30 * 1024 * 1024) throw new Error('File is larger than 30 MB.');
    const bytes = await file.arrayBuffer();
    await this._decode(bytes.slice(0), file.name);
    await idbPut({ name: file.name, type: file.type, bytes });
  }

  async _decode(bytes, name, builtin = false) {
    const ctx = this._ensureCtx();   // decoding works while the context is still suspended
    try {
      const wasLooping = !!this.loop;
      this.stopLoop(0);
      this.buffer = await ctx.decodeAudioData(bytes);
      this.fileName = name;
      this.isBuiltin = builtin;
      this.lastError = '';
      this._analyze();
      if (wasLooping) this.startLoop();
    } catch (e) {
      this.lastError = 'Could not decode audio file.';
      throw new Error(this.lastError);
    } finally { this._emit(); }
  }

  /** Load the sound that ships with the app (used when the user hasn't uploaded their own). */
  async loadBuiltin(url, name) {
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      this.builtin = { bytes, name };
      if (!this.buffer) await this._decode(bytes.slice(0), name, true);
    } catch (e) { console.warn('Built-in sound unavailable:', e.message); }
  }

  async restore() {
    try {
      const rec = await idbGet();
      if (rec?.bytes) await this._decode(rec.bytes, rec.name);
    } catch (e) { console.warn('No stored sound restored:', e.message); }
  }

  /** Forget the uploaded sound and go back to the built-in one. */
  async clear() {
    this.stop(); this.stopLoop(0);
    this.buffer = null; this.fileName = ''; this.isBuiltin = false;
    try { await idbDelete(); } catch { /* ignore */ }
    if (this.builtin) await this._decode(this.builtin.bytes.slice(0), this.builtin.name, true);
    this._emit();
  }

  /** Find bell-like (bright, percussive) and voice-like onsets so visuals can sync to the sound. */
  _analyze() {
    this.bellTimes = []; this.voiceTimes = [];
    const b = this.buffer; if (!b) return;
    const d = b.getChannelData(0), sr = b.sampleRate, w = Math.round(sr * 0.02);
    const rms = [], hi = [];
    for (let i = 0; i + w < d.length; i += w) {
      let s = 0, h = 0;
      for (let k = i; k < i + w; k++) { s += d[k] * d[k]; const df = d[k] - (k ? d[k - 1] : 0); h += df * df; }
      rms.push(Math.sqrt(s / w)); hi.push(Math.sqrt(h / w));
    }
    const maxR = Math.max(1e-6, ...rms), maxH = Math.max(1e-6, ...hi);
    let lastBell = -1, lastVoice = -1;
    for (let i = 1; i < rms.length - 1; i++) {
      const t = i * 0.02;
      const ratio = hi[i] / Math.max(1e-6, rms[i]);
      if (hi[i] > 0.4 * maxH && hi[i] >= hi[i - 1] && hi[i] >= hi[i + 1] && ratio > 0.6 && t - lastBell > 0.15) { this.bellTimes.push(t); lastBell = t; }
      else if (rms[i] > 0.35 * maxR && rms[i] >= rms[i - 1] && rms[i] >= rms[i + 1] && t - lastVoice > 0.4 && t - lastBell > 0.2) { this.voiceTimes.push(t); lastVoice = t; }
    }
  }

  get looping() { return !!this.loop; }

  /** Start looping the sound (used while a person is in view). */
  startLoop(fadeSec = 0.08) {
    if (!this.buffer) return { played: false, reason: 'no-file' };
    if (!this.ctx || this.ctx.state !== 'running') { this.ctx?.resume().catch(() => {}); return { played: false, reason: 'locked' }; }
    if (this.loop) {
      if (this.loop.stopping) { // cancel a fade-out in progress
        const gn = this.loop.gain.gain, now = this.ctx.currentTime;
        gn.cancelScheduledValues(now); gn.setValueAtTime(gn.value, now); gn.linearRampToValueAtTime(1, now + fadeSec);
        try { this.loop.src.stop(now + 3600); } catch { /* ignore */ }
        this.loop.stopping = false;
      }
      return { played: true };
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer; src.loop = true;
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(1, now + fadeSec);
    src.connect(gain); gain.connect(this.gain);
    src.start(now);
    const loop = { src, gain, start: now, stopping: false };
    src.onended = () => { if (this.loop === loop) this.loop = null; this._emit(); };
    this.loop = loop;
    this._emit();
    return { played: true };
  }

  stopLoop(fadeSec = 0.6) {
    const l = this.loop; if (!l) return;
    const now = this.ctx.currentTime;
    if (fadeSec <= 0) { try { l.src.stop(); } catch { /* ignore */ } this.loop = null; this._emit(); return; }
    const gn = l.gain.gain;
    gn.cancelScheduledValues(now); gn.setValueAtTime(gn.value, now); gn.linearRampToValueAtTime(0, now + fadeSec);
    try { l.src.stop(now + fadeSec + 0.05); } catch { /* ignore */ }
    l.stopping = true;
    this._emit();
  }

  /** Seconds since the most recent bell / voice onset in the looping sound, or null if not looping. */
  eventAge(kind) {
    const l = this.loop; if (!l || l.stopping || !this.buffer) return null;
    const times = kind === 'bell' ? this.bellTimes : this.voiceTimes;
    if (!times.length) return null;
    const dur = this.buffer.duration, pos = ((this.ctx.currentTime - l.start) % dur + dur) % dur;
    let best = null;
    for (const tt of times) { const age = pos >= tt ? pos - tt : pos + dur - tt; if (best === null || age < best) best = age; }
    return best;
  }

  /**
   * Play once. Returns {played:boolean, reason?:string}.
   * By default a new trigger restarts the sound instead of layering copies.
   */
  play({ allowOverlap = false } = {}) {
    if (!this.buffer) return { played: false, reason: 'no-file' };
    if (!this.ctx || this.ctx.state !== 'running') {
      // Try anyway (may succeed if the page already had a gesture); report if locked.
      this.ctx?.resume().catch(() => {});
      if (!this.ctx || this.ctx.state !== 'running') return { played: false, reason: 'locked' };
    }
    if (!allowOverlap) this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => { if (this.current === src) this.current = null; this._emit(); };
    src.start();
    this.current = src;
    this._emit();
    return { played: true };
  }

  stop() {
    try { this.current?.stop(); } catch { /* already stopped */ }
    this.current = null;
    this._emit();
  }

  get playing() { return !!this.current || (!!this.loop && !this.loop.stopping); }
}

// ---------------- IndexedDB helpers ----------------
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbTx(mode, fn) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
const idbPut = (v) => idbTx('readwrite', s => s.put(v, KEY));
const idbGet = () => idbTx('readonly', s => s.get(KEY));
const idbDelete = () => idbTx('readwrite', s => s.delete(KEY));

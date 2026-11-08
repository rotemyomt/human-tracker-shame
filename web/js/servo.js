// Servo controller: speaks the HumanTracker firmware protocol on top of SerialLink.
// Owns the browser-side motion plan (rate limiting + throttled ANGLE commands).
// Events: 'update' (any state change), 'error' {detail}, 'estop' {detail: bool}
import { clampAngle, rateLimit } from './mapping.js';

const INIT_SPEED = 60; // deg/s used for the initial move to center

export class ServoController extends EventTarget {
  constructor(link) {
    super();
    this.link = link;
    this.reset();
    this._onLine = (e) => this._parse(e.detail);
    this.link.addEventListener('line', this._onLine); // registered once for the controller's lifetime
  }

  reset() {
    this.initialized = false;
    this.initializing = false;
    this.estopped = false;
    this.hwAngle = null;      // angle firmware is currently commanding (open loop, no feedback)
    this.hwTarget = null;     // target firmware acknowledged
    this.fw = {};             // parsed READY/STATUS fields
    this.commanded = null;    // browser-side rate-limited angle
    this.desired = null;      // where the planner wants to go
    this.speed = 90;
    this.lastSent = null;
    this.lastSendTime = 0;
    this.lastTick = performance.now();
    this._arrivedWaiters = [];
    this._emit();
  }

  get usable() { return this.link.ready && this.initialized && !this.estopped; }

  _emit() { this.dispatchEvent(new Event('update')); }

  _parse(line) {
    let m;
    if ((m = line.match(/^POS:(-?[\d.]+)/))) { this.hwAngle = +m[1]; }
    else if ((m = line.match(/^ARRIVED:(-?[\d.]+)/))) {
      this.hwAngle = +m[1];
      const w = this._arrivedWaiters; this._arrivedWaiters = [];
      w.forEach(fn => fn(this.hwAngle));
    }
    else if ((m = line.match(/^OK (?:ANGLE|CENTER)=(-?[\d.]+)/))) { this.hwTarget = +m[1]; }
    else if (line.startsWith('OK STOPPED')) { this.estopped = true; this.dispatchEvent(new CustomEvent('estop', { detail: true })); }
    else if ((m = line.match(/^OK RESUMED ANGLE=(-?[\d.]+)/))) {
      this.estopped = false;
      this.hwAngle = this.commanded = this.lastSent = this.desired = +m[1];
      this.dispatchEvent(new CustomEvent('estop', { detail: false }));
    }
    else if (line.startsWith('READY') || line.startsWith('STATUS')) {
      const f = Object.fromEntries([...line.matchAll(/(\w+)=([^\s]+)/g)].map(x => [x[1], x[2]]));
      this.fw = { ...this.fw, ...f };
      if (f.ANGLE !== undefined) this.hwAngle = +f.ANGLE;
      if (f.TARGET !== undefined) this.hwTarget = +f.TARGET;
      if (f.STOPPED !== undefined) {
        const stopped = f.STOPPED === '1';
        if (stopped !== this.estopped) { this.estopped = stopped; this.dispatchEvent(new CustomEvent('estop', { detail: stopped })); }
      }
    }
    else if (line.startsWith('ERR')) {
      this.dispatchEvent(new CustomEvent('error', { detail: line }));
    }
    else if (line === 'PONG' || line.startsWith('OK')) { /* acks */ }
    this._emit();
  }

  _waitArrived(timeoutMs, expected) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._arrivedWaiters = this._arrivedWaiters.filter(f => f !== done);
        reject(new Error('Servo did not report reaching center in time.'));
      }, timeoutMs);
      const done = (a) => {
        // Ignore arrivals at other angles (e.g. a re-clamp caused by a LIMITS change).
        if (expected !== undefined && Math.abs(a - expected) > 0.6) { this._arrivedWaiters.push(done); return; }
        clearTimeout(t); resolve(a);
      };
      this._arrivedWaiters.push(done);
    });
  }

  /** Push calibration to firmware (soft limits, pulse widths, center, speed). */
  applyConfig(s, speed = s.maxSpeed) {
    if (!this.link.ready) return;
    this.link.send(`LIMITS:${s.minAngle.toFixed(1)},${s.maxAngle.toFixed(1)}`);
    this.link.send(`SETCENTER:${s.centerAngle.toFixed(1)}`);
    this.link.send(`PULSE:${Math.round(s.pulseMinUs)},${Math.round(s.pulseMaxUs)}`);
    // Firmware slews a bit faster than the browser plan so it never lags behind it.
    this.link.send(`SPEED:${Math.min(720, Math.max(s.maxSpeed, s.returnSpeed) * 1.5).toFixed(1)}`);
    if (speed === INIT_SPEED) this.link.send(`SPEED:${INIT_SPEED}`);
  }

  /** Configure firmware and move to center. Tracking must not start until this resolves. */
  async initialize(s) {
    this.initialized = false;
    this.initializing = true;
    this._emit();
    try {
      if (this.estopped) throw new Error('Firmware is in EMERGENCY STOP. Press "Resume" to re-enable the servo.');
      this.applyConfig(s, INIT_SPEED);
      const from = Number.isFinite(this.hwAngle) ? this.hwAngle : 180;
      const timeout = (Math.abs(from - s.centerAngle) / INIT_SPEED) * 1000 + 2500;
      const arrived = this._waitArrived(timeout, s.centerAngle);
      this.link.send('CENTER', { critical: false });
      await arrived;
      // Allow the physical horn to settle (the servo has no feedback; this is a time estimate).
      await new Promise(r => setTimeout(r, 300));
      this.link.send(`SPEED:${Math.min(720, Math.max(s.maxSpeed, s.returnSpeed) * 1.5).toFixed(1)}`);
      this.commanded = this.desired = this.lastSent = s.centerAngle;
      this.initialized = true;
      return true;
    } finally {
      this.initializing = false;
      this._emit();
    }
  }

  /** Planner input: where to go and how fast (deg/s). Always clamped to safe limits. */
  setDesired(angle, speed, s) {
    if (!Number.isFinite(angle)) return;
    this.desired = clampAngle(angle, s);
    this.speed = speed;
  }

  /** Call frequently (~50 Hz). Rate-limits and throttles ANGLE commands. */
  tick(s) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000); // cap: no jumps after pauses
    this.lastTick = now;
    if (!this.usable || this.desired === null) return;
    if (this.commanded === null) this.commanded = this.desired;

    this.commanded = clampAngle(rateLimit(this.commanded, this.desired, this.speed, dt), s);
    const diff = this.lastSent === null ? Infinity : Math.abs(this.commanded - this.lastSent);
    const settledFinal = this.commanded === this.desired && diff >= 0.1;
    if ((diff >= s.minStepDeg || settledFinal) && now - this.lastSendTime >= s.sendIntervalMs) {
      const a = this.commanded.toFixed(1);
      if (this.link.send(`ANGLE:${a}`)) {
        this.lastSent = +a;
        this.lastSendTime = now;
        this._emit();
      }
    }
  }

  /** Immediately jump the plan to an angle (used by manual control); still rate-limited by firmware. */
  goNow(angle, s) {
    this.desired = clampAngle(angle, s);
    this.speed = s.maxSpeed;
  }

  async emergencyStop() {
    this.desired = this.commanded;
    const ok = await this.link.emergencyStop();
    this.estopped = true; // assume stopped locally even before the ack; firmware confirms with OK STOPPED
    this.dispatchEvent(new CustomEvent('estop', { detail: true }));
    this._emit();
    return ok;
  }

  resume() {
    this.link.send('RESUME', { critical: true });
  }

  requestStatus() { this.link.send('STATUS'); }

  dispose() { this.link.removeEventListener('line', this._onLine); }
}

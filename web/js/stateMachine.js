// Tracking state machine with an explicit transition table.
export const S = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  SEARCHING: 'SEARCHING',
  PERSON_DETECTED: 'PERSON_DETECTED',
  TRACKING: 'TRACKING',
  TARGET_LOST: 'TARGET_LOST',
  STOPPED: 'STOPPED',
});

const ANY = Object.values(S);
// Allowed transitions. DISCONNECTED and STOPPED are reachable from anywhere (safety).
const TABLE = {
  [S.DISCONNECTED]: [S.INITIALIZING],
  [S.INITIALIZING]: [S.READY, S.STOPPED, S.DISCONNECTED],
  [S.READY]: [S.SEARCHING, S.PERSON_DETECTED, S.STOPPED, S.DISCONNECTED, S.INITIALIZING],
  [S.SEARCHING]: [S.PERSON_DETECTED, S.STOPPED, S.DISCONNECTED, S.INITIALIZING],
  [S.PERSON_DETECTED]: [S.TRACKING, S.TARGET_LOST, S.SEARCHING, S.STOPPED, S.DISCONNECTED],
  [S.TRACKING]: [S.TARGET_LOST, S.SEARCHING, S.PERSON_DETECTED, S.STOPPED, S.DISCONNECTED],
  [S.TARGET_LOST]: [S.TRACKING, S.SEARCHING, S.PERSON_DETECTED, S.STOPPED, S.DISCONNECTED],
  [S.STOPPED]: [S.READY, S.INITIALIZING, S.DISCONNECTED],
};

export class StateMachine extends EventTarget {
  constructor() {
    super();
    this.state = S.DISCONNECTED;
    this.since = performance.now();
    this.history = [];
  }

  can(to) { return to === this.state || (TABLE[this.state] || ANY).includes(to); }

  /** Returns true if the transition happened. Invalid transitions are logged and refused. */
  go(to, reason = '') {
    if (to === this.state) return false;
    if (!this.can(to)) {
      console.warn(`[state] refused ${this.state} -> ${to} (${reason})`);
      return false;
    }
    const from = this.state;
    this.state = to;
    this.since = performance.now();
    this.history.push({ from, to, reason, t: Date.now() });
    if (this.history.length > 50) this.history.shift();
    this.dispatchEvent(new CustomEvent('change', { detail: { from, to, reason } }));
    return true;
  }

  get elapsed() { return performance.now() - this.since; }
  is(...states) { return states.includes(this.state); }
}

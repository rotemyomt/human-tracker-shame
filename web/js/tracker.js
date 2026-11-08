// Multi-person tracker: gives detections persistent IDs across frames (MediaPipe Pose has no IDs),
// debounces entries, detects exits, and selects one primary target with hysteresis.

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

const MATCH_MAX_DIST = 0.25; // normalized center distance gate

export class PersonTracker {
  constructor() { this.reset(); }

  reset() {
    this.tracks = new Map();
    this.nextId = 1;
    this.targetId = null;
    this.manualId = null;
    this._challenger = null; // {id, since}
    this.occupied = false;
    this._lastUpdate = null;
    this._avgDt = 33;        // ms between detection frames (EMA)
  }

  /**
   * @param people detections in display coordinates
   * @param now ms timestamp
   * @param s settings
   * @returns {events: Array<{type:'enter'|'leave'|'occupied'|'empty', track?}>}
   */
  update(people, now, s) {
    const events = [];
    const tracks = [...this.tracks.values()];
    if (this._lastUpdate !== null) this._avgDt += 0.1 * ((now - this._lastUpdate) - this._avgDt);
    this._lastUpdate = now;
    // Gaps shorter than ~2.5 frames are never treated as absence, even on a slow computer.
    const frameSlack = 2.5 * this._avgDt;

    // --- greedy matching on cost = distance - IoU bonus ---
    const pairs = [];
    people.forEach((p, di) => {
      tracks.forEach((t) => {
        const dx = p.center.x - t.center.x, dy = p.center.y - t.center.y;
        const dist = Math.hypot(dx, dy);
        const ov = iou(p.bbox, t.bbox);
        if (dist < MATCH_MAX_DIST || ov > 0.2) pairs.push({ di, t, cost: dist - 0.5 * ov });
      });
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const usedDet = new Set(), usedTrack = new Set();
    for (const { di, t } of pairs) {
      if (usedDet.has(di) || usedTrack.has(t.id)) continue;
      usedDet.add(di); usedTrack.add(t.id);
      const p = people[di];
      Object.assign(t, { center: p.center, bbox: p.bbox, landmarks: p.landmarks, confidence: p.confidence, area: p.area });
      t.lastSeen = now; t.hits++; t.visible = true;
    }
    for (const t of tracks) if (!usedTrack.has(t.id)) t.visible = false;

    // --- new tracks ---
    people.forEach((p, di) => {
      if (usedDet.has(di)) return;
      const t = { id: this.nextId++, ...p, firstSeen: now, lastSeen: now, hits: 1, visible: true, confirmed: false };
      this.tracks.set(t.id, t);
    });

    // --- confirm (debounce) & expire (absence) ---
    for (const t of [...this.tracks.values()]) {
      if (!t.confirmed && t.visible && now - t.firstSeen >= s.entryDebounceMs && t.hits >= 3) {
        t.confirmed = true;
        t.confirmedAt = now;
        events.push({ type: 'enter', track: t });
      }
      const timeout = Math.max(frameSlack, t.confirmed ? s.absenceMs : Math.min(300, s.absenceMs)); // unconfirmed blips vanish fast
      if (now - t.lastSeen > timeout) {
        this.tracks.delete(t.id);
        if (t.confirmed) events.push({ type: 'leave', track: t });
      }
    }

    // --- occupancy (empty <-> occupied) ---
    const anyConfirmed = [...this.tracks.values()].some(t => t.confirmed);
    if (anyConfirmed && !this.occupied) { this.occupied = true; events.push({ type: 'occupied' }); }
    if (!anyConfirmed && this.occupied) { this.occupied = false; events.push({ type: 'empty' }); }

    this._selectTarget(now, s);
    return { events };
  }

  get confirmedTracks() { return [...this.tracks.values()].filter(t => t.confirmed); }
  get visibleCount() { return [...this.tracks.values()].filter(t => t.confirmed && t.visible).length; }
  get target() { return this.targetId !== null ? this.tracks.get(this.targetId) || null : null; }

  /** Manual selection: pick the confirmed track whose box contains (x,y), display coords. */
  selectAt(x, y) {
    const hit = this.confirmedTracks
      .filter(t => x >= t.bbox.x && x <= t.bbox.x + t.bbox.w && y >= t.bbox.y && y <= t.bbox.y + t.bbox.h)
      .sort((a, b) => a.area - b.area)[0];
    if (hit) { this.manualId = hit.id; this.targetId = hit.id; this._challenger = null; }
    return hit || null;
  }

  _score(t, mode) {
    if (mode === 'center') return 1 - Math.abs(t.center.x - 0.5) * 2; // 1 = dead center
    if (mode === 'largest') return t.area;
    return -t.firstSeen; // 'first': older = better
  }

  _selectTarget(now, s) {
    const candidates = this.confirmedTracks;
    const current = this.target;

    // Manual mode: stick to the chosen ID; if it's gone, fall back to the first-detected person.
    if (s.targetMode === 'manual' && this.manualId !== null) {
      if (this.tracks.has(this.manualId)) { this.targetId = this.manualId; return; }
      this.manualId = null;
    }

    // Keep the current target while its track exists (even if briefly unseen => TARGET_LOST).
    if (current && current.confirmed) {
      if (s.targetMode === 'center' || s.targetMode === 'largest') {
        // Hysteresis: a challenger must be clearly better, visibly, for switchHoldMs.
        const visible = candidates.filter(t => t.visible && t.id !== current.id);
        const best = visible.sort((a, b) => this._score(b, s.targetMode) - this._score(a, s.targetMode))[0];
        const cur = this._score(current, s.targetMode);
        const margin = s.targetMode === 'center' ? 0.2 : Math.abs(cur) * 0.25;
        if (best && current.visible && this._score(best, s.targetMode) > cur + margin) {
          if (!this._challenger || this._challenger.id !== best.id) this._challenger = { id: best.id, since: now };
          else if (now - this._challenger.since >= s.switchHoldMs) {
            this.targetId = best.id; this._challenger = null;
          }
        } else this._challenger = null;
      }
      return;
    }

    // No (valid) target: choose a new one among visible confirmed tracks.
    this._challenger = null;
    const visible = candidates.filter(t => t.visible);
    const mode = s.targetMode === 'manual' ? 'first' : s.targetMode;
    const pick = visible.sort((a, b) => this._score(b, mode) - this._score(a, mode))[0];
    this.targetId = pick ? pick.id : null;
  }
}

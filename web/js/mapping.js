// Pure functions: camera x-coordinate -> servo angle, plus filtering helpers.
// xNorm is the target's horizontal position in DISPLAY coordinates, 0 = left edge, 1 = right edge.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Clamp to the configured safe range (and the absolute 0–180 range). */
export function clampAngle(angle, s) {
  return clamp(clamp(angle, 0, 180), s.minAngle, s.maxAngle);
}

/**
 * Map a normalized horizontal position to a servo angle.
 * Modes:
 *  - 'fov'      Geometric: converts the pixel offset to a real bearing using the camera's
 *               horizontal field of view. Correct when the servo pivot sits at (or very near)
 *               the camera. Left edge = center - FOV/2, right edge = center + FOV/2.
 *  - 'linear'   Frame edges map to the safe limits (left edge -> min, right edge -> max).
 *               Matches the "0°/90°/180°" example; NOT geometrically meaningful.
 *  - 'twopoint' Line fitted through two recorded (x, angle) pairs. Use when the camera and
 *               servo are mounted apart. Exact only at the distance it was calibrated at.
 */
export function xToAngle(xNorm, s) {
  const x = clamp(xNorm, 0, 1);
  const c = s.centerAngle;
  let delta; // degrees from center, positive = toward the right side of the image

  if (s.mappingMode === 'twopoint' && s.twoPoint) {
    const { x1, a1, x2, a2 } = s.twoPoint;
    const raw = a1 + (x - x1) * (a2 - a1) / (x2 - x1);
    // Two-point already encodes direction; apply sensitivity around the center only.
    return clampAngle(c + (raw - c) * s.sensitivity, s);
  }

  const off = (x - 0.5) * 2; // -1 .. +1
  if (s.mappingMode === 'linear') {
    delta = off < 0 ? off * (c - s.minAngle) : off * (s.maxAngle - c);
  } else {
    const half = (s.cameraFov / 2) * Math.PI / 180;
    delta = Math.atan(off * Math.tan(half)) * 180 / Math.PI;
  }
  delta *= s.sensitivity;
  if (s.invert) delta = -delta;
  return clampAngle(c + delta, s);
}

/** Time-constant based exponential low-pass filter (frame-rate independent). */
export class LowPass {
  constructor() { this.value = null; }
  reset(v = null) { this.value = v; }
  update(x, dtSec, tauSec) {
    if (this.value === null || tauSec <= 0) { this.value = x; return x; }
    const alpha = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
    this.value += alpha * (x - this.value);
    return this.value;
  }
}

/** Dead zone with hysteresis: output only moves once the input leaves the band. */
export class DeadZone {
  constructor() { this.held = null; }
  reset(v = null) { this.held = v; }
  update(x, band) {
    if (this.held === null || Math.abs(x - this.held) > band) this.held = x;
    return this.held;
  }
}

/** Move `current` toward `target` by at most speed*dt. */
export function rateLimit(current, target, speedDegPerSec, dtSec) {
  const step = speedDegPerSec * Math.max(0, dtSec);
  const d = target - current;
  if (Math.abs(d) <= step) return target;
  return current + Math.sign(d) * step;
}

// Settings: defaults, validation and persistence (localStorage).
const STORAGE_KEY = 'humanTracker.settings.v1';

export const DEFAULTS = Object.freeze({
  // --- servo calibration (degrees) ---
  minAngle: 10,           // safe soft limit
  maxAngle: 170,          // safe soft limit
  centerAngle: 90,        // home position
  invert: false,
  mappingMode: 'fov',     // 'fov' | 'linear' | 'twopoint'
  cameraFov: 60,          // horizontal FOV of webcam in degrees (check your camera's spec)
  sensitivity: 1.0,       // gain on the offset from center
  twoPoint: null,         // {x1, a1, x2, a2} recorded during calibration
  pulseMinUs: 600,        // firmware pulse width at 0°
  pulseMaxUs: 2400,       // firmware pulse width at 180°

  // --- motion ---
  smoothing: 0.25,        // low-pass time constant in seconds (0 = off)
  deadZone: 2.0,          // degrees; ignore target changes smaller than this
  maxSpeed: 90,           // deg/s, browser-side rate limit while tracking
  returnSpeed: 20,        // deg/s when slowly returning to center
  sendIntervalMs: 50,     // min gap between ANGLE commands (20 Hz max)
  minStepDeg: 0.5,        // don't send changes smaller than this

  // --- detection ---
  modelVariant: 'lite',   // 'lite' | 'full'
  numPoses: 3,
  detectionConfidence: 0.5,
  presenceConfidence: 0.5,
  trackingConfidence: 0.5,
  minVisibility: 0.5,     // landmark visibility required to accept a person
  mirror: true,           // selfie-style display (also flips coordinates used for mapping)
  cameraId: '',

  // --- tracking / targets ---
  targetMode: 'first',    // 'first' | 'center' | 'largest' | 'manual'
  entryDebounceMs: 400,   // person must be seen this long before "entered"
  absenceMs: 1500,        // track dropped after unseen for this long (= "left")
  switchHoldMs: 1000,     // hysteresis before switching target in center/largest modes
  noPersonMode: 'return', // 'return' | 'hold'
  noPersonTimeoutMs: 3000,

  // --- audio ---
  soundEnabled: true,
  muted: false,
  volume: 0.8,
  soundTrigger: 'each',   // 'each' (each new person) | 'occupancy' (empty -> occupied)
  soundCooldownMs: 3000,  // minimum time between plays
  allowOverlap: false,
  soundWithoutHardware: true,
  soundMode: 'loop',      // 'loop' (plays while someone is in view) | 'once' (once per entry)
  soundFadeMs: 600,       // fade-out when the last person leaves

  // --- scene ---
  personInScene: true,    // cut the person out of the webcam image and place them in the street
});

export function validate(s) {
  const out = { ...DEFAULTS, ...s };
  const num = (k, lo, hi) => {
    let v = Number(out[k]);
    if (!Number.isFinite(v)) v = DEFAULTS[k];
    out[k] = Math.min(hi, Math.max(lo, v));
  };
  num('minAngle', 0, 179); num('maxAngle', 1, 180); num('centerAngle', 0, 180);
  if (out.minAngle >= out.maxAngle) { out.minAngle = DEFAULTS.minAngle; out.maxAngle = DEFAULTS.maxAngle; }
  out.centerAngle = Math.min(out.maxAngle, Math.max(out.minAngle, out.centerAngle));
  num('cameraFov', 20, 170); num('sensitivity', 0.1, 3);
  num('pulseMinUs', 400, 2500); num('pulseMaxUs', 500, 2600);
  if (out.pulseMinUs >= out.pulseMaxUs) { out.pulseMinUs = DEFAULTS.pulseMinUs; out.pulseMaxUs = DEFAULTS.pulseMaxUs; }
  num('smoothing', 0, 2); num('deadZone', 0, 20); num('maxSpeed', 5, 360); num('returnSpeed', 2, 180);
  num('sendIntervalMs', 20, 500); num('minStepDeg', 0.1, 5);
  num('numPoses', 1, 5); num('detectionConfidence', 0.1, 0.95); num('presenceConfidence', 0.1, 0.95);
  num('trackingConfidence', 0.1, 0.95); num('minVisibility', 0, 0.95);
  num('entryDebounceMs', 0, 5000); num('absenceMs', 200, 20000); num('switchHoldMs', 0, 10000);
  num('noPersonTimeoutMs', 0, 60000); num('volume', 0, 1); num('soundCooldownMs', 0, 120000);
  if (!['fov', 'linear', 'twopoint'].includes(out.mappingMode)) out.mappingMode = 'fov';
  if (out.mappingMode === 'twopoint' && !validTwoPoint(out.twoPoint)) out.mappingMode = 'fov';
  if (!['first', 'center', 'largest', 'manual'].includes(out.targetMode)) out.targetMode = 'first';
  if (!['return', 'hold'].includes(out.noPersonMode)) out.noPersonMode = 'return';
  if (!['each', 'occupancy'].includes(out.soundTrigger)) out.soundTrigger = 'each';
  if (!['lite', 'full'].includes(out.modelVariant)) out.modelVariant = 'lite';
  if (!['loop', 'once'].includes(out.soundMode)) out.soundMode = 'loop';
  num('soundFadeMs', 0, 5000);
  out.personInScene = out.personInScene !== false;
  out.numPoses = Math.round(out.numPoses);
  return out;
}

export function validTwoPoint(tp) {
  return !!tp && [tp.x1, tp.a1, tp.x2, tp.a2].every(Number.isFinite) && Math.abs(tp.x2 - tp.x1) >= 0.1;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return validate(raw ? JSON.parse(raw) : {});
  } catch {
    return validate({});
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  return validate({});
}

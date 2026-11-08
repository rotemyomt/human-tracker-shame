// App orchestration: wires camera -> detector -> tracker -> planner -> servo, audio events and UI.
import { loadSettings, saveSettings, resetSettings, validate, validTwoPoint, DEFAULTS } from './settings.js';
import { SerialLink } from './serial.js';
import { ServoController } from './servo.js';
import { Camera } from './camera.js';
import { PoseDetector, mirrorPerson } from './detector.js';
import { PersonTracker } from './tracker.js';
import { AudioManager } from './audio.js';
import { StateMachine, S } from './stateMachine.js';
import { Overlay } from './overlay.js';
import { xToAngle, LowPass, DeadZone, clampAngle } from './mapping.js';
import { Scene } from './scene.js';

const BUILTIN_SOUND = window.HT_BUILTIN_SOUND || 'media/presence.mp4';
const BUILTIN_SOUND_NAME = 'Ding ding (built-in)';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ singletons
let settings = loadSettings();
const link = new SerialLink();
const servo = new ServoController(link);
const camera = new Camera($('video'));
const detector = new PoseDetector();
const tracker = new PersonTracker();
const audio = new AudioManager();
const fsm = new StateMachine();
const overlay = new Overlay($('overlay'));
let scene = null;
try { scene = new Scene($('scene')); } catch (e) { console.error('Scene failed to start', e); }

const app = {
  autoTrack: true,          // tracking enabled (not persisted: always on at startup per spec)
  cameraOn: false,
  lastTargetId: null,
  trackedId: null,
  lastPersonSeen: 0,        // last time a target was visible
  lastSoundAt: -Infinity,
  aimX: null,
  aimFilter: new LowPass(),
  dead: new DeadZone(),
  lastFrameTs: performance.now(),
  fps: 0, fpsCount: 0, fpsT0: performance.now(),
  detectorError: '',
  twoPointDraft: {},
  presence: false,          // someone is in view (debounced)
  scenePeople: [],
};

// ------------------------------------------------------------------ logging
function log(text, cls = 'ev') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  el.appendChild(line);
  while (el.childElementCount > 300) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}
link.addEventListener('log', (e) => {
  const { dir, text } = e.detail;
  const noisy = /^(ANGLE:|POS:|OK ANGLE=|PING|PONG|STATUS)/.test(text);
  if (noisy && !$('logTraffic').checked) return;
  log(`${dir === 'tx' ? '→' : '←'} ${text}`, dir);
});

function banner(text, kind = 'warn') {
  const b = $('banner');
  if (!text) { b.hidden = true; return; }
  $('bannerText').textContent = text;
  b.className = `banner ${kind === 'error' ? 'is-error' : kind === 'ok' ? 'is-ok' : ''}`;
  b.hidden = false;
}
$('bannerClose').addEventListener('click', () => banner(''));

function chip(id, level, text) {
  const c = $(id);
  c.dataset.level = level;
  c.querySelector('span').textContent = text;
  c.title = text;
}

// ------------------------------------------------------------------ settings binding
const servoKeys = new Set(['minAngle', 'maxAngle', 'centerAngle', 'pulseMinUs', 'pulseMaxUs', 'maxSpeed', 'returnSpeed']);
const detKeys = new Set(['numPoses', 'detectionConfidence', 'presenceConfidence', 'trackingConfidence']);
let servoCfgTimer = null, detCfgTimer = null;

function renderSettings() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const k = el.dataset.setting, v = settings[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el || el.type === 'range') el.value = v;
  });
  document.querySelectorAll('output[data-for]').forEach((o) => {
    const v = settings[o.dataset.for];
    o.textContent = o.dataset.format === 'pct' ? `${Math.round(v * 100)}%` : (Number.isInteger(v) ? v : (+v).toFixed(2));
  });
  $('centerLbl').textContent = settings.centerAngle;
  $('manual').min = settings.minAngle; $('manual').max = settings.maxAngle;
  $('stage').classList.toggle('mirrored', settings.mirror);
  $('stage').classList.toggle('manual', settings.targetMode === 'manual');
  $('manualHint').hidden = settings.targetMode !== 'manual';
  drawGaugeSafeZone();
  renderTwoPoint();
}

function onSettingChanged(key, raw, el) {
  const prev = settings;
  const next = { ...settings, [key]: raw };
  settings = validate(next);
  if (settings[key] !== next[key] && el && el.type !== 'checkbox') {
    log(`Setting ${key} adjusted to ${settings[key]} (out of range or conflicting with other limits)`, 'er');
  }
  saveSettings(settings);
  renderSettings();

  if (servoKeys.has(key) && link.ready) {
    clearTimeout(servoCfgTimer);
    servoCfgTimer = setTimeout(() => servo.applyConfig(settings), 300);
  }
  if (detKeys.has(key) && detector.ready) {
    clearTimeout(detCfgTimer);
    detCfgTimer = setTimeout(() => detector.updateOptions(settings).catch(e => log(`MediaPipe options: ${e.message}`, 'er')), 300);
  }
  if ((key === 'modelVariant' && prev.modelVariant !== settings.modelVariant) || (key === 'personInScene' && prev.personInScene !== settings.personInScene)) reloadDetector();
  if (['soundMode', 'soundEnabled'].includes(key)) syncPresenceSound();
  if (key === 'volume') audio.setVolume(settings.volume);
  if (key === 'mirror' && prev.mirror !== settings.mirror) { tracker.reset(); resetAim(); }
  if (key === 'targetMode') tracker.manualId = null;
  if (['mappingMode', 'invert', 'cameraFov', 'sensitivity', 'centerAngle'].includes(key)) app.dead.reset();
}

document.querySelectorAll('[data-setting]').forEach((el) => {
  const evt = (el.type === 'range' || el.type === 'checkbox' || el.tagName === 'SELECT') ? 'input' : 'change';
  el.addEventListener(evt, () => {
    const k = el.dataset.setting;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'number') v = Number(v);
    onSettingChanged(k, v, el);
  });
});

$('btnResetSettings').addEventListener('click', () => {
  if (!confirm('Reset all settings (including calibration) to defaults?')) return;
  settings = resetSettings();
  renderSettings();
  if (link.ready) servo.applyConfig(settings);
  log('Settings reset to defaults');
});

// ------------------------------------------------------------------ gauge
function polar(angle, r) { // 0° = left, 180° = right (matches the manual slider)
  const th = Math.PI - (angle * Math.PI) / 180;
  return [110 + r * Math.cos(th), 110 - r * Math.sin(th)];
}
(function buildTicks() {
  const g = $('gaugeTicks');
  let html = '';
  for (let a = 0; a <= 180; a += 15) {
    const [x1, y1] = polar(a, 98), [x2, y2] = polar(a, a % 45 === 0 ? 88 : 93);
    html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    if (a % 45 === 0) { const [tx, ty] = polar(a, 76); html += `<text x="${tx}" y="${ty + 3}">${a}</text>`; }
  }
  g.innerHTML = html;
})();
function drawGaugeSafeZone() {
  const [x0, y0] = polar(settings.minAngle, 90), [x1, y1] = polar(settings.maxAngle, 90);
  const large = settings.maxAngle - settings.minAngle > 180 ? 1 : 0;
  $('gaugeSafe').setAttribute('d', `M${x0} ${y0} A90 90 0 ${large} 1 ${x1} ${y1}`);
}
function setNeedle(id, angle) {
  const el = $(id);
  if (!Number.isFinite(angle)) { el.style.opacity = 0; return; }
  el.style.opacity = 1;
  el.style.transform = `rotate(${angle - 90}deg)`;
}

// ------------------------------------------------------------------ UI refresh
function fmtA(a) { return Number.isFinite(a) ? `${a.toFixed(1)}°` : '—'; }

function refreshUI() {
  // camera
  if (!Camera.isSupported()) chip('stCamera', 'err', 'getUserMedia unsupported');
  else if (app.cameraOn) chip('stCamera', 'ok', camera.label || 'Live');
  // mediapipe
  if (app.detectorError) chip('stMediapipe', 'err', app.detectorError);
  else if (detector.loading) chip('stMediapipe', 'busy', 'Loading…');
  else if (detector.ready) chip('stMediapipe', 'ok', `Pose ${settings.modelVariant} · ${detector.delegate}`);
  // arduino
  if (!SerialLink.isSupported()) chip('stArduino', 'err', 'Web Serial unsupported');
  else if (link.ready) chip('stArduino', 'ok', 'Connected');
  else if (link.connected) chip('stArduino', 'busy', 'Handshaking…');
  else chip('stArduino', '', 'Not connected');
  // servo
  if (servo.estopped) chip('stServo', 'err', 'EMERGENCY STOP');
  else if (servo.initializing) chip('stServo', 'busy', 'Centering…');
  else if (servo.initialized && link.ready) chip('stServo', 'ok', `${fmtA(servo.hwAngle)}`);
  else chip('stServo', '', 'Not initialized');
  // audio
  const hd = $('hwDot');
  if (servo.estopped) { hd.dataset.level = 'err'; hd.title = 'Emergency stop'; }
  else if (link.ready) { hd.dataset.level = 'ok'; hd.title = 'Arduino connected'; }
  else { hd.dataset.level = 'warn'; hd.title = 'Arduino not connected'; }
  if (!audio.loaded) chip('stAudio', 'warn', 'No sound loaded');
  else if (!audio.unlocked) chip('stAudio', 'warn', 'Click page to enable');
  else if (!settings.soundEnabled) chip('stAudio', '', 'Disabled');
  else if (audio.muted) chip('stAudio', 'warn', 'Muted');
  else chip('stAudio', 'ok', audio.playing ? 'Playing' : 'Ready');

  // connection panel
  $('btnConnect').disabled = !SerialLink.isSupported() || link.connected;
  $('btnDisconnect').disabled = !link.connected;
  const pi = link.portInfo;
  $('portInfo').textContent = link.connected
    ? (pi?.usbVendorId ? `USB VID 0x${pi.usbVendorId.toString(16).padStart(4, '0')} PID 0x${(pi.usbProductId || 0).toString(16).padStart(4, '0')}` : 'Open') + ' @ 115200'
    : 'Not connected';
  $('fwInfo').textContent = link.ready ? (servo.fw.FW ? `v${servo.fw.FW} · pin D${servo.fw.PIN}` : link.firmwareInfo) : '—';
  $('linkInfo').textContent = link.ready ? `OK · last reply ${Math.round(performance.now() - link.lastRx)} ms ago` : '—';

  // servo panel
  setNeedle('needleCur', servo.hwAngle);
  setNeedle('needleTgt', servo.desired);
  $('angCur').textContent = fmtA(servo.hwAngle);
  $('angTgt').textContent = fmtA(servo.desired);
  $('angSent').textContent = fmtA(servo.lastSent);
  $('autoTrack').checked = app.autoTrack;
  $('estopBanner').hidden = !servo.estopped;
  ['btnCenter', 'btnTestMin', 'btnTestMax', 'btnTestCenter', 'manual'].forEach(id => { $(id).disabled = !servo.usable; });
  $('btnStart').disabled = app.autoTrack && !servo.estopped;
  $('btnStopTrack').disabled = !app.autoTrack;

  // audio panel
  $('btnPreview').disabled = !audio.loaded;
  $('btnStopSound').disabled = !audio.playing;
  $('btnClearSound').disabled = !audio.loaded;
  $('btnMute').setAttribute('aria-pressed', String(audio.muted));
  $('btnMute').textContent = audio.muted ? 'Unmute' : 'Mute';
  const st = $('audioStatus');
  if (audio.loaded) {
    st.textContent = `Loaded: ${audio.fileName} (${audio.buffer.duration.toFixed(1)} s)` + (audio.unlocked ? '' : ' — click anywhere on the page to allow playback');
    st.className = `audio-status ${audio.unlocked ? 'ok' : 'warn'}`;
  } else {
    st.textContent = audio.lastError || 'No sound loaded — upload an MP3 or WAV.';
    st.className = 'audio-status';
  }

  $('statePill').textContent = fsm.state.replaceAll('_', ' ');
  $('statePill').dataset.state = fsm.state;
}
audio.addEventListener('update', refreshUI);
fsm.addEventListener('change', (e) => log(`State ${e.detail.from} → ${e.detail.to}${e.detail.reason ? ` (${e.detail.reason})` : ''}`));

// ------------------------------------------------------------------ camera
async function startCamera(deviceId = settings.cameraId) {
  $('camPlaceholder').hidden = false;
  $('camPlaceholder').textContent = 'Requesting camera permission…';
  chip('stCamera', 'busy', 'Requesting…');
  try {
    const st = await camera.start(deviceId);
    app.cameraOn = true;
    $('camPlaceholder').hidden = true;
    $('stage').style.aspectRatio = `${$('video').videoWidth} / ${$('video').videoHeight}`;
    overlay.resize($('video').videoWidth, $('video').videoHeight);
    camera.label = `${st.width || $('video').videoWidth}×${st.height || $('video').videoHeight}`;
    await populateCameras();
    log(`Camera started ${camera.label}`);
  } catch (e) {
    app.cameraOn = false;
    chip('stCamera', 'err', e.message);
    $('camPlaceholder').textContent = e.message;
    log(e.message, 'er');
  }
  refreshUI();
}
camera.onEnded = () => {
  app.cameraOn = false;
  chip('stCamera', 'err', 'Camera stopped');
  banner('The camera stream ended (unplugged or taken by another app). Choose a camera to restart.', 'error');
  tracker.reset();
};
async function populateCameras() {
  try {
    const list = await camera.listDevices();
    const sel = $('cameraSelect');
    sel.innerHTML = '';
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === camera.deviceId) o.selected = true;
      sel.appendChild(o);
    });
  } catch { /* ignore */ }
}
$('cameraSelect').addEventListener('change', async (e) => {
  settings = validate({ ...settings, cameraId: e.target.value });
  saveSettings(settings);
  tracker.reset(); resetAim();
  await startCamera(e.target.value);
});
navigator.mediaDevices?.addEventListener?.('devicechange', populateCameras);

// ------------------------------------------------------------------ detector
async function loadDetector() {
  app.detectorError = '';
  refreshUI();
  try {
    const d = await detector.load(settings, (msg) => { $('hudDet').textContent = `Detection: ${msg}`; chip('stMediapipe', 'busy', msg); });
    overlay.connections = detector.connections;
    log(`MediaPipe Pose Landmarker ready (${d})`);
  } catch (e) {
    app.detectorError = 'Failed to load';
    const msg = `MediaPipe failed to load: ${e.message || e}. Check your internet connection (the library and model are fetched from cdn.jsdelivr.net and storage.googleapis.com), then reload.`;
    banner(msg, 'error');
    log(msg, 'er');
    $('hudDet').textContent = 'Detection: unavailable';
  }
  refreshUI();
}
async function reloadDetector() { detector.close(); tracker.reset(); resetAim(); await loadDetector(); }

// ------------------------------------------------------------------ Arduino
$('btnConnect').addEventListener('click', () => { audio.unlock(); connectArduino(null); });

let connecting = false;
async function connectArduino(port) {
  if (connecting || link.connected) return;
  connecting = true;
  banner('');
  try {
    servo.reset();
    fsm.go(S.INITIALIZING, 'port opening');
    refreshUI();
    await link.connect(port);
    log(`Firmware: ${link.firmwareInfo}`);
    await initializeServo();
  } catch (e) {
    if (e.name === 'NotFoundError') { log('No port selected'); }
    else { banner(`Arduino: ${e.message}`, 'error'); log(e.message, 'er'); }
    if (link.connected && !link.ready) await link.disconnect('handshake failed');
    if (!link.connected) fsm.go(S.DISCONNECTED, 'connect failed');
  } finally { connecting = false; }
  refreshUI();
}

/** Reconnect without a prompt to a port this page was already allowed to use. */
async function autoConnect() {
  try {
    const port = await SerialLink.findKnownPort();
    if (port && !link.connected) { log('Reconnecting to the previously used Arduino…'); await connectArduino(port); }
  } catch (e) { console.warn('auto-connect', e); }
}
if (SerialLink.isSupported()) navigator.serial.addEventListener('connect', () => setTimeout(autoConnect, 1500));

async function initializeServo() {
  if (servo.estopped) {
    fsm.go(S.STOPPED, 'firmware is in emergency stop');
    banner('The Arduino reports EMERGENCY STOP is latched. Press "Resume servo" when it is safe.', 'error');
    return false;
  }
  fsm.go(S.INITIALIZING, 'moving to center');
  resetAim();
  try {
    await servo.initialize(settings);
    log(`Servo centered at ${settings.centerAngle}°`);
    fsm.go(S.READY, 'servo at center');
    banner('Arduino connected and servo centered. Tracking is active.', 'ok');
    setTimeout(() => { if (!$('banner').classList.contains('is-error')) banner(''); }, 3000);
    return true;
  } catch (e) {
    banner(`Servo initialization failed: ${e.message}`, 'error');
    log(e.message, 'er');
    fsm.go(S.STOPPED, 'init failed');
    return false;
  }
}

$('btnDisconnect').addEventListener('click', async () => {
  await link.disconnect('user');
});
link.addEventListener('lost', (e) => {
  banner(`⚠ Arduino connection lost: ${e.detail} Servo commands have stopped; the servo is NOT tracking. Reconnect to continue.`, 'error');
  log(`Link lost: ${e.detail}`, 'er');
});
link.addEventListener('closed', (e) => {
  servo.reset();
  fsm.go(S.DISCONNECTED, `port closed: ${e.detail}`);
  refreshUI();
});
servo.addEventListener('error', (e) => log(`Firmware: ${e.detail}`, 'er'));
servo.addEventListener('estop', async (e) => {
  if (e.detail) { fsm.go(S.STOPPED, 'emergency stop'); }
  else if (link.ready) {
    log('Servo resumed');
    if (!servo.initialized) await initializeServo();
    else fsm.go(S.READY, 'resumed');
  }
  refreshUI();
});

// ------------------------------------------------------------------ system controls
function setAutoTrack(on, reason) {
  app.autoTrack = on;
  if (on) { resetAim(); app.lastPersonSeen = performance.now(); }
  log(`Auto tracking ${on ? 'ON' : 'OFF'}${reason ? ` (${reason})` : ''}`);
  refreshUI();
}
$('btnStart').addEventListener('click', async () => {
  audio.unlock();
  if (servo.estopped) { banner('Release the emergency stop first ("Resume servo").', 'error'); return; }
  setAutoTrack(true, 'start button');
  if (link.ready && !servo.initialized && !servo.initializing) await initializeServo();
});
$('btnStopTrack').addEventListener('click', () => setAutoTrack(false, 'stop button'));
$('autoTrack').addEventListener('change', (e) => setAutoTrack(e.target.checked, 'toggle'));
$('btnResetCenter').addEventListener('click', () => {
  setAutoTrack(false, 'reset to center');
  tracker.reset(); resetAim();
  if (servo.usable) servo.goNow(settings.centerAngle, settings);
});
async function emergencyStop() {
  setAutoTrack(false, 'EMERGENCY STOP');
  audio.stop(); audio.stopLoop(0);
  if (link.connected) await servo.emergencyStop();
  fsm.go(S.STOPPED, 'emergency stop');
  log('EMERGENCY STOP sent', 'er');
  refreshUI();
}
$('btnEstop').addEventListener('click', emergencyStop);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isSettingsOpen()) { closeSettings(); return; }   // Esc closes the settings window first
  emergencyStop();
});
$('btnResume').addEventListener('click', () => {
  if (!link.ready) { servo.estopped = false; refreshUI(); return; }
  servo.resume();
});

// manual servo control (turns auto tracking off so the two never fight)
$('manual').addEventListener('input', (e) => {
  const a = Number(e.target.value);
  $('manualOut').textContent = `${a}°`;
  if (app.autoTrack) setAutoTrack(false, 'manual control');
  if (servo.usable) servo.goNow(a, settings);
});
function manualGo(a) {
  if (app.autoTrack) setAutoTrack(false, 'manual control');
  a = clampAngle(a, settings);
  $('manual').value = a; $('manualOut').textContent = `${a}°`;
  if (servo.usable) servo.goNow(a, settings);
}
$('btnCenter').addEventListener('click', () => manualGo(settings.centerAngle));
$('btnTestMin').addEventListener('click', () => manualGo(settings.minAngle));
$('btnTestMax').addEventListener('click', () => manualGo(settings.maxAngle));
$('btnTestCenter').addEventListener('click', () => manualGo(settings.centerAngle));
$('btnSaveFw').addEventListener('click', () => {
  if (!link.ready) { banner('Connect the Arduino first.', 'error'); return; }
  servo.applyConfig(settings);
  link.send('SAVE');
  log('Calibration sent and saved to EEPROM');
});

// two-point calibration
function recordPoint(which) {
  const t = tracker.target;
  if (!t || !t.visible || !Number.isFinite(app.aimX)) { banner('Stand in view so you are detected as the target, then record.', 'error'); return; }
  if (!Number.isFinite(servo.desired)) { banner('Connect the Arduino and aim the servo with the manual slider first.', 'error'); return; }
  app.twoPointDraft[which] = { x: app.aimX, a: servo.desired };
  log(`Two-point ${which}: x=${app.aimX.toFixed(3)} angle=${servo.desired.toFixed(1)}°`);
  const { A, B } = app.twoPointDraft;
  if (A && B) {
    const tp = { x1: A.x, a1: A.a, x2: B.x, a2: B.a };
    if (!validTwoPoint(tp)) { banner('Points A and B are too close horizontally — stand further apart (at least 10% of the frame).', 'error'); return; }
    settings = validate({ ...settings, twoPoint: tp, mappingMode: 'twopoint' });
    saveSettings(settings);
    app.twoPointDraft = {};
    banner('Two-point calibration saved and enabled.', 'ok');
  }
  renderSettings();
}
function renderTwoPoint() {
  const tp = settings.twoPoint, d = app.twoPointDraft;
  let s = tp ? `Saved: x=${tp.x1.toFixed(2)}→${tp.a1.toFixed(1)}°, x=${tp.x2.toFixed(2)}→${tp.a2.toFixed(1)}°` : 'No points saved.';
  if (d.A || d.B) s += `  Draft: ${d.A ? 'A ✓' : 'A –'} ${d.B ? 'B ✓' : 'B –'}`;
  $('tpInfo').textContent = s;
}
$('btnRecA').addEventListener('click', () => recordPoint('A'));
$('btnRecB').addEventListener('click', () => recordPoint('B'));
$('btnClearTp').addEventListener('click', () => {
  app.twoPointDraft = {};
  settings = validate({ ...settings, twoPoint: null, mappingMode: settings.mappingMode === 'twopoint' ? 'fov' : settings.mappingMode });
  saveSettings(settings); renderSettings();
});

// manual target selection by clicking the overlay
$('overlay').addEventListener('click', (e) => {
  if (settings.targetMode !== 'manual') return;
  const r = $('overlay').getBoundingClientRect();
  // account for object-fit: contain letterboxing
  const vw = $('overlay').width, vh = $('overlay').height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const ox = (r.width - vw * scale) / 2, oy = (r.height - vh * scale) / 2;
  const x = (e.clientX - r.left - ox) / (vw * scale), y = (e.clientY - r.top - oy) / (vh * scale);
  const hit = tracker.selectAt(x, y);
  log(hit ? `Manual target → person #${hit.id}` : 'No person at that point');
});

// ------------------------------------------------------------------ audio UI
$('audioFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  await audio.unlock();
  try { await audio.loadFile(f); log(`Sound loaded: ${f.name}`); }
  catch (err) { banner(err.message, 'error'); log(err.message, 'er'); }
  refreshUI();
});
$('btnPreview').addEventListener('click', async () => {
  await audio.unlock();
  const r = audio.play({ allowOverlap: settings.allowOverlap });
  if (!r.played) banner(r.reason === 'locked' ? 'Audio is blocked by the browser. Click the page and try again.' : 'No sound loaded.', 'error');
});
$('btnStopSound').addEventListener('click', () => audio.stop());
$('btnMute').addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  onSettingChanged('muted', audio.muted);
});
$('btnClearSound').addEventListener('click', async () => { await audio.clear(); log('Restored the built-in sound'); });
// Any interaction unlocks audio (autoplay policy). Registered once.
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (!audio.unlocked) audio.unlock(); }, { passive: true }));

/** Loop mode: start/stop the sound with presence. Called on changes and periodically. */
function syncPresenceSound() {
  const want = app.presence && settings.soundMode === 'loop' && settings.soundEnabled && !servo.estopped &&
    (servo.usable || settings.soundWithoutHardware);
  if (want && !audio.looping) {
    const r = audio.startLoop();
    if (r.played) log('♪ Sound looping (person in view)');
    else if (r.reason === 'locked' && !app.lockWarned) { app.lockWarned = true; log('Sound blocked: click the page once to allow audio', 'er'); }
  } else if (want && audio.loop?.stopping) {
    audio.startLoop();
  } else if (!want && audio.looping && !audio.loop.stopping) {
    audio.stopLoop(settings.soundFadeMs / 1000);
    log('Sound fading out');
  }
}
setInterval(syncPresenceSound, 250);

function triggerSound(reason) {
  if (settings.soundMode !== 'once') return;
  if (!settings.soundEnabled) return;
  if (!app.autoTrack || servo.estopped) return;
  if (!servo.usable && !settings.soundWithoutHardware) return;
  const now = performance.now();
  if (now - app.lastSoundAt < settings.soundCooldownMs) { log(`Sound suppressed by cooldown (${reason})`); return; }
  const r = audio.play({ allowOverlap: settings.allowOverlap });
  if (r.played) { app.lastSoundAt = now; log(`♪ Sound played (${reason})`); }
  else if (r.reason === 'locked') log('Sound blocked: browser needs a click on the page first', 'er');
  else if (r.reason === 'no-file') log('Person entered, but no sound is loaded');
}

// ------------------------------------------------------------------ main loop
function resetAim() { app.aimFilter.reset(); app.dead.reset(); app.aimX = null; }

function frame() {
  requestAnimationFrame(frame);
  if (!app.cameraOn || !detector.ready) { stepState(null); return; }

  let people, masks = [];
  try {
    const res = detector.detect($('video'), settings.minVisibility);
    people = res ? res.people : null;
    if (res) masks = res.masks;
  } catch (e) {
    if (!app.detectorError) log(`Detection error: ${e.message}`, 'er');
    app.detectorError = 'Runtime error';
    return;
  }
  if (people === null) return; // same video frame as last time
  if (app.detectorError === 'Runtime error') app.detectorError = '';

  const now = performance.now();
  const dt = (now - app.lastFrameTs) / 1000;
  app.lastFrameTs = now;
  app.fpsCount++;
  if (now - app.fpsT0 >= 1000) { app.fps = app.fpsCount * 1000 / (now - app.fpsT0); app.fpsCount = 0; app.fpsT0 = now; }

  const disp = settings.mirror ? people.map(mirrorPerson) : people;
  const { events } = tracker.update(disp, now, settings);
  if (scene && settings.personInScene) {
    scene.updateCutout($('video'), masks, settings.mirror);
    app.scenePeople = tracker.confirmedTracks.filter(tr => tr.visible).map(tr => ({ id: tr.id, center: tr.center, bbox: tr.bbox, landmarks: tr.landmarks }));
  } else app.scenePeople = [];

  // --- entry / exit events -> sound ---
  for (const ev of events) {
    if (ev.type === 'enter') {
      log(`Person entered (#${ev.track.id})`);
      if (settings.soundTrigger === 'each') triggerSound(`person #${ev.track.id} entered`);
    } else if (ev.type === 'leave') log(`Person left (#${ev.track.id})`);
    else if (ev.type === 'occupied') { log('Frame occupied'); app.presence = true; syncPresenceSound(); if (settings.soundTrigger === 'occupancy') triggerSound('frame occupied'); }
    else if (ev.type === 'empty') { log('Frame empty'); app.presence = false; syncPresenceSound(); }
  }

  // --- aim point (only from real detections) ---
  const t = tracker.target;
  if (t && t.id !== app.lastTargetId) {
    log(`Target → person #${t.id}`);
    app.dead.reset();
  }
  app.lastTargetId = t ? t.id : null;
  if (t && t.visible) {
    app.aimX = app.aimFilter.update(t.center.x, dt, settings.smoothing);
    app.lastPersonSeen = now;
  } else if (!t) {
    app.aimX = null;
  }

  stepState(t);

  overlay.resize($('video').videoWidth, $('video').videoHeight);
  overlay.draw({
    tracks: [...tracker.tracks.values()],
    targetId: t ? t.id : null,
    targetLost: !!t && !t.visible,
    aimX: app.aimX,
    showSkeleton: $('showSkeleton').checked,
  });

  // HUD
  $('hudCount').textContent = tracker.visibleCount;
  $('hudTarget').textContent = t ? `#${t.id}${t.visible ? '' : ' (lost)'}` : '—';
  $('hudConf').textContent = t ? `${Math.round(t.confidence * 100)}%` : '—';
  $('hudFps').textContent = app.fps ? app.fps.toFixed(0) : '—';
  $('hudDet').textContent = `Detection: running · ${people.length} raw pose${people.length === 1 ? '' : 's'}`;
}

/** State machine + motion planning. Called every detection frame (or idle frame). */
function stepState(t) {
  const now = performance.now();
  if (!link.ready) { if (!link.connected) fsm.go(S.DISCONNECTED, 'no Arduino'); return; }
  if (servo.initializing) return;                       // stay in INITIALIZING
  if (!servo.initialized) return;                       // waiting for (re)initialization
  if (servo.estopped || !app.autoTrack) {
    if (fsm.state !== S.STOPPED) fsm.go(S.STOPPED, servo.estopped ? 'emergency stop' : 'tracking disabled');
    return;
  }
  if (fsm.state === S.STOPPED) fsm.go(S.READY, 'tracking enabled');
  if (!app.cameraOn || !detector.ready) { if (fsm.state !== S.READY) fsm.go(S.READY, 'waiting for camera/detector'); return; }

  if (t && t.visible && Number.isFinite(app.aimX)) {
    if (fsm.is(S.READY, S.SEARCHING)) fsm.go(S.PERSON_DETECTED, `person #${t.id}`);
    else if (fsm.is(S.PERSON_DETECTED) && fsm.elapsed > 250) fsm.go(S.TRACKING, `following #${t.id}`);
    else if (fsm.is(S.TARGET_LOST)) {
      if (t.id === app.trackedId) fsm.go(S.TRACKING, `reacquired #${t.id}`);
      else fsm.go(S.PERSON_DETECTED, `new target #${t.id}`);
    }
    app.trackedId = t.id;
    const raw = xToAngle(app.aimX, settings);
    const angle = app.dead.update(raw, settings.deadZone);
    servo.setDesired(angle, settings.maxSpeed, settings);
  } else if (t && !t.visible) {
    if (fsm.is(S.TRACKING, S.PERSON_DETECTED)) fsm.go(S.TARGET_LOST, `#${t.id} not visible`);
    // hold position while the track might come back (absence interval)
  } else {
    if (!fsm.is(S.SEARCHING)) {
      if (fsm.is(S.READY)) fsm.go(S.SEARCHING, 'no person');
      else fsm.go(S.SEARCHING, 'nobody in frame');
    }
    if (settings.noPersonMode === 'return' && now - app.lastPersonSeen >= settings.noPersonTimeoutMs) {
      if (servo.desired !== settings.centerAngle) servo.setDesired(settings.centerAngle, settings.returnSpeed, settings);
      app.dead.reset(settings.centerAngle);
    }
  }
}

// ------------------------------------------------------------------ scene + settings window
function sceneLoop() {
  requestAnimationFrame(sceneLoop);
  if (!scene) return;
  const active = app.presence && !servo.estopped;
  scene.render({
    active,
    bellAge: audio.eventAge('bell'),
    voiceAge: audio.eventAge('voice'),
    people: settings.personInScene ? app.scenePeople : [],
  });
}
function isSettingsOpen() { return $('settingsModal').classList.contains('open'); }
function openSettings() { $('settingsModal').classList.add('open'); $('settingsModal').setAttribute('aria-hidden', 'false'); $('btnCloseSettings').focus(); }
function closeSettings() { $('settingsModal').classList.remove('open'); $('settingsModal').setAttribute('aria-hidden', 'true'); $('btnSettings').focus(); }
$('btnSettings').addEventListener('click', (e) => { e.stopPropagation(); isSettingsOpen() ? closeSettings() : openSettings(); });
$('btnCloseSettings').addEventListener('click', closeSettings);
$('modalBackdrop').addEventListener('click', closeSettings);
$('intro').addEventListener('click', async () => {
  $('intro').classList.add('gone');
  await audio.unlock();
  syncPresenceSound();
});

// Servo motion runs on its own timer so rate limiting continues between video frames.
setInterval(() => { if (link.ready) servo.tick(settings); }, 20);
setInterval(refreshUI, 150);

// ------------------------------------------------------------------ boot
async function boot() {
  renderSettings();
  audio.setVolume(settings.volume);
  audio.setMuted(settings.muted);
  if (!SerialLink.isSupported()) $('unsupported').hidden = false;
  refreshUI();
  requestAnimationFrame(sceneLoop);
  audio.loadBuiltin(BUILTIN_SOUND, BUILTIN_SOUND_NAME).then(() => audio.restore()).then(refreshUI);
  autoConnect();
  // Camera permission is requested immediately; MediaPipe loads in parallel.
  await Promise.all([Camera.isSupported() ? startCamera() : Promise.resolve(), loadDetector()]);
  requestAnimationFrame(frame);
  if (link.ready) return;
  log('Ready. Open Settings → "Connect Arduino" and choose the Leonardo\'s port.');
}

// Cleanup on unload: stop the camera and close the port so the Leonardo is free next time.
window.addEventListener('pagehide', () => { camera.stop(); link.disconnect('page closed'); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.autoTrack) log('Tab hidden: browsers pause video processing in background tabs; keep this tab visible for tracking.', 'er');
});

boot();
export { DEFAULTS };

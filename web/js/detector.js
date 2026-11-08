// MediaPipe Pose Landmarker wrapper (official @mediapipe/tasks-vision web build).
// Produces person detections in normalized image coordinates (unmirrored).
const MP_VERSION = '0.10.21';
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

// Landmark indices (BlazePose 33-point topology)
export const LM = { NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_HIP: 23, R_HIP: 24 };
const TORSO = [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP];

export class PoseDetector {
  constructor() {
    this.landmarker = null;
    this.connections = [];
    this.delegate = null;
    this.loading = false;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
  }

  get ready() { return !!this.landmarker; }

  async load(settings, onStatus = () => {}) {
    if (this.loading) return;
    this.loading = true;
    try {
      onStatus('Loading MediaPipe library…');
      const vision = await import(MP_BUNDLE);
      const { FilesetResolver, PoseLandmarker } = vision;
      const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODELS[settings.modelVariant] || MODELS.lite, delegate },
        runningMode: 'VIDEO',
        numPoses: settings.numPoses,
        minPoseDetectionConfidence: settings.detectionConfidence,
        minPosePresenceConfidence: settings.presenceConfidence,
        minTrackingConfidence: settings.trackingConfidence,
        outputSegmentationMasks: settings.personInScene !== false,
      });
      onStatus('Loading pose model (GPU)…');
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
        this.delegate = 'GPU';
      } catch (gpuErr) {
        console.warn('GPU delegate failed, falling back to CPU', gpuErr);
        onStatus('GPU unavailable, loading pose model (CPU)…');
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
        this.delegate = 'CPU';
      }
      this.connections = PoseLandmarker.POSE_CONNECTIONS || [];
      this._PoseLandmarker = PoseLandmarker;
      this._fileset = fileset;
      return this.delegate;
    } finally {
      this.loading = false;
    }
  }

  async updateOptions(settings) {
    if (!this.landmarker) return;
    await this.landmarker.setOptions({
      numPoses: settings.numPoses,
      minPoseDetectionConfidence: settings.detectionConfidence,
      minPosePresenceConfidence: settings.presenceConfidence,
      minTrackingConfidence: settings.trackingConfidence,
    });
  }

  /**
   * Run detection on the current video frame. Returns null if the frame hasn't changed.
   * Returns {people, masks}. Each person: {landmarks, bbox:{x,y,w,h}, center:{x,y}, confidence, area};
   * masks: copies of the per-person segmentation masks [{width, height, data: Float32Array}] (may be empty).
   */
  detect(video, minVisibility) {
    if (!this.landmarker || video.readyState < 2) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    // Timestamps must be strictly increasing for VIDEO mode.
    let ts = performance.now();
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    const result = this.landmarker.detectForVideo(video, ts);
    const people = [];
    for (const lms of result.landmarks || []) {
      const p = summarize(lms, minVisibility);
      if (p) people.push(p);
    }
    const masks = [];
    for (const m of result.segmentationMasks || []) {
      try {
        if (!this.maskFailed) masks.push({ width: m.width, height: m.height, data: new Float32Array(m.getAsFloat32Array()) });
      } catch (e) {
        this.maskFailed = true; console.warn('Segmentation mask unavailable:', e);
      } finally { try { m.close(); } catch { /* ignore */ } }
    }
    return { people, masks: people.length ? masks : [] };
  }

  close() { try { this.landmarker?.close(); } catch { /* ignore */ } this.landmarker = null; }
}

/** Turn 33 landmarks into a stable tracking point, box and confidence. Returns null if too weak. */
function summarize(lms, minVisibility) {
  const vis = (i) => lms[i]?.visibility ?? 0;
  const torsoVis = TORSO.map(vis);
  const confidence = torsoVis.reduce((a, b) => a + b, 0) / torsoVis.length;

  const visible = lms.filter(l => (l.visibility ?? 0) >= Math.min(0.3, minVisibility));
  if (visible.length < 5) return null;

  // Accept the person if the torso is reasonably visible, OR at least the shoulders are
  // (people close to the camera often have hips out of frame).
  const shouldersOk = vis(LM.L_SHOULDER) >= minVisibility && vis(LM.R_SHOULDER) >= minVisibility;
  if (confidence < minVisibility && !shouldersOk) return null;

  let xs = visible.map(l => l.x), ys = visible.map(l => l.y);
  let x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(1, Math.max(...xs));
  let y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(1, Math.max(...ys));
  const padX = (x1 - x0) * 0.08, padY = (y1 - y0) * 0.06;
  x0 = Math.max(0, x0 - padX); x1 = Math.min(1, x1 + padX);
  y0 = Math.max(0, y0 - padY); y1 = Math.min(1, y1 + padY);

  // Tracking point: midpoint of visible torso landmarks (more stable than nose or box center).
  const torsoPts = TORSO.filter(i => vis(i) >= 0.3).map(i => lms[i]);
  let cx, cy;
  if (torsoPts.length >= 2) {
    cx = torsoPts.reduce((a, l) => a + l.x, 0) / torsoPts.length;
    cy = torsoPts.reduce((a, l) => a + l.y, 0) / torsoPts.length;
  } else {
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
  }
  return {
    landmarks: lms,
    bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    center: { x: Math.min(1, Math.max(0, cx)), y: Math.min(1, Math.max(0, cy)) },
    confidence,
    area: (x1 - x0) * (y1 - y0),
  };
}

/** Mirror a detection horizontally (for selfie-view display coordinates). */
export function mirrorPerson(p) {
  return {
    ...p,
    landmarks: p.landmarks.map(l => ({ ...l, x: 1 - l.x })),
    bbox: { ...p.bbox, x: 1 - p.bbox.x - p.bbox.w },
    center: { x: 1 - p.center.x, y: p.center.y },
  };
}

// Webcam access and device selection.
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.deviceId = '';
  }

  static isSupported() { return !!navigator.mediaDevices?.getUserMedia; }

  async start(deviceId = '') {
    this.stop();
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        return this.start(''); // remembered camera no longer present -> default camera
      }
      throw new Error(describeError(e));
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.addEventListener('loadeddata', resolve, { once: true });
    });
    const track = this.stream.getVideoTracks()[0];
    this.deviceId = track?.getSettings?.().deviceId || deviceId;
    track?.addEventListener('ended', () => this.onEnded?.());
    return track?.getSettings?.() || {};
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
  }
}

function describeError(e) {
  switch (e.name) {
    case 'NotAllowedError': return 'Camera permission was denied. Allow camera access in the address bar, then reload.';
    case 'NotFoundError': return 'No camera was found.';
    case 'NotReadableError': return 'The camera is in use by another application.';
    case 'SecurityError': return 'Camera requires a secure context (http://localhost or https).';
    default: return `Camera error: ${e.message || e.name}`;
  }
}

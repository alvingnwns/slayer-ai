// Camera + MediaPipe Hand Landmarker wrapper. This is the ONLY place MediaPipe
// is used, and it only produces landmarks – no rendering, no VFX.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL || '/';
const LOCAL_WASM = `${BASE}mediapipe/wasm`;
const LOCAL_MODEL = `${BASE}models/hand_landmarker.task`;
// Used only if the local copies are missing (see scripts/fetch-assets.mjs).
const REMOTE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const type = r.headers.get('content-type') || '';
    return r.ok && !type.includes('text/html');
  } catch { return false; }
}

export class HandTracker extends EventTarget {
  constructor() {
    super();
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.stream = null;
    this.landmarker = null;
    this.status = 'off';
    this.detail = '';
    this.delegate = '';
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
    this.inferenceMs = 0;
    this._lastRun = 0;
    this.brightness = 128;
    this._lumaCanvas = null;
    this._lumaAt = 0;
    this._starting = null;
  }

  _set(status, detail = '') {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }

  get active() { return !!this.stream; }
  get ready() { return !!this.stream && !!this.landmarker; }
  get videoSize() { return { w: this.video.videoWidth || 1280, h: this.video.videoHeight || 720 }; }

  async start() {
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    if (this.stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this._set('error', 'This browser has no camera API (needs HTTPS or localhost).');
      return false;
    }
    this._set('requesting', 'Waiting for camera permission…');
    try {
      this.stream = await this._getStream();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      const missing = err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
      this._set(denied ? 'denied' : missing ? 'no-camera' : 'error', denied
        ? 'Camera permission was denied. Use mouse/keyboard mode, or allow the camera in your browser settings.'
        : missing ? 'No camera was found.' : `Camera error: ${err?.message || err}`);
      return false;
    }
    // If the track ends (unplugged / revoked) clean up.
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stop('Camera disconnected.'));

    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* autoplay edge cases */ }

    if (!this.landmarker) {
      this._set('loading', 'Loading hand-tracking model…');
      try {
        await this._createLandmarker();
      } catch (err) {
        console.error(err);
        this.stop();
        this._set('error', `Hand tracking could not start: ${err?.message || err}`);
        return false;
      }
    }
    if (!this.stream) return false; // stopped while loading
    this.lastVideoTime = -1;
    this._set('searching', 'Show your hand to the camera');
    return true;
  }

  /** Preferred constraints first; relax them for cameras that cannot satisfy them. */
  async _getStream() {
    const attempts = [
      { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 60 } },
      { width: { ideal: 640 }, height: { ideal: 480 } },
      true,
    ];
    let lastErr;
    for (const video of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video });
      } catch (err) {
        lastErr = err;
        // permission problems will not be fixed by relaxing constraints
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
      }
    }
    throw lastErr;
  }

  async _createLandmarker() {
    const localOk = (await exists(LOCAL_MODEL)) && (await exists(`${LOCAL_WASM}/vision_wasm_internal.wasm`));
    const fileset = await FilesetResolver.forVisionTasks(localOk ? LOCAL_WASM : REMOTE_WASM);
    const modelAssetPath = localOk ? LOCAL_MODEL : REMOTE_MODEL;
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await make('GPU');
      this.delegate = 'GPU';
    } catch (gpuErr) {
      console.warn('GPU delegate unavailable, using CPU', gpuErr);
      this.landmarker = await make('CPU');
      this.delegate = 'CPU';
    }
  }

  /** Returns {landmarks, world} | null (no hand) | undefined (no new frame). */
  detect(nowMs) {
    if (!this.landmarker || !this.stream) return undefined;
    const v = this.video;
    if (v.readyState < 2 || v.videoWidth === 0) return undefined;
    if (v.currentTime === this.lastVideoTime) return undefined;
    // slow devices: never spend more than ~half of the frame budget on inference
    if (nowMs - this._lastRun < this.inferenceMs * 1.2) return undefined;
    this._lastRun = nowMs;
    this.lastVideoTime = v.currentTime;
    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(nowMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;

    const t0 = performance.now();
    let res;
    try {
      res = this.landmarker.detectForVideo(v, ts);
    } catch (err) {
      console.warn('detectForVideo failed', err);
      return null;
    }
    this.inferenceMs += (performance.now() - t0 - this.inferenceMs) * 0.1;
    this._sampleBrightness(nowMs);

    if (res.landmarks && res.landmarks.length > 0) {
      return { landmarks: res.landmarks[0], world: res.worldLandmarks?.[0] || null };
    }
    return null;
  }

  _sampleBrightness(nowMs) {
    if (nowMs - this._lumaAt < 1000) return;
    this._lumaAt = nowMs;
    try {
      if (!this._lumaCanvas) {
        this._lumaCanvas = document.createElement('canvas');
        this._lumaCanvas.width = 32;
        this._lumaCanvas.height = 18;
      }
      const ctx = this._lumaCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(this.video, 0, 0, 32, 18);
      const d = ctx.getImageData(0, 0, 32, 18).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      this.brightness = s / (d.length / 4);
    } catch { /* ignore */ }
  }

  stop(reason = '') {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
    this.lastVideoTime = -1;
    this._set('off', reason);
  }

  dispose() {
    this.stop();
    try { this.landmarker?.close(); } catch { /* ignore */ }
    this.landmarker = null;
  }
}

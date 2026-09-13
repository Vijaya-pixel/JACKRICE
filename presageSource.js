/**
 * presageSource.js — frame source for blinkEngine.js backed by the Presage
 * SmartSpectra SDK (Electron renderer). This is the real product path; the
 * SDK owns the camera, hands us the live MediaStream for the visible <video>,
 * and streams face landmarks + blink detection + vitals.
 *
 * Only usable inside Electron, bundled with esbuild (see renderer.js /
 * package.json#scripts.build). Requires @smartspectra/node-sdk and the SDK's
 * preload + bindSmartSpectraIpc in the main process (see main.js).
 *
 *   const source = createPresageSource({ apiKey, vitals: true, zoom: 2 });
 *
 * ZOOM: Presage rounds landmarks to whole pixels of the frame it is given. At
 * a normal sitting distance an eye is only ~30 px wide, which makes iris-based
 * gaze coarse. So instead of letting the SDK open the camera, we open it at
 * full resolution ourselves, show the raw feed in the visible <video>, and feed
 * the SDK a `zoom`x face-following crop upscaled to the working size. The SDK's
 * pixel rounding is then 1/zoom of a real pixel. Landmarks are mapped back to
 * full-frame coordinates before they reach the engine. (Trade-off: a tight crop
 * hides the chest, so breathing rate is unavailable while zoomed; pulse is fine.)
 *   const engine = createBlinkEngine({ source });
 *   source.on('vitals', v => ...);   // also re-emitted by the engine as 'vitals'
 *   source.on('validation', ({ code, name, hint }) => ...);
 */
const {
  SmartSpectraSDK, ProcessingStatus, ValidationCode,
  breathingMetrics, cardioMetrics, faceMetrics,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');

const STATUS_NAMES     = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]));
const VALIDATION_NAMES = Object.fromEntries(Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]));

function tsToNumber(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  if (typeof ts.toNumber === 'function') return ts.toNumber();
  return Number(ts);
}
function last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }

export function createPresageSource({ apiKey, vitals = true, cardio = true, zoom = 1, gazeProvider = null,
                                      cameraWidth = 1920, cameraHeight = 1080, workWidth = 1280, workHeight = 720 } = {}) {
  if (!apiKey) throw new Error('createPresageSource: apiKey is required (PRESAGE_API_KEY in .env)');
  const listeners = {};
  const on = (name, fn) => { (listeners[name] ||= []).push(fn); };
  const emit = (name, p) => { for (const fn of listeners[name] || []) { try { fn(p); } catch (e) { console.error(e); } } };

  let sdk = null, video = null, onFrame = null;
  let rawStream = null, cropCanvas = null, cropCtx = null, cropTimer = null;
  // Crop window in normalized full-frame coords; starts as the whole frame.
  const crop = { x: 0, y: 0, w: 1, h: 1 };
  let lastFaceAt = 0;
  let tOffsetMs = null;          // maps SDK µs-since-epoch to performance.now() ms
  let lastBlink = null;          // latest DetectionStatus.detected seen
  let lastVitals = {};
  let framesSeen = 0, coordsArePixels = null;

  // SDK landmarks are documented as normalized in one place and pixel in
  // another; detect once from the data and normalize to 0-1 of the frame the
  // SDK was given (the crop), then map into full-frame coordinates.
  function normalizeLandmarks(points) {
    if (coordsArePixels === null) {
      let mx = 0; for (const p of points) if (p.x > mx) mx = p.x;
      coordsArePixels = mx > 1.5;
    }
    const w = coordsArePixels ? (zoom > 1 ? workWidth : (video.videoWidth || workWidth)) : 1;
    const h = coordsArePixels ? (zoom > 1 ? workHeight : (video.videoHeight || workHeight)) : 1;
    const out = points.map(p => ({ x: crop.x + (p.x / w) * crop.w, y: crop.y + (p.y / h) * crop.h }));
    updateCrop(out);
    return out;
  }
  // Face-following crop: center on the eye midpoint, size = 1/zoom of the
  // frame, eased so the crop doesn't jitter. Falls back to the full frame if
  // the face has not been seen for a while (so it can be re-acquired).
  function updateCrop(lm) {
    lastFaceAt = performance.now();
    if (zoom <= 1) return;
    const cx = (lm[33].x + lm[263].x) / 2, cy = (lm[33].y + lm[263].y) / 2 + 0.12 / zoom; // a bit below the eyes: include nose/mouth
    const w = 1 / zoom, h = 1 / zoom;
    const tx = Math.min(1 - w, Math.max(0, cx - w / 2)), ty = Math.min(1 - h, Math.max(0, cy - h / 2));
    const k = 0.08; // easing
    crop.x += (tx - crop.x) * k; crop.y += (ty - crop.y) * k; crop.w += (w - crop.w) * k; crop.h += (h - crop.h) * k;
  }
  function resetCropIfLost() {
    if (zoom > 1 && performance.now() - lastFaceAt > 1500) { crop.x = 0; crop.y = 0; crop.w = 1; crop.h = 1; }
  }
  // Draw the crop region of the raw video into the working canvas at ~30 fps.
  function pumpCrop() {
    resetCropIfLost();
    if (video.videoWidth) {
      const W = video.videoWidth, H = video.videoHeight;
      cropCtx.drawImage(video, crop.x * W, crop.y * H, crop.w * W, crop.h * H, 0, 0, workWidth, workHeight);
    }
  }
  function currentCrop() { return { ...crop }; }

  function handleMetrics(m) {
    // Vitals (windowed slices; keep the latest of each)
    const pr = last(m.cardio?.pulseRate), br = last(m.breathing?.rate);
    let vitalsChanged = false;
    if (pr) { lastVitals.pulseBpm = pr.value; lastVitals.pulseConfidence = pr.confidence; vitalsChanged = true; }
    if (br) { lastVitals.breathingBpm = br.value; lastVitals.breathingConfidence = br.confidence; vitalsChanged = true; }
    if (vitalsChanged) emit('vitals', { ...lastVitals });

    const face = m.face;
    if (!face) return;
    const blinks = face.blinking || [];
    const lms = face.landmarks || [];
    if (!lms.length) {
      // No landmarks in this slice: if the SDK says blink state changed, still
      // surface it via the next landmark frame. Nothing to draw now.
      if (blinks.length) lastBlink = last(blinks).detected;
      return;
    }
    let bi = 0;
    for (const entry of lms) {
      const tsUs = tsToNumber(entry.timestamp);
      // advance blink state up to this landmark timestamp
      while (bi < blinks.length && tsToNumber(blinks[bi].timestamp) <= tsUs) { lastBlink = blinks[bi].detected; bi++; }
      if (tOffsetMs === null) tOffsetMs = performance.now() - tsUs / 1000;
      const t = tsUs / 1000 + tOffsetMs;
      const pts = entry.value || [];
      framesSeen++;
      onFrame({
        t,
        landmarks: pts.length >= 468 ? normalizeLandmarks(pts) : null,
        // No graded closed-ness score from Presage: leave `blink` null so the
        // engine runs EAR-only, and surface its detector as a per-frame flag.
        blink: null,
        blinkFlag: lastBlink === true,
        lookDown: null, gazeBlend: null,
        // Sub-pixel landmarks for gaze from the hybrid tracker (gazeTracker.js), if any.
        gazeLandmarks: gazeProvider ? (gazeProvider.latest()?.landmarks || null) : null,
        vitals: vitalsChanged ? { ...lastVitals } : undefined,
        stable: entry.stable,
      });
      vitalsChanged = false;
    }
    while (bi < blinks.length) { lastBlink = blinks[bi].detected; bi++; }
  }

  // --- SDK lifecycle (with auto-restart) -------------------------------
  // The native graph occasionally fails with kProcessingFailed
  // ("SmartSpectra processing failed", retryable: true) — sometimes right
  // after Starting, sometimes tens of seconds into a healthy 30 fps run.
  // Observed on macOS with no change in input; the SDK marks it retryable.
  // Left alone the graph stays in Error forever and the app is dead (no
  // frames → no blinks). So: tear the SDK down and start a fresh one, with
  // backoff, up to RESTART_MAX_ATTEMPTS; the attempt counter resets once the
  // new instance is producing frames again.
  const RESTART_MAX_ATTEMPTS = 5;
  const RESTART_BASE_DELAY_MS = 1500;
  let statusCb = () => {};
  let stopped = false;
  let restartTimer = null;
  let restartAttempts = 0;
  let framesSinceStart = 0;

  async function teardownSdk() {
    const old = sdk;
    sdk = null;
    if (!old) return;
    try { await old.stop(); } catch (_) {}
    try { old.destroy(); } catch (_) {}
  }

  function scheduleRestart(reason) {
    if (stopped || restartTimer) return;
    if (restartAttempts >= RESTART_MAX_ATTEMPTS) {
      statusCb(`Presage: gave up after ${restartAttempts} restarts (${reason})`);
      return;
    }
    restartAttempts++;
    const delay = RESTART_BASE_DELAY_MS * restartAttempts;
    statusCb(`Presage: restarting in ${(delay / 1000).toFixed(1)}s (attempt ${restartAttempts}/${RESTART_MAX_ATTEMPTS}) — ${reason}`);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopped) return;
      await teardownSdk();
      try {
        await startSdk(statusCb);
      } catch (e) {
        onFrame({ t: performance.now(), landmarks: null, error: e });
        scheduleRestart(e.message || String(e));
      }
    }, delay);
  }

  function noteFrame() {
    framesSinceStart++;
    // A restarted instance that reaches steady state earns back its attempts.
    if (framesSinceStart === 60 && restartAttempts) restartAttempts = 0;
  }

  async function startSdk(onStatus) {
      framesSinceStart = 0;
      const requested = [...breathingMetrics, ...faceMetrics];
      if (vitals && cardio) requested.push(...cardioMetrics);
      const instance = new SmartSpectraSDK({ apiKey, requestedMetrics: requested, enableAccumulatedOutput: false });
      sdk = instance;
      // Events from a torn-down instance must not touch the live one.
      const live = () => sdk === instance;

      if (zoom > 1) {
        // Own the camera: raw full-res feed to the visible <video>, zoomed crop to the SDK.
        // NOTE: measured on a MacBook, the 1080p->canvas->SDK path dropped below the
        // SDK's 25 fps floor and stalled, and the crop hides the chest (breathing +
        // ChestNotVisible warnings). Off by default (zoom: 1); kept for experiments.
        onStatus('Presage: opening camera…');
        rawStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: cameraWidth }, height: { ideal: cameraHeight }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false });
        video.srcObject = rawStream; video.muted = true; video.playsInline = true;
        await new Promise(res => video.readyState >= 1 ? res() : video.addEventListener('loadedmetadata', res, { once: true }));
        await video.play();
        onStatus(`Presage: camera ${video.videoWidth}x${video.videoHeight}, feeding SDK a ${zoom}x crop at ${workWidth}x${workHeight}`);
        cropCanvas = document.createElement('canvas'); cropCanvas.width = workWidth; cropCanvas.height = workHeight;
        cropCtx = cropCanvas.getContext('2d', { alpha: false, desynchronized: true });
        pumpCrop();
        cropTimer = setInterval(pumpCrop, 1000 / 30);
        instance.useMediaStream(cropCanvas.captureStream(30));
      }

      // Default (zoom 1): the SDK opens the camera itself and hands us the stream for the visible video.
      instance.on('streamAvailable', stream => {
        if (!live() || zoom > 1) return; // host-supplied stream; visible video already shows the raw feed
        video.srcObject = stream; video.muted = true; video.playsInline = true;
        video.play().catch(() => {});
        onStatus('Presage: camera stream attached');
      });
      instance.on('processingStatus', status => {
        if (!live()) return;
        const name = STATUS_NAMES[status] || `Status(${status})`;
        onStatus(`Presage: ${name}`);
        emit('processing', { status, name });
      });
      instance.on('validationStatus', (code, _ts, hint) => {
        if (!live()) return;
        emit('validation', { code, name: VALIDATION_NAMES[code] || `Code(${code})`, hint, ok: code === ValidationCode.kOk });
      });
      instance.on('metrics', buf => {
        if (!live()) return;
        noteFrame();
        try { handleMetrics(decodeMetrics(buf)); }
        catch (e) { onFrame({ t: performance.now(), landmarks: null, error: e }); }
      });
      instance.on('error', (code, message, retryable) => {
        if (!live()) return;
        onFrame({ t: performance.now(), landmarks: null, error: Object.assign(new Error(`Presage ${code}: ${message}`), { code, retryable }) });
        if (retryable) scheduleRestart(`Presage ${code}: ${message}`);
      });
      onStatus(restartAttempts ? `Presage: starting SDK (restart ${restartAttempts})…` : 'Presage: starting SDK…');
      await instance.start();
  }

  return {
    name: 'presage',
    on,
    getStatusNames: () => ({ STATUS_NAMES, VALIDATION_NAMES }),
    async start(videoEl, frameCb, onStatus = () => {}) {
      video = videoEl; onFrame = frameCb; statusCb = onStatus;
      await startSdk(onStatus);
    },
    async stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer); restartTimer = null;
      if (cropTimer) clearInterval(cropTimer); cropTimer = null;
      rawStream?.getTracks().forEach(t => t.stop()); rawStream = null;
      await teardownSdk();
      if (video) video.srcObject = null;
    },
    get framesSeen() { return framesSeen; },
    get crop() { return currentCrop(); },
  };

}

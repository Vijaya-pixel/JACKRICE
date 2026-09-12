/**
 * gazeTracker.js — sub-pixel eye landmarks for gaze, from a MediaPipe
 * FaceLandmarker running in a Web Worker on a clone of the camera track that
 * Presage is displaying.
 *
 * Why this exists: Presage SmartSpectra is the product's perception engine for
 * blink detection and vitals, but it rounds landmarks to whole pixels, and
 * gaze (which box is the user looking at) is a 3-5 pixel iris shift. This
 * module supplies float-precision iris/eye-corner points to blinkEngine.js's
 * gaze math; Presage still decides every blink and every vital sign.
 *
 * Runs locally and off the main thread (so it can't stall Presage's frame
 * pump): WASM runtime + model in ./mp (npm run setup), worker bundled to
 * dist/gazeWorker.bundle.js.
 *
 *   const gaze = createGazeTracker();
 *   await gaze.start(videoEl);            // after the video has a stream
 *   gaze.latest()  -> { t, landmarks (478 x {x,y} normalized) } | null
 */
export const GAZE_TRACKER_DEFAULTS = {
  workerUrl: 'dist/gazeWorker.bundle.js',
  wasmDir: '../mp/wasm',            // relative to the worker script
  modelPath: '../mp/face_landmarker.task',
  delegate: 'GPU',
  maxAgeMs: 200,   // latest() returns null if the last result is older than this
};

export function createGazeTracker(overrides = {}) {
  const cfg = { ...GAZE_TRACKER_DEFAULTS, ...overrides };
  let worker = null, track = null, latest = null, fps = 0, frameCount = 0, fpsAt = 0, lastMs = 0;
  let reader = null, busy = false, pumping = false, dropped = 0;

  return {
    name: 'mediapipe-gaze-worker',
    async start(videoEl, onStatus = () => {}) {
      const stream = videoEl.srcObject;
      const src = stream && stream.getVideoTracks()[0];
      if (!src) throw new Error('video has no camera track yet');
      track = src.clone();
      worker = new Worker(cfg.workerUrl);
      const wasmDir = new URL(cfg.wasmDir, new URL(cfg.workerUrl, location.href)).href;
      const modelPath = new URL(cfg.modelPath, new URL(cfg.workerUrl, location.href)).href;
      await new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'status') {
            onStatus(m.message);
            if (m.message === 'running') resolve();
            if (m.message.startsWith('ERROR')) reject(new Error(m.message));
          } else if (m.type === 'result') {
            busy = false;
            const t = performance.now();
            lastMs = m.ms;
            if (m.error) onStatus('inference error: ' + m.error);
            if (m.landmarks) {
              const a = m.landmarks, lm = new Array(a.length / 2);
              for (let i = 0; i < lm.length; i++) lm[i] = { x: a[i * 2], y: a[i * 2 + 1] };
              latest = { t, landmarks: lm };
            } else latest = null;
            frameCount++;
            if (t - fpsAt >= 1000) { fps = frameCount; frameCount = 0; fpsAt = t; }
          }
        };
        worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
        worker.postMessage({ type: 'start', wasmDir, modelPath, delegate: cfg.delegate });
      });
      // Frame pump on the main thread: read VideoFrames from the cloned track
      // (no inference here) and transfer one at a time to the worker. Frames
      // that arrive while the worker is busy are dropped, never queued.
      reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      pumping = true;
      (async () => {
        while (pumping) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          if (busy || !worker) { frame.close(); dropped++; continue; }
          busy = true;
          worker.postMessage({ type: 'frame', frame }, [frame]);
        }
      })();
    },
    latest() {
      if (!latest || performance.now() - latest.t > cfg.maxAgeMs) return null;
      return latest;
    },
    get fps() { return fps; },
    get inferenceMs() { return lastMs; },
    get dropped() { return dropped; },
    stop() { pumping = false; reader?.cancel().catch(() => {}); track?.stop(); worker?.terminate(); worker = null; latest = null; },
  };
}

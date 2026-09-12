// gazeWorker.js — runs the MediaPipe FaceLandmarker OFF the main thread on a
// cloned camera track, so it never stalls Presage's frame pump (which lives on
// the renderer main thread). Bundled to dist/gazeWorker.bundle.js.
//
// main -> worker: { type: 'start', wasmDir, modelPath, delegate }
//                 { type: 'frame', frame (transferred VideoFrame) }   -- one at a time; main waits for 'result'
// worker -> main: { type: 'status', message } | { type: 'result', landmarks: Float32Array(478*2) | null, ms }
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

let landmarker = null, lastTs = -1;

function handleFrame(frame) {
  const t0 = performance.now();
  try {
    if (!landmarker) { self.postMessage({ type: 'result', landmarks: null, ms: 0 }); return; }
    // Monotonic timestamps are required by detectForVideo.
    const ts = Math.max(lastTs + 1, Math.round(frame.timestamp / 1000));
    lastTs = ts;
    const res = landmarker.detectForVideo(frame, ts);
    const lm = res.faceLandmarks?.[0];
    if (lm) {
      const out = new Float32Array(lm.length * 2);
      for (let i = 0; i < lm.length; i++) { out[i * 2] = lm[i].x; out[i * 2 + 1] = lm[i].y; }
      self.postMessage({ type: 'result', landmarks: out, ms: performance.now() - t0 }, [out.buffer]);
    } else {
      self.postMessage({ type: 'result', landmarks: null, ms: performance.now() - t0 });
    }
  } catch (err) {
    self.postMessage({ type: 'result', landmarks: null, ms: performance.now() - t0, error: err.message || String(err) });
  } finally { frame.close(); }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'frame') { handleFrame(msg.frame); return; }
  if (msg.type !== 'start') return;
  try {
    self.postMessage({ type: 'status', message: 'loading face mesh…' });
    const fileset = await FilesetResolver.forVisionTasks(msg.wasmDir);
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.modelPath, delegate: msg.delegate }, runningMode: 'VIDEO', numFaces: 1 });
    } catch (gpuErr) {
      self.postMessage({ type: 'status', message: `GPU delegate failed (${gpuErr.message}); using CPU` });
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.modelPath, delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 1 });
    }
    self.postMessage({ type: 'status', message: 'running' });
  } catch (err) {
    self.postMessage({ type: 'status', message: 'ERROR: ' + (err.message || err) });
  }
};

// engineHostRenderer.js — renderer entry for the hidden "engine host" window
// (see engine-host.html, main.js). Bootstraps the SAME blinkEngine.js /
// presageSource.js / gazeTracker.js stack as renderer.js does for the legacy
// yesno-electron.html UI — none of that logic is duplicated here, only the
// wiring is. Instead of driving a local DOM UI, every engine event is
// forwarded over IPC (via window.tacit, from preload.js) so the React
// frontend — running in a different window/origin — can consume it without
// ever importing Electron, Node, or the Presage SDK itself.
//
// Tuning note: ENGINE_OVERRIDES below is intentionally a copy of renderer.js's
// constant, not a shared import — renderer.js (the legacy path) is left
// completely untouched so it keeps working exactly as it does today. If you
// retune blink/gaze behavior, update both.
'use strict';
import { createBlinkEngine } from './blinkEngine.js';
import { createPresageSource } from './presageSource.js';
import { createGazeTracker } from './gazeTracker.js';

const ENGINE_OVERRIDES = {
  calibrationCountdownMs: 1000,
  calibrationMs: 4000,
  signalMode: 'ear',
  confirmWithBlinkFlag: true,
  thresholdRatio: { ear: 0.60 },
  reopenRatio:    { ear: 0.78 },
  eyeMinWidthPx: 30,
  gazeMedianWindow: 5,
  gazeSmoothing: 0.5,
  gazeDeadZone: 0.06,
  gazeDwellMs: 120,
  gazeHeadGain: 0,
};

// Every event the React side is allowed to see (see frontend/src/types/tacit.d.ts
// for the matching payload shapes).
const EVENT_NAMES = [
  'status', 'error', 'calibration', 'select', 'rest', 'resume', 'ambiguous',
  'facelost', 'faceback', 'warning', 'gaze', 'vitals', 'frame',
];

(async () => {
  const video = document.getElementById('video');
  const report = (type, payload) => window.tacit?.reportEngineEvent?.(type, payload);

  if (!window.tacit?.reportEngineEvent) {
    console.error('[engine-host] window.tacit bridge missing — check preload.js');
    return;
  }

  const apiKey = await window.tacit.getApiKey();
  if (!apiKey) {
    report('status', { phase: 'error', message: 'No PRESAGE_API_KEY configured (.env)' });
    return;
  }

  let eyeTrackingEnabled = false;
  let gazeTracker = null;
  const gazeProvider = { latest: () => (eyeTrackingEnabled && gazeTracker ? gazeTracker.latest() : null) };

  const source = createPresageSource({ apiKey, vitals: true, zoom: 1, gazeProvider });
  const engine = createBlinkEngine({ source, ...ENGINE_OVERRIDES });

  for (const name of EVENT_NAMES) {
    engine.on(name, payload => {
      if (name === 'frame') {
        // 'frame' fires ~30x/second with full landmark arrays; the React UI
        // only ever needs a lightweight status summary from it, so it's
        // thinned here rather than forwarding raw landmarks over IPC.
        report('frame', {
          t: payload.t, face: payload.face, eye: payload.eye, gaze: payload.gaze,
          gazeX: payload.gazeX, degraded: payload.degraded, paused: payload.paused,
          signal: payload.signal, eyePx: payload.eyePx,
        });
        return;
      }
      report(name, payload);
    });
  }

  window.tacit.onEngineControl(async msg => {
    if (msg.type === 'calibrate') {
      engine.calibrate();
    } else if (msg.type === 'setEyeTracking') {
      eyeTrackingEnabled = !!msg.enabled;
      if (eyeTrackingEnabled && !gazeTracker) {
        gazeTracker = createGazeTracker();
        try {
          await gazeTracker.start(video, () => {});
        } catch (e) {
          report('warning', { code: 'gaze_tracker_failed', active: true, message: e.message || String(e) });
          gazeTracker = null;
        }
      } else if (!eyeTrackingEnabled && gazeTracker) {
        gazeTracker.stop();
        gazeTracker = null;
      }
    }
  });

  try {
    await engine.start(video);
  } catch (err) {
    report('error', { error: { message: err.message || String(err) } });
  }
})();

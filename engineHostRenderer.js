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

// --- Gaze centering ("look at the middle of the screen") --------------------
// blinkEngine.js only exposes a raw setGazeReference({centerX}) setter; the
// "sample for a couple seconds while the user looks at center" flow is
// app-level, same as yesnoApp.js's gcal object for the legacy UI. Reimplemented
// here so the React side can trigger it over the control bridge and get a
// calibration-style phase event back instead of raw frame data.
const GAZE_CAL_MS = 2000;
const GAZE_CAL_MIN_SAMPLES = 10;
const gazeCal = { active: false, startAt: 0, samples: [] };

function startGazeCalibration(engine, report) {
  gazeCal.active = true;
  gazeCal.startAt = performance.now();
  gazeCal.samples = [];
  report('gazeCalibration', { phase: 'sampling', remainingMs: GAZE_CAL_MS, sampleCount: 0 });
}
function gazeCalTick(engine, report, frame) {
  if (!gazeCal.active) return;
  const elapsed = frame.t - gazeCal.startAt;
  if (elapsed > 500 && frame.face && frame.gazeRaw !== null && frame.eye === 'open') gazeCal.samples.push(frame.gazeRaw);
  if (elapsed < GAZE_CAL_MS) {
    report('gazeCalibration', { phase: 'sampling', remainingMs: GAZE_CAL_MS - elapsed, sampleCount: gazeCal.samples.length });
    return;
  }
  gazeCal.active = false;
  const sorted = [...gazeCal.samples].sort((a, b) => a - b);
  if (sorted.length >= GAZE_CAL_MIN_SAMPLES) {
    const center = sorted[Math.floor(sorted.length / 2)];
    engine.setGazeReference({ centerX: center });
    report('gazeCalibration', { phase: 'done', sampleCount: sorted.length, center, deadZone: engine.config.gazeDeadZone });
  } else {
    report('gazeCalibration', { phase: 'failed', sampleCount: sorted.length, reason: 'too few samples (face not tracked?)' });
  }
}

// --- Vitals warm-up gate ------------------------------------------------
// Presage's own cardio/breathing confidence (0-100) needs several seconds of
// a held-still, well-lit face before it's trustworthy. Rather than showing
// the first noisy bpm reading, wait for confidence to stay at/above
// VITALS_READY_CONFIDENCE for VITALS_READY_HOLD_MS before telling consumers
// the signal is ready. "timeout" is not sticky (sampling keeps going in the
// background) — it just tells the UI this is taking longer than usual so it
// can say so; "ready" IS sticky (vitalsCal.ready), so a momentary confidence
// dip later doesn't yank the numbers back off the screen.
const VITALS_READY_CONFIDENCE = 70;
const VITALS_READY_HOLD_MS = 3000;
const VITALS_TIMEOUT_MS = 20000;
const vitalsCal = { startAt: 0, aboveSince: null, ready: false };

function vitalsCalTick(report, vitals, now) {
  if (vitalsCal.ready) return;
  const pulseConfidence = vitals.pulseConfidence ?? 0;
  if (pulseConfidence >= VITALS_READY_CONFIDENCE) {
    if (vitalsCal.aboveSince === null) vitalsCal.aboveSince = now;
  } else {
    vitalsCal.aboveSince = null;
  }
  const elapsedMs = now - vitalsCal.startAt;
  const breathingConfidence = vitals.breathingConfidence ?? null;
  if (vitalsCal.aboveSince !== null && now - vitalsCal.aboveSince >= VITALS_READY_HOLD_MS) {
    vitalsCal.ready = true;
    report('vitalsCalibration', { phase: 'ready', elapsedMs, pulseConfidence, breathingConfidence });
    return;
  }
  report('vitalsCalibration', {
    phase: elapsedMs >= VITALS_TIMEOUT_MS ? 'timeout' : 'sampling',
    elapsedMs, pulseConfidence, breathingConfidence,
  });
}

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
        // Gaze centering needs frame.gazeRaw/face/eye, only present on the
        // full payload — tick it before thinning.
        gazeCalTick(engine, report, payload);
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
      if (name === 'vitals') vitalsCalTick(report, payload, payload.t);
      report(name, payload);
    });
  }

  window.tacit.onEngineControl(async msg => {
    if (msg.type === 'calibrate') {
      engine.calibrate();
    } else if (msg.type === 'calibrateGaze') {
      startGazeCalibration(engine, report);
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
    vitalsCal.startAt = performance.now();
    await engine.start(video);
  } catch (err) {
    report('error', { error: { message: err.message || String(err) } });
  }
})();

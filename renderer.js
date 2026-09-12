// renderer.js — Electron renderer entry. Bundled by esbuild into
// dist/renderer.bundle.js (npm run build). Wires the Presage SmartSpectra
// frame source into blinkEngine.js and runs the shared Yes/No test UI.
'use strict';
import { createBlinkEngine } from './blinkEngine.js';
import { createPresageSource } from './presageSource.js';
import { createGazeTracker } from './gazeTracker.js';
import { initYesNo } from './yesnoApp.js';

// Presage tuning. Landmarks + a binary blink flag (pulse at the deepest point
// of each blink) but no graded blink score, so:
//  - closure signal is calibrated EAR; the Presage flag CONFIRMS a closure
//  - the EAR lines are tighter than MediaPipe's because Presage's open-eye EAR
//    moves more with gaze (measured p10 0.24 .. max 0.34 on one face)
//  - gaze: iris signal is smaller at 1280x720 (face is smaller in frame), so
//    more smoothing + a wider dead zone; head turns count a bit more.
const ENGINE_OVERRIDES = {
  // 5 s total start-up: 1 s "get ready" + 4 s of natural-blink sampling (~120 frames at 30 fps)
  calibrationCountdownMs: 1000,
  calibrationMs: 4000,
  signalMode: 'ear',
  confirmWithBlinkFlag: true,
  thresholdRatio: { ear: 0.60 },   // inner/confirm (EAR route; the flag is the usual route)
  reopenRatio:    { ear: 0.78 },   // outer/timing
  eyeMinWidthPx: 30,
  gazeMedianWindow: 5,   // sub-pixel input now: lighter filtering, faster response
  gazeSmoothing: 0.5,
  gazeDeadZone: 0.06,
  gazeDwellMs: 120,
  gazeHeadGain: 0,     // EYES ONLY — head/body movement must not move the highlight (and Presage degrades on rotated faces anyway)
};

(async () => {
  const $ = id => document.getElementById(id);
  const apiKey = window.tacit ? await window.tacit.getApiKey() : '';
  console.log(`[tacit] renderer boot — bridge ${window.tacit ? 'ok' : 'MISSING'}, api key ${apiKey ? 'present' : 'absent'}`);
  if (!apiKey) {
    $('calib').textContent = 'No Presage API key. Create a .env file next to package.json with PRESAGE_API_KEY=... and restart (see .env.example).';
    return;
  }
  // HYBRID: Presage = blink detection + vitals (+ landmarks for EAR timing);
  // a local MediaPipe face mesh supplies sub-pixel iris points for gaze only.
  const gazeTracker = createGazeTracker();
  const source = createPresageSource({ apiKey, vitals: true, zoom: 1, gazeProvider: gazeTracker });
  source.on('validation', v => {
    // Presage's own measurement-quality feedback (lighting, framing, motion).
    $('warn').textContent = v.ok ? '' : `Presage: ${v.name}${v.hint ? ' — ' + v.hint : ''}`;
  });
  source.on('processing', p => console.log(`[presage] processing: ${p.name}`));
  let lastValidation = null;
  source.on('validation', v => { const k = v.name + (v.hint || ''); if (k !== lastValidation) { lastValidation = k; console.log(`[presage] validation: ${v.name}${v.hint ? ' — ' + v.hint : ''}`); } });
  const engine = createBlinkEngine({ source, ...ENGINE_OVERRIDES });
  engine.on('status', e => console.log(`[engine] ${e.message}`));
  engine.on('error', e => console.error(`[engine] error: ${e.error?.message || e.error}`));
  engine.on('calibration', e => { if (e.phase !== 'sampling' && e.phase !== 'countdown') console.log(`[engine] calibration ${e.phase}`, e.result ? JSON.stringify({ baseline: +e.result.baseline.toFixed(3), threshold: +e.result.threshold.toFixed(3), reopen: +e.result.reopen.toFixed(3), n: e.result.stats.n, min: +e.result.stats.min.toFixed(3), p10: +e.result.stats.p10.toFixed(3), p50: +e.result.stats.p50.toFixed(3) }) : e.reason || ''); });
  engine.on('select', e => console.log(`[engine] SELECT ${e.durationMs.toFixed(0)} ms`));
  engine.on('rest', () => console.log('[engine] REST')); engine.on('resume', e => console.log(`[engine] RESUME ${e.durationMs.toFixed(0)} ms`));
  engine.on('ambiguous', e => console.log(`[engine] ambiguous ${e.reason} ${e.durationMs.toFixed(0)} ms (min sig ${e.minSig?.toFixed(3)} vs confirm ${e.threshold?.toFixed(3)})`));
  engine.on('select', e => console.log(`[engine]   (select min sig ${e.minSig?.toFixed(3)})`));
  // Presage's binary blink flag: log every transition so it can be lined up with EAR dips.
  let lastFlag = null;
  engine.on('frame', fr => { if (fr.blink !== lastFlag) { lastFlag = fr.blink; console.log(`[presage] blinkFlag -> ${fr.blink} (ear ${fr.ear?.toFixed(3)})`); } });
  engine.on('gaze', e => console.log(`[engine] gaze -> ${e.direction} (${e.x.toFixed(3)})`));
  engine.on('warning', e => console.log(`[engine] warning ${e.code} ${e.active ? 'ON' : 'off'} — ${e.message}`));
  engine.on('facelost', () => console.log('[engine] face lost')); engine.on('faceback', () => console.log('[engine] face back'));
  engine.on('vitals', v => console.log(`[presage] vitals pulse=${v.pulseBpm?.toFixed?.(0) ?? '—'} (${v.pulseConfidence?.toFixed?.(0) ?? '—'}%) breathing=${v.breathingBpm?.toFixed?.(0) ?? '—'} (${v.breathingConfidence?.toFixed?.(0) ?? '—'}%)`));
  // TEMP diagnostic: per-frame iris position within each eye for frames 200-260
  // (0 = temple corner, 1 = nose corner). Steady gaze should give a steady value.
  engine.on('frame', fr => {
    if (!fr.landmarks || frames % 15) return;
    const lm = fr.landmarks, ratio = (i, t, n) => ((lm[i].x - lm[t].x) / (lm[n].x - lm[t].x)).toFixed(3);
    const ins = (i, t, n) => { const lo = Math.min(lm[t].y, lm[n].y) - 0.01, hi = Math.max(lm[t].y, lm[n].y) + 0.01; return lm[i].y > lo && lm[i].y < hi ? 'in' : 'OUT'; };
    console.log(`[iris] eyeRaw ${fr.gazeEye?.toFixed(3)} smoothed ${fr.gazeX?.toFixed(3)} dir ${fr.gaze} eyePx ${fr.eyePx?.toFixed(0)} via ${fr.gazeSource}`);
  });
  // Periodic one-line snapshot so the terminal shows what the tracker sees.
  let frames = 0, lastFrame = null;
  engine.on('frame', fr => { frames++; lastFrame = fr; });
  setInterval(() => {
    const f = lastFrame, r = v => v == null ? '—' : v.toFixed(3);
    const w = engine.getState().warnings, active = Object.keys(w).filter(k => w[k]);
    console.log(`[snap] frames=${frames} face=${f?.face} ear=${r(f?.ear)} sig=${r(f?.signal)} eye=${f?.eye} gaze=${f?.gaze} x=${r(f?.gazeX)} (eyes ${r(f?.gazeEye)} head ${r(f?.gazeHead)}) ${f?.videoWidth || 0}x${f?.videoHeight || 0} warnings=${active.join(',') || 'none'}`);
  }, 2000);
  // Start the gaze tracker on the same <video> once Presage has attached its stream.
  const videoEl = $('video');
  const startGaze = async () => {
    if (!videoEl.videoWidth) { setTimeout(startGaze, 200); return; }
    try { await gazeTracker.start(videoEl, m => console.log(`[gaze] ${m}`)); }
    catch (e) { console.error('[gaze] failed to start:', e.message || e); $('warn').textContent = 'Gaze tracker failed to start: ' + (e.message || e); }
  };
  engine.on('status', e => { if (e.phase === 'running') startGaze(); });
  setInterval(() => console.log(`[gaze] fps=${gazeTracker.fps} inference=${gazeTracker.inferenceMs.toFixed(0)}ms latest=${gazeTracker.latest() ? 'ok' : 'none'}`), 5000);
  initYesNo(engine, { getCrop: () => source.crop });
})();

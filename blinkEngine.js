/**
 * blinkEngine.js — Tacit blink + gaze detection core.
 *
 * Source-agnostic: it consumes per-frame face landmarks from a pluggable
 * "frame source" and turns them into eye events. The product source is
 *   presageSource.js — Presage SmartSpectra SDK (Electron): 478-point face mesh
 *                      (MediaPipe numbering), a binary blink flag, and vitals.
 *
 * Turns a webcam feed into three kinds of intentional eye events:
 *   'select'  a deliberate blink (eyes closed SELECT_MIN_MS..SELECT_MAX_MS)
 *   'rest'    eyes held closed >= REST_MIN_MS (fires while still closed)
 *   'resume'  eyes reopened after a rest
 * Natural blinks (< IGNORE_MAX_MS) are silently discarded.
 * Plus horizontal gaze = iris rotation + head yaw (so turning the head toward
 * a target counts as looking at it):
 *   'gaze'    { direction: 'left'|'center'|'right', x } when the direction changes
 *             (x: negative = looking to the user's LEFT, positive = RIGHT; the
 *             sign is fixed by geometry, not by calibration)
 *   Call engine.setGazeReference({ centerX }) with the x measured while the user
 *   looks straight at the screen center; left/right are then |x - centerX| >
 *   gazeDeadZone. Without it, 0 is used as center.
 *
 * USAGE
 *   import { createBlinkEngine } from './blinkEngine.js';
 *   import { createPresageSource } from './presageSource.js';
 *   const engine = createBlinkEngine({ source: createPresageSource({ apiKey }) });
 *   engine.on('select', e => console.log('select', e.durationMs));
 *   engine.on('rest',   e => ...);  engine.on('resume', e => ...);
 *   engine.on('calibration', e => ...);            // phase: countdown|sampling|done|failed
 *   engine.on('facelost', ...); engine.on('faceback', ...);
 *   engine.on('warning', e => ...);                // { code, active, message }
 *   engine.on('frame', e => ...);                  // per-frame signals + landmarks (for overlays)
 *   await engine.start(videoElement);              // requests camera, loads model, starts
 *   engine.calibrate();                            // re-run calibration any time
 *
 * PRODUCT REQUIREMENT: the <video> element you pass to start() must stay
 * visible and mirrored (CSS transform: scaleX(-1)) for as long as the engine
 * runs. The source attaches the camera stream to it; nothing ever hides it.
 *
 * FRAME SOURCE CONTRACT (what a source must implement):
 *   { name, async start(videoEl, onFrame, onStatus), async stop() }
 *   onFrame({ t, landmarks, blink, lookDown, gazeBlend, vitals? })
 *     t          ms, monotonic (performance.now() time base)
 *     landmarks  array of 478 {x,y} normalized 0-1 (MediaPipe numbering), or null if no face
 *     blink      0-1 closed-ness score, or null if the source has none (EAR-only then)
 *     blinkFlag  true on frames where the source's own blink detector fired (optional)
 *     gazeLandmarks  optional higher-precision 478-point set used ONLY for gaze (hybrid mode)
 *     lookDown   0-1 or null;  gazeBlend  fallback gaze -1..1 or null
 *     vitals     optional { pulseBpm, breathingBpm, ... } — re-emitted as a 'vitals' event
 */

// =====================================================================
// TUNABLE CONSTANTS — every one of these can be overridden via
// createBlinkEngine({ ... }). Adjust from real testing, not theory.
// =====================================================================
export const DEFAULT_CONFIG = {
  // --- Frame source (required) — see presageSource.js ---
  source: null,

  // --- Eye-closure signal ---
  // 'combined':   mean of openness (1 - MediaPipe blink score) and EAR, each
  //               normalized to its calibrated open-eye baseline (~1.0 open).
  //               Measured: closed ~0.2-0.3, look-down ~0.4-0.6, squint ~0.7.
  // 'blendshape': openness only. Pose-aware but a full closure may only reach
  //               blink ~0.6-0.7 on some faces, close to look-down (~0.55).
  // 'ear':        geometric eye aspect ratio only. Looking down reads as closed.
  signalMode: 'combined',

  // --- Calibration ---
  calibrationMs: 8000,           // sampling window (user blinks naturally)
  calibrationCountdownMs: 2000,  // "get ready" delay before sampling
  baselinePercentile: 0.90,      // baseline = this percentile of samples
  calibrationMinSamples: 10,     // fewer than this => calibration failed
  autoCalibrate: true,           // run calibration automatically on start()

  // --- Thresholds (as a ratio of the calibrated baseline), per signal mode ---
  // inner/confirm: a closure only COUNTS if the signal dips below this.
  thresholdRatio: { combined: 0.35, blendshape: 0.40, ear: 0.75 },
  // outer/timing: a closure is TIMED from when the signal drops below this
  // until it rises back above it (must be > thresholdRatio). Wide so the
  // measured duration covers the whole blink, not just its deepest part.
  reopenRatio:    { combined: 0.70, blendshape: 0.55, ear: 0.85 },

  // If the source provides a binary blink flag (Presage: a short pulse at the
  // deepest point of every blink), a closure candidate is also confirmed when
  // the flag fires during it — vendor blink detection decides "was that a
  // blink", EAR only measures how long the eyes were shut.
  confirmWithBlinkFlag: true,

  // --- Debounce (frames) ---
  closedDebounceFrames: 2,       // consecutive frames below outer line to start
  openDebounceFrames: 2,         // consecutive frames above outer line to end

  // --- Blink zones (closed-eye duration, ms) ---
  ignoreMaxMs: 180,              // < this: natural blink, silent (natural ~150-210 measured)
  selectMinMs: 250,              // select zone — a soft "close, one-beat, open" blink
  selectMaxMs: 1000,
  restMinMs: 1200,               // >= this: rest (fires while still closed)
  // gaps (ignoreMax..selectMin, selectMax..restMin) emit 'ambiguous', no action

  // --- Gaze (iris rotation + head yaw; see irisGaze / headYaw / gazeTick) ---
  gazeHeadGain: 2.5,             // how much head yaw contributes vs eye rotation (0 = eyes only)
  gazeMedianWindow: 7,           // median of the last N raw readings: rejects single-frame jumps, follows a real move in ~N/2 frames
  gazeSmoothing: 0.5,            // light EMA after the median (1 = none)
  gazeDeadZone: 0.06,            // |x - centerX| above this => left/right. Eyes-only, far-left/right targets measured ~+-0.12
  gazeExitFrac: 0.5,             // hysteresis: once left/right, return to 'center' only when |x - centerX| < deadZone * this
  gazeDwellMs: 200,              // new direction must persist this long before 'gaze' fires
  gazeFreezeWhileClosing: true,  // ignore gaze while the eye is closing/closed (blinks jerk the iris)
  gazeFreezeAfterReopenMs: 350,  // ...and for this long after the eyes reopen (lids settling)

  // --- Robustness ---
  faceLostAbortMs: 300,          // in-progress closure aborted if face gone this long
  faceLostPauseMs: 500,          // emit 'facelost' after this long without a face
  faceBackStableMs: 300,         // face must be back this long before 'faceback'
  lightCheckMs: 500,             // how often to sample frame brightness
  lowLightLuma: 40,              // mean luma (0-255) below this => 'low_light'
  faceMinWidthFrac: 0.05,        // eye-corner span / frame width below this => 'face_small' (Presage runs 1280 wide)
  eyeMinWidthPx: 50,             // single eye corner-to-corner width in pixels below this => 'too_far' (gaze needs pixels)
  flickerWindowMs: 3000,         // 'unstable_tracking' if face presence flips
  flickerMaxFlips: 6,            //   more than this many times in the window
  suppressEventsWhenDegraded: true, // no select/rest events while a warning is active

};

// MediaPipe mesh indices for the 6-point EAR: [p1 inner corner, p2, p3 upper
// lid, p4 outer corner, p5, p6 lower lid]. EAR = (|p2-p6| + |p3-p5|) / (2|p1-p4|)
export const LEFT_EYE_IDX  = [362, 385, 387, 263, 373, 380];
export const RIGHT_EYE_IDX = [33, 160, 158, 133, 153, 144];

// =====================================================================
// END TUNABLES
// =====================================================================

export function createBlinkEngine(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides,
    thresholdRatio: { ...DEFAULT_CONFIG.thresholdRatio, ...(overrides.thresholdRatio || {}) },
    reopenRatio:    { ...DEFAULT_CONFIG.reopenRatio,    ...(overrides.reopenRatio    || {}) },
  };
  if (!cfg.source || typeof cfg.source.start !== 'function') throw new Error('createBlinkEngine: a frame source is required (see presageSource.js)');
  const THRESHOLD_RATIO = cfg.thresholdRatio[cfg.signalMode];
  const REOPEN_RATIO    = cfg.reopenRatio[cfg.signalMode];
  if (!(REOPEN_RATIO > THRESHOLD_RATIO)) throw new Error('reopenRatio must be > thresholdRatio');

  // --- Event emitter ---------------------------------------------------
  const listeners = new Map();
  function on(name, fn)  { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => off(name, fn); }
  function off(name, fn) { listeners.get(name)?.delete(fn); }
  function emit(name, payload) {
    const set = listeners.get(name); if (!set) return;
    for (const fn of set) { try { fn(payload); } catch (e) { console.error(`blinkEngine listener for '${name}' threw`, e); } }
  }

  // --- State -----------------------------------------------------------
  let video = null, running = false;
  const lumaCanvas = document.createElement('canvas'); lumaCanvas.width = 32; lumaCanvas.height = 24;
  const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });

  const calib = {
    phase: 'idle',        // idle | countdown | sampling | done | failed
    startAt: 0,
    rawOpen: [], rawEar: [],
    baseOpen: null, baseEar: null,
    baseline: null, threshold: null, reopen: null,
    samples: null, stats: null,
  };
  const det = {
    closed: false, confirmed: false, closedSince: 0,
    belowFrames: 0, aboveFrames: 0, restFired: false, minSig: Infinity,
    lastFrameAt: 0, frameMs: 1000 / 30,
  };
  const face = {
    present: false, lastSeenAt: 0, lastLostAt: 0, paused: false,
    flips: [],            // timestamps of presence changes (for flicker)
  };
  const warnings = { low_light: false, face_small: false, unstable_tracking: false, too_far: false };
  const gaze = { x: 0, direction: 'center', candidate: 'center', candidateSince: 0,
                 ref: null,     // { centerX } once calibrated
                 frozenUntil: 0, window: [] };
  let lastLightCheckAt = 0;
  let selectCount = 0, restCount = 0;

  // --- Math ------------------------------------------------------------
  function dist(a, b) {
    return Math.hypot((a.x - b.x) * video.videoWidth, (a.y - b.y) * video.videoHeight);
  }
  function eyeAspectRatio(lm, idx) {
    const [p1, p2, p3, p4, p5, p6] = idx.map(i => lm[i]);
    const h = dist(p1, p4);
    return h === 0 ? 0 : (dist(p2, p6) + dist(p3, p5)) / (2 * h);
  }
  // Horizontal gaze from iris landmarks. For each eye, where the iris center
  // sits between the two corners (0 = temple side, 1 = nose side). Looking to
  // the user's right pulls the right iris toward the temple and the left iris
  // toward the nose, so (leftRatio - rightRatio) is positive. Range ~ +-0.3.
  // Indices: right eye corners 33 (temple) / 133 (nose), iris 468;
  //          left eye corners 263 (temple) / 362 (nose), iris 473.
  function irisGaze(lm) {
    if (lm.length < 478) return null; // model without iris landmarks
    // Iris center = mean of the 5 iris points (center + 4 rim). Sources that
    // round landmarks to whole pixels (Presage) make a single point step in
    // ~1/eye-width increments; averaging 5 points recovers sub-pixel precision.
    const mean = (a, b) => { let x = 0, y = 0; for (let i = a; i <= b; i++) { x += lm[i].x; y += lm[i].y; } const n = b - a + 1; return { x: x / n, y: y / n }; };
    // Project the iris center onto the temple->nose axis of its eye (0 temple,
    // 1 nose), so head roll doesn't skew the reading.
    const ratio = (iris, temple, nose) => {
      const ax = lm[nose].x - lm[temple].x, ay = lm[nose].y - lm[temple].y;
      const len2 = ax * ax + ay * ay;
      if (len2 < 1e-9) return 0.5;
      return ((iris.x - lm[temple].x) * ax + (iris.y - lm[temple].y) * ay) / len2;
    };
    const r = ratio(mean(468, 472), 33, 133);   // 0 temple .. 1 nose
    const l = ratio(mean(473, 477), 263, 362);  // 0 temple .. 1 nose
    // Looking to the user's LEFT (image-right, since the camera is unmirrored):
    // right iris -> nose (r->1), left iris -> temple (l->0)  =>  l - r negative.
    return l - r;
  }
  // Head yaw proxy: nose tip (1) offset from the midpoint of the outer eye
  // corners (33, 263), as a fraction of their span. Head turned to the user's
  // LEFT pushes the nose image-right (+x), so negate to match irisGaze's sign.
  function headYaw(lm) {
    const midX = (lm[33].x + lm[263].x) / 2, span = Math.abs(lm[263].x - lm[33].x);
    return span < 1e-6 ? 0 : -(lm[1].x - midX) / span;
  }
  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
  }
  function combinedSignal(openness, ear) {
    if (openness === null || ear === null || !calib.baseOpen || !calib.baseEar) return null;
    return 0.5 * (openness / calib.baseOpen + ear / calib.baseEar);
  }
  function activeSignal(openness, ear) {
    if (cfg.signalMode === 'blendshape') return openness;
    if (cfg.signalMode === 'ear') return ear;
    if (openness === null) return ear; // source has no blink score: fall back to EAR (still calibrated)
    return combinedSignal(openness, ear);
  }

  // --- Calibration -----------------------------------------------------
  function calibrate() {
    calib.phase = 'countdown';
    calib.startAt = performance.now() + cfg.calibrationCountdownMs;
    calib.rawOpen = []; calib.rawEar = [];
    calib.baseOpen = calib.baseEar = calib.baseline = calib.threshold = calib.reopen = null;
    calib.samples = calib.stats = null;
    resetDetection();
    emit('calibration', { phase: 'countdown', remainingMs: cfg.calibrationCountdownMs, sampleCount: 0 });
  }
  function calibrationTick(openness, ear, now) {
    if (calib.phase === 'countdown') {
      const left = calib.startAt - now;
      emit('calibration', { phase: 'countdown', remainingMs: Math.max(0, left), sampleCount: 0 });
      if (left <= 0) calib.phase = 'sampling';
    } else if (calib.phase === 'sampling') {
      const elapsed = now - calib.startAt;
      if (ear !== null) { calib.rawOpen.push(openness === null ? 1 : openness); calib.rawEar.push(ear); }
      emit('calibration', { phase: 'sampling', remainingMs: Math.max(0, cfg.calibrationMs - elapsed), sampleCount: calib.rawOpen.length });
      if (elapsed >= cfg.calibrationMs) finishCalibration();
    }
  }
  function finishCalibration() {
    const n = calib.rawOpen.length;
    if (n < cfg.calibrationMinSamples) {
      calib.phase = 'failed';
      emit('calibration', { phase: 'failed', sampleCount: n, reason: 'too few samples (face not tracked?)' });
      return;
    }
    const so = [...calib.rawOpen].sort((a, b) => a - b);
    const se = [...calib.rawEar].sort((a, b) => a - b);
    calib.baseOpen = percentile(so, cfg.baselinePercentile);
    calib.baseEar  = percentile(se, cfg.baselinePercentile);
    const samples = calib.rawOpen.map((o, i) => activeSignal(o, calib.rawEar[i]));
    const sorted = samples.sort((a, b) => a - b);
    calib.baseline  = percentile(sorted, cfg.baselinePercentile);
    calib.threshold = calib.baseline * THRESHOLD_RATIO;
    calib.reopen    = calib.baseline * REOPEN_RATIO;
    calib.samples = sorted;
    calib.stats = { n, min: sorted[0], p10: percentile(sorted, .1), p50: percentile(sorted, .5),
                    p90: percentile(sorted, .9), max: sorted[n - 1] };
    calib.phase = 'done';
    emit('calibration', { phase: 'done', sampleCount: n, result: calibrationResult() });
  }
  function calibrationResult() {
    return { baseline: calib.baseline, threshold: calib.threshold, reopen: calib.reopen,
             baseOpen: calib.baseOpen, baseEar: calib.baseEar, stats: calib.stats, samples: calib.samples,
             thresholdRatio: THRESHOLD_RATIO, reopenRatio: REOPEN_RATIO };
  }

  // --- Detection -------------------------------------------------------
  function resetDetection() {
    det.closed = det.confirmed = det.restFired = false;
    det.belowFrames = det.aboveFrames = 0;
  }
  // too_far only degrades gaze precision, not blink detection, so it does not suppress events.
  function degraded() { return cfg.suppressEventsWhenDegraded && (warnings.low_light || warnings.face_small || warnings.unstable_tracking); }

  function detectionTick(sig, now, blinkFlag = false) {
    if (calib.phase !== 'done' || face.paused) return;
    if (det.lastFrameAt) det.frameMs = 0.9 * det.frameMs + 0.1 * (now - det.lastFrameAt);
    det.lastFrameAt = now;
    if (sig === null) return;

    const belowOuter = sig < calib.reopen, aboveOuter = sig > calib.reopen, belowInner = sig < calib.threshold;
    det.belowFrames = belowOuter ? det.belowFrames + 1 : 0;
    det.aboveFrames = aboveOuter ? det.aboveFrames + 1 : 0;

    if (!det.closed && det.belowFrames >= cfg.closedDebounceFrames) {
      det.closed = true; det.confirmed = belowInner || (cfg.confirmWithBlinkFlag && blinkFlag); det.restFired = false; det.minSig = sig;
      det.closedSince = now - (cfg.closedDebounceFrames - 1) * det.frameMs;
    } else if (det.closed && det.aboveFrames < cfg.openDebounceFrames) {
      if (sig < det.minSig) det.minSig = sig;
      if (belowInner || (cfg.confirmWithBlinkFlag && blinkFlag)) det.confirmed = true;
      if (det.confirmed && !det.restFired && now - det.closedSince >= cfg.restMinMs) {
        det.restFired = true;
        if (!degraded()) { restCount++; emit('rest', { t: now, sinceMs: now - det.closedSince }); }
      }
    } else if (det.closed) {
      det.closed = false;
      const dur = (now - (cfg.openDebounceFrames - 1) * det.frameMs) - det.closedSince;
      classifyClosure(dur, now);
    }
  }
  function classifyClosure(dur, now) {
    const minSig = det.minSig, threshold = calib.threshold;
    if (!det.confirmed) {
      if (dur >= cfg.ignoreMaxMs) emit('ambiguous', { t: now, durationMs: dur, reason: 'shallow', minSig, threshold });
      return;
    }
    if (det.restFired) { emit('resume', { t: now, durationMs: dur, minSig }); return; }
    if (dur < cfg.ignoreMaxMs) return; // natural blink: intentionally silent
    if (degraded()) { emit('ambiguous', { t: now, durationMs: dur, reason: 'degraded', minSig, threshold }); return; }
    if (dur >= cfg.selectMinMs && dur <= cfg.selectMaxMs) {
      selectCount++; emit('select', { t: now, durationMs: dur, minSig });
    } else {
      emit('ambiguous', { t: now, durationMs: dur, reason: 'gap', minSig, threshold });
    }
  }

  // --- Gaze ------------------------------------------------------------
  function setGazeReference(ref) {
    gaze.ref = ref && Number.isFinite(ref.centerX) ? { centerX: ref.centerX } : null;
  }
  function gazeTick(rawX, now) {
    if (rawX === null) return;
    if (cfg.gazeFreezeWhileClosing && det.closed) { gaze.frozenUntil = now + cfg.gazeFreezeAfterReopenMs; return; }
    if (now < gaze.frozenUntil) return;
    gaze.window.push(rawX); if (gaze.window.length > cfg.gazeMedianWindow) gaze.window.shift();
    const sorted = [...gaze.window].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    gaze.x = gaze.x + cfg.gazeSmoothing * (med - gaze.x);
    const d = gaze.x - (gaze.ref ? gaze.ref.centerX : 0);
    let dir = d > cfg.gazeDeadZone ? 'right' : d < -cfg.gazeDeadZone ? 'left' : 'center';
    // Hysteresis: stay on the current side until the gaze is clearly back near center.
    if (dir === 'center' && gaze.direction !== 'center' && Math.abs(d) > cfg.gazeDeadZone * cfg.gazeExitFrac) dir = gaze.direction;
    if (dir !== gaze.candidate) { gaze.candidate = dir; gaze.candidateSince = now; }
    if (dir !== gaze.direction && now - gaze.candidateSince >= cfg.gazeDwellMs) {
      gaze.direction = dir;
      emit('gaze', { t: now, direction: dir, x: gaze.x });
    }
  }

  // --- Robustness: face presence, lighting, tracking stability ---------
  function facePresenceTick(present, now) {
    if (present !== face.present) {
      face.present = present;
      face.flips.push(now);
      if (present) face.lastSeenAt = now; else face.lastLostAt = now;
    }
    if (present) face.lastSeenAt = now;
    face.flips = face.flips.filter(t => now - t <= cfg.flickerWindowMs);
    setWarning('unstable_tracking', face.flips.length > cfg.flickerMaxFlips,
               'Face tracking is flickering — check lighting / move closer');

    if (!present) {
      const gone = now - face.lastSeenAt;
      if (det.closed && gone >= cfg.faceLostAbortMs) resetDetection(); // drop half-measured closure silently
      if (!face.paused && gone >= cfg.faceLostPauseMs) { face.paused = true; emit('facelost', { t: now }); }
    } else if (face.paused && now - face.lastLostAt >= cfg.faceBackStableMs) {
      face.paused = false; resetDetection(); emit('faceback', { t: now });
    }
  }
  function lightingTick(now) {
    if (now - lastLightCheckAt < cfg.lightCheckMs) return;
    lastLightCheckAt = now;
    try {
      lumaCtx.drawImage(video, 0, 0, lumaCanvas.width, lumaCanvas.height);
      const d = lumaCtx.getImageData(0, 0, lumaCanvas.width, lumaCanvas.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const luma = sum / (d.length / 4);
      setWarning('low_light', luma < cfg.lowLightLuma, `Low light (brightness ${luma.toFixed(0)}/255) — tracking may be unreliable`);
      return luma;
    } catch (_) { return null; }
  }
  function faceSizeCheck(lm) {
    const span = dist(lm[33], lm[263]) / video.videoWidth; // outer eye corners
    setWarning('face_small', span < cfg.faceMinWidthFrac, 'Face is small in frame — move closer to the camera');
    const eyePx = (dist(lm[33], lm[133]) + dist(lm[263], lm[362])) / 2;
    lastEyePx = eyePx;
    // 15% hysteresis so the warning doesn't flicker at the boundary
    const tooFar = warnings.too_far ? eyePx < cfg.eyeMinWidthPx * 1.15 : eyePx < cfg.eyeMinWidthPx;
    setWarning('too_far', tooFar, `Eyes are only ${eyePx.toFixed(0)} px wide — sit closer for reliable gaze (need ≥ ${cfg.eyeMinWidthPx})`);
  }
  let lastEyePx = 0;
  function setWarning(code, active, message) {
    if (warnings[code] === active) return;
    warnings[code] = active;
    emit('warning', { code, active, message });
  }

  // --- Per-frame processing (called by the source) ---------------------
  function processFrame(src) {
    if (!running) return;
    if (src.error) { emit('error', { error: src.error }); return; }
    if (!video.videoWidth) return; // stream not up yet; EAR needs pixel dims
    const now = src.t;
    const lm = src.landmarks && src.landmarks.length >= 468 ? src.landmarks : null;
    if (src.vitals) emit('vitals', { t: now, ...src.vitals });
    const frame = { t: now, face: !!lm, ear: null, earL: null, earR: null, blink: null, lookDown: null,
                    gazeX: null, gazeRaw: null, gazeEye: null, gazeHead: null, gaze: gaze.direction,
                    openness: null, combined: null, signal: null, landmarks: lm,
                    eyeIdx: { left: LEFT_EYE_IDX, right: RIGHT_EYE_IDX },
                    videoWidth: video.videoWidth, videoHeight: video.videoHeight };

    if (lm) {
      frame.earL = eyeAspectRatio(lm, LEFT_EYE_IDX);
      frame.earR = eyeAspectRatio(lm, RIGHT_EYE_IDX);
      frame.ear  = (frame.earL + frame.earR) / 2;
      frame.blink = src.blink ?? null; frame.lookDown = src.lookDown ?? null;
      const gazeLm = src.gazeLandmarks && src.gazeLandmarks.length >= 478 ? src.gazeLandmarks : lm;
      const eye = irisGaze(gazeLm), head = headYaw(lm);
      frame.gazeSource = gazeLm === lm ? 'source' : 'hybrid';
      frame.gazeEye = eye !== null ? eye : (src.gazeBlend ?? 0);   // fall back to blendshapes if no iris
      frame.gazeHead = head;
      frame.gazeRaw = frame.gazeEye + cfg.gazeHeadGain * head;
      frame.openness = frame.blink === null ? null : 1 - frame.blink;
      frame.combined = combinedSignal(frame.openness, frame.ear);
      frame.signal = activeSignal(frame.openness, frame.ear);
      faceSizeCheck(lm);
    }

    facePresenceTick(!!lm, now);
    lightingTick(now);
    calibrationTick(frame.openness, frame.ear, now);
    detectionTick(frame.signal, now, src.blinkFlag === true);
    if (lm) gazeTick(frame.gazeRaw, now);   // after detection so det.closed is current
    frame.gazeX = gaze.x; frame.gaze = gaze.direction; frame.gazeRef = gaze.ref;

    frame.blinkFlag = src.blinkFlag === true;
    frame.eyePx = lastEyePx;
    frame.eye = det.closed ? (det.confirmed ? 'closed' : 'closing') : 'open';
    frame.closedFor = det.closed ? now - det.closedSince : 0;
    frame.paused = face.paused;
    frame.degraded = degraded();
    emit('frame', frame);
  }

  // --- Lifecycle -------------------------------------------------------
  async function start(videoEl) {
    if (running) return;
    if (!(videoEl instanceof HTMLVideoElement)) throw new Error('start(videoEl): pass the <video> element that will display the camera');
    video = videoEl;
    running = true;
    await cfg.source.start(video, processFrame, message => emit('status', { phase: 'starting', message }));
    emit('status', { phase: 'running', message: `running (source: ${cfg.source.name})` });
    if (cfg.autoCalibrate) calibrate();
  }
  async function stop() {
    running = false;
    await cfg.source.stop();
  }
  function getState() {
    return { running, calibration: calib.phase, calibrationResult: calib.phase === 'done' ? calibrationResult() : null,
             eye: det.closed ? (det.confirmed ? 'closed' : 'closing') : 'open',
             facePresent: face.present, paused: face.paused, warnings: { ...warnings }, degraded: degraded(),
             gaze: gaze.direction, gazeX: gaze.x, gazeRef: gaze.ref,
             selectCount, restCount, source: cfg.source.name, config: cfg };
  }

  return { start, stop, calibrate, setGazeReference, on, off, getState, config: cfg,
           LEFT_EYE_IDX, RIGHT_EYE_IDX };
}

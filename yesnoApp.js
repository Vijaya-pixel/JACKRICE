/**
 * yesnoApp.js — the bare-bones Yes/No selection test UI (Milestone 6), shared
 * by the browser page (MediaPipe source) and the Electron app (Presage source).
 *
 *   import { initYesNo } from './yesnoApp.js';
 *   initYesNo(engine);   // engine = createBlinkEngine({ source })
 *
 * Expects the DOM from yesno-test.html / yesno-electron.html.
 */
export function initYesNo(engine, opts = {}) {
  // --- Tunables for this harness -------------------------------------------
  // 'gaze': highlight follows where you look (left = Yes, right = No).
  // 'scan': highlight alternates on a timer.
  const HIGHLIGHT_MODE = 'gaze';
  const SCAN_INTERVAL_MS = 1500;   // scan mode only
  // Dwell-to-select (gaze mode): keep looking at a box this long and it selects
  // itself. 0 = off: ONE deliberate blink selects the highlighted box.
  const DWELL_MS = 0;
  // Gaze centering: how long the user looks at the video (screen center) to
  // measure their resting "center" value, and how much of the start to discard.
  const GAZE_CAL_MS = 2000;
  const GAZE_CAL_SKIP_MS = 500;

  const $ = id => document.getElementById(id);
  const boxes = [$('yes'), $('no')];
  const overlay = $('overlay'), octx = overlay.getContext('2d');

  // Landmark overlay: EAR eye points (cyan = your left eye, magenta = your right),
  // iris centers in yellow, and the eye-corner span the gaze is measured against.
  function drawOverlay(fr) {
    if (overlay.width !== fr.videoWidth) { overlay.width = fr.videoWidth; overlay.height = fr.videoHeight; }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const lm = fr.landmarks; if (!lm) return;
    const X = p => p.x * overlay.width, Y = p => p.y * overlay.height;
    const dot = (i, color, r) => { octx.fillStyle = color; octx.beginPath(); octx.arc(X(lm[i]), Y(lm[i]), r, 0, Math.PI * 2); octx.fill(); };
    for (const i of fr.eyeIdx.left)  dot(i, '#00e5ff', 3);
    for (const i of fr.eyeIdx.right) dot(i, '#ff4dff', 3);
    if (lm.length >= 478) {
      // corner-to-corner line each iris is measured along, then the iris center
      octx.strokeStyle = 'rgba(255,255,255,0.5)'; octx.lineWidth = 1;
      for (const [a, b] of [[33, 133], [263, 362]]) { octx.beginPath(); octx.moveTo(X(lm[a]), Y(lm[a])); octx.lineTo(X(lm[b]), Y(lm[b])); octx.stroke(); }
      dot(468, '#ffd54a', 5); dot(473, '#ffd54a', 5);
    }
    // the region being fed to Presage (zoom crop)
    if (opts.getCrop) {
      const c = opts.getCrop();
      if (c && c.w < 1) { octx.strokeStyle = 'rgba(255,213,74,0.8)'; octx.lineWidth = 2; octx.strokeRect(c.x * overlay.width, c.y * overlay.height, c.w * overlay.width, c.h * overlay.height); }
    }
    // gaze direction tag, drawn un-mirrored so the text reads correctly
    octx.save(); octx.scale(-1, 1);
    octx.fillStyle = fr.eye === 'open' ? '#fff' : '#f66'; octx.font = 'bold 20px system-ui';
    octx.fillText(`gaze: ${fr.gaze}   eye: ${fr.eye}`, -overlay.width + 10, 28);
    octx.restore();
  }
  let current = 0, scanTimer = null, chosen = null, ready = false;
  let dwellMs = 0, dwellLastT = null;

  function sendTelemetry() {} // diagnostics go to the terminal via renderer.js

  // --- Highlight / selection -------------------------------------------------
  function setHighlight(i) {
    boxes.forEach((b, j) => b.classList.toggle('highlight', j === i));
    dwellMs = 0; dwellLastT = null;
    boxes.forEach(b => { if (!b.classList.contains('chosen')) b.querySelector('small').textContent = ''; });
  }
  function startRound() {
    stopScan();
    chosen = null;
    boxes.forEach(b => { b.classList.remove('chosen', 'target'); b.querySelector('small').textContent = ''; });
    $('result').textContent = '—';
    current = -1; setHighlight(current);   // nothing highlighted until the eyes go to a box
    if (HIGHLIGHT_MODE === 'scan') {
      current = 0; setHighlight(current);
      scanTimer = setInterval(() => { current = (current + 1) % boxes.length; setHighlight(current); }, SCAN_INTERVAL_MS);
      $('state').textContent = 'scanning';
    } else {
      $('state').textContent = DWELL_MS
        ? `look at a box and hold your gaze ${DWELL_MS / 1000}s — or blink — to select`
        : 'look at Yes or No, then blink once to select';
    }
    sendTelemetry({ t: 'event', cls: 'round', text: 'round started' });
  }
  function stopScan() { if (scanTimer) clearInterval(scanTimer); scanTimer = null; }
  function onGaze(direction) {
    if (HIGHLIGHT_MODE !== 'gaze' || chosen !== null || !ready) return;
    if (direction === 'left'  && current !== 0) { current = 0; setHighlight(current); }
    if (direction === 'right' && current !== 1) { current = 1; setHighlight(current); }
  }
  function dwellTick(fr) {
    if (HIGHLIGHT_MODE !== 'gaze' || !DWELL_MS || chosen !== null || !ready || current < 0) return;
    const side = current === 0 ? 'left' : 'right';
    if (fr.gaze === side && fr.eye === 'open' && !fr.paused) {
      if (dwellLastT !== null) dwellMs += fr.t - dwellLastT;
      dwellLastT = fr.t;
    } else dwellLastT = null;
    const pct = Math.min(100, Math.round(dwellMs / DWELL_MS * 100));
    boxes[current].querySelector('small').textContent = pct > 0 ? `hold… ${pct}%` : '';
    if (dwellMs >= DWELL_MS) choose('dwell');
  }
  function choose(how) {
    if (chosen !== null || current < 0) return;   // nothing highlighted: a blink does nothing
    stopScan();
    chosen = current;
    const b = boxes[chosen];
    b.classList.remove('highlight'); b.classList.add('chosen');
    b.querySelector('small').textContent = `SELECTED (${how})`;
    $('result').textContent = b.id.toUpperCase();
    $('state').textContent = 'locked — press Reset';
    sendTelemetry({ t: 'event', cls: 'choose', text: `${b.id.toUpperCase()} via ${how}` });
  }

  // --- Gaze centering: look at the video (screen center) -------------------------
  // Left/right are fixed by geometry in the engine; this only measures the user's
  // resting center so an off-center camera or seating position doesn't bias it.
  const gcal = { active: false, startAt: 0, samples: [], center: null };
  function calibrateGaze() {
    ready = false; stopScan();
    boxes.forEach(b => { b.classList.remove('highlight', 'chosen', 'target'); b.querySelector('small').textContent = ''; });
    gcal.active = true; gcal.startAt = performance.now(); gcal.samples = [];
    $('lookhere').style.display = 'block';
    $('calib').textContent = 'gaze centering: look at the video…';
  }
  function gazeCalTick(fr) {
    if (!gcal.active) return;
    const el = fr.t - gcal.startAt;
    if (el > GAZE_CAL_SKIP_MS && fr.face && fr.gazeRaw !== null && fr.eye === 'open') gcal.samples.push(fr.gazeRaw);
    $('calib').textContent = `gaze centering: look at the video… ${((GAZE_CAL_MS - el) / 1000).toFixed(1)}s (${gcal.samples.length})`;
    if (el < GAZE_CAL_MS) return;
    gcal.active = false; $('lookhere').style.display = 'none';
    const sorted = gcal.samples.sort((a, b) => a - b);
    if (sorted.length < 10) { $('calib').textContent = 'gaze centering FAILED (face not tracked) — press Re-center gaze'; return; }
    gcal.center = sorted[Math.floor(sorted.length / 2)];
    engine.setGazeReference({ centerX: gcal.center });
    $('gazeRef').textContent = `center ${gcal.center.toFixed(3)} · dead zone ±${engine.config.gazeDeadZone}`;
    sendTelemetry({ t: 'gazecal', center: +gcal.center.toFixed(4) });
    $('calib').textContent = 'ready. Look at Yes or No to highlight it, then blink once to select. (Nothing is selected until you look.)';
    ready = true; startRound();
  }

  // --- Engine ------------------------------------------------------------------
  let lastTelemetryAt = 0;

  engine.on('calibration', e => {
    if (e.phase === 'countdown') { ready = false; stopScan(); $('calib').textContent = `blink calibration: get ready… ${(e.remainingMs / 1000).toFixed(1)}s`; }
    else if (e.phase === 'sampling') $('calib').textContent = `blink calibration: blink naturally… ${(e.remainingMs / 1000).toFixed(1)}s`;
    else if (e.phase === 'failed')   $('calib').textContent = `blink calibration FAILED: ${e.reason} — press Recalibrate blink`;
    else if (e.phase === 'done')     { if (gcal.center === null) calibrateGaze(); else { ready = true; startRound(); } }
  });
  engine.on('gaze', e => { onGaze(e.direction); sendTelemetry({ t: 'event', cls: 'gaze', text: `${e.direction} ${e.x.toFixed(3)}` }); });
  engine.on('frame', fr => {
    drawOverlay(fr);
    if (fr.gazeRaw !== null && fr.gazeRaw !== undefined) {
      $('gaze').textContent = `${fr.gaze}  x ${fr.gazeX.toFixed(3)}  (eyes ${fr.gazeEye.toFixed(3)} + head ${fr.gazeHead.toFixed(3)})`;
      $('eyeinfo').textContent = `EAR ${fr.ear?.toFixed(3) ?? '—'} · eye ${fr.eye} · presage blink ${fr.blinkFlag ? 'YES' : 'no'} · gaze via ${fr.gazeSource || '—'}`;
      drawBar(fr);
    }
    gazeCalTick(fr);
    dwellTick(fr);
    if (fr.t - lastTelemetryAt >= 250) {
      lastTelemetryAt = fr.t; const r = v => v == null ? null : +v.toFixed(3);
      sendTelemetry({ t: 'snap', face: fr.face, gazeRaw: r(fr.gazeRaw), gazeEye: r(fr.gazeEye), gazeHead: r(fr.gazeHead), gazeX: r(fr.gazeX), gaze: fr.gaze, eye: fr.eye,
        sig: r(fr.signal), highlight: current < 0 ? null : boxes[current].id, dwell: Math.round(dwellMs), chosen: chosen === null ? null : boxes[chosen].id,
        calib: engine.getState().calibration, gcal: gcal.active ? 1 : null });
    }
  });
  function drawBar(fr) {
    const c = fr.gazeRef ? fr.gazeRef.centerX : 0, dz = engine.config.gazeDeadZone, W = 400, lo = c - 0.4, hi = c + 0.4;
    const x = v => Math.max(0, Math.min(W, (v - lo) / (hi - lo) * W));
    $('dot').style.left = x(fr.gazeX) + 'px';
    $('mMid').style.left = x(c) + 'px';
    $('zone').style.left = x(c - dz) + 'px'; $('zone').style.width = (x(c + dz) - x(c - dz)) + 'px';
  }
  engine.on('select', e => { $('last').textContent = `SELECT ${e.durationMs.toFixed(0)} ms`; if (ready) choose('blink'); });
  engine.on('rest',   () => $('last').textContent = 'REST (eyes held closed)');
  engine.on('resume', e => $('last').textContent = `RESUME after ${e.durationMs.toFixed(0)} ms`);
  engine.on('ambiguous', e => $('last').textContent = `(ignored ${e.reason} closure ${e.durationMs.toFixed(0)} ms)`);
  engine.on('facelost', () => $('warn').textContent = 'Face not detected — detection paused');
  engine.on('faceback', () => $('warn').textContent = '');
  engine.on('warning', e => {
    const w = engine.getState().warnings, active = Object.keys(w).filter(k => w[k]);
    if (!engine.getState().paused) $('warn').textContent = active.length ? e.message : '';
  });
  engine.on('error', e => $('calib').textContent = 'ERROR: ' + (e.error.message || e.error));
  engine.on('status', e => { $('source').textContent = e.message; });
  engine.on('vitals', v => {
    const p = v.pulseBpm != null ? `${v.pulseBpm.toFixed(0)} bpm (${(v.pulseConfidence ?? 0).toFixed(0)}%)` : '—';
    const b = v.breathingBpm != null ? `${v.breathingBpm.toFixed(0)} br/min (${(v.breathingConfidence ?? 0).toFixed(0)}%)` : '—';
    $('vitals').textContent = `pulse ${p} · breathing ${b}`;
  });
  if (opts.onReady) opts.onReady({ engine });

  $('resetBtn').addEventListener('click', () => { if (ready) startRound(); });
  $('gazeCalBtn').addEventListener('click', () => { if (engine.getState().calibration === 'done') calibrateGaze(); });
  $('recalBtn').addEventListener('click', () => engine.calibrate());

    (async () => {
      try { await engine.start($('video')); }
      catch (err) { console.error(err); $('calib').textContent = 'ERROR: ' + (err.message || err); }
    })();
}

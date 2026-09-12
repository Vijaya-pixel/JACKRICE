/**
 * yesnoApp.js — blink-scanned AAC communication board.
 *
 * The engine still owns blink calibration and blink events. This UI scans a
 * 2 x 3 board one option at a time; a deliberate blink selects the active cell.
 */
export function initYesNo(engine, opts = {}) {
  const SCAN_INTERVAL_MS = 1500;
  const TYPE_OPTION = 'Type yourself';
  const FALLBACK_OPTIONS = [
    'Yes',
    'No',
    'I am in pain',
    'I need water',
    'Please reposition me',
  ];

  const $ = id => document.getElementById(id);
  const board = $('board');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  const messageLog = $('messageLog');
  const typePanel = $('typePanel');
  const customText = $('customText');
  const eyeTrackingToggle = $('eyeTrackingToggle');

  let options = [...FALLBACK_OPTIONS, TYPE_OPTION];
  let current = 0;
  let chosen = null;
  let ready = false;
  let scanTimer = null;
  let eyeTrackingEnabled = localStorage.getItem('tacit:eyeTracking') === '1';
  let lastTelemetryAt = 0;

  function sendTelemetry() {}

  function setStatus(text) {
    $('state').textContent = text;
  }

  function drawBoard() {
    board.innerHTML = '';
    options.forEach((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice';
      button.dataset.index = String(index);
      button.innerHTML = `<span class="choiceIndex">${index + 1}</span><span class="choiceText"></span><small></small>`;
      button.querySelector('.choiceText').textContent = label;
      button.addEventListener('click', () => {
        current = index;
        setHighlight(index);
        choose('manual');
      });
      board.appendChild(button);
    });
    setHighlight(current);
  }

  function cells() {
    return [...board.querySelectorAll('.choice')];
  }

  function setHighlight(index) {
    current = index;
    cells().forEach((cell, cellIndex) => {
      cell.classList.toggle('highlight', cellIndex === index);
      if (!cell.classList.contains('chosen')) cell.querySelector('small').textContent = '';
    });
    $('activeChoice').textContent = options[index] || 'none';
  }

  function startScan() {
    stopScan();
    chosen = null;
    typePanel.hidden = true;
    cells().forEach(cell => {
      cell.classList.remove('chosen');
      cell.querySelector('small').textContent = '';
    });
    if (current < 0 || current >= options.length) current = 0;
    setHighlight(current);
    scanTimer = setInterval(() => {
      if (!ready || chosen !== null) return;
      setHighlight((current + 1) % options.length);
    }, SCAN_INTERVAL_MS);
    setStatus('scanning');
    $('result').textContent = '-';
  }

  function stopScan() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
  }

  function appendMessage(text, how) {
    const item = document.createElement('li');
    item.innerHTML = `<strong></strong><span></span>`;
    item.querySelector('strong').textContent = text;
    item.querySelector('span').textContent = how ? `selected by ${how}` : '';
    if (messageLog.querySelector('.empty')) messageLog.innerHTML = '';
    messageLog.prepend(item);
  }

  function choose(how) {
    if (chosen !== null || current < 0) return;
    stopScan();
    chosen = current;
    const selected = options[chosen];
    const cell = cells()[chosen];
    cell.classList.remove('highlight');
    cell.classList.add('chosen');
    cell.querySelector('small').textContent = `SELECTED (${how})`;
    $('result').textContent = selected;
    setStatus(selected === TYPE_OPTION ? 'typing' : 'locked - press Reset');

    if (selected === TYPE_OPTION) {
      typePanel.hidden = false;
      customText.focus();
    } else {
      appendMessage(selected, how);
    }
    sendTelemetry({ t: 'event', cls: 'choose', text: `${selected} via ${how}` });
  }

  async function refreshSuggestions() {
    $('suggestionStatus').textContent = 'asking Gemini...';
    const patientContext = $('patientContext').value.trim();
    try {
      const response = await window.tacit?.getGeminiSuggestions?.({ patientContext });
      // The board is a fixed 2 x 3 grid, so top up from the fallbacks if the
      // main process ever hands back fewer than five options.
      const next = [...(response?.options || []), ...FALLBACK_OPTIONS].slice(0, 5);
      options = [...next, TYPE_OPTION];
      current = 0;
      drawBoard();
      if (ready) startScan();
      $('suggestionStatus').textContent = response?.source === 'gemini'
        ? `Gemini suggestions loaded (${response.model || 'gemini'})`
        : `fallback suggestions${response?.error ? ` (${response.error})` : ''}`;
    } catch (error) {
      options = [...FALLBACK_OPTIONS, TYPE_OPTION];
      drawBoard();
      if (ready) startScan();
      $('suggestionStatus').textContent = `fallback suggestions (${error.message || error})`;
    }
  }

  function drawOverlay(fr) {
    if (overlay.width !== fr.videoWidth) { overlay.width = fr.videoWidth; overlay.height = fr.videoHeight; }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const lm = fr.landmarks;
    if (!lm) return;
    const X = p => p.x * overlay.width, Y = p => p.y * overlay.height;
    const dot = (i, color, r) => {
      octx.fillStyle = color;
      octx.beginPath();
      octx.arc(X(lm[i]), Y(lm[i]), r, 0, Math.PI * 2);
      octx.fill();
    };
    for (const i of fr.eyeIdx.left) dot(i, '#00e5ff', 3);
    for (const i of fr.eyeIdx.right) dot(i, '#ff4dff', 3);
    if (lm.length >= 478 && eyeTrackingEnabled) {
      octx.strokeStyle = 'rgba(255,255,255,0.5)';
      octx.lineWidth = 1;
      for (const [a, b] of [[33, 133], [263, 362]]) {
        octx.beginPath();
        octx.moveTo(X(lm[a]), Y(lm[a]));
        octx.lineTo(X(lm[b]), Y(lm[b]));
        octx.stroke();
      }
      dot(468, '#ffd54a', 5);
      dot(473, '#ffd54a', 5);
    }
    if (opts.getCrop) {
      const c = opts.getCrop();
      if (c && c.w < 1) {
        octx.strokeStyle = 'rgba(255,213,74,0.8)';
        octx.lineWidth = 2;
        octx.strokeRect(c.x * overlay.width, c.y * overlay.height, c.w * overlay.width, c.h * overlay.height);
      }
    }
    octx.save();
    octx.scale(-1, 1);
    octx.fillStyle = fr.eye === 'open' ? '#fff' : '#f66';
    octx.font = 'bold 20px system-ui';
    octx.fillText(`eye: ${fr.eye}   scan: ${options[current] || '-'}`, -overlay.width + 10, 28);
    octx.restore();
  }

  const gcal = { active: false, startAt: 0, samples: [], center: null };
  function calibrateGaze() {
    if (!eyeTrackingEnabled) return;
    ready = false;
    stopScan();
    gcal.active = true;
    gcal.startAt = performance.now();
    gcal.samples = [];
    $('lookhere').style.display = 'block';
    $('calib').textContent = 'gaze centering: look at the video...';
  }

  function gazeCalTick(fr) {
    if (!gcal.active) return;
    const elapsed = fr.t - gcal.startAt;
    if (elapsed > 500 && fr.face && fr.gazeRaw !== null && fr.eye === 'open') gcal.samples.push(fr.gazeRaw);
    $('calib').textContent = `gaze centering: look at the video... ${((2000 - elapsed) / 1000).toFixed(1)}s (${gcal.samples.length})`;
    if (elapsed < 2000) return;
    gcal.active = false;
    $('lookhere').style.display = 'none';
    const sorted = gcal.samples.sort((a, b) => a - b);
    if (sorted.length >= 10) {
      gcal.center = sorted[Math.floor(sorted.length / 2)];
      engine.setGazeReference({ centerX: gcal.center });
      $('gazeRef').textContent = `center ${gcal.center.toFixed(3)} - dead zone +/-${engine.config.gazeDeadZone}`;
    } else {
      $('gazeRef').textContent = 'not calibrated';
    }
    ready = true;
    $('calib').textContent = 'ready. The scanner moves option by option; blink once to select.';
    startScan();
  }

  function drawBar(fr) {
    const c = fr.gazeRef ? fr.gazeRef.centerX : 0;
    const dz = engine.config.gazeDeadZone;
    const W = 400;
    const lo = c - 0.4, hi = c + 0.4;
    const x = v => Math.max(0, Math.min(W, (v - lo) / (hi - lo) * W));
    $('dot').style.left = x(fr.gazeX) + 'px';
    $('mMid').style.left = x(c) + 'px';
    $('zone').style.left = x(c - dz) + 'px';
    $('zone').style.width = (x(c + dz) - x(c - dz)) + 'px';
  }

  engine.on('calibration', e => {
    if (e.phase === 'countdown') {
      ready = false;
      stopScan();
      $('calib').textContent = `blink calibration: get ready... ${(e.remainingMs / 1000).toFixed(1)}s`;
    } else if (e.phase === 'sampling') {
      $('calib').textContent = `blink calibration: blink naturally... ${(e.remainingMs / 1000).toFixed(1)}s`;
    } else if (e.phase === 'failed') {
      $('calib').textContent = `blink calibration FAILED: ${e.reason} - press Recalibrate blink`;
    } else if (e.phase === 'done') {
      if (eyeTrackingEnabled && gcal.center === null) calibrateGaze();
      else {
        ready = true;
        $('calib').textContent = 'ready. The scanner moves option by option; blink once to select.';
        startScan();
      }
    }
  });

  engine.on('gaze', e => {
    if (!eyeTrackingEnabled || !ready || chosen !== null) return;
    const col = e.direction === 'left' ? 0 : e.direction === 'right' ? 1 : -1;
    if (col >= 0) setHighlight(Math.min(options.length - 1, Math.floor(current / 2) * 2 + col));
    sendTelemetry({ t: 'event', cls: 'gaze', text: `${e.direction} ${e.x.toFixed(3)}` });
  });

  engine.on('frame', fr => {
    drawOverlay(fr);
    if (fr.gazeRaw !== null && fr.gazeRaw !== undefined) {
      $('gaze').textContent = eyeTrackingEnabled
        ? `${fr.gaze}  x ${fr.gazeX.toFixed(3)}  (eyes ${fr.gazeEye.toFixed(3)} + head ${fr.gazeHead.toFixed(3)})`
        : 'disabled';
      $('eyeinfo').textContent = `EAR ${fr.ear?.toFixed(3) ?? '-'} - eye ${fr.eye} - presage blink ${fr.blinkFlag ? 'YES' : 'no'} - gaze via ${eyeTrackingEnabled ? (fr.gazeSource || '-') : 'disabled'}`;
      if (eyeTrackingEnabled) drawBar(fr);
    }
    gazeCalTick(fr);
    if (fr.t - lastTelemetryAt >= 250) lastTelemetryAt = fr.t;
  });

  engine.on('select', e => {
    $('last').textContent = `SELECT ${e.durationMs.toFixed(0)} ms`;
    if (ready) choose('blink');
  });
  engine.on('rest', () => $('last').textContent = 'REST (eyes held closed)');
  engine.on('resume', e => $('last').textContent = `RESUME after ${e.durationMs.toFixed(0)} ms`);
  engine.on('ambiguous', e => $('last').textContent = `(ignored ${e.reason} closure ${e.durationMs.toFixed(0)} ms)`);
  engine.on('facelost', () => $('warn').textContent = 'Face not detected - detection paused');
  engine.on('faceback', () => $('warn').textContent = '');
  engine.on('warning', e => {
    const w = engine.getState().warnings;
    const active = Object.keys(w).filter(k => w[k]);
    if (!engine.getState().paused) $('warn').textContent = active.length ? e.message : '';
  });
  engine.on('error', e => $('calib').textContent = 'ERROR: ' + (e.error.message || e.error));
  engine.on('status', e => { $('source').textContent = e.message; });
  engine.on('vitals', v => {
    const p = v.pulseBpm != null ? `${v.pulseBpm.toFixed(0)} bpm (${(v.pulseConfidence ?? 0).toFixed(0)}%)` : '-';
    const b = v.breathingBpm != null ? `${v.breathingBpm.toFixed(0)} br/min (${(v.breathingConfidence ?? 0).toFixed(0)}%)` : '-';
    $('vitals').textContent = `pulse ${p} - breathing ${b}`;
  });

  if (opts.onReady) opts.onReady({ engine });

  eyeTrackingToggle.checked = eyeTrackingEnabled;
  eyeTrackingToggle.addEventListener('change', () => {
    eyeTrackingEnabled = eyeTrackingToggle.checked;
    localStorage.setItem('tacit:eyeTracking', eyeTrackingEnabled ? '1' : '0');
    $('gazeRef').textContent = eyeTrackingEnabled ? 'not calibrated' : 'disabled';
    if (opts.setEyeTrackingEnabled) opts.setEyeTrackingEnabled(eyeTrackingEnabled);
    if (eyeTrackingEnabled && engine.getState().calibration === 'done') calibrateGaze();
    if (!eyeTrackingEnabled && engine.getState().calibration === 'done') {
      ready = true;
      gcal.active = false;
      $('lookhere').style.display = 'none';
      startScan();
    }
  });

  $('resetBtn').addEventListener('click', () => { if (ready) startScan(); });
  $('gazeCalBtn').addEventListener('click', () => { if (engine.getState().calibration === 'done') calibrateGaze(); });
  $('recalBtn').addEventListener('click', () => engine.calibrate());
  $('refreshBtn').addEventListener('click', refreshSuggestions);
  $('sendCustomBtn').addEventListener('click', () => {
    const text = customText.value.trim();
    if (!text) return;
    appendMessage(text, 'typed');
    customText.value = '';
    startScan();
  });
  customText.addEventListener('keydown', event => {
    if (event.key === 'Enter') $('sendCustomBtn').click();
  });

  drawBoard();
  refreshSuggestions();

  (async () => {
    try { await engine.start($('video')); }
    catch (err) { console.error(err); $('calib').textContent = 'ERROR: ' + (err.message || err); }
  })();
}

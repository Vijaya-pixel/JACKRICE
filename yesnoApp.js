/**
 * yesnoApp.js — three-tier blink-scanned AAC communication board.
 *
 * The engine still owns blink calibration and blink events. Three tiers share
 * one blink/click "select" gesture, escalating from fastest to most flexible:
 *   1. yesno    — Yes / No / escalate to the needs board (3-cell flat scan)
 *   2. board    — 5 Gemini-ranked needs + escalate to the keyboard (6-cell flat scan)
 *   3. keyboard — frequency-ordered scanning keyboard with word/phrase
 *                 completion, for anything the first two tiers can't say
 *
 * Tiers 1-2 reuse the same flat linear scan (one highlighted cell at a time).
 * Tier 3 uses two-phase row/column scanning since a flat scan over ~30 cells
 * would be far too slow. Every cell in every tier is also a real button, so
 * the whole flow can be driven by mouse click with no camera at all.
 */
import { FREQUENCY_LETTERS, predictWords, chunk } from './keyboardData.js';

export function initYesNo(engine, opts = {}) {
  const SCAN_INTERVAL_MS = 1500;
  const KEYBOARD_OPTION = 'Keyboard';
  const YESNO_OPTIONS = ['Yes', 'No'];
  const FALLBACK_OPTIONS = [
    'Yes',
    'No',
    'I am in pain',
    'I need water',
    'Please reposition me',
  ];

  // Drives the CSS dwell-progress bar (see .choice::after / .kbCell::after in
  // yesno.css) so it always matches this constant instead of a duplicated
  // magic number in the stylesheet.
  document.documentElement.style.setProperty('--dwell-ms', `${SCAN_INTERVAL_MS}ms`);

  const $ = id => document.getElementById(id);
  const board = $('board');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  const messageLog = $('messageLog');
  const modeYesNoBtn = $('modeYesNoBtn');
  const modeBoardBtn = $('modeBoardBtn');
  const modeKeyboardBtn = $('modeKeyboardBtn');
  const eyeTrackingToggle = $('eyeTrackingToggle');
  const patientSelect = $('patientSelect');
  const newPatientBtn = $('newPatientBtn');
  const newPatientForm = $('newPatientForm');
  const newPatientFirstName = $('newPatientFirstName');
  const newPatientId = $('newPatientId');
  const addPatientBtn = $('addPatientBtn');
  const keyboardEl = $('keyboard');
  const keyboardRowsEl = $('keyboardRows');
  const keyboardDraftText = $('keyboardDraftText');

  // --- Tier 1 / 2 shared flat-scan state --------------------------------
  let tier = 'yesno'; // 'yesno' | 'board' | 'keyboard'
  let boardOptions = [...FALLBACK_OPTIONS, KEYBOARD_OPTION]; // cached tier-2 board, refreshed in the background
  let options = [...YESNO_OPTIONS];
  let current = 0;
  let chosen = null;
  let ready = false;
  let scanTimer = null;

  // --- Tier 3 (keyboard) state --------------------------------------------
  let draftText = '';
  let keyboardRowDefs = [];
  let historyPhrasesCache = [];
  let kphase = 'row'; // 'row' | 'col'
  let krow = 0;
  let kcol = 0;
  let keyboardTimer = null;

  let eyeTrackingEnabled = localStorage.getItem('tacit:eyeTracking') === '1';
  let lastTelemetryAt = 0;

  function recordSelection(text, source, how) {
    window.tacit?.recordSelection?.({
      patientId: patientSelect.value,
      patientContext: $('patientContext').value.trim(),
      text, source, how,
    });
  }

  // Populate the dropdown from the saved directory, keeping whichever patient
  // is passed as preferredId selected (falls back to the last one used on
  // this device, then to no selection).
  async function loadPatients(preferredId) {
    const patients = (await window.tacit?.listPatients?.()) || [];
    const wanted = preferredId ?? localStorage.getItem('tacit:patientId') ?? '';
    patientSelect.innerHTML = '<option value="">Select a patient...</option>';
    for (const patient of patients) {
      const option = document.createElement('option');
      option.value = patient.id;
      option.textContent = `${patient.firstName} (${patient.id})`;
      patientSelect.appendChild(option);
    }
    patientSelect.value = patients.some(p => p.id === wanted) ? wanted : '';
  }

  function selectPatient(id) {
    patientSelect.value = id;
    localStorage.setItem('tacit:patientId', id);
    // Switching who the device is set to shouldn't carry the previous
    // patient's session log, draft, or tier forward.
    messageLog.innerHTML = '<li class="empty">Selections will appear here.</li>';
    enterYesNoTier();
    fetchSuggestions();
  }

  function sendTelemetry() {}

  function setStatus(text) {
    $('state').textContent = text;
  }

  function currentScanLabel() {
    if (tier === 'keyboard') {
      if (kphase === 'row') return `row ${krow + 1}`;
      return keyboardRowDefs[krow]?.[kcol]?.label ?? '-';
    }
    return options[current] || '-';
  }

  // Whichever tier is active, resume its own scanning mechanism.
  function startActiveScan() {
    if (tier === 'keyboard') startKeyboardScan();
    else startScan();
  }

  // ------------------------------------------------------------------------
  // Tiers 1 & 2 — shared flat linear scan
  // ------------------------------------------------------------------------

  function drawBoard() {
    board.innerHTML = '';
    board.style.gridTemplateRows = `repeat(${Math.max(1, Math.ceil(options.length / 2))}, minmax(130px, 1fr))`;
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
    const selected = options[current];
    // The keyboard cell is a blink-selectable escalation from the board tier
    // (it's also reachable via the mode switcher); it navigates immediately
    // rather than logging a message.
    if (selected === KEYBOARD_OPTION) { enterKeyboardTier(); return; }

    stopScan();
    chosen = current;
    const cell = cells()[chosen];
    cell.classList.remove('highlight');
    cell.classList.add('chosen');
    cell.querySelector('small').textContent = `SELECTED (${how})`;
    $('result').textContent = selected;
    setStatus('locked - press Home / Reset');
    appendMessage(selected, how);
    recordSelection(selected, 'suggested', how);
    sendTelemetry({ t: 'event', cls: 'choose', text: `${selected} via ${how}` });

    // Speak the selection using Eleven Labs TTS
    if (window.tacitTTS && typeof window.tacitTTS.speak === 'function') {
      window.tacitTTS.speak(selected).catch(err => {
        console.error('[yesnoApp] TTS error:', err.message);
      });
    }
  }

  // Fetches (and caches) the tier-2 board; only re-renders it if tier 2 is
  // currently on screen, so it's safe to prefetch in the background.
  async function fetchSuggestions() {
    $('suggestionStatus').textContent = 'asking Gemini...';
    const patientContext = $('patientContext').value.trim();
    const patientId = patientSelect.value;
    try {
      const response = await window.tacit?.getGeminiSuggestions?.({ patientContext, patientId });
      // The board is a fixed 2 x 3 grid, so top up from the fallbacks if the
      // main process ever hands back fewer than five options.
      const next = [...(response?.options || []), ...FALLBACK_OPTIONS].slice(0, 5);
      boardOptions = [...next, KEYBOARD_OPTION];
      $('suggestionStatus').textContent = response?.source === 'gemini'
        ? `Gemini suggestions loaded (${response.model || 'gemini'})`
        : `fallback suggestions${response?.error ? ` (${response.error})` : ''}`;
    } catch (error) {
      boardOptions = [...FALLBACK_OPTIONS, KEYBOARD_OPTION];
      $('suggestionStatus').textContent = `fallback suggestions (${error.message || error})`;
    }
    if (tier === 'board') {
      options = [...boardOptions];
      current = 0;
      drawBoard();
      startScan();
    }
  }

  // ------------------------------------------------------------------------
  // Tier 3 — frequency-ordered scanning keyboard
  // ------------------------------------------------------------------------

  function currentWordPrefix(text) {
    const parts = text.split(' ');
    return parts[parts.length - 1] || '';
  }

  // Fresh word (draft empty or just finished with a space): offer this
  // patient's own most-used past phrases first (one tap sends the whole
  // phrase), falling back to generic starter words. Mid-word: offer
  // dictionary completions for the prefix typed so far.
  function buildPredictionRow(text) {
    const startingFresh = text === '' || text.endsWith(' ');
    if (startingFresh) {
      if (historyPhrasesCache.length) {
        return historyPhrasesCache.slice(0, 5).map(phrase => ({ kind: 'phrase', label: phrase, value: phrase }));
      }
      return predictWords('', 5).map(word => ({ kind: 'predict', label: word, value: word }));
    }
    return predictWords(currentWordPrefix(text), 5).map(word => ({ kind: 'predict', label: word, value: word }));
  }

  function buildKeyboardRows(text) {
    const rows = [];
    const predictions = buildPredictionRow(text);
    if (predictions.length) rows.push(predictions);
    for (const row of chunk(FREQUENCY_LETTERS, 6)) {
      rows.push(row.map(letter => ({ kind: 'letter', label: letter, value: letter })));
    }
    rows.push([
      { kind: 'space', label: 'Space' },
      { kind: 'backspace', label: 'Delete' },
      { kind: 'clear', label: 'Clear' },
      { kind: 'speak', label: 'Speak' },
      { kind: 'back', label: 'Back' },
    ]);
    return rows;
  }

  function drawKeyboard() {
    keyboardRowDefs = buildKeyboardRows(draftText);
    keyboardRowsEl.innerHTML = '';
    keyboardRowDefs.forEach((row, r) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'kbRow';
      row.forEach((cell, c) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `kbCell kbCell-${cell.kind}`;
        btn.textContent = cell.label;
        // Direct click always activates the cell immediately — the
        // row-then-column phases below are only for blink scanning.
        btn.addEventListener('click', () => activateKeyboardCell(r, c));
        rowEl.appendChild(btn);
      });
      keyboardRowsEl.appendChild(rowEl);
    });
    keyboardDraftText.textContent = draftText || ' ';
    updateKeyboardHighlight();
  }

  function updateKeyboardHighlight() {
    [...keyboardRowsEl.children].forEach((rowEl, r) => {
      [...rowEl.children].forEach((cellEl, c) => {
        const isTargetRow = r === krow;
        cellEl.classList.toggle('rowActive', kphase === 'row' && isTargetRow);
        cellEl.classList.toggle('highlight', kphase === 'col' && isTargetRow && c === kcol);
      });
    });
    $('activeChoice').textContent = currentScanLabel();
  }

  function startKeyboardScan() {
    stopKeyboardScan();
    kphase = 'row';
    krow = 0;
    kcol = 0;
    updateKeyboardHighlight();
    keyboardTimer = setInterval(() => {
      if (!ready) return;
      if (kphase === 'row') {
        krow = (krow + 1) % keyboardRowDefs.length;
      } else {
        const len = keyboardRowDefs[krow]?.length || 1;
        kcol = (kcol + 1) % len;
      }
      updateKeyboardHighlight();
    }, SCAN_INTERVAL_MS);
    setStatus('scanning');
    $('result').textContent = '-';
  }

  function stopKeyboardScan() {
    if (keyboardTimer) clearInterval(keyboardTimer);
    keyboardTimer = null;
  }

  // Row phase: a blink confirms the targeted row and starts scanning its
  // cells. Column phase: a blink activates the targeted cell.
  function handleKeyboardBlink() {
    if (kphase === 'row') {
      kphase = 'col';
      kcol = 0;
      updateKeyboardHighlight();
    } else {
      activateKeyboardCell(krow, kcol);
    }
  }

  function activateKeyboardCell(r, c) {
    const cell = keyboardRowDefs[r]?.[c];
    if (!cell) return;
    switch (cell.kind) {
      case 'letter':
        draftText += cell.value;
        break;
      case 'predict': {
        const parts = draftText.split(' ');
        parts[parts.length - 1] = cell.value;
        draftText = parts.join(' ') + ' ';
        break;
      }
      case 'phrase':
        draftText = cell.value.trim() + ' ';
        break;
      case 'space':
        draftText += ' ';
        break;
      case 'backspace':
        draftText = draftText.slice(0, -1);
        break;
      case 'clear':
        draftText = '';
        break;
      case 'speak':
        speakDraft();
        return;
      case 'back':
        draftText = '';
        enterBoardTier();
        return;
      default:
        return;
    }
    // Any content-changing key: predictions may have changed, so redraw and
    // restart from the row phase.
    drawKeyboard();
    startKeyboardScan();
  }

  function speakDraft() {
    stopKeyboardScan();
    const text = draftText.trim();
    draftText = '';
    if (text) {
      appendMessage(text, 'keyboard');
      recordSelection(text, 'typed', 'keyboard');

      // Speak the selection using Eleven Labs TTS
      if (window.tacitTTS && typeof window.tacitTTS.speak === 'function') {
        window.tacitTTS.speak(text).catch(err => {
          console.error('[yesnoApp] TTS error:', err.message);
        });
      }
    }
    $('result').textContent = text || '-';
    setStatus('locked - press Home / Reset');
  }

  // ------------------------------------------------------------------------
  // Tier transitions
  // ------------------------------------------------------------------------

  // The mode switcher is a caregiver-operated click control, not part of any
  // tier's blink scan — it stays visible and active-highlighted in all three.
  function updateModeButtons() {
    modeYesNoBtn.classList.toggle('active', tier === 'yesno');
    modeBoardBtn.classList.toggle('active', tier === 'board');
    modeKeyboardBtn.classList.toggle('active', tier === 'keyboard');
  }

  function enterYesNoTier() {
    tier = 'yesno';
    updateModeButtons();
    keyboardEl.hidden = true;
    board.hidden = false;
    options = [...YESNO_OPTIONS];
    current = 0;
    drawBoard();
    startScan();
  }

  function enterBoardTier() {
    tier = 'board';
    updateModeButtons();
    keyboardEl.hidden = true;
    board.hidden = false;
    options = [...boardOptions];
    current = 0;
    drawBoard();
    startScan();
    // Cached board shows instantly above; refresh it live in the background.
    fetchSuggestions();
  }

  async function enterKeyboardTier() {
    tier = 'keyboard';
    updateModeButtons();
    board.hidden = true;
    keyboardEl.hidden = false;
    draftText = '';
    historyPhrasesCache = (await window.tacit?.getTopPhrases?.(patientSelect.value)) || [];
    drawKeyboard();
    startKeyboardScan();
  }

  function goHome() {
    enterYesNoTier();
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
    octx.fillText(`eye: ${fr.eye}   scan: ${currentScanLabel()}`, -overlay.width + 10, 28);
    octx.restore();
  }

  const gcal = { active: false, startAt: 0, samples: [], center: null };
  function calibrateGaze() {
    if (!eyeTrackingEnabled) return;
    ready = false;
    stopScan();
    stopKeyboardScan();
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
    startActiveScan();
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
      stopKeyboardScan();
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
        startActiveScan();
      }
    }
  });

  engine.on('gaze', e => {
    // Gaze-driven column jumps assume the tier-1/2 two-column flat grid;
    // the keyboard's row/column scan is blink-only.
    if (!eyeTrackingEnabled || !ready || chosen !== null || tier === 'keyboard') return;
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
    if (!ready) return;
    if (tier === 'keyboard') handleKeyboardBlink();
    else choose('blink');
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
      startActiveScan();
    }
  });

  $('resetBtn').addEventListener('click', goHome);
  modeYesNoBtn.addEventListener('click', enterYesNoTier);
  modeBoardBtn.addEventListener('click', enterBoardTier);
  modeKeyboardBtn.addEventListener('click', enterKeyboardTier);
  $('gazeCalBtn').addEventListener('click', () => { if (engine.getState().calibration === 'done') calibrateGaze(); });
  $('recalBtn').addEventListener('click', () => engine.calibrate());
  $('refreshBtn').addEventListener('click', fetchSuggestions);
  patientSelect.addEventListener('change', () => selectPatient(patientSelect.value));
  newPatientBtn.addEventListener('click', () => {
    newPatientForm.hidden = !newPatientForm.hidden;
    if (!newPatientForm.hidden) newPatientFirstName.focus();
  });
  addPatientBtn.addEventListener('click', async () => {
    const firstName = newPatientFirstName.value.trim();
    const id = newPatientId.value.trim();
    if (!id) { newPatientId.focus(); return; }
    // findOrCreate: an existing ID is reused (and its name updated) rather
    // than creating a duplicate patient.
    const patient = await window.tacit?.addPatient?.({ id, firstName });
    if (!patient) return;
    newPatientFirstName.value = '';
    newPatientId.value = '';
    newPatientForm.hidden = true;
    await loadPatients(patient.id);
    selectPatient(patient.id);
  });

  enterYesNoTier();
  loadPatients().then(() => fetchSuggestions());

  (async () => {
    try { await engine.start($('video')); }
    catch (err) { console.error(err); $('calib').textContent = 'ERROR: ' + (err.message || err); }
  })();
}

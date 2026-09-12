// geminiHistory.js — local history store that lets Gemini suggestions improve
// over time based on what a patient has actually picked before.
//
// Stored as a flat JSON file under Electron's per-machine userData dir (not in
// the repo, no DB setup needed) — fits a hackathon timeline and keeps this
// feature fully isolated from the rest of the app's IPC surface.
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const HISTORY_FILE = path.join(app.getPath('userData'), 'tacit-gemini-history.json');
const MAX_ENTRIES = 300;
const MAX_PROMPT_PHRASES = 6;

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveHistory(entries) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
  } catch (error) {
    console.error('[tacit] failed to save gemini history:', error.message);
  }
}

// Patients are identified by an explicit patientId (room number, name, or
// whatever the bedside device is set to) — never by the free-text clinical
// context, which can repeat across patients or change wording per visit.
// An empty patientId is its own bucket ("unassigned"), so it never blends
// into a real patient's history.
function bucketKey(patientId) {
  return String(patientId || '').trim().toLowerCase() || '__unassigned__';
}

// Record one finalized selection (a suggested option the patient chose, or
// something they typed themselves). Called from the renderer via IPC.
function recordSelection({ patientId, patientContext, text, source, how } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const entries = loadHistory();
  entries.push({
    text: trimmed,
    patientId: bucketKey(patientId),
    patientContext: String(patientContext || '').trim(),
    source: source === 'typed' ? 'typed' : 'suggested', // where the phrase came from
    how: how || 'unknown', // 'blink' | 'manual' | 'typed'
    at: Date.now(),
  });
  while (entries.length > MAX_ENTRIES) entries.shift();
  saveHistory(entries);
}

// Build a short natural-language summary of this patient's past picks to fold
// into the Gemini prompt. Strictly scoped to this patientId's own bucket —
// never falls back to another patient's history.
function summarizeForPrompt(patientId) {
  const entries = loadHistory();
  if (!entries.length) return '';

  const key = bucketKey(patientId);
  const pool = entries.filter(e => e.patientId === key);
  if (!pool.length) return '';

  const counts = new Map();
  for (const entry of pool) {
    const phrase = entry.text.trim();
    if (!phrase) continue;
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROMPT_PHRASES)
    .map(([text]) => text);

  if (!ranked.length) return '';
  return `This patient has previously needed: ${ranked.join('; ')}. Weigh these when relevant, ` +
    'but do not just repeat the same list verbatim every time — adapt to the current context.';
}

module.exports = { recordSelection, summarizeForPrompt };

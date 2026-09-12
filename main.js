// main.js — Electron main process for Tacit.
// Creates the window, wires the Presage SmartSpectra IPC bridge, grants the
// camera to our own bundled page only, and serves API helpers from .env.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session, ipcMain } = require('electron');

// Packaged builds: point the SDK at the unpacked native runtime (see the
// Presage electron-quickstart for the electron-builder extraResources layout).
if (app.isPackaged && !process.env.SMARTSPECTRA_CAPI_PATH) {
  const LIB = { darwin: 'libsmartspectra_capi.dylib', win32: 'smartspectra_capi.dll', linux: 'libsmartspectra_capi.so' }[process.platform];
  if (LIB) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', LIB);
}

const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

function readEnvFileVar(name) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* no .env */ }
  return '';
}

// --- API keys from .env or the environment ---------------------------------
function readEnvVar(name) {
  if (process.env[name]) return process.env[name].trim();
  return readEnvFileVar(name);
}

function readApiKey() {
  return readEnvVar('PRESAGE_API_KEY');
}
ipcMain.handle('tacit:apiKey', () => readApiKey());

// --- Gemini predicted options ----------------------------------------------
// Google AI (Gemini API), v1beta `models.generateContent`. Three things about
// the current API drive the shape of this code:
//   * Gemini 3.x models think before answering and those thought tokens count
//     against maxOutputTokens, so a tight cap truncates the answer
//     (finishReason MAX_TOKENS) and leaves half-written JSON. We ask for a low
//     thinking level and leave the cap roomy instead.
//   * responseSchema makes the reply a guaranteed JSON object, so the board
//     options are parsed exactly instead of scraped out of prose.
//   * The key belongs in the x-goog-api-key header, not the query string.
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
const GEMINI_BACKUP_MODEL = 'gemini-flash-lite-latest';
const GEMINI_TIMEOUT_MS = 20000;
const GEMINI_ATTEMPTS_PER_MODEL = 3;
// The board is a fixed 2 x 3 grid: five predicted options + "Type yourself".
const GEMINI_OPTION_COUNT = 5;
const GEMINI_MAX_OPTION_CHARS = 52;
const GEMINI_RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const GEMINI_FALLBACK_OPTIONS = [
  'Yes',
  'No',
  'I am in pain',
  'I need water',
  'Please reposition me',
];

const GEMINI_SYSTEM_PROMPT = [
  'You help build an AAC communication board for a hospital patient who cannot speak clearly.',
  'The patient selects one option by blinking, so every option is something the patient says to a nurse or doctor.',
  'Write plain first-person language, at most 5 words per option, no punctuation at the end.',
  'Do not include "Type yourself" — the app adds that as the sixth option.',
].join('\n');

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    options: {
      type: 'ARRAY',
      minItems: GEMINI_OPTION_COUNT,
      maxItems: GEMINI_OPTION_COUNT,
      items: { type: 'STRING', description: 'One thing the patient might want to say, at most 5 words.' },
    },
  },
  required: ['options'],
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Join the answer text of a candidate. Parts flagged `thought` carry the
// model's reasoning rather than the answer, so they are skipped.
function geminiAnswerText(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;
  const finishReason = candidate?.finishReason || (candidate ? 'STOP' : 'NO_CANDIDATE');
  if (!Array.isArray(parts)) return { text: '', finishReason };
  const text = parts
    .filter(part => part && part.thought !== true && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
  return { text: text.trim(), finishReason };
}

// responseSchema guarantees a JSON object, but tolerate a bare array or a
// ```json fence in case someone points GEMINI_MODEL at an older model.
function parseOptionArray(text) {
  if (!text) return [];
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return []; }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.options)) return parsed.options;
  return [];
}

// Trim, drop anything unusable, de-duplicate, and keep at most five.
function normalizeOptions(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const value = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s"'\-*•\d.)]+/, '')
      .replace(/[\s"']+$/, '')
      .trim();
    if (!value || value.length > GEMINI_MAX_OPTION_CHARS) continue;
    const key = value.toLowerCase();
    if (key === 'type yourself' || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length === GEMINI_OPTION_COUNT) break;
  }
  return out;
}

// The grid has exactly five slots, so top up a short list from the fallbacks.
function fillOptions(list) {
  return normalizeOptions([...list, ...GEMINI_FALLBACK_OPTIONS]);
}

async function geminiGenerate(model, apiKey, prompt, { thinking }) {
  const generationConfig = {
    temperature: 0.35,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json',
    responseSchema: GEMINI_RESPONSE_SCHEMA,
  };
  // thinkingLevel is the Gemini 3.x control; older models reject it (see below).
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`${model}: ${data?.error?.message || `HTTP ${response.status}`}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Try each model in turn, retrying the overloaded/rate-limited statuses that
// the Gemini API returns often enough to matter during a demo.
async function geminiSuggest(apiKey, models, prompt) {
  const failures = [];
  for (const model of models) {
    let thinking = true;
    for (let attempt = 0; attempt < GEMINI_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const data = await geminiGenerate(model, apiKey, prompt, { thinking });
        const { text, finishReason } = geminiAnswerText(data);
        const options = normalizeOptions(parseOptionArray(text));
        if (options.length) return { model, options, finishReason };
        failures.push(`${model}: no usable options (finishReason ${finishReason})`);
        break; // A well-formed but empty answer will not improve on a retry.
      } catch (error) {
        const timedOut = error.name === 'AbortError';
        const message = timedOut ? `${model}: timed out after ${GEMINI_TIMEOUT_MS} ms` : error.message;
        failures.push(message);
        // A pinned pre-3.x model rejects thinkingLevel; drop it and try again.
        if (error.status === 400 && thinking && /thinking/i.test(error.message)) {
          thinking = false;
          continue;
        }
        if (!timedOut && !GEMINI_RETRYABLE_STATUS.has(error.status)) break;
        if (attempt < GEMINI_ATTEMPTS_PER_MODEL - 1) await sleep(400 * 2 ** attempt);
      }
    }
  }
  const error = new Error(failures[failures.length - 1] || 'no response');
  error.failures = failures;
  throw error;
}

ipcMain.handle('tacit:geminiSuggestions', async (_event, context = {}) => {
  const apiKey = readEnvVar('GEMINI_API_KEY');
  if (!apiKey) return { source: 'fallback', options: [...GEMINI_FALLBACK_OPTIONS], error: 'GEMINI_API_KEY missing' };

  const configured = readEnvVar('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
  const models = [...new Set([configured, GEMINI_DEFAULT_MODEL, GEMINI_BACKUP_MODEL])];
  const patientContext = String(context.patientContext || '').trim();
  const prompt = [
    patientContext ? `Clinical context: ${patientContext}` : 'Clinical context: general inpatient bedside conversation.',
    `Give the ${GEMINI_OPTION_COUNT} options this patient is most likely to need right now.`,
  ].join('\n');

  try {
    const { model, options } = await geminiSuggest(apiKey, models, prompt);
    console.log(`[tacit] gemini ${model} -> ${JSON.stringify(options)}`);
    return { source: 'gemini', model, options: fillOptions(options) };
  } catch (error) {
    console.error('[tacit] gemini failed:', error.failures ? error.failures.join(' | ') : error.message);
    return { source: 'fallback', options: [...GEMINI_FALLBACK_OPTIONS], error: error.message || String(error) };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 800, backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox off so preload.js can require the SDK's preload bridge.
      sandbox: false,
    },
  });
  bindSmartSpectraIpc(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  // Renderer console -> terminal (handy since the renderer has no terminal).
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log(`[renderer${level >= 2 ? ':ERR' : ''}] ${message}${sourceId ? ` (${path.basename(sourceId)}:${line})` : ''}`);
  });
  win.webContents.on('preload-error', (e, p, err) => console.error('[preload-error]', p, err));
  win.loadFile(path.join(__dirname, 'yesno-electron.html'));
  // TACIT_SMOKE=<seconds>: quit automatically (for unattended smoke tests).
  if (process.env.TACIT_SMOKE) setTimeout(() => app.quit(), Number(process.env.TACIT_SMOKE) * 1000);
  if (process.env.TACIT_DEVTOOLS === '1' || process.env.SMARTSPECTRA_DIAGNOSTICS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  console.log(`[tacit] main ready — electron ${process.versions.electron}, api key ${readApiKey() ? 'present' : 'absent (.env missing?)'}`);
  // Camera only, for our own file:// page only.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const mediaTypes = (details && details.mediaTypes) || [];
    const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
    callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

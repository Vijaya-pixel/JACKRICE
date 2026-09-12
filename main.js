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

function readElevenLabsApiKey() {
  return readEnvVar('ELEVENLABS_API_KEY');
}
ipcMain.handle('tacit:elevenLabsApiKey', () => readElevenLabsApiKey());

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
const geminiHistory = require('./geminiHistory');
const patientDirectory = require('./patientDirectory');

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
  const historyNote = geminiHistory.summarizeForPrompt(context.patientId);
  const prompt = [
    patientContext ? `Clinical context: ${patientContext}` : 'Clinical context: general inpatient bedside conversation.',
    historyNote,
    `Give the ${GEMINI_OPTION_COUNT} options this patient is most likely to need right now.`,
  ].filter(Boolean).join('\n');

  try {
    const { model, options } = await geminiSuggest(apiKey, models, prompt);
    console.log(`[tacit] gemini ${model} -> ${JSON.stringify(options)}`);
    return { source: 'gemini', model, options: fillOptions(options) };
  } catch (error) {
    console.error('[tacit] gemini failed:', error.failures ? error.failures.join(' | ') : error.message);
    return { source: 'fallback', options: [...GEMINI_FALLBACK_OPTIONS], error: error.message || String(error) };
  }
});

// Renderer reports each finalized selection here so future prompts can be
// steered by what this patient has actually needed before.
ipcMain.handle('tacit:recordSelection', (_event, entry = {}) => {
  geminiHistory.recordSelection(entry);
});

ipcMain.handle('tacit:topPhrases', (_event, patientId) => geminiHistory.topPhrases(patientId, 5));

// --- Patient directory ------------------------------------------------------
ipcMain.handle('tacit:listPatients', () => patientDirectory.listPatients());
ipcMain.handle('tacit:addPatient', (_event, entry = {}) => patientDirectory.findOrCreatePatient(entry));

// --- Engine event relay ------------------------------------------------------
// Hidden engine-host window -> main -> visible React window, and back for
// control commands (calibrate, toggle eye tracking). See preload.js
// (producer side, used by engine-host.html) and preload-react.js (consumer
// side). No-ops in legacy mode, where there's only one window and the UI
// talks to the engine in-process (see yesnoApp.js).
let mainWindow = null;
let engineHostWindow = null;

// `win?.webContents.send(...)` isn't enough here: the engine-host window
// keeps emitting ~30 events/sec even after the visible window is closed (see
// createWindows() below), and `?.` only guards `win` being null/undefined —
// not the BrowserWindow having been destroyed. Sending to a destroyed
// window's webContents throws "Object has been destroyed" *inside this
// ipcMain listener*, which is an uncaught exception in the main process
// (crashes the whole app with Electron's default dialog).
ipcMain.on('tacit:engine-event-report', (_event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tacit:engine-event', msg);
});
ipcMain.on('tacit:engine-control-send', (_event, msg) => {
  if (engineHostWindow && !engineHostWindow.isDestroyed()) engineHostWindow.webContents.send('tacit:engine-control', msg);
});

// --- Window setup -------------------------------------------------------
const LEGACY_UI = readEnvVar('TACIT_LEGACY_UI') === '1';

function getDevServerUrl() {
  // This project's Vite dev server defaults to port 8080 (falls back to 8081,
  // 8082, ... if that's taken — see @lovable.dev/vite-tanstack-config's
  // sandbox-detection plugin in frontend/vite.config.ts), NOT Vite's usual
  // 5173. If "cd frontend; npm run dev" printed a different port, set
  // TACIT_DEV_SERVER_URL to match before starting Electron.
  return readEnvVar('TACIT_DEV_SERVER_URL') || 'http://localhost:8080/app';
}
function getProdPort() {
  return Number(readEnvVar('TACIT_PROD_PORT')) || 4173;
}

// Camera permission is granted to: our own bundled file:// pages (legacy UI,
// engine-host), the Vite dev server origin, and the local packaged-frontend
// server origin. Nothing else ever gets the camera.
function isAllowedOrigin(url) {
  if (url.startsWith('file://')) return true;
  try {
    if (new URL(url).origin === new URL(getDevServerUrl()).origin) return true;
  } catch (_) { /* not a URL we recognize */ }
  return url.startsWith(`http://localhost:${getProdPort()}`);
}

// win.loadURL()'s own promise only rejects on network-level failure (DNS,
// connection refused, ...) — it resolves normally for an HTTP error response
// (e.g. a 404), because navigation still "succeeded" as far as Chromium is
// concerned. That's silently wrong for us: if anything else is listening on
// the target port/path, the window renders that 404 instead of ever falling
// back. This watches both did-fail-load (network failure) and did-navigate's
// httpResponseCode (HTTP-level failure) and falls back to the legacy UI on
// either, exactly once.
function loadWithFallback(win, url, label) {
  let settled = false;
  const cleanup = () => {
    win.webContents.removeListener('did-fail-load', onFail);
    win.webContents.removeListener('did-navigate', onNav);
  };
  const fallback = reason => {
    if (settled) return;
    settled = true;
    cleanup();
    console.error(`[tacit] ${label}: ${reason} — falling back to the legacy UI`);
    win.loadFile(path.join(__dirname, 'yesno-electron.html'));
  };
  const onFail = (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // ignore subframes / our own aborted loadFile()
    fallback(`could not load ${validatedURL || url}: ${errorDescription} (${errorCode})`);
  };
  const onNav = (_e, navUrl, httpResponseCode) => {
    if (settled) return;
    if (httpResponseCode != null && httpResponseCode >= 400) {
      fallback(`${navUrl} responded HTTP ${httpResponseCode}`);
    } else {
      settled = true; // real success — stop watching this load
      cleanup();
    }
  };
  win.webContents.on('did-fail-load', onFail);
  win.webContents.on('did-navigate', onNav);
  win.loadURL(url).catch(err => fallback(`loadURL threw: ${err.message}`));
}

function attachCommonWindowLogging(win, tag) {
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log(`[${tag}${level >= 2 ? ':ERR' : ''}] ${message}${sourceId ? ` (${path.basename(sourceId)}:${line})` : ''}`);
  });
  win.webContents.on('preload-error', (e, p, err) => console.error(`[${tag} preload-error]`, p, err));
}

// Legacy path: single window, camera + UI together, exactly as before.
// Untouched behavior — this is the TACIT_LEGACY_UI=1 fallback.
function createLegacyWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 800, backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  bindSmartSpectraIpc(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  attachCommonWindowLogging(win, 'renderer');
  win.loadFile(path.join(__dirname, 'yesno-electron.html'));
  return win;
}

// Hidden window: real camera + blinkEngine, forwards events over IPC. Never
// shown. backgroundThrottling: false keeps it running while occluded/hidden.
function createEngineHostWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  bindSmartSpectraIpc(win);
  attachCommonWindowLogging(win, 'engine-host');
  win.loadFile(path.join(__dirname, 'engine-host.html'));
  return win;
}

// Visible window: the React frontend. Dev loads the Vite dev server;
// production spawns and loads the built frontend's server. Either falls back
// to the legacy HTML UI if the React app can't be reached, so the app is
// never left on a blank window.
function createReactWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload-react.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Same-origin navigation (TanStack Router, dev-server HMR reloads) is
  // unaffected — will-navigate only fires for actual document navigations.
  // This just stops the window from following a link out to an external site.
  win.webContents.on('will-navigate', (e, url) => { if (!isAllowedOrigin(url)) e.preventDefault(); });
  attachCommonWindowLogging(win, 'react');

  if (app.isPackaged) {
    loadPackagedReactFrontend(win);
  } else {
    const devServerUrl = getDevServerUrl();
    console.log(`[tacit] loading React dev server at ${devServerUrl} — if this 404s, your Vite server is probably on a different port; set TACIT_DEV_SERVER_URL to match`);
    loadWithFallback(win, devServerUrl, 'dev server');
  }
  return win;
}

// Production loading is best-effort and only lightly verified: `npm run
// build` in frontend/ was actually run once while writing this (see the repo
// history/PR notes), confirming two things —
//   1. the build output IS at frontend/.output/server/index.mjs, as guessed.
//   2. that file is a Cloudflare Workers-style `{ fetch(req) }` module (its
//      vite.config.ts targets the "cloudflare-module" Nitro preset — see the
//      AGENTS.md-equivalent comment at the top of that file), NOT a Node
//      server with .listen(). Spawning it directly with plain `node` would
//      define the handler and then exit — nothing would ever bind a port.
// The build's own output names the supported local-preview path instead:
// `npx vite preview`, which Nitro/Vite wire up to actually serve this build
// over HTTP. That's what's spawned below. This has NOT been verified inside
// an actual electron-builder packaged app — there is no electron-builder
// config in this repo yet, and a packaged build would additionally need
// frontend/.output and frontend/node_modules bundled as extraResources for
// `vite preview` to even be runnable post-package. Treat this path as
// "works for a local production smoke-test", not "ready to ship".
let packagedServerProcess = null;
function loadPackagedReactFrontend(win) {
  const { spawn } = require('child_process');
  const frontendDir = path.join(process.resourcesPath, 'frontend');
  const outputDir = path.join(frontendDir, '.output');
  if (!fs.existsSync(outputDir)) {
    console.error(`[tacit] no frontend build found at ${outputDir} (run "npm run build" in frontend/) — falling back to legacy UI`);
    win.loadFile(path.join(__dirname, 'yesno-electron.html'));
    return;
  }
  const port = getProdPort();
  packagedServerProcess = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: frontendDir,
    stdio: 'inherit',
  });
  packagedServerProcess.on('error', err => console.error('[tacit] packaged frontend preview server failed to start:', err.message));
  setTimeout(() => loadWithFallback(win, `http://localhost:${port}/app`, 'packaged preview server'), 1500);
}

function createWindows() {
  if (LEGACY_UI) {
    mainWindow = createLegacyWindow();
    mainWindow.on('closed', () => { mainWindow = null; });
  } else {
    engineHostWindow = createEngineHostWindow();
    mainWindow = createReactWindow();
    engineHostWindow.on('closed', () => { engineHostWindow = null; });
    // The engine host is pointless without a visible window to report to —
    // and left running, it keeps the camera/Presage session alive forever
    // and (on macOS, where closing the last visible window doesn't quit the
    // app) makes Electron think a window is still open, since the hidden
    // engine host itself counts as one. That silently breaks both
    // window-all-closed and the dock icon's "reopen" (activate), which only
    // recreates windows when BrowserWindow.getAllWindows() is empty.
    mainWindow.on('closed', () => {
      mainWindow = null;
      if (engineHostWindow && !engineHostWindow.isDestroyed()) engineHostWindow.close();
    });
  }
  // TACIT_SMOKE=<seconds>: quit automatically (for unattended smoke tests).
  if (process.env.TACIT_SMOKE) setTimeout(() => app.quit(), Number(process.env.TACIT_SMOKE) * 1000);
  if (process.env.TACIT_DEVTOOLS === '1' || process.env.SMARTSPECTRA_DIAGNOSTICS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  console.log(`[tacit] main ready — electron ${process.versions.electron}, mode ${LEGACY_UI ? 'legacy' : 'react'}, api key ${readApiKey() ? 'present' : 'absent (.env missing?)'}`);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const mediaTypes = (details && details.mediaTypes) || [];
    const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
    callback(permission === 'media' && cameraOnly && isAllowedOrigin(url));
  });
  createWindows();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });
});
app.on('window-all-closed', () => {
  if (packagedServerProcess) { packagedServerProcess.kill(); packagedServerProcess = null; }
  if (process.platform !== 'darwin') app.quit();
});

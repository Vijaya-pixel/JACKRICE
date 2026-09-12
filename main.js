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

const GEMINI_FALLBACK_OPTIONS = [
  'Yes',
  'No',
  'I am in pain',
  'I need water',
  'Please reposition me',
];

function cleanOptionList(value) {
  let parsed = null;
  try { parsed = JSON.parse(value); } catch (_) { /* handled below */ }
  const raw = Array.isArray(parsed)
    ? parsed
    : String(value).split(/\r?\n|,/).map(s => s.replace(/^[-*\d.\s"]+|["\s]+$/g, ''));
  const seen = new Set();
  return raw
    .map(v => String(v || '').trim())
    .filter(v => v.length > 0 && v.length <= 52)
    .filter(v => {
      const key = v.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

ipcMain.handle('tacit:geminiSuggestions', async (_event, context = {}) => {
  const apiKey = readEnvVar('GEMINI_API_KEY');
  const model = readEnvVar('GEMINI_MODEL') || 'gemini-2.0-flash';
  const patientContext = String(context.patientContext || '').trim();
  if (!apiKey) return { source: 'fallback', options: GEMINI_FALLBACK_OPTIONS, error: 'GEMINI_API_KEY missing' };

  const prompt = [
    'You are helping build an AAC communication board for a hospital patient who cannot speak clearly.',
    'Return exactly five short patient-selectable options as a JSON array of strings.',
    'Each option must be useful for nurse/doctor interaction, plain language, and at most 5 words.',
    'Do not include "Type yourself"; the app adds that as the sixth option.',
    patientContext ? `Clinical context: ${patientContext}` : 'Clinical context: general inpatient bedside conversation.',
  ].join('\n');

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 160,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
    const options = cleanOptionList(text);
    return { source: 'gemini', options: options.length ? options : GEMINI_FALLBACK_OPTIONS };
  } catch (error) {
    return { source: 'fallback', options: GEMINI_FALLBACK_OPTIONS, error: error.message || String(error) };
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

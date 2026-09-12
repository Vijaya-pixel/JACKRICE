// main.js — Electron main process for Tacit.
// Creates the window, wires the Presage SmartSpectra IPC bridge, grants the
// camera to our own bundled page only, and serves the API key from .env.
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

// --- API key from .env (PRESAGE_API_KEY=...) or the environment -------------
function readApiKey() {
  if (process.env.PRESAGE_API_KEY) return process.env.PRESAGE_API_KEY.trim();
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*PRESAGE_API_KEY\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* no .env */ }
  return '';
}
ipcMain.handle('tacit:apiKey', () => readApiKey());

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

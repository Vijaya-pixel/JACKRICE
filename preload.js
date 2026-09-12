// preload.js — runs in the renderer's isolated world before the page loads.
// 1. Installs the Presage SmartSpectra preload bridge (renderer <-> main IPC).
// 2. Exposes a tiny `window.tacit` API so the renderer can fetch the API key
//    from the main process (which reads it from .env) — the key is never
//    baked into the renderer bundle or the HTML.
'use strict';
require('@smartspectra/node-sdk/preload');
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tacit', {
  getApiKey: () => ipcRenderer.invoke('tacit:apiKey'),
});

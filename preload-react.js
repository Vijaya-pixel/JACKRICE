// preload-react.js — preload for the VISIBLE React window only.
//
// Deliberately does NOT `require('@smartspectra/node-sdk/preload')` — that
// bridge is for the window that actually runs presageSource.js (the hidden
// engine-host window, see preload.js + engineHostRenderer.js). The React
// window only ever talks to window.tacit; it never touches Electron, Node,
// or the Presage SDK directly, satisfying contextIsolation/nodeIntegration
// and keeping the Presage SDK out of the React bundle entirely.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tacit', {
  // --- Gemini + patient directory (unchanged from preload.js) ---
  getGeminiSuggestions: context => ipcRenderer.invoke('tacit:geminiSuggestions', context),
  recordSelection: entry => ipcRenderer.invoke('tacit:recordSelection', entry),
  getTopPhrases: patientId => ipcRenderer.invoke('tacit:topPhrases', patientId),
  listPatients: () => ipcRenderer.invoke('tacit:listPatients'),
  addPatient: entry => ipcRenderer.invoke('tacit:addPatient', entry),

  // --- Engine bridge (consumer side) ---
  // Subscribe to every blink/gaze/calibration/vitals/etc. event forwarded
  // from the hidden engine-host window. Returns an unsubscribe function,
  // mirroring blinkEngine.js's own on()/off() convention.
  onEngineEvent: callback => {
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on('tacit:engine-event', listener);
    return () => ipcRenderer.removeListener('tacit:engine-event', listener);
  },
  // Send a control command to the engine host, e.g. { type: 'calibrate' } or
  // { type: 'setEyeTracking', enabled: true }.
  sendEngineControl: command => ipcRenderer.send('tacit:engine-control-send', command),

  // Lets the renderer tell whether it's actually running inside Electron
  // (vs. a plain browser tab hitting the same URL) without feature-sniffing.
  isElectron: true,
});

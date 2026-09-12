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
  getElevenLabsApiKey: () => ipcRenderer.invoke('tacit:elevenLabsApiKey'),
  getGeminiSuggestions: context => ipcRenderer.invoke('tacit:geminiSuggestions', context),
  recordSelection: entry => ipcRenderer.invoke('tacit:recordSelection', entry),
  getTopPhrases: patientId => ipcRenderer.invoke('tacit:topPhrases', patientId),
  listPatients: () => ipcRenderer.invoke('tacit:listPatients'),
  addPatient: entry => ipcRenderer.invoke('tacit:addPatient', entry),
  dbListPatients: () => ipcRenderer.invoke('tacit:db:patients:list'),
  dbCreatePatient: patient => ipcRenderer.invoke('tacit:db:patients:create', patient),
  dbGetPatient: id => ipcRenderer.invoke('tacit:db:patients:get', id),
  dbGetPatientByPatientId: patientId => ipcRenderer.invoke('tacit:db:patients:getByPatientId', patientId),
  dbUpdatePatient: (id, updates) => ipcRenderer.invoke('tacit:db:patients:update', id, updates),
  dbDeletePatient: id => ipcRenderer.invoke('tacit:db:patients:delete', id),
  dbGetClinicalContext: patientId => ipcRenderer.invoke('tacit:db:clinicalContext:get', patientId),
  dbSaveClinicalContext: context => ipcRenderer.invoke('tacit:db:clinicalContext:save', context),
  dbCreateSession: session => ipcRenderer.invoke('tacit:db:sessions:create', session),
  dbGetSession: id => ipcRenderer.invoke('tacit:db:sessions:get', id),
  dbCompleteSession: (id, endedAt) => ipcRenderer.invoke('tacit:db:sessions:complete', id, endedAt),
  dbSaveInteraction: interaction => ipcRenderer.invoke('tacit:db:interactions:save', interaction),
  dbListInteractionsForSession: sessionId => ipcRenderer.invoke('tacit:db:interactions:listForSession', sessionId),
  dbSaveVitalReading: reading => ipcRenderer.invoke('tacit:db:vitals:save', reading),
  dbListVitalReadingsForSession: sessionId => ipcRenderer.invoke('tacit:db:vitals:listForSession', sessionId),

  // --- Engine bridge (producer side — used only by engine-host.html) ---
  // Forwards one blinkEngine.js event to the main process, which relays it
  // to the React window. See preload-react.js for the consumer side.
  reportEngineEvent: (type, payload) => ipcRenderer.send('tacit:engine-event-report', { type, payload }),
  onEngineControl: callback => {
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on('tacit:engine-control', listener);
    return () => ipcRenderer.removeListener('tacit:engine-control', listener);
  },
});

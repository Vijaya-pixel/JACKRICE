// patientDirectory.js — local registry of known patients (first name + ID)
// so the renderer can offer a dropdown instead of retyping an ID every time.
//
// Same storage pattern as geminiHistory.js: a flat JSON file under Electron's
// per-machine userData dir, kept as its own file/IPC surface so it merges
// independently of the rest of the app.
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const PATIENTS_FILE = path.join(app.getPath('userData'), 'tacit-patients.json');

function loadPatients() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PATIENTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function savePatients(patients) {
  try {
    fs.mkdirSync(path.dirname(PATIENTS_FILE), { recursive: true });
    fs.writeFileSync(PATIENTS_FILE, JSON.stringify(patients, null, 2));
  } catch (error) {
    console.error('[tacit] failed to save patients:', error.message);
  }
}

// Alphabetical by first name for a stable, scannable dropdown.
function listPatients() {
  return loadPatients().sort((a, b) => a.firstName.localeCompare(b.firstName));
}

// Look up a patient by ID (case-insensitive, trimmed); create one if no match
// exists yet. Returns the patient record either way, so the caller can always
// select it right after calling this.
function findOrCreatePatient({ id, firstName } = {}) {
  const trimmedId = String(id || '').trim();
  if (!trimmedId) return null;

  const patients = loadPatients();
  const existing = patients.find(p => p.id.toLowerCase() === trimmedId.toLowerCase());
  const trimmedName = String(firstName || '').trim();

  if (existing) {
    if (trimmedName && trimmedName !== existing.firstName) {
      existing.firstName = trimmedName;
      savePatients(patients);
    }
    return existing;
  }

  const created = { id: trimmedId, firstName: trimmedName || trimmedId, createdAt: Date.now() };
  patients.push(created);
  savePatients(patients);
  return created;
}

module.exports = { listPatients, findOrCreatePatient };

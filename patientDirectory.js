// patientDirectory.js — compatibility wrapper for the old patient dropdown API.
'use strict';

const tacitDatabase = require('./tacitDatabase');

// Alphabetical by first name for a stable, scannable dropdown.
function listPatients() {
  return tacitDatabase.listPatients().map(tacitDatabase.toLegacyPatient);
}

// Look up a patient by ID (case-insensitive, trimmed); create one if no match
// exists yet. Returns the patient record either way, so the caller can always
// select it right after calling this.
function findOrCreatePatient({ id, firstName } = {}) {
  return tacitDatabase.toLegacyPatient(tacitDatabase.findOrCreatePatient({ patientId: id, name: firstName }));
}

module.exports = { listPatients, findOrCreatePatient };

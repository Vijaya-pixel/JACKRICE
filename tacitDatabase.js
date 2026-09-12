// tacitDatabase.js — local SQLite persistence for Tacit.
// Stored under Electron's userData directory; no cloud services involved.
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { app } = require('electron');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(app.getPath('userData'), 'tacit.sqlite');
const LEGACY_PATIENTS_FILE = path.join(app.getPath('userData'), 'tacit-patients.json');

let db;

function now() {
  return new Date().toISOString();
}

function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      patientId TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clinical_contexts (
      id TEXT PRIMARY KEY,
      patientId TEXT NOT NULL UNIQUE,
      diagnosis TEXT NOT NULL DEFAULT '',
      procedure TEXT NOT NULL DEFAULT '',
      medicalNotes TEXT NOT NULL DEFAULT '',
      bloodTestNotes TEXT NOT NULL DEFAULT '',
      additionalContext TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (patientId) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      patientId TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      endedAt TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
      FOREIGN KEY (patientId) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      patientId TEXT NOT NULL,
      question TEXT NOT NULL DEFAULT '',
      questionType TEXT NOT NULL CHECK (questionType IN ('yes_no', 'option_board', 'keyboard')),
      response TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (patientId) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vital_readings (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_patient ON sessions(patientId);
    CREATE INDEX IF NOT EXISTS idx_interactions_patient ON interactions(patientId);
    CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(sessionId);
    CREATE INDEX IF NOT EXISTS idx_vitals_session ON vital_readings(sessionId);
  `);
  migrateLegacyPatients();
  return db;
}

function migrateLegacyPatients() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_PATIENTS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return;
    for (const patient of parsed) {
      const patientId = String(patient.id || '').trim();
      if (!patientId || getPatientByPatientId(patientId)) continue;
      const createdAt = patient.createdAt ? new Date(patient.createdAt).toISOString() : now();
      createPatient({
        patientId,
        name: String(patient.firstName || patientId).trim() || patientId,
        createdAt,
        updatedAt: createdAt,
      });
    }
  } catch (_) {
    // No legacy file yet, or it is unreadable. The SQLite DB remains usable.
  }
}

function rowToPatient(row) {
  return row || null;
}

function createPatient(input = {}) {
  const database = openDb();
  const patientId = String(input.patientId || input.id || '').trim();
  if (!patientId) return null;
  const stamp = input.createdAt || now();
  const patient = {
    id: input.internalId || input.uuid || randomUUID(),
    patientId,
    name: String(input.name || input.firstName || patientId).trim() || patientId,
    createdAt: stamp,
    updatedAt: input.updatedAt || stamp,
  };
  database.prepare(`
    INSERT INTO patients (id, patientId, name, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(patient.id, patient.patientId, patient.name, patient.createdAt, patient.updatedAt);
  return patient;
}

function listPatients() {
  return openDb().prepare('SELECT * FROM patients ORDER BY name COLLATE NOCASE, patientId').all();
}

function getPatient(id) {
  return rowToPatient(openDb().prepare('SELECT * FROM patients WHERE id = ?').get(id));
}

function getPatientByPatientId(patientId) {
  return rowToPatient(openDb().prepare('SELECT * FROM patients WHERE lower(patientId) = lower(?)').get(String(patientId || '').trim()));
}

function updatePatient(id, updates = {}) {
  const existing = getPatient(id);
  if (!existing) return null;
  const next = {
    patientId: String(updates.patientId ?? existing.patientId).trim(),
    name: String(updates.name ?? existing.name).trim(),
    updatedAt: now(),
  };
  if (!next.patientId || !next.name) return null;
  openDb().prepare(`
    UPDATE patients SET patientId = ?, name = ?, updatedAt = ? WHERE id = ?
  `).run(next.patientId, next.name, next.updatedAt, id);
  return getPatient(id);
}

function deletePatient(id) {
  const result = openDb().prepare('DELETE FROM patients WHERE id = ?').run(id);
  return result.changes > 0;
}

function findOrCreatePatient(input = {}) {
  const patientId = String(input.patientId || input.id || '').trim();
  if (!patientId) return null;
  const existing = getPatientByPatientId(patientId);
  if (existing) {
    const name = String(input.name || input.firstName || '').trim();
    return name && name !== existing.name ? updatePatient(existing.id, { name }) : existing;
  }
  return createPatient({ patientId, name: input.name || input.firstName });
}

function saveClinicalContext(input = {}) {
  const patientId = String(input.patientId || '').trim();
  if (!getPatient(patientId)) return null;
  const existing = getClinicalContext(patientId);
  const stamp = now();
  const context = {
    id: existing?.id || input.id || randomUUID(),
    patientId,
    diagnosis: String(input.diagnosis || ''),
    procedure: String(input.procedure || ''),
    medicalNotes: String(input.medicalNotes || ''),
    bloodTestNotes: String(input.bloodTestNotes || ''),
    additionalContext: String(input.additionalContext || ''),
    createdAt: existing?.createdAt || input.createdAt || stamp,
    updatedAt: stamp,
  };
  openDb().prepare(`
    INSERT INTO clinical_contexts
      (id, patientId, diagnosis, procedure, medicalNotes, bloodTestNotes, additionalContext, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(patientId) DO UPDATE SET
      diagnosis = excluded.diagnosis,
      procedure = excluded.procedure,
      medicalNotes = excluded.medicalNotes,
      bloodTestNotes = excluded.bloodTestNotes,
      additionalContext = excluded.additionalContext,
      updatedAt = excluded.updatedAt
  `).run(
    context.id,
    context.patientId,
    context.diagnosis,
    context.procedure,
    context.medicalNotes,
    context.bloodTestNotes,
    context.additionalContext,
    context.createdAt,
    context.updatedAt,
  );
  return getClinicalContext(patientId);
}

function getClinicalContext(patientId) {
  return openDb().prepare('SELECT * FROM clinical_contexts WHERE patientId = ?').get(patientId) || null;
}

function createSession(input = {}) {
  const patientId = String(input.patientId || '').trim();
  if (!getPatient(patientId)) return null;
  const session = {
    id: input.id || randomUUID(),
    patientId,
    startedAt: input.startedAt || now(),
    endedAt: input.endedAt || null,
    status: input.status === 'completed' ? 'completed' : 'active',
  };
  openDb().prepare(`
    INSERT INTO sessions (id, patientId, startedAt, endedAt, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(session.id, session.patientId, session.startedAt, session.endedAt, session.status);
  return session;
}

function completeSession(id, endedAt = now()) {
  openDb().prepare(`
    UPDATE sessions SET endedAt = ?, status = 'completed' WHERE id = ?
  `).run(endedAt, id);
  return openDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

function saveInteraction(input = {}) {
  const interaction = {
    id: input.id || randomUUID(),
    sessionId: String(input.sessionId || '').trim(),
    patientId: String(input.patientId || '').trim(),
    question: String(input.question || ''),
    questionType: input.questionType || 'option_board',
    response: String(input.response || ''),
    timestamp: input.timestamp || now(),
  };
  if (!interaction.sessionId || !interaction.patientId) return null;
  openDb().prepare(`
    INSERT INTO interactions (id, sessionId, patientId, question, questionType, response, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    interaction.id,
    interaction.sessionId,
    interaction.patientId,
    interaction.question,
    interaction.questionType,
    interaction.response,
    interaction.timestamp,
  );
  return interaction;
}

function saveVitalReading(input = {}) {
  const reading = {
    id: input.id || randomUUID(),
    sessionId: String(input.sessionId || '').trim(),
    type: String(input.type || '').trim(),
    value: String(input.value ?? ''),
    unit: String(input.unit || ''),
    timestamp: input.timestamp || now(),
  };
  if (!reading.sessionId || !reading.type) return null;
  openDb().prepare(`
    INSERT INTO vital_readings (id, sessionId, type, value, unit, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(reading.id, reading.sessionId, reading.type, reading.value, reading.unit, reading.timestamp);
  return reading;
}

function listInteractionsForSession(sessionId) {
  return openDb().prepare('SELECT * FROM interactions WHERE sessionId = ? ORDER BY timestamp').all(sessionId);
}

function listVitalReadingsForSession(sessionId) {
  return openDb().prepare('SELECT * FROM vital_readings WHERE sessionId = ? ORDER BY timestamp').all(sessionId);
}

// Legacy dropdown shape used by yesnoApp.js and older React wrappers.
function toLegacyPatient(patient) {
  if (!patient) return null;
  return { id: patient.patientId, firstName: patient.name, createdAt: Date.parse(patient.createdAt) || Date.now() };
}

module.exports = {
  DB_FILE,
  createPatient,
  listPatients,
  getPatient,
  getPatientByPatientId,
  updatePatient,
  deletePatient,
  findOrCreatePatient,
  saveClinicalContext,
  getClinicalContext,
  createSession,
  completeSession,
  saveInteraction,
  saveVitalReading,
  listInteractionsForSession,
  listVitalReadingsForSession,
  toLegacyPatient,
};

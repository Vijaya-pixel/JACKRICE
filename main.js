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
const tacitDatabase = require('./tacitDatabase');

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

const GEMINI_QUESTION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'OBJECT',
        properties: {
          question: {
            type: 'STRING',
            description: 'A short question the clinician may choose to ask the patient.',
          },
          type: {
            type: 'STRING',
            enum: ['yes_no', 'option_board'],
            description: 'The best existing communication mode for this question.',
          },
          boardOptions: {
            type: 'ARRAY',
            minItems: 2,
            maxItems: 6,
            items: { type: 'STRING' },
            description: 'Only for option_board questions. Short patient-selectable answers.',
          },
        },
        required: ['question', 'type'],
      },
    },
  },
  required: ['questions'],
};

const GEMINI_QUESTION_SYSTEM_PROMPT = [
  'You help a clinician communicate efficiently with a patient who may be unable to speak.',
  'You are NOT diagnosing the patient and must not autonomously make medical decisions.',
  'Only suggest short questions the clinician may choose, edit, or ignore.',
  'Prefer questions answerable by yes/no or by a short option board.',
  'Never imply certainty about the patient condition.',
].join('\n');

const GEMINI_KEYBOARD_COMPLETION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    completions: {
      type: 'ARRAY',
      minItems: 0,
      maxItems: 4,
      items: {
        type: 'STRING',
        description: 'A short word or sentence completion preserving the patient-entered prefix.',
      },
    },
  },
  required: ['completions'],
};

const GEMINI_KEYBOARD_COMPLETION_SYSTEM_PROMPT = [
  'You help predict text for an AAC blink keyboard.',
  'The patient controls selection. You must never submit, speak, or finalize a response.',
  'You are NOT diagnosing the patient and must not autonomously make medical decisions.',
  'Return likely short word or sentence completions only.',
  'Every completion must preserve the exact meaning and visible prefix of text already typed by the patient.',
  'Prefer concise patient-authored first-person phrases when appropriate.',
].join('\n');

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

function parseQuestionArray(text) {
  if (!text) return [];
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return []; }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.questions)) return parsed.questions;
  return [];
}

function normalizeQuestionSuggestions(list) {
  const questions = [];
  const seen = new Set();
  for (const raw of list) {
    const question = String(raw?.question ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const type = raw?.type === 'option_board' ? 'option_board' : 'yes_no';
    if (!question || question.length > 120) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const suggestion = { question, type };
    if (type === 'option_board') {
      const boardOptions = normalizeOptions(Array.isArray(raw?.boardOptions) ? raw.boardOptions : []).slice(0, 6);
      if (boardOptions.length >= 2) suggestion.boardOptions = boardOptions;
    }
    questions.push(suggestion);
    if (questions.length === 3) break;
  }
  return questions;
}

function parseCompletionArray(text) {
  if (!text) return [];
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return []; }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.completions)) return parsed.completions;
  return [];
}

function normalizeKeyboardCompletions(list, typedText = '') {
  const prefix = String(typedText || '').replace(/\s+/g, ' ').trim();
  const prefixKey = prefix.toLowerCase();
  const seen = new Set();
  const completions = [];
  for (const raw of list) {
    const value = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s"'\-*•\d.)]+/, '')
      .replace(/[\s"']+$/, '')
      .trim();
    if (!value || value.length > 80) continue;
    if (prefixKey && !value.toLowerCase().startsWith(prefixKey)) continue;
    const key = value.toLowerCase();
    if (seen.has(key) || key === prefixKey) continue;
    seen.add(key);
    completions.push(value);
    if (completions.length === 4) break;
  }
  return completions;
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

async function geminiGenerateQuestionJson(model, apiKey, prompt, { thinking }) {
  const generationConfig = {
    temperature: 0.25,
    maxOutputTokens: 1536,
    responseMimeType: 'application/json',
    responseSchema: GEMINI_QUESTION_RESPONSE_SCHEMA,
  };
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GEMINI_QUESTION_SYSTEM_PROMPT }] },
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

async function geminiGenerateKeyboardCompletionJson(model, apiKey, prompt, { thinking }) {
  const generationConfig = {
    temperature: 0.35,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json',
    responseSchema: GEMINI_KEYBOARD_COMPLETION_RESPONSE_SCHEMA,
  };
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GEMINI_KEYBOARD_COMPLETION_SYSTEM_PROMPT }] },
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

async function geminiSuggestQuestions(apiKey, models, prompt) {
  const failures = [];
  for (const model of models) {
    let thinking = true;
    for (let attempt = 0; attempt < GEMINI_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const data = await geminiGenerateQuestionJson(model, apiKey, prompt, { thinking });
        const { text, finishReason } = geminiAnswerText(data);
        const questions = normalizeQuestionSuggestions(parseQuestionArray(text));
        if (questions.length === 3) return { model, questions, finishReason };
        failures.push(`${model}: expected 3 usable questions, got ${questions.length} (finishReason ${finishReason})`);
        break;
      } catch (error) {
        const timedOut = error.name === 'AbortError';
        const message = timedOut ? `${model}: timed out after ${GEMINI_TIMEOUT_MS} ms` : error.message;
        failures.push(message);
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

async function geminiSuggestKeyboardCompletions(apiKey, models, prompt, typedText) {
  const failures = [];
  for (const model of models) {
    let thinking = true;
    for (let attempt = 0; attempt < GEMINI_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const data = await geminiGenerateKeyboardCompletionJson(model, apiKey, prompt, { thinking });
        const { text, finishReason } = geminiAnswerText(data);
        const completions = normalizeKeyboardCompletions(parseCompletionArray(text), typedText);
        return { model, completions, finishReason };
      } catch (error) {
        const timedOut = error.name === 'AbortError';
        const message = timedOut ? `${model}: timed out after ${GEMINI_TIMEOUT_MS} ms` : error.message;
        failures.push(message);
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

ipcMain.handle('tacit:geminiQuestionSuggestions', async (_event, context = {}) => {
  const apiKey = readEnvVar('GEMINI_API_KEY');
  if (!apiKey) {
    return { source: 'fallback', questions: [], error: 'GEMINI_API_KEY missing' };
  }

  const configured = readEnvVar('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
  const models = [...new Set([configured, GEMINI_DEFAULT_MODEL, GEMINI_BACKUP_MODEL])];
  const clinicalContext = context.clinicalContext || {};
  const patient = context.patient || {};
  const recentInteractions = Array.isArray(context.recentInteractions) ? context.recentInteractions.slice(-8) : [];
  const currentSessionInteractions = Array.isArray(context.currentSessionInteractions)
    ? context.currentSessionInteractions.slice(-8)
    : [];

  const prompt = [
    'Return exactly 3 JSON question suggestions for the clinician.',
    'Each object must have: question, type. Use type "yes_no" or "option_board".',
    'For option_board items, include boardOptions with 2 to 6 short answer options.',
    'Do not diagnose. Do not recommend treatment. Do not decide what the patient needs.',
    `Patient: ${JSON.stringify({
      patientId: patient.patientId,
      name: patient.name,
    })}`,
    `Clinical context: ${JSON.stringify({
      diagnosis: clinicalContext.diagnosis || '',
      procedure: clinicalContext.procedure || '',
      medicalNotes: clinicalContext.medicalNotes || '',
      bloodTestNotes: clinicalContext.bloodTestNotes || '',
      additionalContext: clinicalContext.additionalContext || '',
    })}`,
    `Recent communication history: ${JSON.stringify(recentInteractions.map(item => ({
      question: item.question,
      type: item.questionType,
      response: item.response,
      timestamp: item.timestamp,
    })))}`,
    `Current session interactions: ${JSON.stringify(currentSessionInteractions.map(item => ({
      question: item.question,
      type: item.questionType,
      response: item.response,
      timestamp: item.timestamp,
    })))}`,
  ].join('\n');

  try {
    const { model, questions } = await geminiSuggestQuestions(apiKey, models, prompt);
    console.log(`[tacit] gemini ${model} question suggestions -> ${JSON.stringify(questions)}`);
    return { source: 'gemini', model, questions };
  } catch (error) {
    console.error('[tacit] gemini question suggestions failed:', error.failures ? error.failures.join(' | ') : error.message);
    return { source: 'fallback', questions: [], error: error.message || String(error) };
  }
});

ipcMain.handle('tacit:geminiKeyboardCompletions', async (_event, context = {}) => {
  const typedText = String(context.typedText || '').replace(/\s+/g, ' ').trim();
  if (typedText.length < 2) return { source: 'fallback', completions: [] };

  const apiKey = readEnvVar('GEMINI_API_KEY');
  if (!apiKey) {
    return { source: 'fallback', completions: [], error: 'GEMINI_API_KEY missing' };
  }

  const configured = readEnvVar('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
  const models = [...new Set([configured, GEMINI_DEFAULT_MODEL, GEMINI_BACKUP_MODEL])];
  const clinicalContext = context.clinicalContext || {};
  const patient = context.patient || {};
  const recentInteractions = Array.isArray(context.recentInteractions) ? context.recentInteractions.slice(-8) : [];
  const currentSessionInteractions = Array.isArray(context.currentSessionInteractions)
    ? context.currentSessionInteractions.slice(-8)
    : [];

  const prompt = [
    'Return up to 4 likely completions for the patient text.',
    'The patient must choose a completion before it is inserted, and still confirms DONE later.',
    'Do not submit, speak, or finalize anything.',
    'Every completion must start with the already typed text exactly in meaning and visible prefix.',
    `Typed text: ${typedText}`,
    `Clinician current question: ${String(context.clinicianQuestion || '').trim()}`,
    `Patient: ${JSON.stringify({
      patientId: patient.patientId,
      name: patient.name,
    })}`,
    `Clinical context: ${JSON.stringify({
      diagnosis: clinicalContext.diagnosis || '',
      procedure: clinicalContext.procedure || '',
      medicalNotes: clinicalContext.medicalNotes || '',
      bloodTestNotes: clinicalContext.bloodTestNotes || '',
      additionalContext: clinicalContext.additionalContext || '',
    })}`,
    `Recent conversation: ${JSON.stringify(recentInteractions.map(item => ({
      question: item.question,
      type: item.questionType,
      response: item.response,
      timestamp: item.timestamp,
    })))}`,
    `Current session interactions: ${JSON.stringify(currentSessionInteractions.map(item => ({
      question: item.question,
      type: item.questionType,
      response: item.response,
      timestamp: item.timestamp,
    })))}`,
  ].join('\n');

  try {
    const { model, completions } = await geminiSuggestKeyboardCompletions(apiKey, models, prompt, typedText);
    return { source: 'gemini', model, completions };
  } catch (error) {
    console.error('[tacit] gemini keyboard completions failed:', error.failures ? error.failures.join(' | ') : error.message);
    return { source: 'fallback', completions: [], error: error.message || String(error) };
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

// --- Local database ---------------------------------------------------------
ipcMain.handle('tacit:db:patients:list', () => tacitDatabase.listPatients());
ipcMain.handle('tacit:db:patients:create', (_event, patient = {}) => tacitDatabase.createPatient(patient));
ipcMain.handle('tacit:db:patients:get', (_event, id) => tacitDatabase.getPatient(id));
ipcMain.handle('tacit:db:patients:getByPatientId', (_event, patientId) => tacitDatabase.getPatientByPatientId(patientId));
ipcMain.handle('tacit:db:patients:update', (_event, id, updates = {}) => tacitDatabase.updatePatient(id, updates));
ipcMain.handle('tacit:db:patients:delete', (_event, id) => tacitDatabase.deletePatient(id));
ipcMain.handle('tacit:db:clinicalContext:get', (_event, patientId) => tacitDatabase.getClinicalContext(patientId));
ipcMain.handle('tacit:db:clinicalContext:save', (_event, context = {}) => tacitDatabase.saveClinicalContext(context));
ipcMain.handle('tacit:db:sessions:create', (_event, session = {}) => tacitDatabase.createSession(session));
ipcMain.handle('tacit:db:sessions:get', (_event, id) => tacitDatabase.getSession(id));
ipcMain.handle('tacit:db:sessions:complete', (_event, id, endedAt) => tacitDatabase.completeSession(id, endedAt));
ipcMain.handle('tacit:db:interactions:save', (_event, interaction = {}) => tacitDatabase.saveInteraction(interaction));
ipcMain.handle('tacit:db:interactions:listForSession', (_event, sessionId) => tacitDatabase.listInteractionsForSession(sessionId));
ipcMain.handle('tacit:db:vitals:save', (_event, reading = {}) => tacitDatabase.saveVitalReading(reading));
ipcMain.handle('tacit:db:vitals:listForSession', (_event, sessionId) => tacitDatabase.listVitalReadingsForSession(sessionId));

// --- Engine event relay ------------------------------------------------------
// Hidden engine-host window -> main -> visible React window, and back for
// control commands (calibrate, toggle eye tracking). See preload.js
// (producer side, used by engine-host.html) and preload-react.js (consumer
// side). No-ops in legacy mode, where there's only one window and the UI
// talks to the engine in-process (see yesnoApp.js).
let mainWindow = null;
let engineHostWindow = null;

ipcMain.on('tacit:engine-event-report', (_event, msg) => {
  mainWindow?.webContents.send('tacit:engine-event', msg);
});
ipcMain.on('tacit:engine-control-send', (_event, msg) => {
  engineHostWindow?.webContents.send('tacit:engine-control', msg);
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
  } else {
    engineHostWindow = createEngineHostWindow();
    mainWindow = createReactWindow();
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

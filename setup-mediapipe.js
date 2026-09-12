// setup-mediapipe.js — copies the MediaPipe WASM runtime out of node_modules and
// downloads the FaceLandmarker model into ./mp so the Electron page (file://,
// CSP 'self') can load them locally. Run: npm run setup
'use strict';
const fs = require('fs'), path = require('path'), https = require('https');
const src = path.join(__dirname, 'node_modules/@mediapipe/tasks-vision/wasm');
const dst = path.join(__dirname, 'mp/wasm');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('copied wasm runtime ->', dst);
const model = path.join(__dirname, 'mp/face_landmarker.task');
const url = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
if (fs.existsSync(model) && fs.statSync(model).size > 1e6) { console.log('model already present'); process.exit(0); }
const get = (u, cb) => https.get(u, r => (r.statusCode >= 300 && r.headers.location) ? get(r.headers.location, cb) : cb(r));
get(url, r => { const w = fs.createWriteStream(model); r.pipe(w); w.on('finish', () => console.log('downloaded model ->', model, fs.statSync(model).size, 'bytes')); });

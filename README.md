# Tacit

Eye-driven Yes/No selection for patients who can't speak or move: look at an answer, blink once.
Electron desktop app. Perception by the **Presage SmartSpectra SDK** (blink detection, face
landmarks, pulse/breathing); gaze from a local MediaPipe face mesh; decision logic in `blinkEngine.js`.

## Run

```bash
npm install                 # pulls @smartspectra/node-sdk (+ per-platform native runtimes, large)
npm run setup               # one-time: copies MediaPipe WASM + downloads the face model into ./mp
cp .env.example .env        # then put your key in .env:  PRESAGE_API_KEY=...   (free at physiology.presagetech.com)
npm start                   # bundles renderer + worker with esbuild, launches Electron
```

VS Code terminal: `env -u ELECTRON_RUN_AS_NODE npm start` (VS Code sets a var that makes Electron run as plain Node).
Diagnostics: the renderer console is relayed to the terminal; `TACIT_DEVTOOLS=1 npm start` opens DevTools.

## Flow in the app

1. Blink calibration (5 s) — blink naturally.
2. Gaze centering — look at the video when it says LOOK HERE (2 s).
3. Look at **Yes** or **No** to highlight it; **blink once** to select. Reset for another round.

## Files

| File | Role |
|---|---|
| `main.js` / `preload.js` | Electron main process: window, Presage IPC bridge, camera permission, reads `PRESAGE_API_KEY` from `.env` |
| `renderer.js` | Renderer entry: wires Presage source + gaze tracker into the engine, Presage-specific tuning (`ENGINE_OVERRIDES`), terminal diagnostics |
| `presageSource.js` | Frame source: Presage SDK -> landmarks, blink flag, vitals |
| `gazeTracker.js` / `gazeWorker.js` | Sub-pixel iris landmarks for gaze (MediaPipe in a Web Worker on a cloned camera track) |
| `blinkEngine.js` | Source-agnostic engine: EAR timing, blink zones (ignore/select/rest), calibration, gaze direction, face-lost + lighting handling. All tunables in `DEFAULT_CONFIG` |
| `yesnoApp.js`, `yesno-electron.html`, `yesno.css` | The Yes/No test UI |
| `setup-mediapipe.js` | Fetches the MediaPipe runtime/model into `./mp` (gitignored) |

## Why the hybrid

Presage is the product's physiology engine and its blink detector confirms every selection. But it
rounds landmarks to whole pixels, and "which box is the user looking at" is a 3-5 pixel iris shift,
so gaze needs float-precision eye points — the MediaPipe face mesh supplies only that, off the main
thread so it never starves Presage's frame pump.

## Tuning

`renderer.js` -> `ENGINE_OVERRIDES` (blink zone timings, EAR thresholds, gaze dead zone/dwell/smoothing).
Defaults and documentation for every knob: `blinkEngine.js` -> `DEFAULT_CONFIG`.

## Text-to-speech in the React desktop app

Set `ELEVENLABS_API_KEY` in the root `.env`, then restart Electron. The
**Text-to-speech** switch above the patient workflow turns voice playback on or
off and remembers the setting on this device. Voice starts enabled when configured.
Selected Yes/No and board options are spoken for click, blink, and spacebar input;
keyboard messages are spoken when **DONE** is selected. The session's **Read summary**
button reads the saved questions and answers aloud.

Turning voice off or pressing **Stop speaking** cancels pending and playing speech.
Plain browser previews do not have access to the ElevenLabs key and show voice as
unavailable. API or playback failures leave communication and saving usable.

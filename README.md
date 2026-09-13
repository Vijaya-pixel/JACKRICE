# Tacit - Eye Driven Communication App

A comprehensive assistive communication app that helps non-verbal or mobility-limited patients communicate using blink detection, gaze tracking, AI-assisted suggestions, and text-to-speech.

## Features

### 👁️ Pages & Features

1. **Patient Setup / Selection**

   * Create and select patient profiles
   * Store patient-specific clinical context
   * Add diagnosis, procedure, and medical notes
   * Maintain separate communication histories for each patient
   * Start and manage communication sessions

2. **Yes / No Communication**

   * Large Yes and No response options
   * Automatic option scanning
   * Blink-based selection
   * Mouse input fallback
   * Designed for quick clinician questions

3. **AI Communication Board**

   * Context-aware communication suggestions
   * Google Gemini integration
   * Uses patient and session history
   * Generates likely needs and phrases
   * Blink-based option selection
   * Keyboard fallback for custom responses

4. **Blink-Scanning Keyboard**

   * Row and column scanning
   * Blink-based character selection
   * Frequency-ordered keyboard layout
   * Phrase and sentence prediction
   * AI-assisted text completion
   * Completed messages can be spoken aloud

5. **Clinician Dashboard**

   * Patient session monitoring
   * Blink and gaze tracking status
   * Calibration information
   * Patient responses and interaction history
   * Pulse and breathing-rate display
   * Lighting and tracking warnings

6. **Text-to-Speech**

   * ElevenLabs integration
   * Speaks selected patient responses
   * Supports typed keyboard messages
   * Automatic playback
   * TTS enable/disable preference

## Tech Stack

* **Frontend**: React 19 with TypeScript
* **Desktop Framework**: Electron
* **Routing**: TanStack Router
* **Styling**: Tailwind CSS
* **AI**: Google Gemini API
* **Computer Vision**: Presage SmartSpectra SDK + MediaPipe
* **Text-to-Speech**: ElevenLabs
* **Database**: SQLite
* **Icons**: Lucide React
* **Build Tools**: Vite and esbuild

## Setup Instructions

### Prerequisites

* Node.js
* npm
* Git
* Webcam
* Presage SmartSpectra API key
* Google Gemini API key
* ElevenLabs API key

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/Vijaya-pixel/JACKRICE.git
   cd JACKRICE
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **MediaPipe Setup**

   ```bash
   npm run setup
   ```

4. **Environment Setup**

   Create a `.env` file or copy the example configuration:

   ```bash
   cp .env.example .env
   ```

   Add your API keys:

   ```env
   PRESAGE_API_KEY=your_presage_api_key
   GEMINI_API_KEY=your_gemini_api_key
   GEMINI_MODEL=gemini-flash-latest
   ELEVENLABS_API_KEY=your_elevenlabs_api_key
   ```

5. **Run the app**

   ```bash
   npm start
   ```

   If Electron launches incorrectly from VS Code:

   ```bash
   env -u ELECTRON_RUN_AS_NODE npm start
   ```

## Project Structure

```text
JACKRICE/
├── main.js                     # Electron main process
├── preload.js                  # Electron IPC bridge
├── blinkEngine.js              # Blink detection and calibration
├── gazeTracker.js              # Gaze tracking logic
├── gazeWorker.js               # MediaPipe gaze processing
├── presageSource.js            # Presage SmartSpectra integration
├── geminiHistory.js            # Patient communication history
├── elevenLabsService.js        # Text-to-speech integration
├── tacitDatabase.js            # SQLite database
├── keyboardData.js             # Keyboard and prediction utilities
├── yesnoApp.js                 # AAC communication interface
├── setup-mediapipe.js          # MediaPipe setup
├── .env.example                # Environment configuration
└── frontend/
    └── src/
        ├── components/         # React UI components
        ├── hooks/              # Blink, TTS, and vitals hooks
        ├── lib/                # App services and API helpers
        ├── routes/             # Application pages
        └── types/              # TypeScript definitions
```

## Key Features Implementation

### Blink Detection

* Uses Presage SmartSpectra for blink and face tracking
* Performs blink calibration before communication
* Tracks Eye Aspect Ratio
* Detects intentional blink selections
* Includes false-activation filtering
* Handles face-loss and poor-lighting conditions

### Gaze Tracking

* Uses MediaPipe Face Landmarker
* Tracks iris and eye landmarks
* Processes gaze data in a Web Worker
* Works alongside Presage blink detection
* Helps identify communication targets

### Gemini Integration

* Generates context-aware communication options
* Suggests clinician questions
* Uses patient-specific interaction history
* Assists with phrase and sentence completion
* Does not autonomously diagnose patients

### Text-to-Speech

* Uses ElevenLabs for voice output
* Reads selected communication responses
* Supports keyboard-generated messages
* Can be enabled or disabled
* Communication remains usable without TTS

### Local Storage

* SQLite database for persistent patient data
* Stores patients and clinical context
* Tracks communication sessions
* Saves clinician questions and patient responses
* Stores session vital readings

## Development Notes

* Tacit is currently a hackathon prototype
* Blink detection requires initial calibration
* Webcam quality and lighting can affect tracking
* Mouse input is available as a fallback
* Gemini suggestions require internet access
* ElevenLabs speech requires internet access
* AI assists communication but does not make medical decisions
* The clinician remains responsible for diagnosis and treatment decisions

## Future Enhancements

* Improved gaze calibration
* More personalized blink detection
* Multi-language communication boards
* Offline AI support
* Hospital EHR / FHIR integration
* Additional AAC layouts
* Patient-specific voice profiles
* Session export functionality
* Improved support for glasses and varied lighting
* Dedicated hardware eye-tracker support

## Troubleshooting

### Common Issues

1. **Camera not working**: Ensure webcam permissions are enabled and no other application is using the camera
2. **Blink detection inaccurate**: Re-run calibration and improve room lighting
3. **Gemini not responding**: Verify the `GEMINI_API_KEY` in the environment file
4. **Text-to-speech not working**: Verify the `ELEVENLABS_API_KEY`
5. **Electron launches as Node**: Run `env -u ELECTRON_RUN_AS_NODE npm start`
6. **Build errors**: Delete `node_modules`, reinstall dependencies, and restart the application

### Support

For issues or questions, please refer to the Electron, MediaPipe, Google Gemini, Presage SmartSpectra, or ElevenLabs documentation.

## About

Tacit is an AI-assisted Augmentative and Alternative Communication system designed to help patients communicate through minimal eye movement and intentional blinks.

The system follows a progressive communication model:

```text
Yes / No
   ↓
Context-Aware Communication Board
   ↓
Blink-Scanning Keyboard
```

The goal is to reduce the physical effort required for a patient to express their needs while keeping clinicians in control of medical interpretation and decision-making.

### Resources

* README
* Repository Activity
* Issues
* Pull Requests

### Languages

* TypeScript
* JavaScript
* CSS
* HTML

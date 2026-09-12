// tacit.d.ts — types for the window.tacit bridge exposed by preload-react.js
// (see ../../../preload-react.js and ../../../engineHostRenderer.js for the
// producer side). window.tacit is undefined when running in a plain browser
// tab — every consumer in this app must handle that case, not assume Electron.

export type TacitGeminiSuggestions = {
  source: "gemini" | "fallback";
  model?: string;
  options: string[];
  error?: string;
};

export type TacitSelectionEntry = {
  patientId?: string;
  patientContext?: string;
  text: string;
  source: "suggested" | "typed";
  how: string;
};

export type TacitPatient = {
  id: string;
  firstName: string;
  createdAt: number;
};

// --- Engine events (forwarded from blinkEngine.js via the hidden engine-host
// window — see engineHostRenderer.js). Payload shapes mirror what
// blinkEngine.js itself emits; 'frame' is thinned to a lightweight summary.
export type TacitCalibrationPhase = "countdown" | "sampling" | "done" | "failed";
export type TacitEyeState = "open" | "closing" | "closed";
export type TacitGazeDirection = "left" | "center" | "right";

export type TacitCalibrationResult = {
  baseline: number;
  threshold: number;
  reopen: number;
  baseOpen: number | null;
  baseEar: number | null;
  stats: { n: number; min: number; p10: number; p50: number; p90: number; max: number };
  samples: number[];
  thresholdRatio: number;
  reopenRatio: number;
};

export type TacitEngineEvent =
  | { type: "status"; payload: { phase: string; message: string } }
  | { type: "error"; payload: { error: { message: string; name?: string } } }
  | {
      type: "calibration";
      payload: {
        phase: TacitCalibrationPhase;
        remainingMs?: number;
        sampleCount: number;
        reason?: string;
        result?: TacitCalibrationResult;
      };
    }
  | { type: "select"; payload: { t: number; durationMs: number; minSig: number } }
  | { type: "rest"; payload: { t: number; sinceMs: number } }
  | { type: "resume"; payload: { t: number; durationMs: number; minSig: number } }
  | {
      type: "ambiguous";
      payload: { t: number; durationMs: number; reason: string; minSig: number; threshold: number };
    }
  | { type: "facelost"; payload: { t: number } }
  | { type: "faceback"; payload: { t: number } }
  | { type: "warning"; payload: { code: string; active: boolean; message: string } }
  | { type: "gaze"; payload: { t: number; direction: TacitGazeDirection; x: number } }
  | {
      type: "vitals";
      payload: {
        pulseBpm?: number;
        pulseConfidence?: number;
        breathingBpm?: number;
        breathingConfidence?: number;
      };
    }
  | {
      type: "frame";
      payload: {
        t: number;
        face: boolean;
        eye: TacitEyeState;
        gaze: TacitGazeDirection;
        gazeX: number | null;
        degraded: boolean;
        paused: boolean;
        signal: number | null;
        eyePx: number;
      };
    };

export type TacitEngineControlCommand =
  { type: "calibrate" } | { type: "setEyeTracking"; enabled: boolean };

export interface TacitBridge {
  // Gemini + patient directory (main-process IPC, see ../../../main.js)
  getGeminiSuggestions(context: {
    patientContext?: string;
    patientId?: string;
  }): Promise<TacitGeminiSuggestions>;
  recordSelection(entry: TacitSelectionEntry): Promise<void>;
  getTopPhrases(patientId?: string): Promise<string[]>;
  listPatients(): Promise<TacitPatient[]>;
  addPatient(entry: { id: string; firstName?: string }): Promise<TacitPatient | null>;

  // Engine bridge (consumer side)
  onEngineEvent(callback: (event: TacitEngineEvent) => void): () => void;
  sendEngineControl(command: TacitEngineControlCommand): void;

  // Always true when window.tacit exists — lets code distinguish "running in
  // Electron" from "running in a browser tab" without feature-sniffing.
  isElectron: true;
}

declare global {
  interface Window {
    tacit?: TacitBridge;
  }
}

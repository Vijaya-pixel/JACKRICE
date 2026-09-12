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

export type SuggestedQuestion = {
  question: string;
  type: "yes_no" | "option_board";
  boardOptions?: string[];
};

export type SuggestedQuestionsResponse = {
  source: "gemini" | "fallback";
  model?: string;
  questions: SuggestedQuestion[];
  error?: string;
};

export type KeyboardCompletionsResponse = {
  source: "gemini" | "fallback";
  model?: string;
  completions: string[];
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

export type Patient = {
  id: string;
  patientId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ClinicalContext = {
  id: string;
  patientId: string;
  diagnosis: string;
  procedure: string;
  medicalNotes: string;
  bloodTestNotes: string;
  additionalContext: string;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  patientId: string;
  startedAt: string;
  endedAt: string | null;
  status: "active" | "completed";
};

export type QuestionType = "yes_no" | "option_board" | "keyboard";

export type Interaction = {
  id: string;
  sessionId: string;
  patientId: string;
  question: string;
  questionType: QuestionType;
  response: string;
  timestamp: string;
};

export type VitalReading = {
  id: string;
  sessionId: string;
  type: string;
  value: string;
  unit: string;
  timestamp: string;
};

export type CreatePatientInput = {
  patientId: string;
  name: string;
};

export type UpdatePatientInput = Partial<CreatePatientInput>;

export type SaveClinicalContextInput = {
  patientId: string;
  diagnosis?: string;
  procedure?: string;
  medicalNotes?: string;
  bloodTestNotes?: string;
  additionalContext?: string;
};

export type CreateSessionInput = {
  patientId: string;
  startedAt?: string;
};

export type SaveInteractionInput = {
  sessionId: string;
  patientId: string;
  question?: string;
  questionType: QuestionType;
  response?: string;
  timestamp?: string;
};

export type SaveVitalReadingInput = {
  sessionId: string;
  type: string;
  value: string | number;
  unit?: string;
  timestamp?: string;
};

// --- Engine events (forwarded from blinkEngine.js via the hidden engine-host
// window — see engineHostRenderer.js). Payload shapes mirror what
// blinkEngine.js itself emits; 'frame' is thinned to a lightweight summary.
export type TacitCalibrationPhase = "countdown" | "sampling" | "done" | "failed";
export type TacitEyeState = "open" | "closing" | "closed";
export type TacitGazeDirection = "left" | "center" | "right";
// Gaze centering: "look at the center of the screen" for a couple seconds
// right after blink calibration finishes. Mirrors the blink calibration
// phase naming, minus "countdown" (no lead-in needed).
export type TacitGazeCalibrationPhase = "sampling" | "done" | "failed";
// Presage's cardio/breathing signal takes several seconds of a held-still,
// well-lit face before its own confidence score is trustworthy. "sampling"
// covers that warm-up; "timeout" means it's still not confident after the
// budget but sampling continues in the background; "ready" is sticky once
// reached (see engineHostRenderer.js's vitalsCalTick).
export type TacitVitalsCalibrationPhase = "sampling" | "ready" | "timeout";

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
      type: "gazeCalibration";
      payload: {
        phase: TacitGazeCalibrationPhase;
        remainingMs?: number;
        sampleCount: number;
        center?: number;
        deadZone?: number;
        reason?: string;
      };
    }
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
      type: "vitalsCalibration";
      payload: {
        phase: TacitVitalsCalibrationPhase;
        elapsedMs: number;
        pulseConfidence: number;
        breathingConfidence: number | null;
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
        blinkFlag?: boolean;
      };
    };

export type TacitEngineControlCommand =
  { type: "calibrate" } | { type: "calibrateGaze" } | { type: "setEyeTracking"; enabled: boolean };

export interface TacitBridge {
  // Gemini + patient directory (main-process IPC, see ../../../main.js)
  getGeminiSuggestions(context: {
    patientContext?: string;
    patientId?: string;
  }): Promise<TacitGeminiSuggestions>;
  getGeminiQuestionSuggestions(context: {
    patient?: Patient;
    clinicalContext?: ClinicalContext | null;
    recentInteractions?: Interaction[];
    currentSessionInteractions?: Interaction[];
  }): Promise<SuggestedQuestionsResponse>;
  getGeminiKeyboardCompletions(context: {
    typedText: string;
    clinicianQuestion?: string;
    patient?: Patient;
    clinicalContext?: ClinicalContext | null;
    recentInteractions?: Interaction[];
    currentSessionInteractions?: Interaction[];
  }): Promise<KeyboardCompletionsResponse>;
  recordSelection(entry: TacitSelectionEntry): Promise<void>;
  getTopPhrases(patientId?: string): Promise<string[]>;
  listPatients(): Promise<TacitPatient[]>;
  addPatient(entry: { id: string; firstName?: string }): Promise<TacitPatient | null>;
  dbListPatients(): Promise<Patient[]>;
  dbCreatePatient(patient: CreatePatientInput): Promise<Patient | null>;
  dbGetPatient(id: string): Promise<Patient | null>;
  dbGetPatientByPatientId(patientId: string): Promise<Patient | null>;
  dbUpdatePatient(id: string, updates: UpdatePatientInput): Promise<Patient | null>;
  dbDeletePatient(id: string): Promise<boolean>;
  dbGetClinicalContext(patientId: string): Promise<ClinicalContext | null>;
  dbSaveClinicalContext(context: SaveClinicalContextInput): Promise<ClinicalContext | null>;
  dbCreateSession(session: CreateSessionInput): Promise<Session | null>;
  dbGetSession(id: string): Promise<Session | null>;
  dbCompleteSession(id: string, endedAt?: string): Promise<Session | null>;
  dbSaveInteraction(interaction: SaveInteractionInput): Promise<Interaction | null>;
  dbListInteractionsForSession(sessionId: string): Promise<Interaction[]>;
  dbSaveVitalReading(reading: SaveVitalReadingInput): Promise<VitalReading | null>;
  dbListVitalReadingsForSession(sessionId: string): Promise<VitalReading[]>;

  // Eleven Labs TTS (get API key from .env)
  getElevenLabsApiKey(): Promise<string>;

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

import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  Camera,
  CameraOff,
  ChevronDown,
  HeartPulse,
  Check,
  ClipboardList,
  Pencil,
  RotateCcw,
  Sparkles,
  Undo2,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { LiveVitalsButton } from "@/components/live-vitals";
import { RoleGate } from "@/components/role-gate";
import { SiteHeader } from "@/components/site-header";
import { SpeechToggleButton, TextToSpeechProvider } from "@/components/text-to-speech";
import { Button } from "@/components/ui/button";
import { suppressBlinkInputFor, useBlinkInput } from "@/hooks/useBlinkInput";
import { useEngineDiagnostics } from "@/hooks/useEngineDiagnostics";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useVitalsRecorder, VITAL_TYPES } from "@/hooks/useVitalsRecorder";
import { localDb } from "@/lib/local-db";
import {
  buildSuggestedQuestionContext,
  generateKeyboardCompletions,
  generateSuggestedQuestions,
} from "@/lib/question-suggestions";
import { fetchNeedsSuggestions, recordSelection, useIsElectron } from "@/lib/tacit-api";
import { cn } from "@/lib/utils";
import type { Interaction, Patient, Session, SuggestedQuestion, VitalReading } from "@/types/tacit";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "TACIT — Blink Communication Prototype" },
      {
        name: "description",
        content:
          "A calm contactless communication interface prototype for ICU and paralysis patients.",
      },
      { property: "og:title", content: "TACIT — Blink Communication Prototype" },
      {
        property: "og:description",
        content:
          "A calm contactless communication interface prototype for ICU and paralysis patients.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AppRoute,
});

function AppRoute() {
  return (
    <RoleGate>
      <TextToSpeechProvider>
        <TacitApp />
      </TextToSpeechProvider>
    </RoleGate>
  );
}

type WorkflowStage =
  "PATIENT_SETUP" | "CLINICAL_CONTEXT" | "CALIBRATION" | "COMMUNICATION" | "SESSION_SUMMARY";

type CalibrationState = {
  calibrationCompleted: boolean;
  detectedBlinkCount: number;
};

type WorkflowState = {
  currentStage: WorkflowStage;
  currentPatient: Patient | null;
  currentSession: Session | null;
  calibrationState: CalibrationState;
  restoring: boolean;
};

type WorkflowAction =
  | { type: "RESTORE_START" }
  | { type: "RESTORE_EMPTY" }
  | { type: "RESTORE_PATIENT"; patient: Patient }
  | { type: "RESTORE_SESSION"; patient: Patient; session: Session }
  | { type: "SELECT_PATIENT"; patient: Patient }
  | { type: "START_SESSION"; session: Session }
  | { type: "SET_STAGE"; stage: WorkflowStage }
  | { type: "RESET_CALIBRATION" }
  | { type: "COMPLETE_CALIBRATION"; detectedBlinkCount: number }
  | { type: "RESET_WORKFLOW" };

type ScanItem = {
  label: string;
  value?: string;
  kind?: "letter" | "suggestion" | "undo" | "speak";
};

type ScanOption<T extends string = string> = {
  label: string;
  value: T;
};

type QuestionSuggestionState = {
  questions: SuggestedQuestion[];
  loading: boolean;
  error: string | null;
  source: "gemini" | "fallback" | null;
  model: string | null;
};

const ACTIVE_PATIENT_KEY = "tacit:activePatientId";
const ACTIVE_SESSION_KEY = "tacit:activeSessionId";

const initialWorkflowState: WorkflowState = {
  currentStage: "PATIENT_SETUP",
  currentPatient: null,
  currentSession: null,
  calibrationState: { calibrationCompleted: false, detectedBlinkCount: 0 },
  restoring: true,
};

function workflowReducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
  switch (action.type) {
    case "RESTORE_START":
      return { ...state, restoring: true };
    case "RESTORE_EMPTY":
      return { ...initialWorkflowState, restoring: false };
    case "RESTORE_PATIENT":
      return {
        ...state,
        currentStage: "CLINICAL_CONTEXT",
        currentPatient: action.patient,
        currentSession: null,
        calibrationState: { calibrationCompleted: false, detectedBlinkCount: 0 },
        restoring: false,
      };
    case "RESTORE_SESSION":
      return {
        ...state,
        currentStage: "CALIBRATION",
        currentPatient: action.patient,
        currentSession: action.session,
        calibrationState: { calibrationCompleted: false, detectedBlinkCount: 0 },
        restoring: false,
      };
    case "SELECT_PATIENT":
      return {
        ...state,
        currentStage: "CLINICAL_CONTEXT",
        currentPatient: action.patient,
        currentSession: null,
        calibrationState: { calibrationCompleted: false, detectedBlinkCount: 0 },
        restoring: false,
      };
    case "START_SESSION":
      return {
        ...state,
        currentStage: "CALIBRATION",
        currentSession: action.session,
        calibrationState: { calibrationCompleted: false, detectedBlinkCount: 0 },
        restoring: false,
      };
    case "SET_STAGE":
      return { ...state, currentStage: action.stage };
    case "RESET_CALIBRATION":
      return { ...state, calibrationState: { calibrationCompleted: false, detectedBlinkCount: 0 } };
    case "COMPLETE_CALIBRATION":
      return {
        ...state,
        calibrationState: {
          calibrationCompleted: true,
          detectedBlinkCount: action.detectedBlinkCount,
        },
      };
    case "RESET_WORKFLOW":
      return { ...initialWorkflowState, restoring: false };
    default:
      return state;
  }
}

const NEEDS: ScanItem[] = [
  { label: "Pain" },
  { label: "Thirsty" },
  { label: "Nurse" },
  { label: "Uncomfortable" },
  { label: "Family" },
  { label: "Yes" },
  { label: "No" },
  { label: "More time" },
];

const LETTERS = "ETAOINSHRDLUCMFPGWYBVKXJQZ".split("").map((label) => ({
  label,
  value: label,
  kind: "letter" as const,
}));

const SUGGESTIONS: ScanItem[] = [
  { label: "I need help", value: "I need help", kind: "suggestion" },
  { label: "Please call my family", value: "Please call my family", kind: "suggestion" },
  { label: "I am uncomfortable", value: "I am uncomfortable", kind: "suggestion" },
];

const NEED_TONES = [
  "bg-pastel-green/70",
  "bg-pastel-mint/70",
  "bg-pastel-blush/70",
  "bg-pastel-blue/70",
];

function useScanner(length: number, active = true, speed = 1500) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active || length === 0) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % length), speed);
    return () => window.clearInterval(timer);
  }, [active, length, speed]);
  useEffect(() => setIndex(0), [length]);
  return { index, setIndex };
}

function useScanningSelection<T extends string>({
  options,
  active,
  intervalMs = 1250,
  onSelect,
}: {
  options: Array<ScanOption<T>>;
  active: boolean;
  intervalMs?: number;
  onSelect: (option: ScanOption<T>, index: number) => void;
}) {
  const { index, setIndex } = useScanner(options.length, active, intervalMs);
  const selectCurrent = useCallback(() => {
    if (!active) return;
    const option = options[index];
    if (!option) return;
    onSelect(option, index);
  }, [active, index, onSelect, options]);

  useBlinkInput(selectCurrent);

  return { index, setIndex, selectCurrent };
}

function TacitApp() {
  const [workflow, dispatchWorkflow] = useReducer(workflowReducer, initialWorkflowState);
  const { stopAudio } = useTextToSpeech();
  const [message, setMessage] = useState("");
  const [spokenMessage, setSpokenMessage] = useState("");
  const [questionSuggestionState, setQuestionSuggestionState] = useState<QuestionSuggestionState>({
    questions: [],
    loading: false,
    error: null,
    source: null,
    model: null,
  });
  const electron = useIsElectron();

  // Record Presage vitals for the summary while the camera is live for this
  // session (calibration + communication), not on the setup/summary screens.
  useVitalsRecorder(
    workflow.currentSession?.id,
    workflow.currentStage === "CALIBRATION" || workflow.currentStage === "COMMUNICATION",
  );

  useEffect(() => {
    stopAudio();
  }, [stopAudio, workflow.currentStage, workflow.currentPatient?.id, workflow.currentSession?.id]);

  useEffect(() => {
    let cancelled = false;
    dispatchWorkflow({ type: "RESTORE_START" });
    const savedPatientId = window.sessionStorage.getItem(ACTIVE_PATIENT_KEY);
    if (!savedPatientId) {
      dispatchWorkflow({ type: "RESTORE_EMPTY" });
      return;
    }
    const patientIdToRestore = savedPatientId;

    async function restoreWorkflow() {
      try {
        const patient = await localDb.getPatient(patientIdToRestore);
        if (cancelled) return;
        if (!patient) {
          window.sessionStorage.removeItem(ACTIVE_PATIENT_KEY);
          window.sessionStorage.removeItem(ACTIVE_SESSION_KEY);
          dispatchWorkflow({ type: "RESTORE_EMPTY" });
          return;
        }

        const savedSessionId = window.sessionStorage.getItem(ACTIVE_SESSION_KEY);
        if (savedSessionId) {
          const session = await localDb.getSession(savedSessionId);
          if (cancelled) return;
          if (session && session.patientId === patient.id && session.status === "active") {
            dispatchWorkflow({ type: "RESTORE_SESSION", patient, session });
            return;
          }
          window.sessionStorage.removeItem(ACTIVE_SESSION_KEY);
        }

        dispatchWorkflow({ type: "RESTORE_PATIENT", patient });
      } catch (restoreError) {
        console.error("[tacit] workflow restore failed:", restoreError);
        if (!cancelled) {
          window.sessionStorage.removeItem(ACTIVE_PATIENT_KEY);
          window.sessionStorage.removeItem(ACTIVE_SESSION_KEY);
          dispatchWorkflow({ type: "RESTORE_EMPTY" });
        }
      }
    }

    void restoreWorkflow();

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshQuestionSuggestions = useCallback(async (patient: Patient, session: Session) => {
    setQuestionSuggestionState((current) => ({
      ...current,
      loading: true,
      error: null,
    }));
    try {
      const context = await buildSuggestedQuestionContext(patient, session);
      const response = await generateSuggestedQuestions(context);
      setQuestionSuggestionState({
        questions: response.questions,
        loading: false,
        error: response.error ?? null,
        source: response.source,
        model: response.model ?? null,
      });
    } catch (suggestionError) {
      console.error("[tacit] question suggestion generation failed:", suggestionError);
      setQuestionSuggestionState((current) => ({
        ...current,
        loading: false,
        error: suggestionError instanceof Error ? suggestionError.message : String(suggestionError),
      }));
    }
  }, []);

  useEffect(() => {
    if (
      workflow.currentStage !== "CALIBRATION" ||
      !workflow.currentPatient ||
      !workflow.currentSession
    ) {
      return;
    }
    void refreshQuestionSuggestions(workflow.currentPatient, workflow.currentSession);
  }, [
    refreshQuestionSuggestions,
    workflow.currentPatient,
    workflow.currentSession,
    workflow.currentStage,
  ]);

  function selectPatient(patient: Patient) {
    window.sessionStorage.setItem(ACTIVE_PATIENT_KEY, patient.id);
    window.sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    setQuestionSuggestionState({
      questions: [],
      loading: false,
      error: null,
      source: null,
      model: null,
    });
    dispatchWorkflow({ type: "SELECT_PATIENT", patient });
  }

  function startSession(session: Session) {
    window.sessionStorage.setItem(ACTIVE_SESSION_KEY, session.id);
    dispatchWorkflow({ type: "START_SESSION", session });
  }

  function goToCalibration() {
    dispatchWorkflow({ type: "SET_STAGE", stage: "CALIBRATION" });
  }

  function completeCalibration(detectedBlinkCount: number) {
    dispatchWorkflow({ type: "COMPLETE_CALIBRATION", detectedBlinkCount });
    dispatchWorkflow({ type: "SET_STAGE", stage: "COMMUNICATION" });
  }

  function retryCalibration() {
    dispatchWorkflow({ type: "RESET_CALIBRATION" });
  }

  function goToSessionSummary() {
    dispatchWorkflow({ type: "SET_STAGE", stage: "SESSION_SUMMARY" });
  }

  function startNewWorkflow() {
    window.sessionStorage.removeItem(ACTIVE_PATIENT_KEY);
    window.sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    setMessage("");
    setSpokenMessage("");
    setQuestionSuggestionState({
      questions: [],
      loading: false,
      error: null,
      source: null,
      model: null,
    });
    dispatchWorkflow({ type: "RESET_WORKFLOW" });
  }

  return (
    <main className="machine-page min-h-svh bg-background text-foreground">
      <SiteHeader />

      <PatientView
        workflow={workflow}
        onPatientIdentified={selectPatient}
        onSessionStarted={startSession}
        onGoToCalibration={goToCalibration}
        onCalibrationComplete={completeCalibration}
        onCalibrationRetry={retryCalibration}
        onGoToSessionSummary={goToSessionSummary}
        onStartNewWorkflow={startNewWorkflow}
        message={message}
        spokenMessage={spokenMessage}
        setSpokenMessage={setSpokenMessage}
        questionSuggestions={questionSuggestionState}
        onRefreshQuestionSuggestions={refreshQuestionSuggestions}
      />

      <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-background/95 px-4 py-2 text-center text-xs text-muted-foreground backdrop-blur-md">
        {electron
          ? "Live blink detection via the desktop app's camera — press spacebar as a manual override"
          : "Browser preview — blink detection simulated via spacebar for demo purposes"}
      </footer>
    </main>
  );
}

function PatientView({
  workflow,
  onPatientIdentified,
  onSessionStarted,
  onGoToCalibration,
  onCalibrationComplete,
  onCalibrationRetry,
  onGoToSessionSummary,
  onStartNewWorkflow,
  message,
  spokenMessage,
  setSpokenMessage,
  questionSuggestions,
  onRefreshQuestionSuggestions,
}: {
  workflow: WorkflowState;
  onPatientIdentified: (patient: Patient) => void;
  onSessionStarted: (session: Session) => void;
  onGoToCalibration: () => void;
  onCalibrationComplete: (detectedBlinkCount: number) => void;
  onCalibrationRetry: () => void;
  onGoToSessionSummary: () => void;
  onStartNewWorkflow: () => void;
  message: string;
  spokenMessage: string;
  setSpokenMessage: (message: string) => void;
  questionSuggestions: QuestionSuggestionState;
  onRefreshQuestionSuggestions: (patient: Patient, session: Session) => Promise<void>;
}) {
  const { currentStage, currentPatient, currentSession, calibrationState, restoring } = workflow;
  // Live vitals ride along on every screen once blink calibration is done —
  // the camera is running from here on, so the numbers are always current.
  const showLiveVitals =
    (currentStage === "COMMUNICATION" || currentStage === "SESSION_SUMMARY") &&
    Boolean(currentPatient && currentSession);

  return (
    <div className="machine-display flex min-h-svh flex-col overflow-hidden px-5 pb-4 pt-3 md:px-8">
      {/* Content on the left; a narrow right rail with the voice toggle and
          live vitals on the post-calibration screens. The content column is
          the ONLY thing allowed to scroll (and only if a screen genuinely
          can't fit — the boards size themselves to the available height so
          they never do). Content is top-anchored so every stage's eyebrow +
          title land at the same height — no vertical jump between stages. */}
      <div className="flex min-h-0 flex-1 items-stretch gap-4">
        <div
          key={currentStage}
          className="page-copy-reveal stage-enter flex min-h-0 flex-1 flex-col items-center justify-start overflow-y-auto pt-1"
        >
          {currentStage === "PATIENT_SETUP" && (
            <PatientIdentification restoring={restoring} onIdentified={onPatientIdentified} />
          )}
          {currentStage === "CLINICAL_CONTEXT" && currentPatient && (
            <PatientContextScreen patient={currentPatient} onSessionStarted={onSessionStarted} />
          )}
          {currentStage === "CALIBRATION" && currentPatient && currentSession && (
            <BlinkCalibrationScreen
              patient={currentPatient}
              session={currentSession}
              calibrationState={calibrationState}
              onComplete={onCalibrationComplete}
              onRetry={onCalibrationRetry}
            />
          )}
          {currentStage === "COMMUNICATION" && currentPatient && currentSession && (
            <CommunicationStageScreen
              patient={currentPatient}
              session={currentSession}
              onContinue={onGoToSessionSummary}
              onMessage={setSpokenMessage}
              questionSuggestions={questionSuggestions}
              onRefreshQuestionSuggestions={onRefreshQuestionSuggestions}
            />
          )}
          {currentStage === "SESSION_SUMMARY" && currentPatient && currentSession && (
            <SessionSummaryScreen
              patient={currentPatient}
              session={currentSession}
              spokenMessage={spokenMessage}
              onStartAnotherPatient={onStartNewWorkflow}
            />
          )}
        </div>
        {/* Same rail on every stage so the content column never shifts:
            voice toggle always; vitals only once the camera is tracking. */}
        <div className="flex shrink-0 flex-col gap-2 self-start pt-1">
          <SpeechToggleButton />
          {showLiveVitals && <LiveVitalsButton />}
        </div>
      </div>
    </div>
  );
}

function PatientIdentification({
  restoring,
  onIdentified,
}: {
  restoring: boolean;
  onIdentified: (patient: Patient) => void;
}) {
  const [name, setName] = useState("");
  const [patientId, setPatientId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const continueTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (continueTimer.current) window.clearTimeout(continueTimer.current);
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedPatientId = patientId.trim();

    setError(null);
    setStatus(null);

    if (!trimmedName || !trimmedPatientId) {
      setError("Enter both patient name and patient ID.");
      return;
    }

    setSubmitting(true);
    try {
      const existing = await localDb.getPatientByPatientId(trimmedPatientId);
      const patient =
        existing ??
        (await localDb.createPatient({ name: trimmedName, patientId: trimmedPatientId }));

      if (!patient) {
        setError("Could not save this patient. Please try again.");
        return;
      }

      setStatus(existing ? "Existing patient found" : "New patient saved");
      continueTimer.current = window.setTimeout(() => onIdentified(patient), 700);
    } catch (dbError) {
      console.error("[tacit] patient identification failed:", dbError);
      setError("Patient lookup failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="my-auto w-full max-w-xl animate-fade-in"
      aria-label="Patient identification"
    >
      <p className="mb-3 text-center text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Patient identification
      </p>
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm md:p-8">
        <h1 className="font-display text-3xl font-semibold md:text-4xl">Start patient session</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Enter the patient details once. TACIT will reuse an existing local record when the patient
          ID already exists.
        </p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <label className="block text-sm font-medium text-foreground">
            Patient Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-3 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring"
              placeholder="Example: Jane Smith"
              autoComplete="off"
              disabled={submitting || restoring}
            />
          </label>

          <label className="block text-sm font-medium text-foreground">
            Patient ID
            <input
              value={patientId}
              onChange={(event) => setPatientId(event.target.value)}
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-3 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring"
              placeholder="Example: MRN-1042"
              autoComplete="off"
              disabled={submitting || restoring}
            />
          </label>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {status && (
            <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm font-medium text-success">
              {status}
            </p>
          )}

          <Button type="submit" size="lg" className="w-full" disabled={submitting || restoring}>
            {restoring ? "Loading patient..." : submitting ? "Checking..." : "Continue"}
          </Button>
        </form>
      </div>
    </section>
  );
}

function PatientContextScreen({
  patient,
  onSessionStarted,
}: {
  patient: Patient;
  onSessionStarted: (session: Session) => void;
}) {
  const [diagnosis, setDiagnosis] = useState("");
  const [procedure, setProcedure] = useState("");
  const [medicalNotes, setMedicalNotes] = useState("");
  const [bloodTestNotes, setBloodTestNotes] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);

    localDb
      .getClinicalContext(patient.id)
      .then((context) => {
        if (cancelled || !context) return;
        setDiagnosis(context.diagnosis);
        setProcedure(context.procedure);
        setMedicalNotes(context.medicalNotes);
        setBloodTestNotes(context.bloodTestNotes);
        setAdditionalContext(context.additionalContext);
        setStatus("Existing patient context loaded");
      })
      .catch((contextError) => {
        console.error("[tacit] context load failed:", contextError);
        if (!cancelled) setError("Could not load patient context. You can still continue.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [patient.id]);

  async function beginCommunication({ saveContext }: { saveContext: boolean }) {
    setSubmitting(true);
    setError(null);

    try {
      if (saveContext) {
        const saved = await localDb.saveClinicalContext({
          patientId: patient.id,
          diagnosis: diagnosis.trim(),
          procedure: procedure.trim(),
          medicalNotes: medicalNotes.trim(),
          bloodTestNotes: bloodTestNotes.trim(),
          additionalContext: additionalContext.trim(),
        });
        if (!saved) {
          setError("Could not save patient context. Please try again.");
          return;
        }
      }

      const session = await localDb.createSession({ patientId: patient.id });
      if (!session) {
        setError("Could not start a patient session. Please try again.");
        return;
      }

      setStatus(saveContext ? "Patient context saved" : "Patient context skipped");
      onSessionStarted(session);
    } catch (dbError) {
      console.error("[tacit] context/session step failed:", dbError);
      setError("Could not continue. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="my-auto w-full max-w-3xl animate-fade-in" aria-label="Patient context">
      <p className="mb-3 text-center text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Patient context
      </p>
      <div className="rounded-lg border border-border bg-card p-5 shadow-sm md:p-6">
        <div className="flex items-start gap-4">
          <span className="mt-1 flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
            <ClipboardList className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-semibold md:text-3xl">
              Add clinical context
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Optional notes for {patient.name} ({patient.patientId}). This stays local and can be
              edited before the session begins.
            </p>
          </div>
        </div>

        <form
          className="mt-5 grid gap-3 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void beginCommunication({ saveContext: true });
          }}
        >
          <label className="block text-sm font-medium text-foreground">
            Diagnosis
            <input
              value={diagnosis}
              onChange={(event) => setDiagnosis(event.target.value)}
              className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring"
              placeholder="Example: stroke recovery"
              disabled={loading || submitting}
            />
          </label>

          <label className="block text-sm font-medium text-foreground">
            Procedure / recent operation
            <input
              value={procedure}
              onChange={(event) => setProcedure(event.target.value)}
              className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring"
              placeholder="Example: post-op pain review"
              disabled={loading || submitting}
            />
          </label>

          <label className="block text-sm font-medium text-foreground md:col-span-2">
            Medical notes
            <textarea
              value={medicalNotes}
              onChange={(event) => setMedicalNotes(event.target.value)}
              className="mt-1.5 min-h-[4.5rem] w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring"
              placeholder="Symptoms, mobility, communication considerations"
              disabled={loading || submitting}
            />
          </label>

          <label className="block text-sm font-medium text-foreground">
            Blood test notes
            <textarea
              value={bloodTestNotes}
              onChange={(event) => setBloodTestNotes(event.target.value)}
              className="mt-1.5 min-h-[4.5rem] w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring"
              placeholder="Recent values or clinical concerns"
              disabled={loading || submitting}
            />
          </label>

          <label className="block text-sm font-medium text-foreground">
            Additional context
            <textarea
              value={additionalContext}
              onChange={(event) => setAdditionalContext(event.target.value)}
              className="mt-1.5 min-h-[4.5rem] w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring"
              placeholder="Family, language, preferences, or bedside notes"
              disabled={loading || submitting}
            />
          </label>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive md:col-span-2">
              {error}
            </p>
          )}
          {status && (
            <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm font-medium text-success md:col-span-2">
              {status}
            </p>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end md:col-span-2">
            <Button
              type="button"
              variant="outline"
              disabled={loading || submitting}
              onClick={() => void beginCommunication({ saveContext: false })}
            >
              Skip
            </Button>
            <Button type="submit" disabled={loading || submitting}>
              {loading ? "Loading..." : submitting ? "Starting..." : "Continue"}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

function BlinkCalibrationScreen({
  patient,
  session,
  calibrationState,
  onComplete,
  onRetry,
}: {
  patient: Patient;
  session: Session;
  calibrationState: CalibrationState;
  onComplete: (detectedBlinkCount: number) => void;
  onRetry: () => void;
}) {
  const [blinkCount, setBlinkCount] = useState(calibrationState.detectedBlinkCount);
  const [blinkDetected, setBlinkDetected] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastBlinkFlagRef = useRef(false);
  const blinkTimeoutRef = useRef<number | null>(null);
  const advanceTimeoutRef = useRef<number | null>(null);
  const advanceStartedRef = useRef(false);

  const registerBlink = useCallback(() => {
    if (advancing) return;
    setBlinkDetected(true);
    setBlinkCount((current) => Math.min(3, current + 1));
    if (blinkTimeoutRef.current) window.clearTimeout(blinkTimeoutRef.current);
    blinkTimeoutRef.current = window.setTimeout(() => setBlinkDetected(false), 650);
  }, [advancing]);

  const finishCalibration = useCallback(
    (count: number) => {
      suppressBlinkInputFor(1600);
      onComplete(count);
    },
    [onComplete],
  );

  useEffect(() => {
    let cancelled = false;

    async function openCameraPreview() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        if (!cancelled)
          setCameraError("Camera preview unavailable. Spacebar still simulates a blink.");
      }
    }

    void openCameraPreview();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!window.tacit) return;
    const unsubscribe = window.tacit.onEngineEvent((event) => {
      if (event.type !== "frame") return;
      const blinkFlag = event.payload.blinkFlag === true;
      if (blinkFlag && !lastBlinkFlagRef.current) registerBlink();
      lastBlinkFlagRef.current = blinkFlag;
    });
    return unsubscribe;
  }, [registerBlink]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || advancing) return;
      event.preventDefault();
      registerBlink();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [advancing, registerBlink]);

  useEffect(() => {
    if (blinkCount < 3 || advanceStartedRef.current) return;
    advanceStartedRef.current = true;
    setAdvancing(true);
    suppressBlinkInputFor(1800);
    advanceTimeoutRef.current = window.setTimeout(() => finishCalibration(3), 950);
  }, [blinkCount, finishCalibration]);

  useEffect(() => {
    return () => {
      if (blinkTimeoutRef.current) window.clearTimeout(blinkTimeoutRef.current);
      if (advanceTimeoutRef.current) window.clearTimeout(advanceTimeoutRef.current);
    };
  }, []);

  function retry() {
    if (advanceTimeoutRef.current) window.clearTimeout(advanceTimeoutRef.current);
    advanceStartedRef.current = false;
    setAdvancing(false);
    setBlinkCount(0);
    setBlinkDetected(false);
    lastBlinkFlagRef.current = false;
    onRetry();
  }

  const ready = blinkCount >= 3;

  return (
    <section
      className="flex min-h-0 w-full max-w-6xl flex-1 flex-col text-center"
      aria-label="Blink Calibration"
    >
      <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Calibration
      </p>
      <h1 className="font-display text-3xl font-semibold md:text-4xl">Blink Calibration</h1>
      <p className="mx-auto mt-2 max-w-lg text-base text-muted-foreground">
        Look at the camera and blink normally. Communication starts automatically after 3 blinks.
      </p>

      {/* Camera on the left sized by the AVAILABLE HEIGHT (not the width), so
          the whole screen always fits without scrolling; status + actions in
          a column on the right. Stacks on narrow screens. */}
      <div className="mt-4 flex max-h-[58vh] min-h-0 min-w-0 flex-1 flex-col gap-4 md:flex-row md:items-stretch">
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <div className="relative aspect-video h-full max-h-full w-auto max-w-full origin-center transform-gpu animate-in fade-in zoom-in-50 duration-700 overflow-hidden rounded-lg border-2 border-border bg-[#0d1424] motion-reduce:animate-none">
            <video
              ref={videoRef}
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover"
              aria-label="Camera preview"
            />
            {cameraError && (
              <div className="absolute inset-0 grid place-items-center px-6 text-center">
                <p className="text-sm text-white/70">{cameraError}</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 shrink-0 flex-col justify-center gap-4 md:w-72 md:max-w-72">
          <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
            <p
              className={cn(
                "font-display text-2xl font-semibold",
                advancing || blinkDetected ? "text-success" : "text-foreground",
              )}
            >
              {advancing ? (
                "Calibration complete ✓"
              ) : blinkDetected ? (
                "Blink detected ✓"
              ) : (
                <span
                  className="inline-flex items-center justify-center gap-3"
                  role="status"
                  aria-label="Waiting for blink"
                >
                  <span>Waiting for blink</span>
                  <span className="calibration-loader" aria-hidden="true" />
                </span>
              )}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {advancing ? "Starting communication..." : `Blink count: ${blinkCount} / 3`}
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2" aria-hidden="true">
              {[0, 1, 2].map((step) => (
                <span
                  key={step}
                  className={cn(
                    "h-2 rounded-full transition-colors",
                    blinkCount > step ? "bg-success" : "bg-muted",
                  )}
                />
              ))}
            </div>
            <p className="mt-2 break-all font-mono text-[11px] leading-snug text-muted-foreground">
              patient: {patient.patientId} · session: {session.id}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button size="lg" variant="outline" onClick={retry} disabled={advancing}>
              Retry
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => finishCalibration(blinkCount)}
              disabled={advancing}
            >
              Skip Calibration
            </Button>
            <Button
              size="lg"
              disabled={!ready || advancing}
              onClick={() => finishCalibration(blinkCount)}
            >
              {advancing ? "Starting..." : "Continue"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function YesNoCommunicationScreen({
  patient,
  session,
  onContinue,
  selectedQuestion,
  questionSuggestions,
  onSuggestionSelect,
  onRegenerateSuggestions,
}: {
  patient: Patient;
  session: Session;
  onContinue: () => void;
  selectedQuestion?: string | undefined;
  questionSuggestions: QuestionSuggestionState;
  onSuggestionSelect: (suggestion: SuggestedQuestion) => void;
  onRegenerateSuggestions: () => Promise<void>;
}) {
  const { speak } = useTextToSpeech();
  const [question, setQuestion] = useState("");
  const [selectedResponse, setSelectedResponse] = useState<"YES" | "NO" | null>(null);
  const [scanIntervalMs, setScanIntervalMs] = useState(1250);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo<Array<ScanOption<"YES" | "NO">>>(
    () => [
      { label: "YES", value: "YES" },
      { label: "NO", value: "NO" },
    ],
    [],
  );

  const canScan = !selectedResponse && question.trim().length > 0 && !saving;

  useEffect(() => {
    if (selectedQuestion === undefined) return;
    setQuestion(selectedQuestion);
    setSelectedResponse(null);
    setSaved(false);
    setError(null);
  }, [selectedQuestion]);

  const chooseResponse = useCallback(
    async (option: ScanOption<"YES" | "NO">) => {
      const trimmedQuestion = question.trim();
      if (!trimmedQuestion || selectedResponse || saving) return;

      setSelectedResponse(option.value);
      setSaving(true);
      setError(null);
      setSaved(false);

      void speak(option.label);

      try {
        const interaction = await localDb.saveInteraction({
          patientId: patient.id,
          sessionId: session.id,
          question: trimmedQuestion,
          questionType: "yes_no",
          response: option.value,
          timestamp: new Date().toISOString(),
        });
        if (!interaction) {
          setError("Could not save this response. Please try again.");
          setSelectedResponse(null);
          return;
        }
        setSaved(true);
      } catch (saveError) {
        console.error("[tacit] yes/no interaction save failed:", saveError);
        setError("Could not save this response. Please try again.");
        setSelectedResponse(null);
      } finally {
        setSaving(false);
      }
    },
    [patient.id, question, saving, selectedResponse, session.id, speak],
  );

  const { index: highlightedIndex, setIndex } = useScanningSelection({
    options,
    active: canScan,
    intervalMs: scanIntervalMs,
    onSelect: chooseResponse,
  });

  function askAnotherQuestion() {
    setQuestion("");
    setSelectedResponse(null);
    setSaved(false);
    setError(null);
    setIndex(0);
  }

  return (
    <section
      className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col animate-fade-in"
      aria-label="Yes or no communication"
    >
      <div className="mt-4 grid w-full gap-4 rounded-lg border border-border bg-card p-4 shadow-sm md:grid-cols-[1fr_12rem] md:p-5">
        <PromptSuggestionInput
          label="Question"
          value={question}
          placeholder="Example: Are you in pain?"
          disabled={saving}
          suggestions={questionSuggestions.questions}
          loading={questionSuggestions.loading}
          error={questionSuggestions.error}
          onChange={(nextQuestion) => {
            setQuestion(nextQuestion);
            setSelectedResponse(null);
            setSaved(false);
            setError(null);
            setIndex(0);
          }}
          onSelectSuggestion={onSuggestionSelect}
          onRegenerate={onRegenerateSuggestions}
        />

        <label className="block text-sm font-medium text-foreground">
          Scan speed
          <select
            value={scanIntervalMs}
            onChange={(event) => setScanIntervalMs(Number(event.target.value))}
            className="mt-2 w-full rounded-md border border-input bg-background px-4 py-3 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value={1000}>Fast</option>
            <option value={1250}>Normal</option>
            <option value={1500}>Slow</option>
          </select>
        </label>
      </div>

      <div className="mt-4 grid min-h-0 flex-1 auto-rows-fr gap-3 sm:grid-cols-2">
        {options.map((option, optionIndex) => {
          const active = canScan && highlightedIndex === optionIndex;
          const selected = selectedResponse === option.value;
          return (
            <div
              key={option.value}
              className={cn(
                "relative flex min-h-28 flex-col rounded-lg border-2 bg-card text-center shadow-sm transition",
                active
                  ? "scale-[1.02] border-primary bg-primary text-primary-foreground shadow-lg"
                  : "border-border text-foreground hover:border-primary/60",
                selected && "border-success bg-success text-success-foreground shadow-lg",
                selectedResponse && !selected && "opacity-55",
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setIndex(optionIndex);
                  void chooseResponse(option);
                }}
                disabled={saving || Boolean(selectedResponse)}
                className="flex h-full w-full flex-col items-center justify-center px-5 py-4 focus:outline-none focus:ring-4 focus:ring-primary/25"
                aria-pressed={selected}
              >
                <span className="block font-display text-6xl font-semibold md:text-8xl">
                  {option.label}
                </span>
                {active && !selected && (
                  <span className="mt-3 block text-sm font-semibold uppercase tracking-[0.16em]">
                    Highlighted
                  </span>
                )}
                {selected && (
                  <span className="mt-3 block text-sm font-semibold uppercase tracking-[0.16em]">
                    Selected {saved ? "✓" : saving ? "saving..." : ""}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {!question.trim() && (
        <p className="mt-4 text-center text-sm font-medium text-destructive">
          Enter a question before scanning starts.
        </p>
      )}
      {error && <p className="mt-4 text-center text-sm font-medium text-destructive">{error}</p>}
      {selectedResponse && !error && (
        <p className="mt-5 text-center text-lg font-semibold text-foreground">
          Selected response: {selectedResponse} {saved ? "✓" : saving ? "saving..." : ""}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Button variant="outline" size="lg" onClick={askAnotherQuestion}>
          Ask Another Question
        </Button>
        <Button size="lg" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </section>
  );
}

type CommunicationMode = "yes_no" | "option_board" | "keyboard";
type OptionBoardValue = "Pain" | "Water" | "Position" | "Bathroom" | "Something Else" | "Keyboard";
type KeyboardScanMode = "SUGGESTIONS" | "ROWS" | "COLUMNS";
type KeyboardKeyValue = string | "SPACE" | "BACKSPACE" | "CLEAR" | "DONE";

const KEYBOARD_SCAN_INTERVAL_MS = 1000;
const KEYBOARD_COMPLETION_DEBOUNCE_MS = 1200;
const KEYBOARD_LAYOUT: KeyboardKeyValue[][] = [
  ["SPACE", "E", "A", "N", "D", "M"],
  ["T", "O", "S", "L", "W", "P"],
  ["I", "H", "BACKSPACE", "F", "B", "K"],
  ["R", "C", "G", "DONE", "CLEAR", "X"],
  ["U", "Y", "V", "J", "Q", "Z"],
];

function useScanController({
  itemCount,
  active,
  intervalMs,
  onSelect,
  onCycleEnd,
}: {
  itemCount: number;
  active: boolean;
  intervalMs: number;
  onSelect: (index: number) => void;
  onCycleEnd?: (() => void) | undefined;
}) {
  const [currentScanIndex, setCurrentScanIndex] = useState(0);

  useEffect(() => {
    if (!active || itemCount === 0) return;
    const timer = window.setInterval(() => {
      setCurrentScanIndex((current) => {
        if (current >= itemCount - 1) {
          onCycleEnd?.();
          return 0;
        }
        return current + 1;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs, itemCount, onCycleEnd]);

  useEffect(() => setCurrentScanIndex(0), [itemCount]);

  const selectCurrentItem = useCallback(() => {
    if (!active || itemCount === 0) return;
    onSelect(currentScanIndex);
  }, [active, currentScanIndex, itemCount, onSelect]);

  useBlinkInput(selectCurrentItem);

  return { currentScanIndex, setCurrentScanIndex, selectCurrentItem };
}

function CommunicationStageScreen({
  patient,
  session,
  onContinue,
  onMessage,
  questionSuggestions,
  onRefreshQuestionSuggestions,
}: {
  patient: Patient;
  session: Session;
  onContinue: () => void;
  onMessage: (message: string) => void;
  questionSuggestions: QuestionSuggestionState;
  onRefreshQuestionSuggestions: (patient: Patient, session: Session) => Promise<void>;
}) {
  const [mode, setMode] = useState<CommunicationMode>("option_board");
  const [selectedSuggestedQuestion, setSelectedSuggestedQuestion] =
    useState<SuggestedQuestion | null>(null);

  function selectSuggestion(suggestion: SuggestedQuestion) {
    setSelectedSuggestedQuestion(suggestion);
    setMode(suggestion.type === "yes_no" ? "yes_no" : "option_board");
  }

  if (mode === "keyboard") {
    return (
      <BlinkKeyboardCommunicationScreen
        patient={patient}
        session={session}
        clinicianQuestion={selectedSuggestedQuestion?.question ?? ""}
        onBack={() => setMode("option_board")}
        onContinue={() => {
          onMessage("Keyboard communication complete");
          onContinue();
        }}
      />
    );
  }

  return (
    <section
      className="flex min-h-0 w-full max-w-6xl flex-1 flex-col animate-fade-in"
      aria-label="Communication"
    >
      {/* Shared heading for both boards, then the board picker as a
          segmented control — title first so the mode switch reads as a
          sub-choice of "Communication", not as something above it. */}
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
          Communication
        </p>
        <h1 className="font-display text-3xl font-semibold md:text-4xl">
          {mode === "option_board" ? "6-Option Board" : "Yes / No"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "option_board"
            ? "Type a prompt, then use blink selection or spacebar to choose the highlighted option."
            : "Type the question, then use blink selection or spacebar to choose the highlighted answer."}
        </p>
      </div>
      <div
        role="tablist"
        aria-label="Board type"
        className="mx-auto mt-3 inline-flex rounded-lg border border-border bg-card p-1 shadow-sm"
      >
        {(
          [
            { value: "option_board", label: "6-Option Board" },
            { value: "yes_no", label: "Yes / No" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={mode === tab.value}
            onClick={() => setMode(tab.value)}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-semibold transition-colors",
              mode === tab.value
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "option_board" ? (
        <OptionBoardCommunicationScreen
          patient={patient}
          session={session}
          selectedQuestion={selectedSuggestedQuestion}
          questionSuggestions={questionSuggestions}
          onSuggestionSelect={selectSuggestion}
          onRegenerateSuggestions={() => onRefreshQuestionSuggestions(patient, session)}
          onKeyboard={() => setMode("keyboard")}
          onContinue={() => {
            onMessage("Option board session complete");
            onContinue();
          }}
        />
      ) : (
        <YesNoCommunicationScreen
          patient={patient}
          session={session}
          selectedQuestion={selectedSuggestedQuestion?.question}
          questionSuggestions={questionSuggestions}
          onSuggestionSelect={selectSuggestion}
          onRegenerateSuggestions={() => onRefreshQuestionSuggestions(patient, session)}
          onContinue={() => {
            onMessage("Yes/No session complete");
            onContinue();
          }}
        />
      )}
    </section>
  );
}

function PromptSuggestionInput({
  label,
  value,
  placeholder,
  disabled,
  suggestions,
  loading,
  error,
  onChange,
  onSelectSuggestion,
  onRegenerate,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  suggestions: SuggestedQuestion[];
  loading: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onSelectSuggestion: (suggestion: SuggestedQuestion) => void;
  onRegenerate: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <label className="block text-sm font-medium text-foreground">
        {label}
        <div className="relative mt-2">
          <input
            value={value}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              onChange(event.target.value);
              setOpen(true);
            }}
            className="w-full rounded-md border border-input bg-background px-4 py-3 pr-12 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={placeholder}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Show suggested questions"
            disabled={disabled}
          >
            <ChevronDown className={cn("size-5 transition", open && "rotate-180")} />
          </button>
        </div>
      </label>

      {open && (
        <div className="absolute z-30 mt-2 w-full rounded-lg border border-border bg-card p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2 px-2 py-1">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Suggested
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void onRegenerate()}
            >
              {loading ? "Loading..." : "Refresh"}
            </Button>
          </div>
          {error && (
            <p className="mb-2 rounded-md border border-amber/40 bg-amber/10 px-2 py-1 text-xs text-amber">
              {error}
            </p>
          )}
          {suggestions.length === 0 && !loading ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No suggestions yet.</p>
          ) : (
            <div className="grid gap-1">
              {suggestions.map((suggestion) => (
                <button
                  key={`${suggestion.type}-${suggestion.question}`}
                  type="button"
                  onClick={() => {
                    onSelectSuggestion(suggestion);
                    setOpen(false);
                  }}
                  className="flex items-start gap-2 rounded-md px-3 py-2 text-left transition hover:bg-muted"
                >
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      {suggestion.question}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Gemini · {suggestion.type === "yes_no" ? "Yes/No" : "Board"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestedQuestionsPanel({
  state,
  selectedQuestion,
  onSelect,
  onRegenerate,
}: {
  state: QuestionSuggestionState;
  selectedQuestion: SuggestedQuestion | null;
  onSelect: (suggestion: SuggestedQuestion) => void;
  onRegenerate: () => Promise<void>;
}) {
  return (
    <div className="mb-6 rounded-lg border border-border bg-card p-4 shadow-sm md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">
            Suggested Questions
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Gemini suggests drafts only. The clinician chooses, edits, or ignores them.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={state.loading}
          onClick={() => void onRegenerate()}
        >
          {state.loading ? "Loading..." : "Regenerate"}
        </Button>
      </div>

      {state.loading && (
        <p className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
          Loading suggested questions during calibration...
        </p>
      )}
      {state.error && (
        <p className="mt-4 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">
          Suggestions unavailable: {state.error}. Manual questions still work.
        </p>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {state.questions.map((suggestion) => {
          const selected = selectedQuestion?.question === suggestion.question;
          return (
            <button
              key={`${suggestion.type}-${suggestion.question}`}
              type="button"
              onClick={() => onSelect(suggestion)}
              className={cn(
                "min-h-24 rounded-lg border-2 bg-background px-4 py-3 text-left shadow-sm transition focus:outline-none focus:ring-4 focus:ring-primary/20",
                selected ? "border-primary bg-primary/10" : "border-border hover:border-primary/50",
              )}
            >
              <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {suggestion.type === "yes_no" ? "Yes / No" : "Board"}
              </span>
              <span className="mt-2 block text-base font-semibold text-foreground">
                {suggestion.question}
              </span>
              {suggestion.type === "option_board" && suggestion.boardOptions?.length ? (
                <span className="mt-2 block text-xs text-muted-foreground">
                  {suggestion.boardOptions.join(" · ")}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OptionBoardCommunicationScreen({
  patient,
  session,
  selectedQuestion,
  questionSuggestions,
  onSuggestionSelect,
  onRegenerateSuggestions,
  onKeyboard,
  onContinue,
}: {
  patient: Patient;
  session: Session;
  selectedQuestion: SuggestedQuestion | null;
  questionSuggestions: QuestionSuggestionState;
  onSuggestionSelect: (suggestion: SuggestedQuestion) => void;
  onRegenerateSuggestions: () => Promise<void>;
  onKeyboard: () => void;
  onContinue: () => void;
}) {
  const { speak } = useTextToSpeech();
  const [prompt, setPrompt] = useState("What do you need?");
  const [boardOptions, setBoardOptions] = useState<string[]>([
    "Pain",
    "Water",
    "Position",
    "Bathroom",
    "Something Else",
  ]);
  const [scanIntervalMs, setScanIntervalMs] = useState(1250);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingOptionIndex, setEditingOptionIndex] = useState<number | null>(null);

  const options = useMemo<Array<ScanOption<string>>>(() => {
    const labels = boardOptions
      .map((label) => label.trim())
      .map((label, index) => label || `Option ${index + 1}`);
    return [...labels, "Keyboard"].map((label) => ({ label, value: label }));
  }, [boardOptions]);

  useEffect(() => {
    if (!selectedQuestion || selectedQuestion.type !== "option_board") return;
    setPrompt(selectedQuestion.question);
    setBoardOptions((current) => {
      const next = [...(selectedQuestion.boardOptions ?? [])]
        .filter((label) => label.trim().toLowerCase() !== "keyboard")
        .slice(0, 5);
      while (next.length < 5) next.push(current[next.length] ?? `Option ${next.length + 1}`);
      return next;
    });
    setSelectedOption(null);
    setSaved(false);
    setError(null);
  }, [selectedQuestion]);

  const canScan =
    !selectedOption && prompt.trim().length > 0 && !saving && editingOptionIndex === null;

  const chooseOption = useCallback(
    async (option: ScanOption<string>) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || selectedOption || saving) return;

      setSelectedOption(option.value);
      setSaving(true);
      setError(null);
      setSaved(false);

      void speak(option.label);

      try {
        const interaction = await localDb.saveInteraction({
          patientId: patient.id,
          sessionId: session.id,
          question: trimmedPrompt,
          questionType: "option_board",
          response: option.value,
          timestamp: new Date().toISOString(),
        });

        if (!interaction) {
          setError("Could not save this selection. Please try again.");
          setSelectedOption(null);
          return;
        }

        setSaved(true);
        if (option.value === "Keyboard") {
          window.setTimeout(onKeyboard, 650);
        }
      } catch (saveError) {
        console.error("[tacit] option board interaction save failed:", saveError);
        setError("Could not save this selection. Please try again.");
        setSelectedOption(null);
      } finally {
        setSaving(false);
      }
    },
    [onKeyboard, patient.id, prompt, saving, selectedOption, session.id, speak],
  );

  const { index: highlightedIndex, setIndex } = useScanningSelection({
    options,
    active: canScan,
    intervalMs: scanIntervalMs,
    onSelect: chooseOption,
  });

  function scanAgain() {
    setSelectedOption(null);
    setSaved(false);
    setError(null);
    setEditingOptionIndex(null);
    setIndex(0);
  }

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col"
      aria-label="Six option communication board"
    >
      <div className="mt-4 grid w-full gap-4 rounded-lg border border-border bg-card p-4 shadow-sm md:grid-cols-[1fr_12rem] md:p-5">
        <PromptSuggestionInput
          label="Prompt"
          value={prompt}
          placeholder="What do you need?"
          suggestions={questionSuggestions.questions}
          loading={questionSuggestions.loading}
          error={questionSuggestions.error}
          onChange={(nextPrompt) => {
            setPrompt(nextPrompt);
            setSelectedOption(null);
            setSaved(false);
            setError(null);
            setIndex(0);
          }}
          onSelectSuggestion={onSuggestionSelect}
          onRegenerate={onRegenerateSuggestions}
        />

        <label className="block text-sm font-medium text-foreground">
          Scan speed
          <select
            value={scanIntervalMs}
            onChange={(event) => setScanIntervalMs(Number(event.target.value))}
            className="mt-2 w-full rounded-md border border-input bg-background px-4 py-3 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value={1000}>Fast</option>
            <option value={1250}>Normal</option>
            <option value={1500}>Slow</option>
          </select>
        </label>
      </div>

      <div className="mt-4 grid min-h-0 flex-1 auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((option, optionIndex) => {
          const active = canScan && highlightedIndex === optionIndex;
          const selected = selectedOption === option.value;
          const editable = optionIndex < 5;
          const editing = editingOptionIndex === optionIndex;
          return (
            <div
              key={`${option.value}-${optionIndex}`}
              className={cn(
                "relative flex min-h-24 flex-col rounded-lg border-2 bg-card text-center shadow-sm transition",
                active
                  ? "scale-[1.02] border-primary bg-primary text-primary-foreground shadow-lg"
                  : "border-border text-foreground hover:border-primary/60",
                selected && "border-success bg-success text-success-foreground shadow-lg",
                selectedOption && !selected && "opacity-55",
              )}
            >
              {editable && (
                <button
                  type="button"
                  onClick={() => setEditingOptionIndex(editing ? null : optionIndex)}
                  className={cn(
                    "absolute right-2 top-2 z-10 grid size-9 place-items-center rounded-md border transition",
                    active || selected
                      ? "border-white/50 bg-white/15 text-current hover:bg-white/25"
                      : "border-border bg-background/80 text-muted-foreground hover:text-foreground",
                  )}
                  aria-label={`Edit option ${optionIndex + 1}`}
                >
                  <Pencil className="size-4" />
                </button>
              )}
              {editing ? (
                <div className="flex flex-1 items-center px-5 py-4">
                  <input
                    autoFocus
                    value={boardOptions[optionIndex] ?? ""}
                    onChange={(event) => {
                      const next = [...boardOptions];
                      next[optionIndex] = event.target.value;
                      setBoardOptions(next);
                      setSelectedOption(null);
                      setSaved(false);
                      setError(null);
                      setIndex(0);
                    }}
                    onBlur={() => setEditingOptionIndex(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === "Escape") {
                        event.currentTarget.blur();
                      }
                    }}
                    className="w-full rounded-md border border-input bg-background px-3 py-3 text-center text-xl font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setIndex(optionIndex);
                    void chooseOption(option);
                  }}
                  disabled={saving || Boolean(selectedOption)}
                  className="flex h-full w-full flex-col items-center justify-center px-5 py-4 focus:outline-none focus:ring-4 focus:ring-primary/25"
                  aria-pressed={selected}
                >
                  <span className="block font-display text-3xl font-semibold md:text-4xl">
                    {option.label}
                  </span>
                  {active && !selected && (
                    <span className="mt-3 block text-sm font-semibold uppercase tracking-[0.16em]">
                      Highlighted
                    </span>
                  )}
                  {selected && (
                    <span className="mt-3 block text-sm font-semibold uppercase tracking-[0.16em]">
                      Selected {saved ? "✓" : saving ? "saving..." : ""}
                    </span>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!prompt.trim() && (
        <p className="mt-4 text-center text-sm font-medium text-destructive">
          Enter a prompt before scanning starts.
        </p>
      )}
      {error && <p className="mt-4 text-center text-sm font-medium text-destructive">{error}</p>}
      {selectedOption && !error && (
        <p className="mt-5 text-center text-lg font-semibold text-foreground">
          Selected option: {selectedOption} {saved ? "✓" : saving ? "saving..." : ""}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Button variant="outline" size="lg" onClick={scanAgain}>
          Ask Another Prompt
        </Button>
        <Button size="lg" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function BlinkKeyboardCommunicationScreen({
  patient,
  session,
  clinicianQuestion,
  onBack,
  onContinue,
}: {
  patient: Patient;
  session: Session;
  clinicianQuestion: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { speak } = useTextToSpeech();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const suggestionCacheRef = useRef<Map<string, string[]>>(new Map());
  const lastCompletionRequestRef = useRef("");
  const suggestionScanItems = useMemo(() => suggestions.slice(0, 3), [suggestions]);
  const [message, setMessage] = useState("");
  const [completedMessage, setCompletedMessage] = useState<string | null>(null);
  const [scanMode, setScanMode] = useState<KeyboardScanMode>("ROWS");
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [scanIntervalMs, setScanIntervalMs] = useState(KEYBOARD_SCAN_INTERVAL_MS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scanItems =
    scanMode === "SUGGESTIONS"
      ? suggestionScanItems
      : scanMode === "ROWS"
        ? KEYBOARD_LAYOUT
        : selectedRowIndex === null
          ? []
          : (KEYBOARD_LAYOUT[selectedRowIndex] ?? []);

  useEffect(() => {
    const typedText = message.replace(/\s+/g, " ").trim();
    if (typedText.length < 2) {
      setSuggestions([]);
      setSuggestionLoading(false);
      setSuggestionError(null);
      lastCompletionRequestRef.current = "";
      return;
    }

    const cacheKey = [patient.id, session.id, clinicianQuestion, typedText.toLowerCase()].join("|");
    const cached = suggestionCacheRef.current.get(cacheKey);
    if (cached) {
      setSuggestions(cached);
      if (cached.length > 0) setScanMode("SUGGESTIONS");
      setSuggestionLoading(false);
      setSuggestionError(null);
      return;
    }

    const lastRequested = lastCompletionRequestRef.current;
    const smallPrefixChange =
      lastRequested &&
      typedText.toLowerCase().startsWith(lastRequested.toLowerCase()) &&
      typedText.length - lastRequested.length < 3 &&
      !/[\s.!?]$/.test(typedText);
    if (smallPrefixChange) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      lastCompletionRequestRef.current = typedText;
      setSuggestionLoading(true);
      setSuggestionError(null);
      buildSuggestedQuestionContext(patient, session)
        .then((context) =>
          generateKeyboardCompletions({
            ...context,
            typedText,
            clinicianQuestion,
          }),
        )
        .then((response) => {
          if (cancelled) return;
          suggestionCacheRef.current.set(cacheKey, response.completions);
          setSuggestions(response.completions);
          if (response.completions.length > 0) setScanMode("SUGGESTIONS");
          setSuggestionError(response.error ?? null);
        })
        .catch((completionError) => {
          if (cancelled) return;
          console.error("[tacit] keyboard completions failed:", completionError);
          setSuggestions([]);
          setSuggestionError(
            completionError instanceof Error ? completionError.message : String(completionError),
          );
        })
        .finally(() => {
          if (!cancelled) setSuggestionLoading(false);
        });
    }, KEYBOARD_COMPLETION_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clinicianQuestion, message, patient, session]);

  const completeMessage = useCallback(
    async (completedText: string) => {
      if (!completedText.trim() || saving) return;
      setSaving(true);
      setError(null);
      const completionTime = Date.now();

      void speak(completedText.trim());

      try {
        const interaction = await localDb.saveInteraction({
          patientId: patient.id,
          sessionId: session.id,
          question: "Blink keyboard message",
          questionType: "keyboard",
          response: completedText.trim(),
          timestamp: new Date(completionTime).toISOString(),
        });

        if (!interaction) {
          setError("Could not save this message. Please try again.");
          return;
        }

        setCompletedMessage(completedText.trim());
        setMessage("");
        setSuggestions([]);
        setScanMode("ROWS");
        setSelectedRowIndex(null);
      } catch (saveError) {
        console.error("[tacit] keyboard interaction save failed:", saveError);
        setError("Could not save this message. Please try again.");
      } finally {
        setSaving(false);
      }
    },
    [patient.id, saving, session.id, speak],
  );

  const selectCurrentItem = useCallback(
    (itemIndex: number) => {
      setError(null);

      if (scanMode === "SUGGESTIONS") {
        const selectedSuggestion = suggestionScanItems[itemIndex];
        if (!selectedSuggestion) return;

        const visiblePrefix = message.replace(/\s+/g, " ").trim();
        const completedSuggestion =
          visiblePrefix && selectedSuggestion.toLowerCase().startsWith(visiblePrefix.toLowerCase())
            ? `${message}${selectedSuggestion.slice(visiblePrefix.length)}`
            : selectedSuggestion;
        lastCompletionRequestRef.current = completedSuggestion.replace(/\s+/g, " ").trim();
        setMessage(completedSuggestion);
        setSuggestions([]);
        setScanMode("ROWS");
        setSelectedRowIndex(null);
        return;
      }

      if (scanMode === "ROWS") {
        setSelectedRowIndex(itemIndex);
        setScanMode("COLUMNS");
        return;
      }

      if (scanMode !== "COLUMNS" || selectedRowIndex === null) return;

      const selectedKey = KEYBOARD_LAYOUT[selectedRowIndex]?.[itemIndex];
      if (!selectedKey) return;

      if (selectedKey === "DONE") {
        void completeMessage(message);
      } else if (selectedKey === "BACKSPACE") {
        setSuggestions([]);
        setMessage((current) => current.slice(0, -1));
      } else if (selectedKey === "CLEAR") {
        if (message && !window.confirm("Clear the current message?")) {
          setScanMode("ROWS");
          setSelectedRowIndex(null);
          return;
        }
        setSuggestions([]);
        setMessage("");
      } else {
        setSuggestions([]);
        const value = selectedKey === "SPACE" ? " " : selectedKey;
        setMessage((current) => current + value);
      }

      setScanMode("ROWS");
      setSelectedRowIndex(null);
    },
    [completeMessage, message, scanMode, selectedRowIndex, suggestionScanItems],
  );

  const { currentScanIndex, setCurrentScanIndex } = useScanController({
    itemCount: scanItems.length,
    active: !saving,
    intervalMs: scanIntervalMs,
    onSelect: selectCurrentItem,
    onCycleEnd:
      scanMode === "SUGGESTIONS"
        ? () => {
            setScanMode("ROWS");
            setSelectedRowIndex(null);
          }
        : scanMode === "ROWS" && suggestionScanItems.length > 0
          ? () => {
              setScanMode("SUGGESTIONS");
              setSelectedRowIndex(null);
            }
          : undefined,
  });

  useEffect(() => {
    setCurrentScanIndex(0);
  }, [scanMode, selectedRowIndex, setCurrentScanIndex]);

  return (
    <section
      className="w-full max-w-[76rem] animate-fade-in lg:-mt-10"
      aria-label="Blink keyboard communication"
    >
      <div className="grid gap-5 lg:grid-cols-[23rem_minmax(0,1fr)] lg:items-stretch">
        <div className="flex min-h-[28rem] flex-col rounded-lg border border-border bg-card p-5 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Communication
            </p>
            <h1 className="mt-1 font-display text-3xl font-semibold md:text-4xl">Blink Keyboard</h1>

            <div className="mt-5 rounded-lg border-2 border-border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Current message
              </p>
              <p
                className={cn(
                  "mt-2 min-h-32 max-h-48 overflow-y-auto break-words font-display text-3xl font-semibold leading-tight md:text-4xl",
                  !message && "text-muted-foreground",
                )}
              >
                {message || "Waiting..."}
              </p>
            </div>

            <div className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                {scanMode === "SUGGESTIONS"
                  ? "Scanning suggestions"
                  : scanMode === "ROWS"
                    ? "Scanning rows"
                    : `Scanning row ${(selectedRowIndex ?? 0) + 1}`}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-5">
            <label className="block text-sm font-medium text-foreground">
              Scan speed
              <select
                value={scanIntervalMs}
                onChange={(event) => setScanIntervalMs(Number(event.target.value))}
                className="ml-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option value={800}>Fast</option>
                <option value={1000}>Normal</option>
                <option value={1250}>Slow</option>
              </select>
            </label>

            {completedMessage && (
              <div className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-success">
                <p className="text-xs font-semibold uppercase tracking-[0.16em]">Message saved</p>
                <p className="mt-1 text-sm font-semibold">{completedMessage}</p>
              </div>
            )}
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                {error}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={onBack}>
                Back to Board
              </Button>
              <Button onClick={onContinue}>Continue</Button>
            </div>
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-border bg-card/70 p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">
              Word Suggestions
            </p>
            <p className="text-right text-sm text-muted-foreground">
              {suggestionLoading
                ? "Updating Gemini predictions..."
                : suggestionError
                  ? `Predictive text unavailable: ${suggestionError}. Keyboard still works.`
                  : suggestions.length
                    ? "Suggestions stay active until the next key changes the message."
                    : "Keyboard row scanning is active."}
            </p>
          </div>

          <div className="grid min-h-16 gap-2 md:grid-cols-3">
            {suggestionScanItems.map((suggestion, suggestionIndex) => {
              const active = scanMode === "SUGGESTIONS" && currentScanIndex === suggestionIndex;
              return (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => selectCurrentItem(suggestionIndex)}
                  className={cn(
                    "min-h-16 rounded-lg border-2 bg-card px-3 py-2 text-base font-semibold shadow-sm transition focus:outline-none focus:ring-4 focus:ring-primary/25",
                    active
                      ? "scale-[1.02] border-primary bg-primary text-primary-foreground shadow-lg"
                      : "border-border hover:border-primary/60",
                  )}
                  aria-current={active ? "true" : undefined}
                >
                  {suggestion}
                </button>
              );
            })}
          </div>

          <div className="mt-4 grid gap-2">
            {KEYBOARD_LAYOUT.map((row, rowIndex) => {
              const rowActive = scanMode === "ROWS" && currentScanIndex === rowIndex;
              const rowSelected = scanMode === "COLUMNS" && selectedRowIndex === rowIndex;
              return (
                <div
                  key={`row-${rowIndex}`}
                  className={cn(
                    "grid grid-cols-6 gap-2 rounded-lg border-2 p-1.5 transition",
                    rowActive && "scale-[1.005] border-primary bg-primary/15 shadow-lg",
                    rowSelected && "border-success bg-success/10",
                    !rowActive && !rowSelected && "border-transparent",
                  )}
                >
                  {row.map((keyValue, keyIndex) => {
                    const rowKeyActive = rowActive;
                    const keyActive =
                      scanMode === "COLUMNS" &&
                      selectedRowIndex === rowIndex &&
                      currentScanIndex === keyIndex;
                    return (
                      <button
                        key={`${rowIndex}-${keyValue}`}
                        type="button"
                        onClick={() => {
                          if (scanMode === "ROWS") selectCurrentItem(rowIndex);
                          else if (scanMode === "COLUMNS" && selectedRowIndex === rowIndex) {
                            selectCurrentItem(keyIndex);
                          }
                        }}
                        className={cn(
                          "min-h-14 rounded-md border-2 bg-background px-2 py-2 text-center font-display text-lg font-semibold shadow-sm transition md:min-h-[4.25rem] md:text-xl",
                          rowKeyActive
                            ? "scale-[1.01] border-primary bg-primary text-primary-foreground shadow-lg"
                            : keyActive
                              ? "scale-[1.03] border-primary bg-primary text-primary-foreground shadow-lg"
                              : "border-border",
                          keyValue === "DONE" &&
                            !rowKeyActive &&
                            !keyActive &&
                            "border-success/50 bg-success/10 text-success",
                          keyValue === "CLEAR" &&
                            !rowKeyActive &&
                            !keyActive &&
                            "border-destructive/40 bg-destructive/10 text-destructive",
                        )}
                        aria-current={keyActive ? "true" : undefined}
                        aria-label={keyValue === "BACKSPACE" ? "Backspace" : keyValue}
                      >
                        {keyValue === "BACKSPACE" ? "\u2190" : keyValue}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function SessionSummaryScreen({
  patient,
  session,
  spokenMessage,
  onStartAnotherPatient,
}: {
  patient: Patient;
  session: Session;
  spokenMessage: string;
  onStartAnotherPatient: () => void;
}) {
  const { speak, stopAudio, enabled, available, isSpeaking } = useTextToSpeech();
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [vitals, setVitals] = useState<VitalReading[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      localDb.listInteractionsForSession(session.id),
      // Vitals are a nice-to-have on the summary: a failure here must not
      // hide the answers, so it degrades to "no vitals" instead of an error.
      localDb.listVitalReadingsForSession(session.id).catch((vitalsError) => {
        console.error("[tacit] session vitals load failed:", vitalsError);
        return [] as VitalReading[];
      }),
    ])
      .then(([items, readings]) => {
        if (cancelled) return;
        setInteractions([...items].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
        setVitals([...readings].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      })
      .catch((summaryError) => {
        console.error("[tacit] session summary load failed:", summaryError);
        if (!cancelled) setError("Could not load session answers.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const vitalStats = useMemo(() => summarizeVitals(vitals), [vitals]);

  const summaryText = [
    `Session summary for ${patient.name}.`,
    ...vitalStats.map(
      (stat) =>
        `${stat.label}: average ${stat.avg} ${stat.unit}, ranging ${stat.min} to ${stat.max}, from ${stat.count} readings.`,
    ),
    interactions.length === 0
      ? "No answers were saved for this session."
      : `${interactions.length} ${interactions.length === 1 ? "answer was" : "answers were"} saved.`,
    ...interactions.map((interaction) =>
      interaction.questionType === "keyboard"
        ? `Message: ${interaction.response || "No response recorded"}.`
        : `${interaction.question ? `Question: ${interaction.question}. ` : ""}Answer: ${interaction.response || "No response recorded"}.`,
    ),
  ].join(" ");

  return (
    <section className="my-auto w-full max-w-4xl animate-fade-in" aria-label="Session summary">
      <p className="mb-3 text-center text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Session summary
      </p>
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm md:p-8">
        <div className="text-center">
          <h1 className="font-display text-3xl font-semibold md:text-5xl">Session summary</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Summary for {patient.name} ({patient.patientId}).
          </p>
        </div>

        <div className="mt-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-foreground">Presage vitals</h2>
            <span className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
              {vitals.length} {vitals.length === 1 ? "reading" : "readings"}
            </span>
          </div>

          {loading && (
            <p className="rounded-md border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              Loading vitals...
            </p>
          )}
          {!loading && vitalStats.length === 0 && (
            <p className="rounded-md border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              No vitals were captured for this session. Readings are recorded from the Presage
              SmartSpectra camera feed while the session is live.
            </p>
          )}
          {!loading && vitalStats.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {vitalStats.map((stat) => (
                <article
                  key={stat.type}
                  className="rounded-lg border border-border bg-background p-4"
                  aria-label={`${stat.label} summary`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                      {stat.type === VITAL_TYPES.pulse.type ? (
                        <HeartPulse className="size-4 text-primary" aria-hidden="true" />
                      ) : (
                        <Activity className="size-4 text-primary" aria-hidden="true" />
                      )}
                      {stat.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {stat.count} {stat.count === 1 ? "reading" : "readings"}
                    </span>
                  </div>
                  <p className="mt-3 font-display text-4xl font-semibold leading-none text-foreground">
                    {stat.avg}
                    <span className="ml-1.5 font-sans text-sm font-medium text-muted-foreground">
                      {stat.unit} avg
                    </span>
                  </p>
                  <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-xs text-muted-foreground">
                    <div>
                      <dt className="uppercase tracking-[0.12em]">min</dt>
                      <dd className="mt-0.5 text-sm text-foreground">{stat.min}</dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.12em]">max</dt>
                      <dd className="mt-0.5 text-sm text-foreground">{stat.max}</dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.12em]">last</dt>
                      <dd className="mt-0.5 text-sm text-foreground">{stat.last}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {new Date(stat.firstAt).toLocaleTimeString()} –{" "}
                    {new Date(stat.lastAt).toLocaleTimeString()}
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="mt-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-foreground">Questions answered</h2>
            <span className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
              {interactions.length} saved
            </span>
          </div>

          {loading && (
            <p className="rounded-md border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              Loading answered questions...
            </p>
          )}
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {!loading && !error && interactions.length === 0 && (
            <p className="rounded-md border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              No answered questions were saved for this session.
            </p>
          )}
          {!loading && !error && interactions.length > 0 && (
            <div className="space-y-3">
              {interactions.map((interaction) => (
                <article
                  key={interaction.id}
                  className="rounded-lg border border-border bg-background p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {interaction.questionType.replace("_", " ")}
                    </span>
                    <time className="text-xs text-muted-foreground">
                      {new Date(interaction.timestamp).toLocaleTimeString()}
                    </time>
                  </div>
                  {interaction.question && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Question:{" "}
                      <span className="font-medium text-foreground">{interaction.question}</span>
                    </p>
                  )}
                  <p className="mt-2 text-base font-semibold text-foreground">
                    Answer: {interaction.response || "No response recorded"}
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={!enabled || !available || loading || Boolean(error)}
            onClick={() => {
              if (isSpeaking) stopAudio();
              else void speak(summaryText);
            }}
          >
            <Volume2 className="size-5" aria-hidden="true" />
            {isSpeaking ? "Stop reading" : "Read summary"}
          </Button>
          <Button size="lg" onClick={onStartAnotherPatient}>
            Start another patient
          </Button>
        </div>
      </div>
    </section>
  );
}

type VitalStat = {
  type: string;
  label: string;
  unit: string;
  count: number;
  avg: number;
  min: number;
  max: number;
  last: number;
  firstAt: string;
  lastAt: string;
};

/** Per-vital aggregate of a session's readings, in VITAL_TYPES order (pulse,
 *  then breathing); unknown/unparseable rows are ignored. */
function summarizeVitals(readings: VitalReading[]): VitalStat[] {
  return Object.values(VITAL_TYPES).flatMap((vital) => {
    const rows = readings
      .filter((reading) => reading.type === vital.type && Number.isFinite(Number(reading.value)))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = rows[0];
    const lastRow = rows[rows.length - 1];
    if (!first || !lastRow) return [];
    const values = rows.map((reading) => Number(reading.value));
    const round = (n: number) => Math.round(n);
    return [
      {
        type: vital.type,
        label: vital.label,
        unit: vital.unit,
        count: values.length,
        avg: round(values.reduce((sum, value) => sum + value, 0) / values.length),
        min: round(Math.min(...values)),
        max: round(Math.max(...values)),
        last: round(Number(lastRow.value)),
        firstAt: first.timestamp,
        lastAt: lastRow.timestamp,
      },
    ];
  });
}

function WorkflowPlaceholder({
  eyebrow,
  title,
  body,
  patient,
  session,
  detail,
  primaryLabel,
  onPrimary,
}: {
  eyebrow: string;
  title: string;
  body: string;
  patient: Patient;
  session: Session;
  detail: string;
  primaryLabel: string;
  onPrimary: () => void;
}) {
  return (
    <section className="w-full max-w-2xl animate-fade-in text-center" aria-label={eyebrow}>
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        {eyebrow}
      </p>
      <div className="rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="font-display text-3xl font-semibold md:text-5xl">{title}</h1>
        <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
        <div className="mx-auto mt-6 grid w-fit gap-1 rounded-md border border-border bg-background px-4 py-3 font-mono text-xs text-muted-foreground">
          <span>
            patient: {patient.name} ({patient.patientId})
          </span>
          <span>session: {session.id}</span>
          <span>{detail}</span>
        </div>
        <Button className="mt-7" size="lg" onClick={onPrimary}>
          {primaryLabel}
        </Button>
      </div>
    </section>
  );
}

function CameraCheck({ onDone }: { onDone: () => void }) {
  const [cameraOn, setCameraOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    };
  }, []);

  async function openCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setError(null);
      setCameraOn(true);
    } catch {
      setError("Camera unavailable — you can continue without it for this demo.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  return (
    <section className="w-full max-w-5xl animate-fade-in text-center" aria-label="Camera check">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Step 1 · Diagnosis check
      </p>
      <h1 className="font-display text-3xl font-semibold md:text-5xl">Let’s check the camera</h1>
      <p className="mx-auto mt-4 max-w-lg text-lg text-muted-foreground">
        Position the camera so the patient’s face is clearly visible, then continue.
      </p>

      <div className="relative mx-auto mt-8 aspect-video w-full origin-center transform-gpu animate-in fade-in zoom-in-50 duration-700 overflow-hidden rounded-lg border-2 border-border bg-[#0d1424] motion-reduce:animate-none">
        <video
          ref={videoRef}
          muted
          playsInline
          className={cn("absolute inset-0 h-full w-full object-cover", !cameraOn && "opacity-0")}
          aria-hidden="true"
        />
        {!cameraOn && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center">
              <Camera className="mx-auto mb-3 size-10 text-white/40" />
              <p className="text-sm text-white/50">Camera is off</p>
            </div>
          </div>
        )}
        {cameraOn && (
          <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
            <span className="rounded-md bg-signal px-2 py-1 text-signal-foreground">
              Face detected
            </span>
            <span className="rounded-md bg-black/40 px-2 py-1 text-white/80">Tracking: good</span>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-amber">{error}</p>}

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button size="lg" variant="outline" onClick={cameraOn ? stopCamera : openCamera}>
          {cameraOn ? <CameraOff /> : <Camera />}
          {cameraOn ? "Close camera" : "Open camera"}
        </Button>
        <Button
          size="lg"
          onClick={() => {
            stopCamera();
            onDone();
          }}
        >
          {cameraOn ? "Looks good — begin calibration" : "Skip and begin calibration"}
        </Button>
      </div>
    </section>
  );
}

function Calibration({ onDone }: { onDone: () => void }) {
  const diagnostics = useEngineDiagnostics();
  const triggeredRef = useRef(false);

  // Electron: (re)run calibration fresh each time this screen is reached,
  // rather than relying on the engine's one-shot auto-calibration from when
  // the hidden engine-host window first started (which likely finished
  // before the user got here).
  useEffect(() => {
    if (diagnostics.available && !triggeredRef.current) {
      triggeredRef.current = true;
      diagnostics.calibrate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnostics.available]);

  useEffect(() => {
    if (diagnostics.available) {
      if (diagnostics.calibration === "done" || diagnostics.calibration === "failed") {
        const timer = window.setTimeout(onDone, 600);
        return () => window.clearTimeout(timer);
      }
      return;
    }
    // Browser mode, or the engine hasn't reported in yet: keep the original
    // simulated delay so the demo still flows without Electron.
    const timer = window.setTimeout(onDone, 3400);
    return () => window.clearTimeout(timer);
  }, [diagnostics.available, diagnostics.calibration, onDone]);

  return (
    <section className="animate-fade-in text-center" aria-label="Calibrating blink detection">
      <div className="calibration-ring mx-auto mb-10 grid size-56 place-items-center rounded-full md:size-64">
        <div className="grid size-[82%] place-items-center rounded-full bg-background">
          <div>
            <Activity className="mx-auto mb-2 size-8 text-primary" />
            <span className="font-display text-3xl font-semibold">Calibrating</span>
          </div>
        </div>
      </div>
      <h1 className="font-display text-3xl font-semibold md:text-5xl">
        Getting to know your blink...
      </h1>
      <p className="mx-auto mt-5 max-w-lg text-lg text-muted-foreground">
        Keep your eyes relaxed. There is nothing you need to do.
      </p>
      <div className="mx-auto mt-8 flex w-fit items-center gap-2 text-sm text-primary">
        <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" />
        Preparing your controls
      </div>
    </section>
  );
}

function YesNo({
  patient,
  onDone,
  speak,
}: {
  patient: Patient | null;
  onDone: () => void;
  speak: (text: string) => Promise<void>;
}) {
  const { index, setIndex } = useScanner(2);
  const [selected, setSelected] = useState<number | null>(null);
  const choose = useCallback(
    (choice: number) => {
      if (selected !== null) return;
      setSelected(choice);
      const text = choice === 0 ? "Yes" : "No";
      void recordSelection({
        ...(patient ? { patientId: patient.patientId } : {}),
        text,
        source: "suggested",
        how: "blink",
      });
      // Speak immediately
      void speak(text);
      window.setTimeout(onDone, 900);
    },
    [onDone, patient?.patientId, selected, speak],
  );
  useBlinkInput(() => choose(index));

  return (
    <section className="w-full max-w-5xl animate-fade-in text-center">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Let’s start simply
      </p>
      <h1 className="font-display text-3xl font-semibold md:text-5xl">
        Can you see both choices clearly?
      </h1>
      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {["Yes", "No"].map((label, itemIndex) => (
          <ScanButton
            key={label}
            active={index === itemIndex}
            selected={selected === itemIndex}
            onClick={() => {
              setIndex(itemIndex);
              choose(itemIndex);
            }}
          >
            <span className="font-display text-5xl font-semibold md:text-7xl">{label}</span>
          </ScanButton>
        ))}
      </div>
    </section>
  );
}

function NeedsBoard({
  patient,
  onSelect,
  speak,
}: {
  patient: Patient | null;
  onSelect: (value: string) => void;
  speak: (text: string) => Promise<void>;
}) {
  // Electron: the first five slots come from Gemini (falls back to the
  // static needs below on error or in the browser); Yes/No/More time stay
  // fixed — same 8-slot grid shape and styling as before either way.
  const [items, setItems] = useState<ScanItem[]>(NEEDS);
  const [suggestionSource, setSuggestionSource] = useState<"gemini" | "fallback">("fallback");

  useEffect(() => {
    let cancelled = false;
    fetchNeedsSuggestions(patient ? { patientId: patient.patientId } : {}).then((response) => {
      if (cancelled) return;
      setSuggestionSource(response.source);
      const suggested = response.options.slice(0, 5).map((label) => ({ label }));
      setItems([...suggested, { label: "Yes" }, { label: "No" }, { label: "More time" }]);
    });
    return () => {
      cancelled = true;
    };
  }, [patient?.patientId]);

  const { index, setIndex } = useScanner(items.length);
  const [selected, setSelected] = useState<number | null>(null);
  const choose = useCallback(
    (choice: number) => {
      if (selected !== null) return;
      setSelected(choice);
      const label = items[choice]?.label ?? "";
      void recordSelection({
        ...(patient ? { patientId: patient.patientId } : {}),
        text: label,
        source: "suggested",
        how: "blink",
      });
      // Speak immediately
      void speak(label);
      window.setTimeout(() => onSelect(label), 850);
    },
    [items, onSelect, patient?.patientId, selected, speak],
  );
  useBlinkInput(() => choose(index));

  return (
    <section className="w-full max-w-6xl animate-fade-in">
      <div className="mb-7 text-center">
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
          Quick needs{suggestionSource === "gemini" ? " · Gemini-personalized" : ""}
        </p>
        <h1 className="font-display text-3xl font-semibold md:text-5xl">
          What would you like to say?
        </h1>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        {items.map((item, itemIndex) => (
          <ScanButton
            key={`${item.label}-${itemIndex}`}
            active={index === itemIndex}
            selected={selected === itemIndex}
            compact
            tone={NEED_TONES[itemIndex % NEED_TONES.length] ?? "bg-card"}
            onClick={() => {
              setIndex(itemIndex);
              choose(itemIndex);
            }}
          >
            <span className="font-display text-xl font-semibold md:text-3xl">{item.label}</span>
          </ScanButton>
        ))}
      </div>
    </section>
  );
}

function ScanButton({
  active,
  selected,
  compact,
  tone,
  children,
  onClick,
}: {
  active: boolean;
  selected: boolean;
  compact?: boolean;
  tone?: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "scan-target relative flex w-full items-center justify-center overflow-hidden rounded-lg border-2 bg-card px-4 transition-all duration-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring",
        tone,
        compact ? "min-h-28 md:min-h-40" : "min-h-48 md:min-h-64",
        active && "scan-active border-scan bg-scan/10 text-foreground",
        selected && "scan-selected border-success bg-success text-success-foreground",
      )}
      aria-current={active ? "true" : undefined}
    >
      {selected && <Check className="absolute right-5 top-5 size-7" />}
      {children}
    </button>
  );
}

function ScanningKeyboard({
  patient,
  message,
  setMessage,
  onSpeak,
  speak,
}: {
  patient: Patient | null;
  message: string;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  onSpeak: (value: string) => void;
  speak: (text: string) => Promise<void>;
}) {
  const scanItems = useMemo<ScanItem[]>(
    () => [
      ...SUGGESTIONS,
      ...LETTERS,
      { label: "Space", value: " ", kind: "letter" },
      { label: "Undo", kind: "undo" },
      { label: "Speak", kind: "speak" },
    ],
    [],
  );
  const { index, setIndex } = useScanner(scanItems.length, true, 700);
  const [selected, setSelected] = useState<number | null>(null);

  const choose = useCallback(
    (choice: number) => {
      const item = scanItems[choice];
      if (!item || selected !== null) return;
      setSelected(choice);
      if (item.kind === "undo") setMessage((current) => current.slice(0, -1));
      else if (item.kind === "speak") {
        void recordSelection({
          ...(patient ? { patientId: patient.patientId } : {}),
          text: message,
          source: "typed",
          how: "blink",
        });
        // Speak immediately
        void speak(message);
        onSpeak(message);
      } else if (item.kind === "suggestion") setMessage(item.value ?? item.label);
      else setMessage((current) => current + (item.value ?? item.label));
      window.setTimeout(() => setSelected(null), 320);
    },
    [message, onSpeak, patient?.patientId, scanItems, selected, setMessage, speak],
  );
  useBlinkInput(() => choose(index));

  return (
    <section className="w-full max-w-6xl animate-fade-in py-2">
      <p className="mb-2 text-center text-sm font-semibold uppercase tracking-[0.18em] text-primary">
        Compose a message
      </p>
      <div className="mb-4 min-h-24 rounded-lg border border-border bg-card p-5 shadow-sm md:min-h-28 md:p-7">
        <p
          className={cn(
            "font-display text-2xl font-medium md:text-4xl",
            !message && "text-muted-foreground",
          )}
        >
          {message || "Your message will appear here"}
          <span className="ml-1 inline-block h-8 w-0.5 bg-primary align-middle motion-safe:animate-pulse" />
        </p>
      </div>
      <div className="mb-4 grid gap-2 md:grid-cols-3">
        {SUGGESTIONS.map((item, suggestionIndex) => (
          <KeyboardKey
            key={item.label}
            label={item.label}
            active={index === suggestionIndex}
            selected={selected === suggestionIndex}
            wide
            onClick={() => {
              setIndex(suggestionIndex);
              choose(suggestionIndex);
            }}
          />
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10 md:grid-cols-10 md:gap-2">
        {LETTERS.map((item, letterIndex) => {
          const itemIndex = letterIndex + SUGGESTIONS.length;
          return (
            <KeyboardKey
              key={item.label}
              label={item.label}
              active={index === itemIndex}
              selected={selected === itemIndex}
              onClick={() => {
                setIndex(itemIndex);
                choose(itemIndex);
              }}
            />
          );
        })}
        {scanItems.slice(-3).map((item, offset) => {
          const itemIndex = scanItems.length - 3 + offset;
          return (
            <KeyboardKey
              key={item.label}
              label={item.label}
              icon={
                item.kind === "undo" ? <Undo2 /> : item.kind === "speak" ? <Volume2 /> : undefined
              }
              active={index === itemIndex}
              selected={selected === itemIndex}
              wide
              onClick={() => {
                setIndex(itemIndex);
                choose(itemIndex);
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function KeyboardKey({
  label,
  active,
  selected,
  wide,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  selected: boolean;
  wide?: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-14 items-center justify-center gap-2 rounded-md border border-border bg-card px-2 font-display text-lg font-semibold transition-all duration-200 md:min-h-16 md:text-xl",
        wide && "col-span-2 md:col-auto",
        active && "scan-active border-scan bg-scan/15 ring-2 ring-scan",
        selected && "bg-success text-success-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Confirmed({ message, onAgain }: { message: string; onAgain: () => void }) {
  return (
    <section className="w-full max-w-4xl animate-fade-in text-center">
      <div className="mx-auto mb-8 grid size-16 place-items-center rounded-full bg-success text-success-foreground">
        <Check className="size-8" />
      </div>
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-success">
        Message confirmed
      </p>
      <h1 className="mx-auto mt-5 max-w-3xl font-display text-4xl font-semibold leading-tight md:text-7xl">
        “{message}”
      </h1>
      <div className="mx-auto mt-10 flex w-fit items-center gap-5 rounded-lg border border-border bg-card px-8 py-5">
        <Volume2 className="size-7 text-primary" />
        <div className="sound-wave flex h-9 items-center gap-1" aria-label="Speaking">
          {[0, 1, 2, 3, 4].map((bar) => (
            <span key={bar} style={{ animationDelay: `${bar * 0.12}s` }} />
          ))}
        </div>
        <span className="font-medium">Speaking</span>
      </div>
      <Button size="lg" variant="secondary" className="mt-10" onClick={onAgain}>
        <RotateCcw /> New message
      </Button>
    </section>
  );
}

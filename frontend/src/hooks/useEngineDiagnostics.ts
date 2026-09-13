import { useSyncExternalStore } from "react";

import type {
  TacitCalibrationPhase,
  TacitCalibrationResult,
  TacitEngineEvent,
  TacitEyeState,
  TacitGazeCalibrationPhase,
  TacitGazeDirection,
  TacitVitalsCalibrationPhase,
} from "@/types/tacit";

export type EngineDiagnostics = {
  /** True once window.tacit exists AND at least one engine event has arrived.
   *  Callers should show their own mock/simulated data while this is false —
   *  covers both plain-browser mode and "Electron, but engine not ready yet". */
  available: boolean;
  /** Engine lifecycle from its `status`/`error` events: "starting" while the
   *  Presage SDK spins up, "running" once frames flow, "error" if start
   *  failed or the source reported a fatal error. */
  status: "idle" | "starting" | "running" | "error";
  lastError: string | null;
  calibration: TacitCalibrationPhase | "idle";
  calibrationResult: TacitCalibrationResult | null;
  /** "Look at the center of the screen" gaze centering — starts once blink
   *  calibration is done (see routes/app.tsx's Calibration screen). */
  gazeCalibration: TacitGazeCalibrationPhase | "idle";
  gazeCenter: number | null;
  /** Presage's own pulse/breathing confidence warm-up — see
   *  engineHostRenderer.js's vitalsCalTick. Sticky once "ready". */
  vitalsCalibration: TacitVitalsCalibrationPhase | "idle";
  eye: TacitEyeState;
  gaze: TacitGazeDirection;
  face: boolean;
  degraded: boolean;
  warnings: string[];
  /** Codes of the currently-active warnings (low_light, face_small, …). */
  warningCodes: string[];
  vitals: { pulseBpm?: number | undefined; breathingBpm?: number | undefined } | null;
  vitalsConfidence: { pulse: number | null; breathing: number | null };
  /** Rolling window of the calibrated closure signal, oldest first — feeds a
   *  live EAR-style chart. Empty until calibration has finished. */
  signalHistory: number[];
  selectCount: number;
  ambiguousCount: number;
  sessionStartedAt: number | null;
  lastEventAt: number | null;
};

const SIGNAL_HISTORY_LENGTH = 72;

const IDLE: EngineDiagnostics = {
  available: false,
  status: "idle",
  lastError: null,
  calibration: "idle",
  calibrationResult: null,
  gazeCalibration: "idle",
  gazeCenter: null,
  vitalsCalibration: "idle",
  eye: "open",
  gaze: "center",
  face: false,
  degraded: false,
  warnings: [],
  warningCodes: [],
  vitals: null,
  vitalsConfidence: { pulse: null, breathing: null },
  signalHistory: [],
  selectCount: 0,
  ambiguousCount: 0,
  sessionStartedAt: null,
  lastEventAt: null,
};

/**
 * Live diagnostics from the real blink/gaze engine (calibration phase,
 * tracking quality, vitals, a rolling signal history) — used by the
 * calibration screen and the clinician view. Outside Electron (or before the
 * engine-host window's first event), returns IDLE (available: false); the
 * caller is expected to fall back to its own mock/simulated values then.
 */
export function useEngineDiagnostics() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const calibrate = () => window.tacit?.sendEngineControl({ type: "calibrate" });
  const calibrateGaze = () => window.tacit?.sendEngineControl({ type: "calibrateGaze" });
  const setEyeTracking = (enabled: boolean) =>
    window.tacit?.sendEngineControl({ type: "setEyeTracking", enabled });

  return { ...state, calibrate, calibrateGaze, setEyeTracking };
}

// --- Shared store -----------------------------------------------------------
// ONE subscription to the engine for the whole app, kept for its lifetime.
// Every hook instance reads the same snapshot, so a component that mounts
// later (the vitals panel on the communication screen, a header re-mounted
// by a route change) sees the current state — status, vitals, face — the
// instant it renders, instead of starting blank and waiting for events that
// already happened (e.g. `status: running`, which fires exactly once at
// launch and would otherwise never be seen by late mounters).

let snapshot: EngineDiagnostics = IDLE;
const activeWarnings: Record<string, string> = {};
const listeners = new Set<() => void>();
let engineSubscribed = false;

function getSnapshot() {
  return snapshot;
}
function getServerSnapshot() {
  return IDLE;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  ensureEngineSubscription();
  return () => {
    listeners.delete(listener);
  };
}

function ensureEngineSubscription() {
  if (engineSubscribed || typeof window === "undefined" || !window.tacit) return;
  engineSubscribed = true;
  window.tacit.onEngineEvent((event) => {
    snapshot = reduce(snapshot, event);
    for (const listener of listeners) listener();
  });
}

function reduce(current: EngineDiagnostics, event: TacitEngineEvent): EngineDiagnostics {
  const next: EngineDiagnostics = {
    ...current,
    available: true,
    sessionStartedAt: current.sessionStartedAt ?? Date.now(),
    lastEventAt: Date.now(),
  };
  // Frames/vitals/etc. only ever come from a running engine, so any such
  // event is proof of "running" — needed because the one-off
  // `status: running` at launch can fire before React has subscribed.
  // A frame/vitals/etc. event is proof the engine is alive — including after
  // an error, since the source auto-restarts the SDK (presageSource.js).
  if (event.type !== "status" && event.type !== "error") {
    next.status = "running";
    next.lastError = null;
  }
  switch (event.type) {
    case "status":
      if (event.payload.phase === "error") {
        next.status = "error";
        next.lastError = event.payload.message;
      } else if (event.payload.phase === "running") {
        next.status = "running";
        next.lastError = null;
      } else if (current.status !== "running" && current.status !== "error") {
        // "Presage: restarting…" progress lines must not mask an error;
        // only real frames (above) or an explicit running phase clear it.
        next.status = "starting";
      }
      break;
    case "error":
      next.status = "error";
      next.lastError = event.payload.error.message;
      break;
    case "calibration":
      next.calibration = event.payload.phase;
      if (event.payload.result) next.calibrationResult = event.payload.result;
      break;
    case "gazeCalibration":
      next.gazeCalibration = event.payload.phase;
      if (event.payload.center != null) next.gazeCenter = event.payload.center;
      break;
    case "vitalsCalibration":
      next.vitalsCalibration = event.payload.phase;
      next.vitalsConfidence = {
        pulse: event.payload.pulseConfidence,
        breathing: event.payload.breathingConfidence,
      };
      break;
    case "frame":
      next.eye = event.payload.eye;
      next.gaze = event.payload.gaze;
      next.face = event.payload.face;
      next.degraded = event.payload.degraded;
      if (event.payload.signal != null) {
        next.signalHistory = [...current.signalHistory, event.payload.signal].slice(
          -SIGNAL_HISTORY_LENGTH,
        );
      }
      break;
    case "gaze":
      next.gaze = event.payload.direction;
      break;
    case "warning":
      if (event.payload.active) activeWarnings[event.payload.code] = event.payload.message;
      else delete activeWarnings[event.payload.code];
      next.warnings = Object.values(activeWarnings);
      next.warningCodes = Object.keys(activeWarnings);
      break;
    case "vitals":
      next.vitals = {
        pulseBpm: event.payload.pulseBpm,
        breathingBpm: event.payload.breathingBpm,
      };
      break;
    case "select":
      next.selectCount = current.selectCount + 1;
      break;
    case "ambiguous":
      next.ambiguousCount = current.ambiguousCount + 1;
      break;
    case "facelost":
      next.face = false;
      break;
    case "faceback":
      next.face = true;
      break;
    default:
      break;
  }
  return next;
}

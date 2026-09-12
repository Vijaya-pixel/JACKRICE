import { useEffect, useRef, useState } from "react";

import type {
  TacitCalibrationPhase,
  TacitCalibrationResult,
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
  vitals: { pulseBpm?: number; breathingBpm?: number } | null;
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
  const [state, setState] = useState<EngineDiagnostics>(IDLE);
  const warningsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!window.tacit) return;
    const unsubscribe = window.tacit.onEngineEvent((event) => {
      setState((current) => {
        const next: EngineDiagnostics = {
          ...current,
          available: true,
          sessionStartedAt: current.sessionStartedAt ?? Date.now(),
          lastEventAt: Date.now(),
        };
        switch (event.type) {
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
            if (event.payload.active)
              warningsRef.current[event.payload.code] = event.payload.message;
            else delete warningsRef.current[event.payload.code];
            next.warnings = Object.values(warningsRef.current);
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
      });
    });
    return unsubscribe;
  }, []);

  const calibrate = () => window.tacit?.sendEngineControl({ type: "calibrate" });
  const calibrateGaze = () => window.tacit?.sendEngineControl({ type: "calibrateGaze" });
  const setEyeTracking = (enabled: boolean) =>
    window.tacit?.sendEngineControl({ type: "setEyeTracking", enabled });

  return { ...state, calibrate, calibrateGaze, setEyeTracking };
}

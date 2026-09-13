import { useEffect, useRef } from "react";

import { localDb } from "@/lib/local-db";

/** Minimum gap between two saved readings of the same vital. The engine
 *  emits a `vitals` event on nearly every frame; one row every few seconds
 *  is plenty for a session summary and keeps the table small. */
const SAMPLE_INTERVAL_MS = 5000;
/** Below this the SDK's own value is basically noise — don't persist it. */
const MIN_CONFIDENCE = 0.5;

export const VITAL_TYPES = {
  pulse: { type: "pulse", unit: "bpm", label: "Heart rate" },
  breathing: { type: "breathing", unit: "breaths/min", label: "Breathing rate" },
} as const;

/**
 * Persists Presage vitals (pulse / breathing rate) for the active session by
 * listening to the engine's `vitals` events, throttled per vital type.
 * No-op outside Electron (no engine) or while `active` is false.
 */
export function useVitalsRecorder(sessionId: string | null | undefined, active: boolean) {
  const lastSavedAt = useRef<Record<string, number>>({});

  useEffect(() => {
    lastSavedAt.current = {};
    if (!sessionId || !active || !window.tacit) return;

    const unsubscribe = window.tacit.onEngineEvent((event) => {
      if (event.type !== "vitals") return;
      const now = Date.now();
      const samples = [
        { ...VITAL_TYPES.pulse, value: event.payload.pulseBpm, confidence: event.payload.pulseConfidence },
        { ...VITAL_TYPES.breathing, value: event.payload.breathingBpm, confidence: event.payload.breathingConfidence },
      ];
      for (const sample of samples) {
        if (sample.value == null || !Number.isFinite(sample.value) || sample.value <= 0) continue;
        if ((sample.confidence ?? 1) < MIN_CONFIDENCE) continue;
        if (now - (lastSavedAt.current[sample.type] ?? 0) < SAMPLE_INTERVAL_MS) continue;
        lastSavedAt.current[sample.type] = now;
        void localDb
          .saveVitalReading({
            sessionId,
            type: sample.type,
            value: Math.round(sample.value * 10) / 10,
            unit: sample.unit,
          })
          .catch((error) => console.error("[tacit] vital reading save failed:", error));
      }
    });

    return unsubscribe;
  }, [sessionId, active]);
}

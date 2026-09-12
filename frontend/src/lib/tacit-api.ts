// tacit-api.ts — thin wrappers around window.tacit's Gemini + patient
// directory calls. Every function here is safe to call in a plain browser
// tab (no window.tacit): they no-op or return the same static fallback the
// Electron side already uses (see ../../../main.js).
import { useEffect, useState } from "react";

import type { TacitGeminiSuggestions, TacitPatient, TacitSelectionEntry } from "@/types/tacit";

export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.tacit;
}

/**
 * Hydration-safe isElectron() for use during render: this app is
 * server-rendered, where `window` doesn't exist, so returning isElectron()
 * directly during render would mismatch between the server pass and an
 * Electron client's first paint.
 * Starts false on every render pass (server and client), then syncs once
 * mounted.
 */
export function useIsElectron(): boolean {
  const [electron, setElectron] = useState(false);
  useEffect(() => setElectron(isElectron()), []);
  return electron;
}

const FALLBACK_NEEDS = ["Pain", "Thirsty", "Nurse", "Uncomfortable", "Family"];

/** Needs-board suggestions: Gemini (+ per-patient history) in Electron, a static list in the browser. */
export async function fetchNeedsSuggestions(context: {
  patientContext?: string;
  patientId?: string;
}): Promise<TacitGeminiSuggestions> {
  if (!window.tacit) return { source: "fallback", options: FALLBACK_NEEDS };
  try {
    return await window.tacit.getGeminiSuggestions(context);
  } catch (error) {
    return {
      source: "fallback",
      options: FALLBACK_NEEDS,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** No-op outside Electron. */
export async function recordSelection(entry: TacitSelectionEntry): Promise<void> {
  if (!window.tacit) return;
  try {
    await window.tacit.recordSelection(entry);
  } catch (error) {
    console.error("[tacit] recordSelection failed:", error);
  }
}

export async function listPatients(): Promise<TacitPatient[]> {
  if (!window.tacit) return [];
  try {
    return await window.tacit.listPatients();
  } catch (error) {
    console.error("[tacit] listPatients failed:", error);
    return [];
  }
}

export async function addPatient(entry: {
  id: string;
  firstName?: string;
}): Promise<TacitPatient | null> {
  if (!window.tacit) return null;
  try {
    return await window.tacit.addPatient(entry);
  } catch (error) {
    console.error("[tacit] addPatient failed:", error);
    return null;
  }
}

import { useEffect, useState } from "react";

const KEY = "tacit_role";

export type Role = "clinician" | null;

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function getRole(): Role {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(KEY) === "clinician" ? "clinician" : null;
}

export function setClinicianRole() {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(KEY, "clinician");
  notify();
}

export function clearRole() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(KEY);
  notify();
}

/** Hydration-safe role reader. `ready` is false during SSR/first paint. */
export function useRole(): { role: Role; ready: boolean } {
  const [state, setState] = useState<{ role: Role; ready: boolean }>({
    role: null,
    ready: false,
  });

  useEffect(() => {
    const sync = () => setState({ role: getRole(), ready: true });
    sync();
    listeners.add(sync);
    window.addEventListener("storage", sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return state;
}

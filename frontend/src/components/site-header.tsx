import { Link, useNavigate } from "@tanstack/react-router";
import { Power } from "lucide-react";
import { useEffect, useState } from "react";

import { useEngineDiagnostics } from "@/hooks/useEngineDiagnostics";
import { clearRole, useRole } from "@/lib/role";
import { cn } from "@/lib/utils";

/** No engine event for this long while "running" means the camera/SDK has
 *  stalled (e.g. Presage dropping every frame) even though nothing errored. */
const STALE_AFTER_MS = 3000;

const WARNING_LABELS: Record<string, string> = {
  low_light: "LOW LIGHT",
  face_small: "MOVE CLOSER",
  too_far: "MOVE CLOSER",
  unstable_tracking: "UNSTABLE",
  gaze_tracker_failed: "GAZE OFF",
};

type EngineIndicator = {
  /** Cyan "ready" LED: engine running and tracking a face. */
  ready: boolean;
  /** Amber LED: something needs attention (warning, no face, stalled, error). */
  warn: boolean;
  /** Amber LED blinks (rather than steady) for hard failures. */
  fault: boolean;
  text: string;
};

/**
 * Derives the header's two status LEDs + label from live engine diagnostics,
 * so they reflect what the blink engine is actually doing instead of a
 * hard-coded "SIGNAL READY". Re-evaluated every second so a stalled feed is
 * noticed even when no new event arrives to trigger a render.
 */
function useEngineIndicator(): EngineIndicator {
  const engine = useEngineDiagnostics();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (typeof window === "undefined" || !window.tacit) {
    return { ready: false, warn: false, fault: false, text: "BROWSER PREVIEW · SIMULATED" };
  }
  if (engine.status === "error") {
    const detail = (engine.lastError ?? "").replace(/\s+/g, " ").trim().slice(0, 40).toUpperCase();
    return {
      ready: false,
      warn: true,
      fault: true,
      text: `ENGINE ERROR${detail ? ` · ${detail}` : ""}`,
    };
  }
  if (!engine.available || engine.status !== "running") {
    return { ready: false, warn: false, fault: false, text: "ENGINE STARTING" };
  }
  if (engine.lastEventAt != null && now - engine.lastEventAt > STALE_AFTER_MS) {
    return { ready: false, warn: true, fault: true, text: "NO SIGNAL · CHECK CAMERA" };
  }
  const warning = engine.warningCodes.map((code) => WARNING_LABELS[code]).find(Boolean);
  if (!engine.face) {
    return { ready: true, warn: true, fault: false, text: "ENGINE ACTIVE · NO FACE" };
  }
  if (warning) {
    return { ready: true, warn: true, fault: false, text: `ENGINE ACTIVE · ${warning}` };
  }
  return { ready: true, warn: false, fault: false, text: "ENGINE ACTIVE · FACE OK" };
}

const BASE_NAV = [
  { to: "/", label: "Home", short: "Home" },
  { to: "/how-it-works", label: "How it works", short: "How" },
  { to: "/app", label: "Patient session", short: "Patient" },
] as const;

const CLINICIAN_NAV = {
  to: "/clinician",
  label: "Clinician overview",
  short: "Clinician",
} as const;

const baseLink =
  "machine-nav-link relative rounded-md px-4 py-2 text-sm font-semibold text-machine-ink/70 transition-[transform,color] duration-300 ease-out hover:-translate-y-0.5 hover:text-machine-ink motion-reduce:transform-none after:absolute after:inset-x-3 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors";

const activeLink = "!text-machine-ink after:!bg-machine-cyan";

export function SiteHeader() {
  const navigate = useNavigate();
  const { role } = useRole();
  const items = role === "clinician" ? [...BASE_NAV, CLINICIAN_NAV] : BASE_NAV;
  const indicator = useEngineIndicator();

  const [signingOut, setSigningOut] = useState(false);

  // Let the button shrink/fade out before the route actually changes.
  const signOut = () => {
    if (signingOut) return;
    setSigningOut(true);
    window.setTimeout(() => {
      clearRole();
      navigate({ to: "/", replace: true });
    }, 500);
  };

  return (
    <header className="machine-header fixed inset-x-0 top-0 z-40">
      <div className="mx-auto flex h-[76px] max-w-[1500px] items-center justify-between gap-4 px-5 md:px-8">
        <Link to="/" aria-label="TACIT home" className="flex shrink-0 items-center">
          <span className="font-logo text-3xl font-bold tracking-tight text-machine-ink">
            TACIT
          </span>
        </Link>

        <nav
          aria-label="Main"
          className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-2 md:flex"
        >
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={baseLink}
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{ className: activeLink, "aria-current": "page" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <nav aria-label="Main" className="flex items-center gap-1 md:hidden">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-md px-2 py-1.5 text-xs font-semibold text-machine-ink/75"
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{
                className: "!text-machine-ink underline decoration-machine-cyan underline-offset-4",
              }}
            >
              {item.short}
            </Link>
          ))}
        </nav>

        {role === "clinician" ? (
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className={cn(
              "machine-power flex shrink-0 items-center gap-1.5 rounded-md border border-machine-ink/25 px-3 py-1.5 text-xs font-semibold text-machine-ink transition-all duration-500 ease-in-out hover:border-destructive hover:bg-destructive hover:text-destructive-foreground",
              signingOut && "scale-50 opacity-0 blur-sm",
            )}
          >
            <Power className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        ) : (
          <span className="hidden w-16 md:block" aria-hidden="true" />
        )}
      </div>
      <div
        className="machine-sensors"
        role="status"
        aria-live="polite"
        aria-label={`Engine status: ${indicator.text}`}
      >
        <span className="machine-status">{indicator.text}</span>
        <span
          className={cn("machine-led machine-led-ready", indicator.ready && "is-on")}
          aria-hidden="true"
        />
        <span
          className={cn(
            "machine-led machine-led-warn",
            indicator.warn && "is-on",
            indicator.fault && "is-blink",
          )}
          aria-hidden="true"
        />
      </div>
      <div className="machine-vents" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </header>
  );
}

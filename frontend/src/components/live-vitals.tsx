import { Activity, HeartPulse } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEngineDiagnostics } from "@/hooks/useEngineDiagnostics";
import { cn } from "@/lib/utils";

/** A vitals sample older than this is shown as stale ("--") rather than as
 *  a confident-looking number the SDK stopped updating a while ago. */
const STALE_AFTER_MS = 3000;

type VitalTileProps = {
  icon: typeof HeartPulse;
  label: string;
  unit: string;
  value: number | undefined;
  live: boolean;
};

function VitalTile({ icon: Icon, label, unit, value, live }: VitalTileProps) {
  const shown = live && value != null && Number.isFinite(value) ? Math.round(value) : null;
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Icon
          className={cn("size-3.5 text-primary", shown != null && "motion-safe:animate-pulse")}
          aria-hidden="true"
        />
        {label}
      </p>
      <p className="mt-0.5 font-display text-2xl font-semibold leading-none text-foreground">
        {shown ?? "--"}
        <span className="ml-1 font-sans text-[11px] font-medium text-muted-foreground">{unit}</span>
      </p>
    </div>
  );
}

/**
 * Compact live readout of the Presage vitals (pulse + breathing rate) from
 * the running engine. Meant to sit above every screen once blink calibration
 * is done, so the clinician always sees the patient's current numbers
 * alongside whatever they're doing.
 */
/** One-line "icon  72 bpm" reading for the popover. */
function VitalInline({ icon: Icon, unit, value, live }: Omit<VitalTileProps, "label">) {
  const shown = live && value != null && Number.isFinite(value) ? Math.round(value) : null;
  return (
    <span className="inline-flex items-baseline gap-1">
      <Icon className="size-3.5 self-center text-primary" aria-hidden="true" />
      <span className="font-display text-base font-semibold leading-none text-foreground">
        {shown ?? "--"}
      </span>
      <span className="text-[10px] font-medium text-muted-foreground">{unit}</span>
    </span>
  );
}

type VitalsTone = "muted" | "amber" | "success";

/** Live vitals + a one-line status describing how trustworthy they are. */
function useLiveVitals() {
  const engine = useEngineDiagnostics();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const inElectron = typeof window !== "undefined" && Boolean(window.tacit);
  const stale = engine.lastEventAt != null && now - engine.lastEventAt > STALE_AFTER_MS;
  const calibrating = engine.available && engine.vitalsCalibration === "sampling";
  const live = engine.available && engine.vitals != null && !stale;

  let status: { text: string; tone: VitalsTone };
  if (!inElectron)
    status = { text: "Simulated preview — vitals need the desktop app", tone: "muted" };
  else if (engine.status === "error") status = { text: "Engine error — no vitals", tone: "amber" };
  else if (!engine.available || engine.status !== "running")
    status = { text: "Engine starting…", tone: "muted" };
  else if (stale) status = { text: "No signal — check the camera", tone: "amber" };
  else if (calibrating) status = { text: "Reading pulse signal…", tone: "amber" };
  else if (engine.vitalsCalibration === "timeout")
    status = { text: "Low confidence — hold still, face the camera", tone: "amber" };
  else if (!engine.vitals) status = { text: "Waiting for first reading…", tone: "muted" };
  else status = { text: "Live", tone: "success" };

  return { vitals: engine.vitals, live, status };
}

/**
 * Icon button for the side rail: a heart with a status dot (green = live,
 * amber = needs attention, grey = not available). Click to open the full
 * readout in a popover, so the numbers are one tap away without the panel
 * permanently taking up space.
 */
export function LiveVitalsButton({ className }: { className?: string }) {
  const { vitals, live, status } = useLiveVitals();
  const pulse = live && vitals?.pulseBpm != null ? Math.round(vitals.pulseBpm) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative grid size-11 place-items-center rounded-lg border border-border bg-card text-primary shadow-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={`Presage vitals — ${status.text}`}
          title={`Presage vitals — ${status.text}`}
        >
          <HeartPulse
            className={cn("size-5", live && "motion-safe:animate-pulse")}
            aria-hidden="true"
          />
          <span
            className={cn(
              "absolute right-1.5 top-1.5 size-2 rounded-full ring-2 ring-card",
              status.tone === "success" && "bg-success",
              status.tone === "amber" && "bg-amber",
              status.tone === "muted" && "bg-muted-foreground/50",
            )}
            aria-hidden="true"
          />
          {pulse != null && (
            <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-sm bg-card px-1 font-mono text-[9px] font-semibold leading-none text-foreground">
              {pulse}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* Opens BELOW the button into the empty rail space (not leftwards
          over the board), and stays a single compact row so it never
          covers the prompt or option cards. */}
      <PopoverContent side="bottom" align="end" sideOffset={6} className="w-auto px-2.5 py-1.5">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <VitalInline icon={HeartPulse} unit="bpm" value={vitals?.pulseBpm} live={live} />
          <span className="h-4 w-px bg-border" aria-hidden="true" />
          <VitalInline icon={Activity} unit="/min" value={vitals?.breathingBpm} live={live} />
        </div>
        <p
          className={cn(
            "mt-1 flex items-center gap-1.5 text-[10px] font-medium",
            status.tone === "success" && "text-success",
            status.tone === "amber" && "text-amber",
            status.tone === "muted" && "text-muted-foreground",
          )}
          role="status"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              status.tone === "success" && "bg-success",
              status.tone === "amber" && "bg-amber",
              status.tone === "muted" && "bg-muted-foreground/50",
            )}
            aria-hidden="true"
          />
          {status.text}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function LiveVitalsPanel({ className }: { className?: string }) {
  const { vitals, live, status } = useLiveVitals();

  return (
    <aside
      className={cn(
        "flex w-44 shrink-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-sm",
        className,
      )}
      aria-label="Live Presage vitals"
    >
      <p className="text-xs font-semibold text-foreground">Presage vitals</p>
      <VitalTile
        icon={HeartPulse}
        label="Heart rate"
        unit="bpm"
        value={vitals?.pulseBpm}
        live={live}
      />
      <VitalTile
        icon={Activity}
        label="Breathing"
        unit="/min"
        value={vitals?.breathingBpm}
        live={live}
      />
      <p
        className={cn(
          "flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium leading-snug",
          status.tone === "success" && "border-success/30 bg-success/10 text-success",
          status.tone === "amber" && "border-amber/40 bg-amber/10 text-amber",
          status.tone === "muted" && "border-border bg-background text-muted-foreground",
        )}
        role="status"
      >
        <span
          className={cn(
            "mt-1 size-1.5 shrink-0 rounded-full",
            status.tone === "success" && "bg-success motion-safe:animate-pulse",
            status.tone === "amber" && "bg-amber motion-safe:animate-pulse",
            status.tone === "muted" && "bg-muted-foreground/50",
          )}
          aria-hidden="true"
        />
        {status.text}
      </p>
    </aside>
  );
}

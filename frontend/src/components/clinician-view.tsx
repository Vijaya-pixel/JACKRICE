import { Activity } from "lucide-react";
import { useEffect, useState } from "react";

import { useEngineDiagnostics } from "@/hooks/useEngineDiagnostics";
import { cn } from "@/lib/utils";

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatAgo(timestampMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestampMs) / 1000));
  if (seconds < 60) return `${seconds} sec ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

export function ClinicianView() {
  const diagnostics = useEngineDiagnostics();
  const [mockPoints, setMockPoints] = useState(() =>
    Array.from({ length: 72 }, (_, i) => 0.29 + Math.sin(i / 5) * 0.015),
  );
  const [mockFalseActivations, setMockFalseActivations] = useState(2);
  const [now, setNow] = useState(() => Date.now());

  // Browser mode, or Electron before the engine has reported in: keep the
  // original simulated signal so the view still demos on its own.
  useEffect(() => {
    if (diagnostics.available) return;
    const timer = window.setInterval(() => {
      setMockPoints((current) => {
        const tick = Date.now() / 240;
        const blink = Math.random() > 0.91 ? -0.18 : 0;
        return [
          ...current.slice(1),
          Math.max(0.07, 0.29 + Math.sin(tick) * 0.012 + (Math.random() - 0.5) * 0.018 + blink),
        ];
      });
      if (Math.random() > 0.985) setMockFalseActivations((value) => value + 1);
    }, 180);
    return () => window.clearInterval(timer);
  }, [diagnostics.available]);

  // Keeps "Elapsed" / "Last input" ticking once real session timestamps exist.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const points =
    diagnostics.available && diagnostics.signalHistory.length > 1
      ? diagnostics.signalHistory
      : mockPoints;
  const falseActivations = diagnostics.available
    ? diagnostics.ambiguousCount
    : mockFalseActivations;
  const confirmedSelections = diagnostics.available ? String(diagnostics.selectCount) : "18";
  const trackingQuality = !diagnostics.available
    ? "Good"
    : diagnostics.degraded
      ? "Degraded"
      : diagnostics.face
        ? "Good"
        : "No face";
  const trackingGood = trackingQuality === "Good";
  const baselineEar = diagnostics.calibrationResult
    ? diagnostics.calibrationResult.baseline.toFixed(3)
    : "0.294";
  const blinkThreshold = diagnostics.calibrationResult
    ? diagnostics.calibrationResult.threshold.toFixed(3)
    : "0.190";
  const elapsed = diagnostics.sessionStartedAt
    ? formatElapsed(diagnostics.sessionStartedAt, now)
    : "00:14:32";
  const lastInput = diagnostics.lastEventAt ? formatAgo(diagnostics.lastEventAt, now) : "8 sec ago";

  const chartPoints = points
    .map((value, index) => `${(index / (points.length - 1)) * 1000},${220 - value * 600}`)
    .join(" ");

  return (
    <div className="min-h-svh px-5 pb-20 pt-24 md:px-10">
      <div className="mx-auto max-w-[1450px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Clinical monitoring
            </p>
            <h1 className="mt-1 font-display text-3xl font-semibold md:text-4xl">
              Blink signal overview
            </h1>
          </div>
          <div
            className={cn(
              "flex items-center gap-3 rounded-md border px-4 py-3",
              trackingGood ? "border-success/40 bg-success/10" : "border-amber/40 bg-amber/10",
            )}
          >
            <span
              className={cn(
                "size-2.5 rounded-full motion-safe:animate-pulse",
                trackingGood ? "bg-success" : "bg-amber",
              )}
            />
            <div>
              <p className="text-xs text-muted-foreground">Tracking quality</p>
              <p className={cn("font-semibold", trackingGood ? "text-success" : "text-amber")}>
                {trackingQuality}
              </p>
            </div>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="rounded-lg border border-border bg-card p-4 md:p-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-semibold">Eye aspect ratio</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {diagnostics.available ? "Live signal" : "Live simulated signal"} · 12 second
                  window
                </p>
              </div>
              <span className="text-2xl font-semibold tabular-nums text-primary">
                {(points.at(-1) ?? 0).toFixed(3)}
              </span>
            </div>
            <div className="relative h-[360px] overflow-hidden rounded-md border border-border bg-chart-grid md:h-[480px]">
              <div className="chart-grid absolute inset-0" />
              <svg
                viewBox="0 0 1000 240"
                preserveAspectRatio="none"
                className="absolute inset-0 size-full"
                aria-label="Eye aspect ratio line chart"
              >
                <line x1="0" y1="106" x2="1000" y2="106" className="threshold-line" />
                <polyline
                  points={chartPoints}
                  fill="none"
                  className="signal-line"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span className="absolute right-3 top-[43%] rounded bg-chart-grid px-2 py-1 text-xs tabular-nums text-threshold">
                Threshold {blinkThreshold}
              </span>
              <span className="absolute bottom-3 left-3 text-xs tabular-nums text-muted-foreground">
                −12s
              </span>
              <span className="absolute bottom-3 right-3 text-xs tabular-nums text-muted-foreground">
                Now
              </span>
            </div>
          </section>
          <aside className="grid content-start gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <Metric
              title="False activations"
              value={String(falseActivations)}
              detail="Last 30 minutes"
            />
            <Metric
              title="Confirmed selections"
              value={confirmedSelections}
              detail="Current session"
            />
            <section className="rounded-lg border border-border bg-card p-5 sm:col-span-2 lg:col-span-1">
              <div className="mb-4 flex items-center gap-2">
                <Activity className="size-4 text-primary" />
                <h2 className="font-semibold">Calibration values</h2>
              </div>
              <dl className="space-y-3 text-sm">
                <DataRow label="Baseline EAR" value={baselineEar} />
                <DataRow label="Blink threshold" value={blinkThreshold} />
                <DataRow label="Min. duration" value="180 ms" />
                <DataRow label="Scan interval" value="1500 ms" />
                <DataRow label="Signal confidence" value="96.8%" />
              </dl>
            </section>
            <section className="rounded-lg border border-border bg-card p-5 sm:col-span-2 lg:col-span-1">
              <h2 className="mb-3 font-semibold">Session</h2>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Elapsed</span>
                <span className="tabular-nums">{elapsed}</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last input</span>
                <span>{lastInput}</span>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-2 text-4xl font-semibold tabular-nums">{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </section>
  );
}

function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-3 last:border-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

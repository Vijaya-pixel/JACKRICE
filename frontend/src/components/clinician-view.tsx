import { Activity, AlertTriangle, HeartPulse, MessageSquareText, Wind } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEngineDiagnostics } from "@/hooks/useEngineDiagnostics";
import { LAST_SELECTION_STORAGE_KEY } from "@/lib/tacit-api";
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

// Presage reports vitals as unrounded floats (e.g. 50.750686645...) — round
// for display, same as yesnoApp.js's legacy vitals readout.
function formatBpm(value: number | undefined): string {
  return value != null ? String(Math.round(value)) : "—";
}

type LastSelection = { text: string; how: string; t: number };

function readLastSelection(): LastSelection | null {
  try {
    const raw = localStorage.getItem(LAST_SELECTION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LastSelection) : null;
  } catch {
    return null;
  }
}

/**
 * Same-origin, same-device only: reflects the patient screen's most recent
 * choice via localStorage (written by recordSelection() in tacit-api.ts). A
 * separate clinician tab on the same browser picks up live updates through
 * the 'storage' event (which only fires in OTHER tabs, never the writer) —
 * this does not reach a clinician on a different device.
 */
function useLastSelection(): LastSelection | null {
  const [value, setValue] = useState<LastSelection | null>(null);
  useEffect(() => {
    setValue(readLastSelection());
    const onStorage = (event: StorageEvent) => {
      if (event.key === LAST_SELECTION_STORAGE_KEY) setValue(readLastSelection());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return value;
}

/** Samples `value` into a fixed-length rolling window every intervalMs — feeds a trend sparkline. */
function useRollingHistory(value: number, length: number, intervalMs: number): number[] {
  const [history, setHistory] = useState<number[]>(() => Array(length).fill(value));
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    const timer = window.setInterval(() => {
      setHistory((current) => [...current.slice(1), valueRef.current]);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return history;
}

/**
 * Same sampling as useRollingHistory, but tracks the delta between samples of
 * a monotonically-increasing counter. A raw cumulative count always trends
 * up, which makes for an uninformative sparkline — the *rate* it's climbing
 * at is the actually interesting trend.
 */
function useRateHistory(cumulativeValue: number, length: number, intervalMs: number): number[] {
  const [history, setHistory] = useState<number[]>(() => Array(length).fill(0));
  const valueRef = useRef(cumulativeValue);
  const prevRef = useRef(cumulativeValue);
  valueRef.current = cumulativeValue;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const delta = Math.max(0, valueRef.current - prevRef.current);
      prevRef.current = valueRef.current;
      setHistory((current) => [...current.slice(1), delta]);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return history;
}

function Sparkline({ points, className }: { points: number[]; className?: string }) {
  const path = useMemo(() => {
    if (points.length < 2) return "";
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    return points
      .map(
        (value, index) =>
          `${(index / (points.length - 1)) * 100},${18 - ((value - min) / range) * 16}`,
      )
      .join(" ");
  }, [points]);
  if (!path) return null;
  return (
    <svg
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className={cn("h-5 w-16 shrink-0", className)}
      aria-hidden="true"
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// One index per contiguous run of values below `threshold` — the local
// minimum of that run, i.e. the "worst point" of one blink dip. Marks the
// dip itself rather than every sample under the line.
function findDips(values: number[], threshold: number): number[] {
  const dips: number[] = [];
  let i = 0;
  while (i < values.length) {
    const current = values[i];
    if (current !== undefined && current < threshold) {
      let minIndex = i;
      let minValue = current;
      while (i < values.length) {
        const v = values[i];
        if (v === undefined || v >= threshold) break;
        if (v < minValue) {
          minValue = v;
          minIndex = i;
        }
        i++;
      }
      dips.push(minIndex);
    } else {
      i++;
    }
  }
  return dips;
}

export function ClinicianView() {
  const diagnostics = useEngineDiagnostics();
  const [mockPoints, setMockPoints] = useState(() =>
    Array.from({ length: 72 }, (_, i) => 0.29 + Math.sin(i / 5) * 0.015),
  );
  const [mockFalseActivations, setMockFalseActivations] = useState(2);
  const [mockVitals, setMockVitals] = useState({ pulseBpm: 74, breathingBpm: 15 });
  const [mockWarning, setMockWarning] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastSelection = useLastSelection();

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

  // Vitals and warnings tick on a slower, human-scale cadence — no need for
  // the 180ms chart resolution. Also browser-mode only.
  useEffect(() => {
    if (diagnostics.available) return;
    const timer = window.setInterval(() => {
      setMockVitals((current) => ({
        pulseBpm: Math.round(
          Math.min(96, Math.max(58, current.pulseBpm + (Math.random() - 0.5) * 2.4)),
        ),
        breathingBpm: Math.round(
          Math.min(22, Math.max(10, current.breathingBpm + (Math.random() - 0.5) * 1.2)),
        ),
      }));
      setMockWarning((current) => {
        if (current) return current;
        if (Math.random() > 0.992) return "Lighting is low — move a light closer to the face";
        return null;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [diagnostics.available]);

  useEffect(() => {
    if (!mockWarning) return;
    const timer = window.setTimeout(() => setMockWarning(null), 5000);
    return () => window.clearTimeout(timer);
  }, [mockWarning]);

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
  const confirmedCount = diagnostics.available ? diagnostics.selectCount : 18;
  const confirmedSelections = String(confirmedCount);
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
  const vitals = diagnostics.available && diagnostics.vitals ? diagnostics.vitals : mockVitals;
  const warnings = diagnostics.available ? diagnostics.warnings : mockWarning ? [mockWarning] : [];
  // Browser/mock mode has no real warm-up to wait for; only gate real readings.
  const vitalsReady = !diagnostics.available || diagnostics.vitalsCalibration === "ready";
  const vitalsLabel =
    diagnostics.available && !vitalsReady
      ? diagnostics.vitalsCalibration === "timeout"
        ? "Still acquiring — hold still"
        : "Reading pulse signal..."
      : null;

  // False activations vs. confirmed selections: a ratio at or above 1 means
  // the system is producing more noise than real input — that deserves a
  // warning color, not the same neutral treatment as every other stat.
  const activationRatio =
    confirmedCount > 0 ? falseActivations / confirmedCount : falseActivations > 0 ? Infinity : 0;
  const activationSeverity: "low" | "medium" | "high" =
    activationRatio >= 1 ? "high" : activationRatio >= 0.5 ? "medium" : "low";
  const activationDetail =
    activationSeverity === "high"
      ? "High relative to confirmed selections"
      : activationSeverity === "medium"
        ? "Rising relative to confirmed selections"
        : "Last 30 minutes";

  const falseActivationTrend = useRateHistory(falseActivations, 16, 4000);
  const pulseTrend = useRollingHistory(vitalsReady ? (vitals.pulseBpm ?? 0) : 0, 16, 4000);

  // Fit the y-axis to what's actually on screen (signal + threshold +
  // baseline), instead of a fixed range that leaves most of the card empty
  // whenever the signal sits well above threshold.
  const thresholdValue = Number(blinkThreshold);
  const baselineValue = Number(baselineEar);
  const { scaleY, thresholdY } = useMemo(() => {
    const values = [...points, thresholdValue, baselineValue].filter((v) => Number.isFinite(v));
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const pad = (rawMax - rawMin) * 0.18 || 0.02;
    const yMin = rawMin - pad;
    const yMax = rawMax + pad;
    const scale = (value: number) => 240 - ((value - yMin) / (yMax - yMin)) * 240;
    return { scaleY: scale, thresholdY: scale(thresholdValue) };
  }, [points, thresholdValue, baselineValue]);

  const chartPointX = (index: number) => (index / (points.length - 1)) * 1000;
  const chartPoints = points
    .map((value, index) => `${chartPointX(index)},${scaleY(value)}`)
    .join(" ");
  const dipIndices = useMemo(() => findDips(points, thresholdValue), [points, thresholdValue]);
  const thresholdLabelTop = Math.min(88, Math.max(6, (thresholdY / 240) * 100));

  return (
    <div className="min-h-svh px-5 pb-20 pt-24 md:px-10">
      <div className="mx-auto max-w-[1450px]">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Clinical monitoring
            </p>
            <h1 className="mt-1 font-display text-3xl font-semibold md:text-4xl">
              Blink signal overview
            </h1>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold",
              trackingGood
                ? "border-success/40 bg-success/10 text-success"
                : "border-amber/40 bg-amber/10 text-amber",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full motion-safe:animate-pulse",
                trackingGood ? "bg-success" : "bg-amber",
              )}
            />
            Tracking {trackingQuality}
          </span>
        </div>
        {warnings.length > 0 && (
          <div className="mb-6 space-y-2" role="alert">
            {warnings.map((warning) => (
              <div
                key={warning}
                className="flex items-center gap-3 rounded-md border border-amber/40 bg-amber/10 px-4 py-3 text-sm font-medium text-amber"
              >
                <AlertTriangle className="size-4 shrink-0" />
                {warning}
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
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
            <div className="relative h-[280px] overflow-hidden rounded-md border border-border bg-chart-grid md:h-[360px]">
              <div className="chart-grid absolute inset-0" />
              <svg
                viewBox="0 0 1000 240"
                preserveAspectRatio="none"
                className="absolute inset-0 size-full"
                aria-label="Eye aspect ratio line chart"
              >
                <rect
                  x="0"
                  y={thresholdY}
                  width="1000"
                  height={Math.max(0, 240 - thresholdY)}
                  className="threshold-zone"
                />
                <line x1="0" y1={thresholdY} x2="1000" y2={thresholdY} className="threshold-line" />
                <polyline
                  points={chartPoints}
                  fill="none"
                  className="signal-line"
                  vectorEffect="non-scaling-stroke"
                />
                {dipIndices.map((index) => (
                  <circle
                    key={index}
                    cx={chartPointX(index)}
                    cy={scaleY(points[index] ?? 0)}
                    r="5"
                    className="blink-dot"
                  />
                ))}
              </svg>
              <span
                className="absolute right-3 -translate-y-1/2 rounded bg-chart-grid px-2 py-1 text-xs tabular-nums text-threshold"
                style={{ top: `${thresholdLabelTop}%` }}
              >
                Threshold {blinkThreshold}
              </span>
              <div className="absolute inset-x-3 bottom-3 flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>−12s</span>
                <span>−8s</span>
                <span>−4s</span>
                <span>Now</span>
              </div>
            </div>
          </section>
          <aside className="flex flex-col gap-6">
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Live
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <section className="rounded-lg border border-border bg-card p-5 sm:col-span-2 lg:col-span-1">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <h2 className="font-semibold">Vitals</h2>
                    {vitalsLabel && (
                      <span className="flex items-center gap-1.5 text-xs font-medium text-amber">
                        <span className="size-1.5 rounded-full bg-amber motion-safe:animate-pulse" />
                        {vitalsLabel}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center gap-3">
                      <HeartPulse className="size-5 shrink-0 text-primary" />
                      <div>
                        <p className="text-2xl font-semibold tabular-nums leading-none">
                          {vitalsReady ? formatBpm(vitals.pulseBpm) : "—"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">bpm pulse</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Wind className="size-5 shrink-0 text-primary" />
                      <div>
                        <p className="text-2xl font-semibold tabular-nums leading-none">
                          {vitalsReady ? formatBpm(vitals.breathingBpm) : "—"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">breaths/min</p>
                      </div>
                    </div>
                  </div>
                  {vitalsReady && (
                    <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
                      <p className="text-xs text-muted-foreground">Pulse trend</p>
                      <Sparkline points={pulseTrend} className="text-primary" />
                    </div>
                  )}
                </section>
                <AlertMetric
                  title="False activations"
                  value={String(falseActivations)}
                  detail={activationDetail}
                  tone={activationSeverity}
                  trend={falseActivationTrend}
                />
                <Metric
                  title="Confirmed selections"
                  value={confirmedSelections}
                  detail="Current session"
                />
                <section className="rounded-lg border border-border bg-card p-5 sm:col-span-2 lg:col-span-1">
                  <div className="mb-3 flex items-center gap-2">
                    <MessageSquareText className="size-4 text-primary" />
                    <h2 className="font-semibold">Last selection</h2>
                  </div>
                  {lastSelection ? (
                    <>
                      <p className="truncate text-xl font-semibold" title={lastSelection.text}>
                        “{lastSelection.text}”
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatAgo(lastSelection.t, now)} · via {lastSelection.how}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">No selection yet this session</p>
                  )}
                </section>
              </div>
            </div>
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Session
              </p>
              <div className="grid gap-4">
                <section className="rounded-lg border border-border bg-card p-5">
                  <div className="mb-4 flex items-center gap-2">
                    <Activity className="size-4 text-primary" />
                    <h2 className="font-semibold">Calibration values</h2>
                  </div>
                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <div className="rounded-md bg-muted/50 p-3">
                      <p className="text-xs text-muted-foreground">Baseline EAR</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums">{baselineEar}</p>
                    </div>
                    <div className="rounded-md bg-muted/50 p-3">
                      <p className="text-xs text-muted-foreground">Blink threshold</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-threshold">
                        {blinkThreshold}
                      </p>
                    </div>
                  </div>
                  <dl className="space-y-3 text-sm">
                    <DataRow label="Min. duration" value="180 ms" />
                    <DataRow label="Scan interval" value="1500 ms" />
                    <DataRow label="Signal confidence" value="96.8%" />
                  </dl>
                </section>
                <section className="rounded-lg border border-border bg-card p-5">
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
              </div>
            </div>
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
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </section>
  );
}

const ALERT_TONE_CARD: Record<"low" | "medium" | "high", string> = {
  low: "border-border bg-card",
  medium: "border-amber/40 bg-amber/10",
  high: "border-destructive/40 bg-destructive/10",
};
const ALERT_TONE_TEXT: Record<"low" | "medium" | "high", string> = {
  low: "text-foreground",
  medium: "text-amber",
  high: "text-destructive",
};

// Reserves the largest, boldest number in the sidebar for the metric that
// most needs a fast read — false activations, since a high one signals the
// system is misfiring more than the patient is actually selecting.
function AlertMetric({
  title,
  value,
  detail,
  tone,
  trend,
}: {
  title: string;
  value: string;
  detail: string;
  tone: "low" | "medium" | "high";
  trend: number[];
}) {
  return (
    <section className={cn("rounded-lg border p-5", ALERT_TONE_CARD[tone])}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className={cn("mt-2 text-5xl font-bold tabular-nums", ALERT_TONE_TEXT[tone])}>
            {value}
          </p>
        </div>
        {tone !== "low" && (
          <AlertTriangle className={cn("size-5 shrink-0", ALERT_TONE_TEXT[tone])} />
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{detail}</p>
        <Sparkline points={trend} className={ALERT_TONE_TEXT[tone]} />
      </div>
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

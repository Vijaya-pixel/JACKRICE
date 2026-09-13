import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Eye, Grid3x3, Keyboard, Volume2 } from "lucide-react";

import { RevealOnView } from "@/components/reveal-on-view";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({
    meta: [
      { title: "How it works — TACIT" },
      {
        name: "description",
        content:
          "How TACIT turns a single blink into words: calibration, scanning highlights, needs board and spoken messages.",
      },
      { property: "og:title", content: "How it works — TACIT" },
      {
        property: "og:description",
        content:
          "How TACIT turns a single blink into words: calibration, scanning highlights, needs board and spoken messages.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HowItWorksPage,
});

const STEPS = [
  {
    icon: Eye,
    title: "1 · Calibration",
    body: "A short, calm setup learns the patient's natural blink so nothing has to be forced or repeated.",
    tone: "bg-pastel-blue/60",
  },
  {
    icon: Grid3x3,
    title: "2 · Yes / No and needs",
    body: "A highlight sweeps between large, high-contrast choices. A blink selects whatever is highlighted.",
    tone: "bg-pastel-mint/60",
  },
  {
    icon: Keyboard,
    title: "3 · Frequency keyboard",
    body: "Letters are ordered by how often they are used in English, with undo always in reach, so messages take fewer blinks.",
    tone: "bg-pastel-green/60",
  },
  {
    icon: Volume2,
    title: "4 · Spoken out loud",
    body: "The finished message is shown large and read aloud, so carers and family hear it without leaning in.",
    tone: "bg-pastel-blush/60",
  },
];

// Deliberately irregular landmark cloud for the live detection demo.
const LANDMARKS: Array<[number, number]> = [
  [44.2, 37.1],
  [47.9, 36.2],
  [51.4, 36.9], // left brow
  [55.8, 36.0],
  [59.3, 36.8],
  [62.1, 38.2], // right brow
  [45.6, 41.4],
  [47.8, 40.3],
  [50.1, 41.6], // left eye
  [55.3, 40.6],
  [57.6, 40.1],
  [59.8, 41.3], // right eye
  [51.9, 46.7],
  [51.2, 51.3],
  [49.6, 54.6],
  [53.4, 54.2], // nose
  [48.4, 63.1],
  [51.8, 62.4],
  [55.1, 63.4],
  [51.9, 66.8], // mouth
  [41.8, 49.9],
  [63.4, 50.8], // jaw edges
];

function HowItWorksPage() {
  return (
    <main className="machine-page min-h-svh bg-background text-foreground">
      <SiteHeader />

      <div className="page-copy-reveal machine-display mx-auto max-w-5xl px-6 pb-20 pt-10">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
          How it works
        </p>
        <h1 className="mt-3 font-display text-4xl font-semibold md:text-5xl">
          One blink at a time
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          TACIT is built for the person in the bed first. Everything moves at a calm, predictable
          pace, and a single blink is the only input ever needed.
        </p>

        <section className="mt-10" aria-label="Simulated detection preview">
          <h2 className="font-display text-xl font-semibold">What the camera sees</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            A mock view of the landmark tracking and signal readout used during calibration.
          </p>
          <div className="mt-4 origin-center transform-gpu animate-in fade-in zoom-in-50 duration-1000 motion-reduce:animate-none">
            <CameraPanel />
          </div>
        </section>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {STEPS.map(({ icon: Icon, title, body, tone }) => (
            <RevealOnView key={title}>
              <section className={`rounded-xl border border-border p-6 ${tone}`}>
                <Icon className="size-6 text-machine-ink" />
                <h2 className="mt-4 font-display text-xl font-semibold text-machine-ink">
                  {title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-machine-ink/80">{body}</p>
              </section>
            </RevealOnView>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/app">Open the patient experience</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/clinician">See the clinician overview</Link>
          </Button>
        </div>

        <p className="mt-12 text-xs text-muted-foreground">
          Prototype — blink detection simulated via spacebar for demo purposes
        </p>
      </div>
    </main>
  );
}

function CameraPanel() {
  const [blinks, setBlinks] = useState(3);
  const [ear, setEar] = useState(0.21);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setEar(Number((0.08 + Math.random() * 0.2).toFixed(2)));
      if (Math.random() > 0.72) setBlinks((b) => b + 1);
    }, 900);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
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
      setCameraError(null);
      setCameraOn(true);
    } catch {
      setCameraError("Camera unavailable — showing simulated view.");
    }
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  return (
    <section
      aria-label="Simulated webcam detection preview"
      className="machine-monitor relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-foreground/40 bg-machine-display"
    >
      <video
        ref={videoRef}
        muted
        playsInline
        className={`absolute inset-0 h-full w-full object-cover ${cameraOn ? "opacity-100" : "opacity-0"}`}
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,0.05),transparent_60%)]"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 opacity-[0.15]"
        aria-hidden="true"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      {/* Open camera control */}
      <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={cameraOn ? closeCamera : openCamera}
          className="inline-flex items-center gap-2 rounded-md border border-signal/60 bg-machine-ink/70 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-signal transition-colors hover:bg-machine-ink/90"
        >
          {cameraOn ? <CameraOff className="size-3.5" /> : <Camera className="size-3.5" />}
          {cameraOn ? "Close camera" : "Open camera"}
        </button>
        {cameraError ? <span className="text-[10px] text-amber">{cameraError}</span> : null}
      </div>

      <div className="cam-noise pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[12%] overflow-hidden">
        <div className="cam-scanline h-[2px] w-full bg-signal/40" />
      </div>

      {/* slightly off-centre bounding box */}
      <div
        className="pointer-events-none absolute border border-signal/50"
        style={{ left: "38.5%", top: "17%", width: "27.5%", height: "63%" }}
        aria-hidden="true"
      >
        {[
          "-left-[3px] -top-[3px] border-l-2 border-t-2",
          "-right-[3px] -top-[3px] border-r-2 border-t-2",
          "-left-[3px] -bottom-[3px] border-l-2 border-b-2",
          "-right-[3px] -bottom-[3px] border-r-2 border-b-2",
        ].map((c) => (
          <span key={c} className={`bracket-jitter absolute h-4 w-4 border-signal ${c}`} />
        ))}
      </div>

      {/* landmark cloud */}
      {LANDMARKS.map(([x, y], n) => (
        <span
          key={`${x}-${y}`}
          className="pointer-events-none absolute block h-[3px] w-[3px] rounded-full bg-signal"
          style={{ left: `${x}%`, top: `${y}%`, opacity: 0.4 + ((n * 7) % 5) / 14 }}
          aria-hidden="true"
        />
      ))}
      <span
        className="eye-ping pointer-events-none absolute left-[47.8%] top-[40.3%] block h-2 w-2 rounded-full bg-amber"
        aria-hidden="true"
      />

      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
        <span className="rounded-md bg-signal px-2 py-1 text-signal-foreground">
          Blinks: {blinks}
        </span>
        <span className="rounded-md bg-machine-ink/70 px-2 py-1 text-machine-glow/80">
          EAR: {ear.toFixed(2)}
        </span>
        <span className="rounded-md border-b border-amber bg-machine-ink/70 px-2 py-1 text-amber">
          tracking: good
        </span>
      </div>
    </section>
  );
}

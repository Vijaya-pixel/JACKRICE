import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TACIT — Blink communication demo" },
      {
        name: "description",
        content:
          "TACIT is a blink-driven communication interface for ICU and paralysis patients. Hackathon prototype.",
      },
      { property: "og:title", content: "TACIT — Blink communication demo" },
      {
        property: "og:description",
        content:
          "TACIT is a blink-driven communication interface for ICU and paralysis patients. Hackathon prototype.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  const navigate = Route.useNavigate();
  const [launching, setLaunching] = useState<"/app" | "/how-it-works" | null>(null);

  function launchPage(event: React.MouseEvent<HTMLButtonElement>, destination: "/app" | "/how-it-works") {
    event.preventDefault();
    event.stopPropagation();
    if (launching) return;
    setLaunching(destination);
    window.setTimeout(() => void navigate({ to: destination }), 650);
  }

  return (
    <main className="machine-page flex min-h-svh flex-col bg-background pt-[76px]">
      <SiteHeader />

      <div className="machine-display mx-auto flex w-full max-w-[1500px] flex-1 flex-col px-5 pb-8 pt-10 md:px-8 md:pt-14">
        <section className="page-copy-reveal mx-auto max-w-2xl text-center">
          <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-primary/70" />
            giving voice back
          </p>
          <h1 className="mt-3 font-display text-4xl font-bold leading-[1.08] tracking-tight text-foreground md:text-5xl xl:text-6xl">
            When the body goes silent, the eyes still speak.
          </h1>
          <p className="mx-auto mt-5 max-w-md text-lg leading-relaxed text-muted-foreground">
            A calm, contactless way for ICU and paralysis patients to communicate — no touch, no
            voice, just a blink.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={(event) => launchPage(event, "/app")}
              className={`inline-flex will-change-transform items-center gap-2 rounded-[10px_4px_10px_4px] bg-cta px-7 py-3 text-sm font-semibold uppercase tracking-widest text-cta-foreground transition-[transform,opacity,filter] duration-600 ease-in-out ${launching === "/app" ? "scale-50 opacity-0 blur-sm" : ""}`}
            >
              Try the Prototype
              <span aria-hidden="true">→</span>
            </button>
            <button
              type="button"
              onClick={(event) => launchPage(event, "/how-it-works")}
              className={`inline-flex will-change-transform items-center gap-2 rounded-[3px_12px_3px_12px] border-2 border-foreground/80 px-6 py-[11px] text-sm font-semibold uppercase tracking-widest text-foreground transition-[transform,opacity,filter,background-color,color] duration-600 ease-in-out hover:bg-foreground hover:text-background ${launching === "/how-it-works" ? "scale-50 opacity-0 blur-sm" : ""}`}
            >
              Watch Demo
              <span aria-hidden="true">▶</span>
            </button>
          </div>

          <div className="mt-4 flex items-center justify-center gap-4 text-sm font-medium text-muted-foreground">
            <Link to="/verify" className="underline-offset-4 hover:text-foreground hover:underline">
              Clinician sign-in
            </Link>
          </div>
        </section>
      </div>

      <footer className="machine-footer border-t-2 border-border px-5 py-2.5 md:px-8">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-1 font-mono text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>&gt; note: blink detection simulated in this demo</p>
          <p>build a3f9c2 · MediaPipe · React · WebRTC</p>
        </div>
      </footer>
    </main>
  );
}

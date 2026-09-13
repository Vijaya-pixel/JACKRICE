import { createFileRoute, Link } from "@tanstack/react-router";

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
  { title: "Camera", detail: "Any webcam" },
  { title: "Landmarks", detail: "478 points" },
  { title: "Eye ratio", detail: "Height / width" },
  { title: "Three zones", detail: "Ignore, select, rest" },
  { title: "Scanning", detail: "Frequency ordered letters" },
  { title: "Speech", detail: "Spoken aloud" },
];

function HowItWorksPage() {
  return (
    <main className="machine-page min-h-svh bg-background text-foreground">
      <SiteHeader />

      <div className="page-copy-reveal machine-display mx-auto flex max-w-6xl flex-col justify-center px-6 py-10 md:px-10">
        <p className="inline-flex items-center gap-3 text-base font-medium text-primary">
          <span aria-hidden="true" className="size-3 rounded-full bg-primary/40" />
          How it works
        </p>
        <h1 className="mt-4 font-display text-4xl font-semibold text-primary md:text-6xl">
          Camera to sentence, in six steps
        </h1>

        <ol className="mt-14 grid gap-4 sm:grid-cols-3 lg:grid-cols-6" aria-label="Pipeline steps">
          {STEPS.map((step, index) => (
            <RevealOnView key={step.title} className="h-full">
              <li className="flex h-full min-h-56 flex-col rounded-xl bg-primary/8 p-6">
                <span className="text-lg font-semibold text-primary">{index + 1}</span>
                <h2 className="mt-4 font-display text-2xl font-semibold text-primary">
                  {step.title}
                </h2>
                <p className="mt-auto text-base leading-snug text-primary/85">{step.detail}</p>
              </li>
            </RevealOnView>
          ))}
        </ol>

        <div className="mt-12 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/app">Try it now</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}

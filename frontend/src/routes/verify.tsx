import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BadgeCheck, Camera, Fingerprint, ShieldCheck } from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { setClinicianRole } from "@/lib/role";

export const Route = createFileRoute("/verify")({
  head: () => ({
    meta: [
      { title: "Clinician verification — TACIT" },
      {
        name: "description",
        content:
          "Identity verification step for clinicians before accessing the TACIT clinical overview. Powered by Persona (mocked in this prototype).",
      },
      { property: "og:title", content: "Clinician verification — TACIT" },
      {
        property: "og:description",
        content:
          "Identity verification step for clinicians before accessing the TACIT clinical overview.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VerifyPage,
});

type Stage = "intro" | "checking" | "done";

function VerifyPage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("intro");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (stage === "checking") {
      timerRef.current = window.setTimeout(() => setStage("done"), 2600);
    }
    if (stage === "done") {
      setClinicianRole();
      timerRef.current = window.setTimeout(() => navigate({ to: "/app" }), 1800);
    }
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [stage, navigate]);

  return (
    <main className="machine-page flex min-h-svh flex-col bg-muted/40 pt-[76px]">
      <SiteHeader />

      <div className="machine-display mx-auto flex w-full max-w-[1500px] flex-1 items-center justify-center px-5 py-10 md:px-8">
        <section
          aria-label="Clinician verification"
          className="machine-module w-full max-w-md rounded-xl border-2 border-border bg-card"
        >
          {/* Persona-style card header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ShieldCheck className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-bold leading-tight text-foreground">
                  Verify your identity
                </p>
                <p className="text-xs text-muted-foreground">Required for clinician access</p>
              </div>
            </div>
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              persona
            </span>
          </div>

          <div className="px-6 py-6">
            {stage === "intro" && (
              <>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Before viewing the clinical dashboard, confirm you are a licensed clinician. You
                  will be asked for:
                </p>

                <ul className="mt-4 space-y-3">
                  {[
                    { icon: BadgeCheck, text: "Work email or clinician ID" },
                    { icon: Camera, text: "A quick photo of your ID badge" },
                    { icon: Fingerprint, text: "A short liveness check" },
                  ].map(({ icon: Icon, text }) => (
                    <li key={text} className="flex items-center gap-3 text-sm text-foreground">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      {text}
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  onClick={() => setStage("checking")}
                  className="mt-6 w-full rounded-lg bg-signal px-5 py-3 text-sm font-semibold uppercase tracking-widest text-signal-foreground transition-colors hover:bg-signal/85"
                >
                  Begin verification
                </button>
              </>
            )}

            {stage === "checking" && (
              <div className="py-6 text-center">
                <span
                  className="mx-auto block h-10 w-10 animate-spin rounded-full border-[3px] border-signal border-t-transparent"
                  aria-hidden="true"
                />
                <p className="mt-4 text-sm font-semibold text-foreground">Verifying credentials…</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  checking license_registry · nhs_trust=mock
                </p>
              </div>
            )}

            {stage === "done" && (
              <div className="py-6 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/20">
                  <BadgeCheck className="h-6 w-6 text-success" aria-hidden="true" />
                </span>
                <p className="mt-3 text-sm font-semibold text-foreground">Verification passed</p>
                <p className="mt-1 text-xs text-muted-foreground">Opening the patient session…</p>
              </div>
            )}
          </div>

          <div className="border-t border-border px-6 py-3">
            <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
              &gt; prototype note: persona verification is simulated — no identity data is collected
              or checked.
            </p>
          </div>
        </section>
      </div>

      <footer className="border-t-2 border-border px-5 py-2.5 text-center md:px-8">
        <p className="text-[11px] text-muted-foreground">
          <Link to="/" className="underline-offset-4 hover:underline">
            ← Back to home
          </Link>
        </p>
      </footer>
    </main>
  );
}

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { useRole } from "@/lib/role";
import { useIsElectron } from "@/lib/tacit-api";

/**
 * Prototype role gate: everything behind it is clinician-only.
 * The clinician role is set by the simulated Persona check on /verify.
 *
 * Skipped entirely inside the real Electron app: the desktop build is set up
 * bedside by a clinician who already has physical access to the device, so a
 * simulated identity check adds friction (and a multi-second fake
 * "verifying credentials" delay) with no real security benefit there. It's
 * only meaningful for the public web demo, where anyone can land on /app or
 * /clinician directly.
 */
export function RoleGate({ children }: { children: ReactNode }) {
  const electron = useIsElectron();
  const { role, ready } = useRole();

  if (electron) return <>{children}</>;

  if (!ready) {
    return (
      <main className="machine-page min-h-svh bg-background pt-[76px]">
        <SiteHeader />
      </main>
    );
  }

  if (role !== "clinician") {
    return (
      <main className="machine-page flex min-h-svh flex-col bg-muted/40 pt-[76px]">
        <SiteHeader />
        <div className="machine-display machine-auth-display mx-auto flex w-full max-w-[1500px] flex-1 items-center justify-center px-5 py-10 md:px-8">
          <section className="machine-module w-full max-w-md rounded-xl border-2 border-border bg-card p-6 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-lg font-bold text-foreground">Clinician sign-in required</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              TACIT is set up by a clinician at the bedside. Confirm your clinician identity to open
              the patient session and the clinical overview.
            </p>
            <Link
              to="/verify"
              className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-signal px-5 py-3 text-sm font-semibold uppercase tracking-widest text-signal-foreground transition-colors hover:bg-signal/85"
            >
              Verify as clinician
            </Link>
            <p className="mt-4 font-mono text-[10px] text-muted-foreground">
              &gt; prototype note: verification is simulated — no identity data is collected.
            </p>
          </section>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

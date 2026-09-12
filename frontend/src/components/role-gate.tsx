import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { useRole } from "@/lib/role";

/**
 * Prototype role gate: everything behind it is clinician-only.
 * The clinician role is set by the simulated Persona check on /verify.
 */
export function RoleGate({ children }: { children: ReactNode }) {
  const { role, ready } = useRole();

  if (!ready) {
    return (
      <main className="min-h-svh bg-background pt-16">
        <SiteHeader />
      </main>
    );
  }

  if (role !== "clinician") {
    return (
      <main className="flex min-h-svh flex-col bg-muted/40 pt-16">
        <SiteHeader />
        <div className="mx-auto flex w-full max-w-[1500px] flex-1 items-center justify-center px-5 py-10 md:px-8">
          <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-lg font-bold text-foreground">Clinician sign-in required</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              TACIT is set up by a clinician at the bedside. Confirm your clinician
              identity to open the patient session and the clinical overview.
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

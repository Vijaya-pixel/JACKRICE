import { createFileRoute } from "@tanstack/react-router";

import { ClinicianView } from "@/components/clinician-view";
import { RoleGate } from "@/components/role-gate";
import { SiteHeader } from "@/components/site-header";
import { useIsElectron } from "@/lib/tacit-api";

export const Route = createFileRoute("/clinician")({
  head: () => ({
    meta: [
      { title: "Clinician overview — TACIT" },
      {
        name: "description",
        content:
          "Simulated blink-signal monitoring, calibration values and session metrics for clinicians.",
      },
      { property: "og:title", content: "Clinician overview — TACIT" },
      {
        property: "og:description",
        content:
          "Simulated blink-signal monitoring, calibration values and session metrics for clinicians.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ClinicianPage,
});

function ClinicianPage() {
  const electron = useIsElectron();
  return (
    <RoleGate>
      <main className="machine-page min-h-svh bg-background text-foreground">
        <SiteHeader />
        <div className="machine-display stage-enter">
          <ClinicianView />
        </div>
        <footer className="border-t border-border/70 px-4 py-3 text-center text-xs text-muted-foreground">
          {electron
            ? "Live signal from the desktop app's camera"
            : "Browser preview — blink detection simulated via spacebar for demo purposes"}
        </footer>
      </main>
    </RoleGate>
  );
}

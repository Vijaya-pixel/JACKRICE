import { Link, useNavigate } from "@tanstack/react-router";
import { Power } from "lucide-react";
import { useState } from "react";

import { clearRole, useRole } from "@/lib/role";

const LEFT_NAV = [
  { to: "/", label: "Home", short: "Home" },
  { to: "/how-it-works", label: "How it works", short: "How" },
] as const;

const RIGHT_NAV = [
  { to: "/app", label: "Patient session", short: "Patient" },
] as const;

const baseLink =
  "machine-nav-link relative rounded-md px-4 py-2 text-sm font-semibold text-machine-ink/70 transition-[transform,opacity,box-shadow,color] duration-300 ease-out hover:-translate-y-1 hover:scale-[1.03] hover:text-machine-ink hover:shadow-lg active:translate-y-0 active:scale-[0.98] active:shadow-md after:absolute after:inset-x-3 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors";

const activeLink = "!text-machine-ink after:!bg-machine-cyan";

export function SiteHeader() {
  const navigate = useNavigate();
  const { role } = useRole();
  const [signingOut, setSigningOut] = useState(false);
  const rightItems = role === "clinician"
    ? [...RIGHT_NAV, { to: "/clinician", label: "Clinician overview", short: "Clinician" }]
    : RIGHT_NAV;

  const signOut = () => {
    if (signingOut) return;
    setSigningOut(true);
    window.setTimeout(() => {
      clearRole();
      navigate({ to: "/", replace: true });
    }, 700);
  };

  return (
    <header className="machine-header fixed inset-x-0 top-0 z-40">
      <div className="mx-auto flex h-[76px] max-w-[1500px] items-center justify-between gap-4 px-5 md:px-8">
        <nav
          aria-label="Primary"
          className="machine-nav-left hidden items-center justify-start gap-2 md:flex"
        >
          {LEFT_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={baseLink}
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{ className: activeLink, "aria-current": "page" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <Link to="/" aria-label="TACIT home" className="machine-nav-center flex items-center justify-center">
          <span className="font-logo text-3xl font-bold tracking-tight text-machine-ink">
            TACIT
          </span>
        </Link>

        <div className="machine-nav-right-group flex min-w-0 items-center justify-end gap-2">
          <nav
            aria-label="Session"
            className="machine-nav-right hidden items-center justify-end gap-2 md:flex"
          >
            {rightItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-md px-2 py-1.5 text-xs font-semibold text-machine-ink/75"
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{
                  className: "!text-machine-ink underline decoration-machine-cyan underline-offset-4",
                }}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {role === "clinician" ? (
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className={`machine-power flex shrink-0 items-center gap-1.5 rounded-md border border-machine-ink/25 px-3 py-1.5 text-xs font-semibold text-machine-ink transition-all duration-700 ease-in-out hover:border-destructive hover:bg-destructive hover:text-destructive-foreground ${signingOut ? "scale-50 opacity-0 blur-sm shadow-none" : ""}`}
            >
              <Power className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          ) : (
            <span className="hidden w-16 md:block" aria-hidden="true" />
          )}
        </div>
      </div>
      <div className="machine-sensors" aria-hidden="true">
        <span className="machine-lens" />
        <span className="machine-led machine-led-ready" />
        <span className="machine-led machine-led-warn" />
        <span className="machine-status">SYSTEM ACTIVE · SIGNAL READY</span>
      </div>
      <div className="machine-vents" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </header>
  );
}

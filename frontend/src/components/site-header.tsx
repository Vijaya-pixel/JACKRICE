import { Link } from "@tanstack/react-router";

import logoAsset from "@/assets/tacit-logo-v3-white.png.asset.json";

const NAV = [
  { to: "/", label: "Home", short: "Home" },
  { to: "/how-it-works", label: "How it works", short: "How" },
  { to: "/app", label: "Patient session", short: "Patient" },
  { to: "/clinician", label: "Clinician overview", short: "Clinician" },
] as const;

const baseLink =
  "relative rounded-md px-4 py-2 text-sm font-semibold text-white/80 transition-colors hover:text-white after:absolute after:inset-x-3 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors";

const activeLink = "!text-white after:!bg-white";

export function SiteHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 bg-[#16283a]">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-4 px-5 md:px-8">
        <Link to="/" aria-label="TACIT home" className="flex items-center">
          <img
            src={logoAsset.url}
            alt="TACIT"
            className="h-10 w-auto object-contain"
            width="172"
            height="40"
          />
        </Link>

        <nav
          aria-label="Main"
          className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-2 md:flex"
        >
          {NAV.map((item) => (
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

        <nav aria-label="Main" className="flex items-center gap-1 md:hidden">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-md px-2 py-1.5 text-xs font-semibold text-white/80"
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{ className: "!text-white underline underline-offset-4" }}
            >
              {item.short}
            </Link>
          ))}
        </nav>

        <span className="hidden w-16 md:block" aria-hidden="true" />
      </div>
    </header>
  );
}

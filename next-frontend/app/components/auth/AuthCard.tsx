import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { Download, MonitorPlay, ShieldCheck, Tv } from "lucide-react";

const FEATURES = [
  {
    Icon: Download,
    title: "Download anything",
    description: "HTTP links, magnets and torrents — straight to a worker or MEGA.",
  },
  {
    Icon: MonitorPlay,
    title: "Stream while it downloads",
    description: "Built-in HLS player with subtitles, chapters and resume.",
  },
  {
    Icon: Tv,
    title: "Cast to your TV",
    description: "Pair Android TV and control every worker from one workspace.",
  },
] as const;

/**
 * Full-page split-screen shell for the sign-in and registration pages.
 *
 * The brand panel is purely decorative and hidden below `lg`; the form column
 * keeps a comfortable reading width on every screen size. The component stays
 * a server component so it can use `next/image` without extra client weight.
 */
export function AuthCard({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="h-full w-full overflow-y-auto bg-background">
      <div className="grid min-h-full w-full lg:grid-cols-[1.05fr_1fr]">
        {/* ── Brand / marketing panel ───────────────────────────────── */}
        <aside className="relative hidden overflow-hidden bg-slate-950 lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-14">
          {/* Colour wash */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(37,99,235,0.38),transparent_55%),radial-gradient(circle_at_82%_92%,rgba(6,182,212,0.24),transparent_52%)]"
          />
          {/* Grid lines, faded toward the bottom */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.055)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.055)_1px,transparent_1px)] bg-[size:52px_52px] [mask-image:radial-gradient(ellipse_at_35%_25%,black_25%,transparent_78%)]"
          />
          {/* Soft glow orbs */}
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 top-1/3 h-64 w-64 rounded-full bg-blue-500/20 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-24 right-0 h-72 w-72 rounded-full bg-cyan-400/15 blur-3xl"
          />

          {/* Logo */}
          <Link href="/" className="relative flex items-center gap-3 self-start">
            <Image
              src="/app-icon.png"
              alt=""
              width={44}
              height={44}
              className="rounded-xl ring-1 ring-white/15"
            />
            <span className="flex flex-col leading-tight">
              <span className="text-lg font-bold tracking-tight text-white">
                StreamLift
              </span>
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">
                Download manager
              </span>
            </span>
          </Link>

          {/* Headline + features */}
          <div className="relative max-w-md">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-sky-200/90">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
              Your media workspace
            </p>

            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-white xl:text-[2.9rem]">
              Download it.
              <br />
              Stream it.{" "}
              <span className="bg-gradient-to-r from-sky-300 via-blue-300 to-cyan-200 bg-clip-text text-transparent">
                Own it.
              </span>
            </h1>

            <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/55">
              One place for every download, every worker and every screen in
              your house.
            </p>

            <ul className="mt-9 space-y-3">
              {FEATURES.map(({ Icon, title: featureTitle, description }) => (
                <li
                  key={featureTitle}
                  className="flex items-start gap-3.5 rounded-xl border border-white/[0.07] bg-white/[0.035] p-3.5 backdrop-blur-sm"
                >
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/25 to-cyan-400/10 text-sky-300 ring-1 ring-white/10">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-white/90">
                      {featureTitle}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-white/45">
                      {description}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Trust line */}
          <div className="relative flex items-center gap-2 text-xs text-white/40">
            <ShieldCheck className="h-4 w-4 text-emerald-300/70" />
            Private by default — your workspace and devices stay yours.
          </div>
        </aside>

        {/* ── Form panel ────────────────────────────────────────────── */}
        <section className="relative flex min-h-full flex-col justify-center bg-gradient-to-b from-background via-background to-muted/50 px-5 py-10 sm:px-8 lg:px-12">
          <div className="mx-auto w-full max-w-[26rem]">
            {/* Mobile logo (the brand panel is hidden below lg) */}
            <Link
              href="/"
              className="mb-8 inline-flex items-center gap-2.5 lg:hidden"
            >
              <Image
                src="/app-icon.png"
                alt=""
                width={38}
                height={38}
                className="rounded-xl"
              />
              <span className="text-lg font-bold tracking-tight">StreamLift</span>
            </Link>

            <div className="animate-in fade-in-0 slide-in-from-bottom-4 duration-500">
              {eyebrow ? (
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-600">
                  {eyebrow}
                </p>
              ) : null}

              <h1 className="mt-2 text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
                {title}
              </h1>

              {subtitle ? (
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {subtitle}
                </p>
              ) : null}

              <div className="mt-7 rounded-2xl border bg-card/80 p-6 shadow-xl shadow-slate-950/5 backdrop-blur-sm sm:p-7">
                {children}
              </div>

              {footer ? <div className="mt-6">{footer}</div> : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

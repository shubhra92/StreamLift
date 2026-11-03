"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Image from "next/image";
import {
  Download,
  MonitorPlay,
  Cpu,
  ChevronDown,
  UserPlus,
  LogIn,
  LogOut,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getCurrentSession, type CurrentSession } from "@/app/lib/idb/workspaceGuard";

function useSessionInfo() {
  const [session, setSession] = useState<CurrentSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCurrentSession().then((value) => {
      if (!cancelled) setSession(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return session;
}

const NAV_LINKS = [
  { href: "/watch",   label: "Watch",     Icon: MonitorPlay },
  { href: "/",        label: "Downloads", Icon: Download    },
  { href: "/workers", label: "Workers",   Icon: Cpu         },
] as const;

/** Returns the first letter of the email (uppercase), or null for guests. */
function emailInitial(session: CurrentSession): string | null {
  if (!session.isRegistered || !session.email) return null;
  return session.email[0].toUpperCase();
}

export function Navigation() {
  const pathname = usePathname();
  const session = useSessionInfo();
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const desktopAccountRef = useRef<HTMLDivElement>(null);
  const mobileAccountRef = useRef<HTMLDivElement>(null);

  const active =
    NAV_LINKS.find((l) => l.href === pathname) ??
    NAV_LINKS.find((l) => l.href === "/") ??
    NAV_LINKS[0];

  // Close the mobile nav menu on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close the account menu on outside click. The desktop and mobile menus are
  // both mounted (one hidden via CSS), so check both refs — a single shared ref
  // would point at the hidden copy and close the menu before its buttons fire.
  useEffect(() => {
    if (!accountOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !desktopAccountRef.current?.contains(target) &&
        !mobileAccountRef.current?.contains(target)
      ) {
        setAccountOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [accountOpen]);

  async function handleSignOut() {
    setAccountOpen(false);
    setOpen(false);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Ignore network failures; clearing the cookie is what matters.
    }
    window.location.assign("/");
  }

  const initial = session ? emailInitial(session) : null;

  // Auth pages own the whole viewport — no top navigation there.
  if (pathname === "/login" || pathname === "/register") return null;

  return (
    <nav className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-4xl mx-auto px-4 md:px-6">
        <div className="flex items-center h-16 gap-4">

          {/* ── Logo (always left) ── */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <Image
              src="/app-icon.png"
              alt="StreamLift"
              width={32}
              height={32}
              className="rounded-lg"
            />
            {/* Hide the app name on mobile; show on sm+ */}
            <span className="hidden sm:block text-xl font-bold">StreamLift</span>
          </Link>

          {/* ── Desktop right group: nav links + account (sm+) ── */}
          <div className="hidden sm:flex items-center gap-1 ml-auto">
            {NAV_LINKS.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                  pathname === href
                    ? "bg-blue-600 text-white"
                    : "hover:bg-accent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </Link>
            ))}

            {/* Divider */}
            <div className="w-px h-5 bg-border mx-1" />

            {/* Account */}
            {session === null ? (
              <div className="w-8 h-8" />
            ) : session.isRegistered && initial ? (
              <div ref={desktopAccountRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAccountOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={accountOpen}
                  title={`Signed in as ${session.email}`}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors"
                >
                  {initial}
                </button>

                {accountOpen && (
                  <div className="absolute right-0 top-full mt-2 w-56 rounded-lg border bg-popover shadow-lg z-50 py-1 overflow-hidden">
                    <div className="px-3 py-2 border-b">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Signed in</p>
                      <p className="mt-0.5 truncate text-xs text-foreground">{session.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm transition-colors hover:bg-accent"
                    >
                      <LogOut className="h-4 w-4" />
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Link
                href="/login"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <LogIn className="h-4 w-4" />
                Log in
              </Link>
            )}
          </div>

          {/* ── Mobile (< sm): nav dropdown left-of-center, account/login far right ── */}

          {/* Nav dropdown — sits right after the logo */}
          <div ref={dropdownRef} className="relative flex sm:hidden">
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium"
            >
              <active.Icon className="h-4 w-4" />
              <span>{active.label}</span>
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              />
            </button>

            {open && (
              <div className="absolute left-0 top-full mt-1 w-48 rounded-lg border bg-popover shadow-lg z-50 py-1 overflow-hidden">
                {NAV_LINKS.map(({ href, label, Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    className={`flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors ${
                      pathname === href
                        ? "bg-blue-600 text-white"
                        : "hover:bg-accent text-foreground"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Account / login — pushed to the far right */}
          <div className="flex sm:hidden items-center ml-auto">
            {session !== null && (
              session.isRegistered && initial ? (
                <div ref={mobileAccountRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setAccountOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={accountOpen}
                    title={`Signed in as ${session.email}`}
                    className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors"
                  >
                    {initial}
                  </button>

                  {accountOpen && (
                    <div className="absolute right-0 top-full mt-2 w-56 rounded-lg border bg-popover shadow-lg z-50 py-1 overflow-hidden">
                      <div className="px-3 py-2 border-b">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Signed in</p>
                        <p className="mt-0.5 truncate text-xs text-foreground">{session.email}</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleSignOut}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm transition-colors hover:bg-accent"
                      >
                        <LogOut className="h-4 w-4" />
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  href="/login"
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <LogIn className="h-4 w-4" />
                  Log in
                </Link>
              )
            )}
          </div>

        </div>
      </div>
    </nav>
  );
}

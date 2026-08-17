"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Download, Magnet, Cpu, User, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getCurrentGuest } from "@/app/lib/idb/guestGuard";

function useGuestInfo() {
  const [shortId, setShortId] = useState<string | null>(null);

  useEffect(() => {
    void getCurrentGuest().then((guest) => setShortId(guest?.shortId ?? null));
  }, []);

  return shortId;
}

const NAV_LINKS = [
  { href: "/",        label: "HTTP Downloads", short: "HTTP",    Icon: Download },
  { href: "/torrents",label: "Torrents",        short: "Torrent", Icon: Magnet   },
  { href: "/workers", label: "Workers",         short: "Workers", Icon: Cpu      },
] as const;

export function Navigation() {
  const pathname = usePathname();
  const guestShortId = useGuestInfo();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const active = NAV_LINKS.find((l) => l.href === pathname) ?? NAV_LINKS[0];

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <nav className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-4xl mx-auto px-4 md:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">StreamLift</h1>
          </div>

          {/* ── Desktop nav (sm+) ── */}
          <div className="hidden sm:flex items-center gap-1">
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

            {guestShortId && (
              <div
                title={`Guest session: ${guestShortId}`}
                className="flex items-center gap-1.5 ml-2 px-3 py-1.5 rounded-full bg-muted text-muted-foreground text-xs border"
              >
                <User className="h-3 w-3" />
                <span className="font-mono">{guestShortId}</span>
              </div>
            )}
          </div>

          {/* ── Mobile nav (< sm) ── */}
          <div className="flex sm:hidden items-center gap-2">
            {guestShortId && (
              <div
                title={`Guest session: ${guestShortId}`}
                className="flex items-center gap-1 px-2 py-1 rounded-full bg-muted text-muted-foreground text-xs border"
              >
                <User className="h-3 w-3" />
                <span className="font-mono">{guestShortId}</span>
              </div>
            )}

            {/* Dropdown trigger */}
            <div ref={dropdownRef} className="relative">
              <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium"
              >
                <active.Icon className="h-4 w-4" />
                <span>{active.short}</span>
                <ChevronDown
                  className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                />
              </button>

              {/* Dropdown menu */}
              {open && (
                <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border bg-popover shadow-lg z-50 py-1 overflow-hidden">
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
          </div>
        </div>
      </div>
    </nav>
  );
}

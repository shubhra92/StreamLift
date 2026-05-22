"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Download, Magnet } from "lucide-react";

export function Navigation() {
  const pathname = usePathname();

  const isActive = (path: string) => pathname === path;

  return (
    <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-4xl mx-auto px-4 md:px-6">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">StreamLift</h1>
          </div>
          
          <div className="flex gap-1">
            <Link
              href="/"
              className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                isActive("/")
                  ? "bg-blue-600 text-white"
                  : "hover:bg-accent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">HTTP Downloads</span>
              <span className="sm:hidden">HTTP</span>
            </Link>
            
            <Link
              href="/torrents"
              className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                isActive("/torrents")
                  ? "bg-blue-600 text-white"
                  : "hover:bg-accent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Magnet className="h-4 w-4" />
              <span className="hidden sm:inline">Torrents</span>
              <span className="sm:hidden">Torrent</span>
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}

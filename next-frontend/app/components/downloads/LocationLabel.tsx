"use client";

import { useEffect, useState } from "react";
import { resolveLocationLabel } from "@/app/lib/resolveLocationLabel";
import { Badge } from "@/components/ui/badge";

export function LocationLabel({ location }: { location: string | null | undefined }) {
  const [label, setLabel] = useState<string | null>(() => {
    if (!location) return "—";
    if (location === "server") return "Cloud (Server)";
    if (location === "cloud" || location === "mega") return "Cloud";
    if (location === "all-workers") return "All Workers";
    if (location.startsWith("worker-")) return "Worker…";
    return location;
  });

  useEffect(() => {
    let cancelled = false;
    resolveLocationLabel(location).then((resolved) => {
      if (!cancelled) setLabel(resolved);
    });
    return () => { cancelled = true; };
  }, [location]);

  return <span>{label ?? <>Worker: <Badge className="bg-red-100 text-red-800">deleted</Badge></>}</span>;
}

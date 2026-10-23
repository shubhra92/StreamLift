"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTvDevices } from "../lib/tvClient";
import type { TvDeviceSummary } from "../lib/tvTypes";

const POLL_MS = 30_000;

/**
 * Paired TVs for the current web guest, refreshed periodically so the
 * "Connect to TV" button can show an online indicator and the dialog stays
 * current while open.
 */
export function useTvDevices() {
  const [devices, setDevices] = useState<TvDeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await fetchTvDevices();
      setDevices(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load connected TVs");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { devices, loading, error, refresh };
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { getWatchItems } from "../actions/watchItems";
import type { WatchItemDto } from "../lib/watchTypes";

/**
 * Load the saved Watch items for this workspace.
 *
 * Kept separate from `useWatchMedia` because these rows come from Postgres and
 * are independent of worker availability. Refresh on focus so an item added in
 * another tab shows up without a reload.
 */
export function useWatchItems() {
  const [items, setItems] = useState<WatchItemDto[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await getWatchItems();
      setItems(rows);
    } catch {
      // Leave the last good list in place; the page still shows the offline banner.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  return { items, loading, refresh };
}

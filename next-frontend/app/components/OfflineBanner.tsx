"use client";

/**
 * OfflineBanner
 *
 * Shows a non-intrusive banner when the network is offline.
 * Animates in/out — shows stale data message so user knows what they see
 * is from the local IndexedDB cache.
 */

import { motion, AnimatePresence } from "motion/react";
import type { NetworkStatus } from "@/app/lib/idb/SyncManager";

interface Props {
  networkStatus: NetworkStatus;
}

export function OfflineBanner({ networkStatus }: Props) {
  return (
    <AnimatePresence>
      {networkStatus === "offline" && (
        <motion.div
          key="offline-banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          className="flex items-center gap-2 px-3 py-2 mb-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 text-yellow-400 text-sm"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 shrink-0" aria-hidden="true" />
          You&apos;re offline — showing cached data. Changes will sync when you reconnect.
        </motion.div>
      )}
    </AnimatePresence>
  );
}

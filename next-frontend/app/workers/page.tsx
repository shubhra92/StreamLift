"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { WorkerList } from "../components/workers/WorkerList";
import { WorkerDetails } from "../components/workers/WorkerDetails";
import { AddWorkerModal } from "../components/workers/AddWorkerModal";
import { useWorkerStatus } from "../hooks/useWorkerStatus";
import { useWorkers } from "../hooks/useWorkers";
import { createWorker, deleteWorker } from "../actions/workers";
import { OfflineBanner } from "../components/OfflineBanner";
import WorkerClient from "../lib/sync-worker/workerClient";
import type { WorkerWithStatus } from "../components/workers/types";
import type { CreateWorkerData } from "../service/workerService";
import useWorkerService from "../service/workerService";
import type { IDBWorker } from "../lib/idb/schema";

/** Convert IDB row → WorkerWithStatus (string dates → Date objects, runtime fields preserved) */
function toWorkerWithStatus(w: IDBWorker): WorkerWithStatus {
  return {
    ...w,
    createdAt:          w.createdAt ? new Date(w.createdAt) : null,
    updatedAt:          w.updatedAt ? new Date(w.updatedAt) : null,
    lastHeartbeat:      w.lastHeartbeat ?? null,
    sessionTokenExpiry: null,  // not needed on client — only used server-side
    totalUptime:        0,     // DB column removed — fallback to SSE uptime
  };
}

export default function WorkersPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const contentRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // ── IDB-backed data + sync ────────────────────────────────────────────────
  const { workers: idbWorkers, networkStatus, syncNow } = useWorkers();
  const [workers, setWorkers] = useState<WorkerWithStatus[]>([]);

  // Keep workers list in sync with IDB data
  useEffect(() => {
    setWorkers(idbWorkers.map(toWorkerWithStatus));
  }, [idbWorkers]);

  const workerService = useWorkerService();
  const { status: workerStatus } = useWorkerStatus(selectedId);

  // Patch selected worker with live status from SSE
  useEffect(() => {
    if (!selectedId || !workerStatus) return;
    setWorkers((prev) =>
      prev.map((w) =>
        w.id === selectedId
          ? {
              ...w,
              online:        workerStatus.online,
              lastHeartbeat: workerStatus.lastHeartbeat,
            }
          : w
      )
    );
  }, [selectedId, workerStatus]);

  const handleCreateWorker = async (data: CreateWorkerData) => {
    setLoading(true);
    try {
      const result = await createWorker(data);
      if (result.success) {
        setIsModalOpen(false);
        // Invalidate location label cache so new worker name appears immediately
        const { invalidateWorkerNameCache } = await import("../lib/resolveLocationLabel");
        invalidateWorkerNameCache();
        syncNow();
      } else {
        alert(result.message ?? "Failed to create worker");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteWorker = async (workerId: string) => {
    setDeletingIds((prev) => new Set(prev).add(workerId));
    try {
      const result = await deleteWorker(workerId);
      if (result.success) {
        if (selectedId === workerId) setSelectedId(null);
        const { invalidateWorkerNameCache } = await import("../lib/resolveLocationLabel");
        invalidateWorkerNameCache();
        await WorkerClient.getInstance().deleteWorker(workerId);
        syncNow();
      } else {
        alert(result.message ?? "Failed to delete worker");
      }
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(workerId);
        return next;
      });
    }
  };

  const handleCopyScript = async (workerId: string) => {
    const result = await workerService.getWorkerScript(workerId);
    if (!result.success) {
      alert(result.message ?? "Failed to generate script");
      return;
    }
    try {
      await navigator.clipboard.writeText(result.script);
      alert(
        "Worker script copied to clipboard.\n\n⚠️  Keep this script private — it contains your worker credentials."
      );
    } catch {
      alert("Could not copy to clipboard. Please copy the script manually.");
    }
  };

  const selectedWorker = workers.find((w) => w.id === selectedId) ?? null;

  // Close panel on outside click
  useEffect(() => {
    if (!selectedId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!contentRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setSelectedId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedId]);

  return (
    <main className="flex h-full flex-col bg-background">
      {/* Row 2 (mid, scrollable): page header + banner + worker list — scroll together */}
      <div className="flex-1 min-h-0 overflow-y-auto w-full">
        <div ref={contentRef} className="max-w-5xl mx-auto px-4 md:px-6 pt-4 md:pt-6">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4"
          >
            <div>
              <h2 className="text-xl md:text-2xl font-bold">Workers</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage remote Google Colab workers for distributed downloads
              </p>
            </div>
            <Button
              onClick={() => setIsModalOpen(true)}
              className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 py-2 cursor-pointer"
            >
              + Create Worker
            </Button>
          </motion.div>

          <OfflineBanner networkStatus={networkStatus} />

          <div className="h-4 md:h-6" />

          <WorkerList
            workers={workers}
            selectedId={selectedId}
            deletingIds={deletingIds}
            onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            onDelete={handleDeleteWorker}
            onCopyScript={handleCopyScript}
          />
          <div className="h-4 md:h-6" />
        </div>
      </div>

      {/* Row 3 (bottom, dynamic): worker detail — only when a worker is selected */}
      <div className="shrink-0">
        <AnimatePresence>
          {selectedWorker && (
            <motion.div
              key="worker-details-row"
              ref={panelRef}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
              className="overflow-hidden"
            >
              <WorkerDetails
                worker={selectedWorker}
                status={workerStatus}
                onClose={() => setSelectedId(null)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AddWorkerModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleCreateWorker}
        loading={loading}
      />
    </main>
  );
}

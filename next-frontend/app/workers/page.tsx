"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
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

/** Convert IDB row → WorkerWithStatus (string dates → Date objects) */
function toWorkerWithStatus(w: IDBWorker): WorkerWithStatus {
  return {
    ...w,
    createdAt: w.createdAt ? new Date(w.createdAt) : null,
    updatedAt: w.updatedAt ? new Date(w.updatedAt) : null,
  };
}

export default function WorkersPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);

  // ── IDB-backed data + sync ────────────────────────────────────────────────
  const { workers: idbWorkers, networkStatus, syncNow } = useWorkers();
  const [workers, setWorkers] = useState<WorkerWithStatus[]>([]);

  // Keep workers list in sync with IDB data
  useEffect(() => {
    setWorkers(idbWorkers.map(toWorkerWithStatus));
  }, [idbWorkers]);

  const workerService = useWorkerService();
  const { status: workerStatus } = useWorkerStatus(selectedId);

  // Option A: when SSE fires for the selected worker, patch that entry in the
  // list immediately — no waiting for the next 15s sync cycle.
  useEffect(() => {
    if (!selectedId || !workerStatus) return;
    setWorkers((prev) =>
      prev.map((w) =>
        w.id === selectedId
          ? {
              ...w,
              online:        workerStatus.online,
              ipAddress:     workerStatus.ipAddress,
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
    setDeletingId(workerId);
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
      setDeletingId(null);
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

  // Dynamic spacer height
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPanelHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedId]);

  // Close panel on outside click
  useEffect(() => {
    if (!selectedId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!listRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setSelectedId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedId]);

  return (
    <main className="bg-background p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6"
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

        <div ref={listRef}>
          <WorkerList
            workers={workers}
            selectedId={selectedId}
            deletingId={deletingId}
            onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            onDelete={handleDeleteWorker}
            onCopyScript={handleCopyScript}
          />
        </div>

        <WorkerDetails
          worker={selectedWorker}
          status={workerStatus}
          onClose={() => setSelectedId(null)}
          panelRef={panelRef}
        />

        {selectedId && <div style={{ height: panelHeight }} className="shrink-0" aria-hidden="true" />}
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

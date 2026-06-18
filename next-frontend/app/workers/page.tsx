"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { WorkerList } from "../components/workers/WorkerList";
import { WorkerDetails } from "../components/workers/WorkerDetails";
import { AddWorkerModal } from "../components/workers/AddWorkerModal";
import { useWorkerStatus } from "../hooks/useWorkerStatus";
import useWorkerService from "../service/workerService";
import type { CreateWorkerData } from "../service/workerService";
import type { WorkerWithStatus } from "../components/workers/types";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerWithStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const workerService = useWorkerService();
  const { status: workerStatus } = useWorkerStatus(selectedId);

  const fetchWorkers = useCallback(async () => {
    const result = await workerService.getWorkers();
    if (result.success) {
      setWorkers(result.data ?? []);
      setFetchError(null);
    } else {
      setFetchError(result.message ?? "Failed to load workers");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchWorkers();
    // Refresh list every 15s so online status stays current
    const interval = setInterval(fetchWorkers, 15000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateWorker = async (data: CreateWorkerData) => {
    setLoading(true);
    try {
      const result = await workerService.createWorker(data);
      if (result.success) {
        setIsModalOpen(false);
        await fetchWorkers();
      } else {
        alert(result.message ?? "Failed to create worker");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteWorker = async (workerId: string) => {
    const result = await workerService.deleteWorker(workerId);
    if (result.success) {
      if (selectedId === workerId) setSelectedId(null);
      await fetchWorkers();
    } else {
      alert(result.message ?? "Failed to delete worker");
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

  return (
    <main className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
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

        {fetchError && (
          <p className="text-sm text-destructive mb-4">{fetchError}</p>
        )}

        {/* Worker List */}
        <WorkerList
          workers={workers}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
          onDelete={handleDeleteWorker}
          onCopyScript={handleCopyScript}
        />

        {/* Worker Details */}
        {selectedWorker && (
          <WorkerDetails
            worker={selectedWorker}
            status={workerStatus}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {/* Create Worker Modal */}
      <AddWorkerModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleCreateWorker}
        loading={loading}
      />
    </main>
  );
}

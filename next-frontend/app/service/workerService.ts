"use client";

export interface CreateWorkerData {
  name: string;
  downloadLocation: "local" | "mega";
  computeType: "low" | "medium" | "high";
  pinggyToken: string;
  megaEmail?: string;
  megaPassword?: string;
}

export default function useWorkerService() {
  const createWorker = async (data: CreateWorkerData) => {
    try {
      const res = await fetch("/api/worker/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      return result;
    } catch (err: any) {
      return { success: false, message: err?.message ?? "Network error" };
    }
  };

  const getWorkers = async () => {
    try {
      const res = await fetch("/api/worker/list");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: any) {
      return { success: false, message: err?.message ?? "Network error" };
    }
  };

  const getWorkerById = async (workerId: string) => {
    try {
      const res = await fetch(`/api/worker/${workerId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: any) {
      return { success: false, message: err?.message ?? "Network error" };
    }
  };

  const deleteWorker = async (workerId: string) => {
    try {
      const res = await fetch(`/api/worker/${workerId}`, { method: "DELETE" });
      return await res.json();
    } catch (err: any) {
      return { success: false, message: err?.message ?? "Network error" };
    }
  };

  const getWorkerScript = async (workerId: string) => {
    try {
      const res = await fetch(`/api/worker/${workerId}/script`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: any) {
      return { success: false, message: err?.message ?? "Network error" };
    }
  };

  return { createWorker, getWorkers, getWorkerById, deleteWorker, getWorkerScript };
}

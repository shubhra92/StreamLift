"use client";

import type { TvDeviceSummary } from "./tvTypes";

export interface ApproveTvCodeResult {
  device: { id: string; name: string; model: string | null; appVersion: string | null };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchTvDevices(): Promise<TvDeviceSummary[]> {
  const res = await fetch("/api/tv/devices", { cache: "no-store" });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(typeof data.message === "string" ? data.message : "Could not load connected TVs");
  }
  return Array.isArray(data.devices) ? (data.devices as TvDeviceSummary[]) : [];
}

export async function approveTvCode(code: string): Promise<ApproveTvCodeResult> {
  const res = await fetch("/api/tv/pair/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(typeof data.message === "string" ? data.message : "Could not connect this TV");
  }
  return { device: data.device as ApproveTvCodeResult["device"] };
}

export async function disconnectTv(deviceId: string): Promise<void> {
  const res = await fetch(`/api/tv/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await readJson(res);
    throw new Error(typeof data.message === "string" ? data.message : "Could not disconnect this TV");
  }
}

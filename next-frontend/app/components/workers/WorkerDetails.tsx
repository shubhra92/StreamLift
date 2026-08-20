"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Copy, Check, AlertTriangle, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  formatBytes,
  formatSpeed,
  formatUptime,
  formatDate,
  timeAgo,
  logLevelClass,
  isVersionOutdated,
  countryFlag,
} from "./utils";
import type { WorkerDetailsProps } from "./types";
import type { WorkerLog } from "@/app/lib/workerStore";
import { openWorkerStream, invalidateWorkerConnection } from "@/app/lib/workerConnection";

// ── Progress log parser ───────────────────────────────────────────────────────
const PROGRESS_RE = /📊\s+([\d.]+)%\s*\|(.+)/;

function parseProgressLog(message: string) {
  const m = PROGRESS_RE.exec(message);
  if (!m) return null;
  return {
    percent: parseFloat(m[1]),
    parts: m[2].split("|").map((s) => s.trim()).filter(Boolean),
  };
}

function LogEntry({ log }: { log: WorkerLog }) {
  const progress = parseProgressLog(log.message);
  const time = new Date(log.timestamp).toLocaleTimeString();

  if (progress) {
    const pct = Math.min(100, Math.max(0, progress.percent));
    const barColor = pct >= 100 ? "bg-green-500" : pct > 60 ? "bg-blue-500" : "bg-blue-400";
    return (
      <div className="py-1 border-b border-muted/40 last:border-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-muted-foreground shrink-0">{time}</span>
          <span className="text-blue-500 font-bold shrink-0">📊 {pct.toFixed(1)}%</span>
          {progress.parts.map((part, i) => (
            <span key={i} className="text-muted-foreground">{part}</span>
          ))}
        </div>
        <div className="w-full bg-muted rounded h-1.5">
          <motion.div
            className={`${barColor} h-1.5 rounded`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5 }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-muted-foreground shrink-0">{time}</span>
      <span className={`shrink-0 uppercase font-semibold ${logLevelClass(log.level)}`}>[{log.level}]</span>
      <span className="break-all">{log.message}</span>
    </div>
  );
}

function MiniBar({ value, color = "bg-blue-500", label, valueLabel }: {
  value: number; color?: string; label: string; valueLabel: string;
}) {
  return (
    <div>
      <div className="flex justify-between mb-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs font-medium">{valueLabel}</span>
      </div>
      <div className="w-full bg-muted rounded h-1.5">
        <motion.div
          className={`${color} h-1.5 rounded`}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(100, value)}%` }}
          transition={{ duration: 0.4 }}
        />
      </div>
    </div>
  );
}

function Field({ label, value, mono = false, copyable = false }: {
  label: string; value: string; mono?: boolean; copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{label}</span>
      <div className="flex items-center gap-1 min-w-0">
        <span className={`font-medium text-sm truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
        {copyable && (
          <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 cursor-pointer" onClick={handleCopy}>
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                  <Check className="h-3 w-3 text-green-500" />
                </motion.span>
              ) : (
                <motion.span key="copy" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ duration: 0.15 }}>
                  <Copy className="h-3 w-3" />
                </motion.span>
              )}
            </AnimatePresence>
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Live stream data from worker SSE ─────────────────────────────────────────
interface LiveData {
  metrics?:     { cpuUsage: number; ramUsage: number; downloadSpeed: number; uploadSpeed: number };
  currentTask?: { downloadId: string; fileName: string; status: string; progress: number; startedAt: string } | null;
  logs?:        WorkerLog[];
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface WorkerDetailsPanelProps extends WorkerDetailsProps {
  panelRef?: React.RefObject<HTMLDivElement | null>;
}

export function WorkerDetails({ worker, status, onClose, panelRef }: WorkerDetailsPanelProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);
  const streamRef  = useRef<{ close: () => void } | null>(null);
  const [liveData, setLiveData] = useState<LiveData>({});
  const [streamError, setStreamError] = useState<string | null>(null);

  const online   = worker ? (status?.online ?? worker.online) : false;
  const version  = worker ? (status?.version ?? "1.0.0") : "1.0.0";
  const outdated = worker ? isVersionOutdated(version) : false;
  const workerCountryFlag = countryFlag(worker?.countryCode);
  const publicIp = online && worker?.ipAddress
    ? `${workerCountryFlag ? `${workerCountryFlag} ` : ""}${worker.ipAddress}`
    : "Not connected";

  // ── Connect to worker SSE when panel opens and worker is online ───────────
  useEffect(() => {
    if (!worker || !online) {
      streamRef.current?.close();
      streamRef.current = null;
      setLiveData({});
      setStreamError(null);
      return;
    }

    let cancelled = false;
    setStreamError(null);

    openWorkerStream(
      worker.id,
      (data: any) => {
        if (cancelled) return;
        setStreamError(null);
        setLiveData({
          metrics:     data.metrics     ?? undefined,
          currentTask: data.currentTask ?? null,
          logs:        Array.isArray(data.logs) ? data.logs as WorkerLog[] : undefined,
        });
      },
      (errMsg: string) => {
        if (!cancelled) setStreamError(errMsg);
      },
    ).then((handle) => {
      if (cancelled) { handle.close(); return; }
      streamRef.current = handle;
    }).catch((e) => {
      if (!cancelled) setStreamError(`Failed to connect: ${e.message}`);
    });

    return () => {
      cancelled = true;
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [worker?.id, online]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live SSE data takes priority; status only provides online/lastHeartbeat
  const metrics     = liveData.metrics     ?? null;
  const currentTask = liveData.currentTask ?? null;
  const logs        = liveData.logs        ?? [];

  // Scroll logs to bottom on new entries (must be after logs is declared)
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <AnimatePresence>
      {worker && (
        <motion.div
          key="worker-panel"
          ref={panelRef}
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 32, stiffness: 320 }}
          className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t shadow-2xl rounded-t-xl
                     max-h-[65vh] flex flex-col"
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1 shrink-0">
            <div className="w-8 h-1 rounded-full bg-muted-foreground/25" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-4 pb-2 pt-1 border-b shrink-0">
            <div className="flex items-center gap-2">
              {online
                ? <Wifi className="h-4 w-4 text-green-500" />
                : <WifiOff className="h-4 w-4 text-gray-400" />
              }
              <h3 className="text-sm font-semibold">{worker.name}</h3>
              <Badge className={`text-xs px-1.5 py-0 h-4 ${online ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
                {online ? "Online" : "Offline"}
              </Badge>
              {outdated && (
                <span title="Worker version is outdated">
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                </span>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
              <X className="h-3 w-3" />
            </Button>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 px-4 py-3 space-y-4">

          {/* Stream connection error */}
            {streamError && (
              <div className="text-xs text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 rounded px-3 py-2">
                ⚠ {streamError}
              </div>
            )}

            {/* Current Task */}
            {currentTask && (
              <div className="space-y-1.5">
                <p className="text-sm font-semibold truncate">{currentTask.fileName}</p>
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded h-3">
                    <motion.div
                      className="bg-green-600 h-3 rounded"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, currentTask.progress)}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <span className="text-sm tabular-nums font-medium text-muted-foreground shrink-0">
                    {currentTask.progress.toFixed(1)}%
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Started {timeAgo(currentTask.startedAt)}</p>
              </div>
            )}

            {/* Worker Info + Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <Field label="Worker ID" value={worker.id} mono copyable />
                <Field label="Version"   value={version} />
                <Field label="Last Seen" value={timeAgo(status?.lastHeartbeat)} />
                <Field label="Compute"   value={worker.computeType.charAt(0).toUpperCase() + worker.computeType.slice(1)} />
                <Field label="Download To" value={worker.downloadLocation === "mega" ? "Mega" : "Local"} />
                <Field label="Public IP" value={publicIp} mono={Boolean(worker?.ipAddress)} />
                <Field label="Created"   value={formatDate(worker.createdAt?.toString())} />
                {worker.megaEmail && <Field label="Mega Account" value={worker.megaEmail} />}
              </div>

              <div className="space-y-3">
                {metrics && (
                  <>
                    <MiniBar
                      label="CPU"
                      value={metrics.cpuUsage}
                      valueLabel={`${metrics.cpuUsage.toFixed(1)}%`}
                      color={metrics.cpuUsage > 80 ? "bg-red-500" : "bg-blue-500"}
                    />
                    <MiniBar
                      label="RAM"
                      value={metrics.ramUsage}
                      valueLabel={`${metrics.ramUsage.toFixed(1)}%`}
                      color={metrics.ramUsage > 80 ? "bg-red-500" : "bg-purple-500"}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="↓ Speed" value={formatSpeed(metrics.downloadSpeed)} />
                      <Field label="↑ Speed" value={formatSpeed(metrics.uploadSpeed)} />
                    </div>
                  </>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Downloads"   value={String(worker.totalDownloads ?? 0)} />
                  <Field label="Transferred" value={formatBytes(worker.totalBytes ?? 0)} />
                  <Field label="Uptime"      value={formatUptime(worker.totalUptime ?? 0)} />
                </div>
              </div>
            </div>

            {/* Logs */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Logs <span className="normal-case font-normal">({logs.length} entries)</span>
              </p>
              <div className="bg-muted/50 rounded-lg p-3 h-40 overflow-y-auto font-mono text-xs space-y-0.5">
                {!logs.length ? (
                  <p className="text-muted-foreground italic">No logs yet</p>
                ) : (
                  logs.map((log: WorkerLog, i: number) => <LogEntry key={i} log={log} />)
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

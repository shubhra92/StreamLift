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
} from "./utils";
import type { WorkerDetailsProps } from "./types";
import type { WorkerLog } from "@/app/lib/workerStore";

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

// ── Props extended with panelRef ──────────────────────────────────────────────
interface WorkerDetailsPanelProps extends WorkerDetailsProps {
  panelRef?: React.RefObject<HTMLDivElement | null>;
}

export function WorkerDetails({ worker, status, onClose, panelRef }: WorkerDetailsPanelProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [status?.logs?.length]);

  // Guard: don't compute anything if worker is null (panel is closed)
  const online = worker ? (status?.online ?? worker.online) : false;
  const version = worker ? (status?.version ?? "1.0.0") : "1.0.0";
  const outdated = worker ? isVersionOutdated(version) : false;

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

          {/* Header — sticky inside panel */}
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

            {/* ── Current Task progress — shown prominently at top ── */}
            {status?.currentTask && (
              <div className="space-y-1.5">
                <p className="text-sm font-semibold truncate">{status.currentTask.fileName}</p>
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded h-3">
                    <motion.div
                      className="bg-green-600 h-3 rounded"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, status.currentTask.progress)}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <span className="text-sm tabular-nums font-medium text-muted-foreground shrink-0">
                    {status.currentTask.progress.toFixed(1)}%
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Started {timeAgo(status.currentTask.startedAt)}</p>
              </div>
            )}

            {/* ── Worker Info + Metrics side by side on desktop ── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Info grid */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <Field label="Worker ID" value={worker.id} mono copyable />
                <Field label="Version" value={version} />
                <Field label="IP Address" value={status?.ipAddress ?? worker.ipAddress ?? "—"} />
                <Field label="Last Seen" value={timeAgo(status?.lastHeartbeat)} />
                <Field label="Compute" value={worker.computeType.charAt(0).toUpperCase() + worker.computeType.slice(1)} />
                <Field label="Download To" value={worker.downloadLocation === "mega" ? "Mega" : "Local"} />
                <Field label="Created" value={formatDate(worker.createdAt?.toString())} />
                {worker.megaEmail && <Field label="Mega Account" value={worker.megaEmail} />}
              </div>

              {/* Metrics + Stats */}
              <div className="space-y-3">
                {status?.metrics && (
                  <>
                    <MiniBar
                      label="CPU"
                      value={status.metrics.cpuUsage}
                      valueLabel={`${status.metrics.cpuUsage.toFixed(1)}%`}
                      color={status.metrics.cpuUsage > 80 ? "bg-red-500" : "bg-blue-500"}
                    />
                    <MiniBar
                      label="RAM"
                      value={status.metrics.ramUsage}
                      valueLabel={`${status.metrics.ramUsage.toFixed(1)}%`}
                      color={status.metrics.ramUsage > 80 ? "bg-red-500" : "bg-purple-500"}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="↓ Speed" value={formatSpeed(status.metrics.downloadSpeed)} />
                      <Field label="↑ Speed" value={formatSpeed(status.metrics.uploadSpeed)} />
                    </div>
                  </>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Downloads" value={String(worker.totalDownloads ?? 0)} />
                  <Field label="Transferred" value={formatBytes(worker.totalBytes ?? 0)} />
                  <Field label="Uptime" value={formatUptime(worker.totalUptime ?? 0)} />
                </div>
              </div>
            </div>

            {/* ── Logs ── */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                Logs <span className="normal-case font-normal">({status?.logs?.length ?? 0} entries)</span>
              </p>
              <div className="bg-muted/50 rounded-lg p-3 h-40 overflow-y-auto font-mono text-xs space-y-0.5">
                {!status?.logs?.length ? (
                  <p className="text-muted-foreground italic">No logs yet</p>
                ) : (
                  status.logs.map((log, i) => <LogEntry key={i} log={log} />)
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

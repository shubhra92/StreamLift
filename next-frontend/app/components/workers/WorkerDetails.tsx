"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Copy, AlertTriangle } from "lucide-react";
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

// ── Progress log parser ──────────────────────────────────────────────────────
// Matches: "📊 42.3% | 300.1 MB / 709.6 MB | RAM: 187 MB"
// or:      "📊 42.35% | Speed: 8.21 MB/s | Peers: 6 | Downloaded: 300.2 MB / 709.6 MB | Memory: 187 MB"
const PROGRESS_RE = /📊\s+([\d.]+)%\s*\|(.+)/;

interface ParsedProgress {
  percent: number;
  parts: string[];
}

function parseProgressLog(message: string): ParsedProgress | null {
  const m = PROGRESS_RE.exec(message);
  if (!m) return null;
  const percent = parseFloat(m[1]);
  const parts = m[2].split("|").map((s) => s.trim()).filter(Boolean);
  return { percent, parts };
}

function LogEntry({ log }: { log: WorkerLog }) {
  const progress = parseProgressLog(log.message);
  const time = new Date(log.timestamp).toLocaleTimeString();

  if (progress) {
    // Rich progress row
    const pct = Math.min(100, Math.max(0, progress.percent));
    const barColor =
      pct >= 100 ? "bg-green-500" : pct > 60 ? "bg-blue-500" : "bg-blue-400";

    return (
      <div className="py-1 border-b border-muted/40 last:border-0">
        {/* Top row: time + percent + stats */}
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-muted-foreground shrink-0">{time}</span>
          <span className="text-blue-500 font-bold shrink-0">📊 {pct.toFixed(1)}%</span>
          {progress.parts.map((part, i) => (
            <span key={i} className="text-muted-foreground">
              {part}
            </span>
          ))}
        </div>
        {/* Progress bar */}
        <div className="w-full bg-muted rounded h-1.5">
          <motion.div
            className={`${barColor} h-1.5 rounded transition-all`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5 }}
          />
        </div>
      </div>
    );
  }

  // Regular log row
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-muted-foreground shrink-0">{time}</span>
      <span className={`shrink-0 uppercase font-semibold ${logLevelClass(log.level)}`}>
        [{log.level}]
      </span>
      <span className="break-all">{log.message}</span>
    </div>
  );
}

function DetailItem({
  label,
  value,
  mono = false,
  copyable = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  return (
    <div>
      <p className="text-muted-foreground text-xs mb-0.5">{label}</p>
      <div className="flex items-center gap-1">
        <p className={`font-medium text-sm break-all ${mono ? "font-mono text-xs" : ""}`}>
          {value}
        </p>
        {copyable && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0 cursor-pointer"
            onClick={() => navigator.clipboard.writeText(value)}
          >
            <Copy className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ value, color = "bg-blue-500" }: { value: number; color?: string }) {
  return (
    <div className="w-full bg-muted rounded h-2">
      <motion.div
        className={`${color} h-2 rounded`}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, value)}%` }}
        transition={{ duration: 0.4 }}
      />
    </div>
  );
}

export function WorkerDetails({ worker, status, onClose }: WorkerDetailsProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs to bottom when new entries arrive
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [status?.logs?.length]);

  const online = status?.online ?? worker.online;
  const version = status?.version ?? "1.0.0";
  const outdated = isVersionOutdated(version);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.2 }}
        className="my-4 bg-card p-4 md:p-5 rounded-xl shadow-md border"
      >
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${online ? "bg-green-500" : "bg-gray-400"}`}
            />
            <h3 className="text-lg font-semibold">{worker.name}</h3>
            {outdated && (
              <span title="Worker version is outdated">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
              </span>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-5">
          {/* ── Worker Info ── */}
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Worker Info
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <DetailItem label="Worker ID" value={worker.id} mono copyable />
              <DetailItem label="IP Address" value={status?.ipAddress ?? worker.ipAddress ?? "Not connected"} />
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Status</p>
                <Badge className={online ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}>
                  {online ? "Online" : "Offline"}
                </Badge>
              </div>
              <DetailItem label="Version" value={version} />
              <DetailItem label="Compute Type" value={worker.computeType.charAt(0).toUpperCase() + worker.computeType.slice(1)} />
              <DetailItem label="Download Location" value={worker.downloadLocation === "mega" ? "Mega" : "Local"} />
              {worker.megaEmail && (
                <DetailItem label="Mega Account" value={worker.megaEmail} />
              )}
              <DetailItem label="Created" value={formatDate(worker.createdAt?.toString())} />
              <DetailItem label="Last Seen" value={timeAgo(status?.lastHeartbeat)} />
            </div>
          </section>

          {/* ── Metrics ── */}
          {status?.metrics && (
            <section>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Metrics
              </p>
              <div className="space-y-2 text-sm">
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-muted-foreground text-xs">CPU</span>
                    <span className="text-xs font-medium">{status.metrics.cpuUsage.toFixed(1)}%</span>
                  </div>
                  <ProgressBar
                    value={status.metrics.cpuUsage}
                    color={status.metrics.cpuUsage > 80 ? "bg-red-500" : "bg-blue-500"}
                  />
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-muted-foreground text-xs">RAM</span>
                    <span className="text-xs font-medium">{status.metrics.ramUsage.toFixed(1)}%</span>
                  </div>
                  <ProgressBar
                    value={status.metrics.ramUsage}
                    color={status.metrics.ramUsage > 80 ? "bg-red-500" : "bg-purple-500"}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <DetailItem label="Download Speed" value={formatSpeed(status.metrics.downloadSpeed)} />
                  <DetailItem label="Upload Speed" value={formatSpeed(status.metrics.uploadSpeed)} />
                </div>
              </div>
            </section>
          )}

          {/* ── Current Task ── */}
          {status?.currentTask && (
            <section>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Current Task
              </p>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium truncate">{status.currentTask.fileName}</span>
                  <Badge className="bg-blue-100 text-blue-800 text-xs ml-2 shrink-0">
                    {status.currentTask.status}
                  </Badge>
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-muted-foreground text-xs">Progress</span>
                    <span className="text-xs font-medium">
                      {status.currentTask.progress.toFixed(1)}%
                    </span>
                  </div>
                  <ProgressBar value={status.currentTask.progress} color="bg-green-500" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Started {timeAgo(status.currentTask.startedAt)}
                </p>
              </div>
            </section>
          )}

          {/* ── Statistics ── */}
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Statistics
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <DetailItem label="Total Downloads" value={String(worker.totalDownloads ?? 0)} />
              <DetailItem label="Total Transferred" value={formatBytes(worker.totalBytes ?? 0)} />
              <DetailItem label="Total Uptime" value={formatUptime(worker.totalUptime ?? 0)} />
            </div>
          </section>

          {/* ── Logs ── */}
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Logs{" "}
              <span className="normal-case font-normal text-muted-foreground">
                ({status?.logs?.length ?? 0} entries this session)
              </span>
            </p>
            <div className="bg-muted/50 rounded-lg p-3 h-64 overflow-y-auto font-mono text-xs space-y-1">
              {!status?.logs?.length ? (
                <p className="text-muted-foreground italic">No logs yet</p>
              ) : (
                status.logs.map((log, i) => (
                  <LogEntry key={i} log={log} />
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </section>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

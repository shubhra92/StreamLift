"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MonitorSmartphone,
  Tv,
  Unplug,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { approveTvCode, disconnectTv } from "@/app/lib/tvClient";
import { isValidTvCode, normalizeTvCode } from "@/app/lib/tvConstants";
import type { TvDeviceSummary } from "@/app/lib/tvTypes";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: TvDeviceSummary[];
  loading: boolean;
  devicesError: string | null;
  onRefresh: () => void;
  initialCode?: string;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Not connected yet";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "Just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ConnectToTvDialog({
  open,
  onOpenChange,
  devices,
  loading,
  devicesError,
  onRefresh,
  initialCode,
}: Props) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode(normalizeTvCode(initialCode ?? ""));
    setSubmitError(null);
    setSuccess(null);
  }, [open, initialCode]);

  const onlineCount = devices.filter((device) => device.online).length;

  const handleApprove = async () => {
    if (!isValidTvCode(code) || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setSuccess(null);
    try {
      const result = await approveTvCode(code);
      setSuccess(
        `${result.device.name} is connected. It will open the watch library in a moment.`,
      );
      setCode("");
      onRefresh();
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "Could not connect this TV");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async (device: TvDeviceSummary) => {
    if (disconnecting) return;
    setDisconnecting(device.id);
    setSubmitError(null);
    setSuccess(null);
    try {
      await disconnectTv(device.id);
      onRefresh();
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "Could not disconnect this TV");
    } finally {
      setDisconnecting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tv className="h-5 w-5 text-blue-500" />
            Connect to TV
          </DialogTitle>
          <DialogDescription>
            Open StreamLift TV on your Android TV. It shows a 6-character code —
            enter that code here to connect it to this watch session.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="rounded-xl border bg-muted/30 p-4">
            <label htmlFor="tv-pairing-code" className="text-sm font-medium">
              TV connection code
            </label>
            <input
              id="tv-pairing-code"
              value={code}
              onChange={(event) => {
                setCode(normalizeTvCode(event.target.value));
                setSubmitError(null);
                setSuccess(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleApprove();
              }}
              placeholder="ABC-DEF"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              maxLength={6}
              autoFocus
              className="mt-2 h-14 w-full rounded-lg border bg-background px-4 text-center font-mono text-2xl font-semibold uppercase tracking-[0.35em] outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
              aria-describedby="tv-code-hint"
            />
            <p id="tv-code-hint" className="mt-2 text-xs text-muted-foreground">
              Letters and numbers only. The code expires after 10 minutes.
            </p>

            <Button
              type="button"
              onClick={() => void handleApprove()}
              disabled={!isValidTvCode(code) || submitting}
              className="mt-3 w-full bg-blue-600 hover:bg-blue-700"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting…
                </>
              ) : (
                <>
                  <MonitorSmartphone className="h-4 w-4" />
                  Connect this TV
                </>
              )}
            </Button>
          </div>

          {submitError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {success && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-500">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{success}</span>
            </div>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Connected TVs
                {devices.length > 0 && (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {onlineCount > 0 ? `${onlineCount} online` : "offline"}
                  </span>
                )}
              </h3>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>

            {devicesError && !devices.length ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{devicesError}</span>
              </div>
            ) : devices.length === 0 && !loading ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                No TVs connected yet.
              </div>
            ) : (
              <ul className="space-y-2">
                {devices.map((device) => (
                  <li
                    key={device.id}
                    className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Tv className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-medium">{device.name}</p>
                        {device.online ? (
                          <Wifi className="h-3 w-3 shrink-0 text-emerald-500" />
                        ) : (
                          <WifiOff className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {[device.model, relativeTime(device.lastSeenAt)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDisconnect(device)}
                      disabled={disconnecting === device.id}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Disconnect ${device.name}`}
                    >
                      {disconnecting === device.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Unplug className="h-4 w-4" />
                      )}
                      <span className="hidden sm:inline">Disconnect</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

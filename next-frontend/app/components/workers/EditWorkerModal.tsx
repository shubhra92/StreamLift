"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { EditWorkerModalProps } from "./types";
import type { UpdateWorkerData } from "@/app/service/workerService";
import { megaLogin } from "@/app/lib/megaLogin";
import {
  TUNNEL_PROVIDERS,
  TUNNEL_PROVIDER_META,
  type TunnelProvider,
} from "@/app/lib/tunnelConfig";

export function EditWorkerModal({
  isOpen,
  worker,
  onClose,
  onSubmit,
  loading,
}: EditWorkerModalProps) {
  const [name, setName]                         = useState("");
  const [downloadLocation, setDownloadLocation] = useState<"local" | "mega">("local");
  const [computeType, setComputeType]           = useState<"low" | "medium" | "high">("medium");
  const [tunnelProvider, setTunnelProvider]     = useState<TunnelProvider>("pinggy");
  // Primary token — blank = keep existing
  const [tokenValue, setTokenValue]             = useState("");
  // Optional secondary field (e.g. tunnl.gg SSH key path)
  const [optionalValue, setOptionalValue]       = useState("");
  const [megaEmail, setMegaEmail]               = useState("");
  const [megaPassword, setMegaPassword]         = useState("");
  const [megaSession, setMegaSession]           = useState<object | null>(null);
  const [loggingIn, setLoggingIn]               = useState(false);
  const [errors, setErrors]                     = useState<Record<string, string>>({});

  // Pre-fill from worker when modal opens
  useEffect(() => {
    if (!isOpen || !worker) return;
    setName(worker.name ?? "");
    setDownloadLocation((worker.downloadLocation as "local" | "mega") ?? "local");
    setComputeType((worker.computeType as "low" | "medium" | "high") ?? "medium");
    setTunnelProvider((worker.activeTunnelProvider as TunnelProvider | null) ?? "pinggy");
    // Credentials are never sent back to the client — leave blank to keep existing
    setTokenValue("");
    setOptionalValue("");
    setMegaEmail(worker.megaEmail ?? "");
    setMegaPassword("");
    setMegaSession(null);
    setErrors({});
  }, [isOpen, worker]);

  const meta = TUNNEL_PROVIDER_META[tunnelProvider];

  const validateForm = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Worker name is required";
    // Token: only required if the field is shown AND user typed something wrong,
    // or if the server will reject (handled server-side). Blank = keep existing.
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleMegaLogin = async () => {
    if (!megaEmail.trim() || !megaPassword) {
      setErrors((prev) => ({ ...prev, megaLogin: "Enter your Mega email and password." }));
      return;
    }
    setLoggingIn(true);
    setErrors((prev) => ({ ...prev, megaLogin: "" }));
    try {
      const session = await megaLogin(megaEmail, megaPassword);
      setMegaEmail(megaEmail.trim().toLowerCase());
      setMegaPassword("");
      setMegaSession(session);
    } catch (err: any) {
      setErrors((prev) => ({ ...prev, megaLogin: err?.message ?? "Mega login failed" }));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleChangeAccount = () => {
    setMegaSession(null);
    setMegaPassword("");
    setErrors((prev) => ({ ...prev, megaLogin: "" }));
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    const update: UpdateWorkerData = {
      name:                 name.trim(),
      downloadLocation,
      computeType,
      activeTunnelProvider: tunnelProvider,
    };

    // Only include credentials if the user actually typed something — blank = keep existing
    if (tokenValue.trim()) {
      if (tunnelProvider === "pinggy") update.pinggyToken = tokenValue.trim();
      if (tunnelProvider === "zrok")   update.zrokToken   = tokenValue.trim();
    }
    if (tunnelProvider === "tunnlgg")
      update.tunnlggSshKeyPath = optionalValue.trim();

    if (downloadLocation === "mega") {
      update.megaEmail = megaEmail.trim().toLowerCase();
      if (megaSession) update.megaSession = JSON.stringify(megaSession);
    }

    await onSubmit(update);
  };

  const handleProviderChange = (p: TunnelProvider) => {
    setTunnelProvider(p);
    setTokenValue("");
    setOptionalValue("");
    setErrors((prev) => ({ ...prev, token: "" }));
  };

  const handleClose = () => {
    setErrors({});
    onClose();
  };

  if (!worker) return null;

  const megaReady = megaSession !== null;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Worker</DialogTitle>
          <DialogDescription>
            Update settings for <span className="font-medium">{worker.name}</span>.
          </DialogDescription>
        </DialogHeader>
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-4"
          >
            {/* Online warning banner */}
            {worker.online && (
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5">
                <span className="text-amber-500 mt-0.5 shrink-0">⚠</span>
                <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                  This worker is currently running. Tunnel provider/token changes are saved now
                  but take effect only after you click <span className="font-semibold">Restart
                  tunnel</span> in the worker details panel — that reconnects only the tunnel and
                  keeps the worker running. Compute, download location and Mega changes still
                  require a full worker restart.
                </p>
              </div>
            )}

            {/* Worker Name */}
            <div>
              <input
                type="text"
                placeholder="Worker name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
            </div>

            {/* Download Location */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Download Location</label>
              <select
                value={downloadLocation}
                onChange={(e) => setDownloadLocation(e.target.value as "local" | "mega")}
                className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="local">Local (Colab disk)</option>
                <option value="mega">Mega</option>
              </select>
            </div>

            {/* Compute Type */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Compute Type</label>
              <select
                value={computeType}
                onChange={(e) => setComputeType(e.target.value as "low" | "medium" | "high")}
                className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="low">Low — 25% CPU, 512 KB chunks</option>
                <option value="medium">Medium — 50% CPU, 1 MB chunks</option>
                <option value="high">High — 100% CPU, 2 MB chunks</option>
              </select>
            </div>

            {/* Tunnel Provider */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Tunnel Provider</label>
              <select
                value={tunnelProvider}
                onChange={(e) => handleProviderChange(e.target.value as TunnelProvider)}
                className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {TUNNEL_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {TUNNEL_PROVIDER_META[p].label}
                    {!TUNNEL_PROVIDER_META[p].needsToken ? " (no token needed)" : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">{meta.description}</p>
              <p className="text-xs text-muted-foreground mt-1">
                After saving, use <span className="font-medium">Restart tunnel</span> in the
                worker details to apply this without restarting the worker.
              </p>
            </div>

            {/* Primary token field */}
            <AnimatePresence>
              {meta.needsToken && (
                <motion.div
                  key={`token-${tunnelProvider}`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {meta.tokenLabel}
                    {meta.docsUrl && (
                      <a
                        href={meta.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1 text-blue-500 hover:underline"
                      >
                        ({meta.tokenHint})
                      </a>
                    )}
                  </label>
                  <input
                    type="text"
                    placeholder={`Leave blank to keep existing ${meta.tokenLabel}`}
                    value={tokenValue}
                    onChange={(e) => setTokenValue(e.target.value)}
                    className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
                  />
                  {errors.token && (
                    <p className="text-xs text-destructive mt-1">{errors.token}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave blank to keep the current token.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Optional secondary field (tunnl.gg SSH key path) */}
            <AnimatePresence>
              {meta.hasOptionalField && (
                <motion.div
                  key={`optional-${tunnelProvider}`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {meta.optionalFieldLabel}
                  </label>
                  <input
                    type="text"
                    placeholder={meta.optionalFieldPlaceholder}
                    value={optionalValue}
                    onChange={(e) => setOptionalValue(e.target.value)}
                    className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {meta.optionalFieldHint}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Mega re-auth (conditional) */}
            <AnimatePresence>
              {downloadLocation === "mega" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-3 overflow-hidden"
                >
                  {!megaReady ? (
                    <>
                      <input
                        type="email"
                        placeholder="Mega email"
                        value={megaEmail}
                        onChange={(e) => setMegaEmail(e.target.value)}
                        className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <input
                        type="password"
                        placeholder="Mega password (optional — only if refreshing session)"
                        value={megaPassword}
                        onChange={(e) => setMegaPassword(e.target.value)}
                        className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      {megaPassword && (
                        <Button
                          onClick={handleMegaLogin}
                          disabled={loggingIn}
                          className="w-full bg-emerald-600 hover:bg-emerald-700 cursor-pointer"
                        >
                          {loggingIn ? "Logging into Mega..." : "Refresh Mega session"}
                        </Button>
                      )}
                      {errors.megaLogin && (
                        <p className="text-xs text-destructive">{errors.megaLogin}</p>
                      )}
                    </>
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex items-center justify-between gap-2 rounded-lg border border-green-300/60 bg-green-50 dark:bg-green-900/20 px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-green-800 dark:text-green-200">
                            New Mega session ready
                          </p>
                          <p className="text-xs text-green-700 dark:text-green-300 truncate">
                            {megaEmail}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleChangeAccount}
                        className="h-7 text-xs shrink-0 cursor-pointer"
                      >
                        Change
                      </Button>
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <Button variant="outline" onClick={handleClose} className="flex-1 cursor-pointer">
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={loading || loggingIn}
                className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
              >
                {loading ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

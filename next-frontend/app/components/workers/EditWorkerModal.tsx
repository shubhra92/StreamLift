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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EditWorkerModalProps } from "./types";
import type { UpdateWorkerData } from "@/app/service/workerService";
import { megaLogin } from "@/app/lib/megaLogin";
import { ConsoleLogsToggle } from "./ConsoleLogsToggle";
import {
  TUNNEL_PROVIDERS,
  TUNNEL_PROVIDER_META,
  normaliseTunnelProvider,
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
  const [consoleLogs, setConsoleLogs]           = useState(true);
  const [tunnelProvider, setTunnelProvider]     = useState<TunnelProvider>("pinggy");
  const [tokenValue, setTokenValue]             = useState("");
  const [megaEmail, setMegaEmail]               = useState("");
  const [megaPassword, setMegaPassword]         = useState("");
  const [megaSession, setMegaSession]           = useState<object | null>(null);
  const [loggingIn, setLoggingIn]               = useState(false);
  const [errors, setErrors]                     = useState<Record<string, string>>({});
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Track original values to detect dirty state
  const [origName, setOrigName]             = useState("");
  const [origToken, setOrigToken]           = useState("");
  const [origMegaEmail, setOrigMegaEmail]   = useState("");

  useEffect(() => {
    if (!isOpen || !worker) return;
    const n = worker.name ?? "";
    const e = worker.megaEmail ?? "";
    setName(n);
    setOrigName(n);
    setDownloadLocation((worker.downloadLocation as "local" | "mega") ?? "local");
    setComputeType((worker.computeType as "low" | "medium" | "high") ?? "medium");
    setConsoleLogs(worker.consoleLogs ?? true);
    setTunnelProvider(normaliseTunnelProvider(worker.activeTunnelProvider));
    setTokenValue("");
    setOrigToken("");
    setMegaEmail(e);
    setOrigMegaEmail(e);
    setMegaPassword("");
    setMegaSession(null);
    setErrors({});
    setShowDiscardConfirm(false);
  }, [isOpen, worker]);

  const meta = TUNNEL_PROVIDER_META[tunnelProvider];

  // Dirty if user changed name, typed a new token, changed mega email, or typed a password
  const isDirty =
    name.trim() !== origName.trim() ||
    tokenValue.trim() !== origToken.trim() ||
    megaEmail.trim() !== origMegaEmail.trim() ||
    megaPassword !== "";

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
      consoleLogs,
      activeTunnelProvider: tunnelProvider,
    };

    // Only include credentials if the user actually typed something — blank = keep existing
    if (tokenValue.trim()) {
      if (tunnelProvider === "pinggy") update.pinggyToken = tokenValue.trim();
      if (tunnelProvider === "zrok")   update.zrokToken   = tokenValue.trim();
    }

    if (downloadLocation === "mega") {
      update.megaEmail = megaEmail.trim().toLowerCase();
      if (megaSession) update.megaSession = JSON.stringify(megaSession);
    }

    await onSubmit(update);
  };

  const handleProviderChange = (p: TunnelProvider) => {
    setTunnelProvider(p);
    setTokenValue("");
    setErrors((prev) => ({ ...prev, token: "" }));
  };

  const handleCloseIntent = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      setErrors({});
      onClose();
    }
  };

  const handleDiscard = () => {
    setShowDiscardConfirm(false);
    setErrors({});
    onClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && isDirty) return; // silently block outside-click when dirty
    if (!open) { setErrors({}); onClose(); }
  };

  if (!worker) return null;

  const megaReady = megaSession !== null;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg flex flex-col max-h-[90vh]">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit Worker</DialogTitle>
            <DialogDescription>
              Update settings for <span className="font-medium">{worker.name}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 pr-1">
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-4"
          >
            {/* Online warning banner */}
            {worker.online && (
              <div className="flex items-start gap-2.5 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
                <span className="text-amber-500 mt-0.5 shrink-0">⚠</span>
                <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                  This worker is currently running. Tunnel provider/token changes are saved now
                  but take effect only after you click <span className="font-semibold">Restart
                  tunnel</span> in the worker details panel — that reconnects only the tunnel and
                  keeps the worker running. Compute, download location, Mega and console
                  logging changes still require a full worker restart.
                </p>
              </div>
            )}

            {/* Worker Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Worker name</label>
              <input
                type="text"
                placeholder="Worker name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
            </div>

            {/* Download Location + Compute Type — side by side */}
            <div className="flex gap-3">
              <div className="space-y-1.5 flex-1">
                <label className="text-sm font-medium text-foreground">Download location</label>
                <Select value={downloadLocation} onValueChange={(v) => setDownloadLocation(v as "local" | "mega")}>
                  <SelectTrigger className="w-full bg-background text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local (Colab disk)</SelectItem>
                    <SelectItem value="mega">Mega</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 flex-1">
                <label className="text-sm font-medium text-foreground">Compute type</label>
                <Select value={computeType} onValueChange={(v) => setComputeType(v as "low" | "medium" | "high")}>
                  <SelectTrigger className="w-full bg-background text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low — 25% CPU</SelectItem>
                    <SelectItem value="medium">Medium — 50% CPU</SelectItem>
                    <SelectItem value="high">High — 100% CPU</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Mega account box (conditional on location = mega) */}
            <AnimatePresence>
              {downloadLocation === "mega" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <div className="rounded-md border bg-muted/40 px-4 pt-3 pb-4 space-y-3">
                    <p className="text-sm font-medium text-foreground">Mega account</p>
                    {!megaReady ? (
                      <>
                        <div className="relative">
                          <input
                            id="mega-email-edit"
                            type="email"
                            placeholder=" "
                            value={megaEmail}
                            onChange={(e) => setMegaEmail(e.target.value)}
                            className="peer w-full px-3 py-1.5 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                          />
                          <label
                            htmlFor="mega-email-edit"
                            className="absolute left-3 top-1.5 text-xs text-muted-foreground bg-background px-1
                              transition-all duration-150 pointer-events-none
                              peer-placeholder-shown:top-1.5 peer-placeholder-shown:text-xs
                              peer-focus:-top-2 peer-focus:text-[10px] peer-focus:text-foreground
                              peer-not-placeholder-shown:-top-2 peer-not-placeholder-shown:text-[10px]"
                          >
                            Mega email
                          </label>
                        </div>
                        <div className="relative">
                          <input
                            id="mega-password-edit"
                            type="password"
                            placeholder=" "
                            value={megaPassword}
                            onChange={(e) => setMegaPassword(e.target.value)}
                            className="peer w-full px-3 py-1.5 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                          />
                          <label
                            htmlFor="mega-password-edit"
                            className="absolute left-3 top-1.5 text-xs text-muted-foreground bg-background px-1
                              transition-all duration-150 pointer-events-none
                              peer-placeholder-shown:top-1.5 peer-placeholder-shown:text-xs
                              peer-focus:-top-2 peer-focus:text-[10px] peer-focus:text-foreground
                              peer-not-placeholder-shown:-top-2 peer-not-placeholder-shown:text-[10px]"
                          >
                            Mega password (optional — only to refresh session)
                          </label>
                        </div>
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
                        className="flex items-center justify-between gap-2 rounded-md border border-green-300/60 bg-green-50 dark:bg-green-900/20 px-4 py-2.5"
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
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Console logs */}
            <div className="rounded-md border bg-muted/40 px-4 py-3">
              <ConsoleLogsToggle enabled={consoleLogs} onChange={setConsoleLogs} />
            </div>

            {/* Tunnel Provider */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Tunnel provider</label>
              <Select value={tunnelProvider} onValueChange={(v) => handleProviderChange(v as TunnelProvider)}>
                <SelectTrigger className="w-full bg-background text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TUNNEL_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {TUNNEL_PROVIDER_META[p].label}
                      {!TUNNEL_PROVIDER_META[p].needsToken ? " (no token needed)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{meta.description}</p>
              <p className="text-xs text-muted-foreground">
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
                >
                  <div className="space-y-1.5 pt-px pb-1">
                    <label className="text-sm font-medium text-foreground">
                      {meta.tokenLabel}
                      {meta.docsUrl && (
                        <a
                          href={meta.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1.5 text-sm font-normal text-blue-500 hover:underline"
                        >
                          {meta.tokenHint} ↗
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
                      <p className="text-xs text-destructive">{errors.token}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Leave blank to keep the current token.
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex flex-col-reverse sm:flex-row gap-3 pt-1">
              <Button variant="outline" onClick={handleCloseIntent} className="flex-1 cursor-pointer">
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
        </div>
      </DialogContent>
    </Dialog>

      {/* Discard confirmation */}
      <Dialog open={showDiscardConfirm} onOpenChange={setShowDiscardConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes. If you close now, they will be lost.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse sm:flex-row gap-2 mt-2">
            <Button
              variant="outline"
              onClick={() => setShowDiscardConfirm(false)}
              className="flex-1 cursor-pointer"
            >
              Keep editing
            </Button>
            <Button
              onClick={handleDiscard}
              className="flex-1 bg-destructive hover:bg-destructive/90 cursor-pointer"
            >
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

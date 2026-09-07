"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import type { AddWorkerModalProps } from "./types";
import type { CreateWorkerData } from "@/app/service/workerService";
import { megaLogin } from "@/app/lib/megaLogin";

export function AddWorkerModal({ isOpen, onClose, onSubmit, loading }: AddWorkerModalProps) {
  const [name, setName] = useState("");
  const [downloadLocation, setDownloadLocation] = useState<"local" | "mega">("local");
  const [computeType, setComputeType] = useState<"low" | "medium" | "high">("medium");
  const [pinggyToken, setPinggyToken] = useState("");
  const [megaEmail, setMegaEmail] = useState("");
  const [megaPassword, setMegaPassword] = useState("");
  const [megaSession, setMegaSession] = useState<object | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Worker name is required";
    if (!pinggyToken.trim()) e.pinggyToken = "Pinggy token is required";
    if (downloadLocation === "mega" && !megaSession) {
      e.megaLogin = "Log in to Mega to continue";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleMegaLogin = async () => {
    if (!megaEmail.trim() || !megaPassword) {
      setErrors((prev) => ({ ...prev, megaLogin: "Enter the Mega email and password." }));
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

    const base: CreateWorkerData = {
      name: name.trim(),
      downloadLocation,
      computeType,
      pinggyToken: pinggyToken.trim(),
    };

    if (downloadLocation === "mega" && megaSession) {
      // The password never leaves the client — only the session minted above
      // is sent to (and stored by) the backend.
      base.megaEmail = megaEmail.trim().toLowerCase();
      base.megaSession = JSON.stringify(megaSession);
    }

    await onSubmit(base);
  };

  const handleClose = () => {
    setName("");
    setDownloadLocation("local");
    setComputeType("medium");
    setPinggyToken("");
    setMegaEmail("");
    setMegaPassword("");
    setMegaSession(null);
    setErrors({});
    onClose();
  };

  const handleLocationChange = (value: "local" | "mega") => {
    if (value !== "mega") setMegaSession(null);
    setDownloadLocation(value);
    setErrors((prev) => ({ ...prev, megaLogin: "" }));
  };

  const megaReady = megaSession !== null;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Worker</DialogTitle>
          <DialogDescription>
            Configure your worker's name, storage, compute resources, and connection settings.
          </DialogDescription>
        </DialogHeader>
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-4"
          >
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
                onChange={(e) => handleLocationChange(e.target.value as "local" | "mega")}
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

            {/* Pinggy Token */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Pinggy Token
                <a
                  href="https://pinggy.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 text-blue-500 hover:underline"
                >
                  (get one at pinggy.io)
                </a>
              </label>
              <input
                type="text"
                placeholder="Paste your Pinggy token"
                value={pinggyToken}
                onChange={(e) => setPinggyToken(e.target.value)}
                className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
              />
              {errors.pinggyToken && (
                <p className="text-xs text-destructive mt-1">{errors.pinggyToken}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Used to expose the worker's API via a public HTTPS tunnel.
              </p>
            </div>

            {/* Mega (conditional): login step → session-ready view */}
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
                      <div>
                        <input
                          type="email"
                          placeholder="Mega email"
                          value={megaEmail}
                          onChange={(e) => setMegaEmail(e.target.value)}
                          className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                      <div>
                        <input
                          type="password"
                          placeholder="Mega password"
                          value={megaPassword}
                          onChange={(e) => setMegaPassword(e.target.value)}
                          className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                      <Button
                        onClick={handleMegaLogin}
                        disabled={loggingIn}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 cursor-pointer"
                      >
                        {loggingIn ? "Logging into Mega..." : "Login to Mega"}
                      </Button>
                      {errors.megaLogin && (
                        <p className="text-xs text-destructive">{errors.megaLogin}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground text-center">
                        Mega login happens in your browser — the password is never stored on the server.
                      </p>
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
                            Mega session ready
                          </p>
                          <p className="text-xs text-green-700 dark:text-green-300 truncate">{megaEmail}</p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleChangeAccount}
                        className="h-7 text-xs shrink-0 cursor-pointer"
                      >
                        Change account
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
                disabled={loading || loggingIn || (downloadLocation === "mega" && !megaReady)}
                className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
              >
                {loading ? "Creating..." : "Create Worker"}
              </Button>
            </div>
            {downloadLocation === "mega" && !megaReady && (
              <p className="text-[11px] text-muted-foreground text-center">
                Log in to Mega to enable creating this worker.
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
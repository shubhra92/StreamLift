"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AddWorkerModalProps } from "./types";
import type { CreateWorkerData } from "@/app/service/workerService";

export function AddWorkerModal({ isOpen, onClose, onSubmit, loading }: AddWorkerModalProps) {
  const [name, setName] = useState("");
  const [downloadLocation, setDownloadLocation] = useState<"local" | "mega">("local");
  const [computeType, setComputeType] = useState<"low" | "medium" | "high">("medium");
  const [megaEmail, setMegaEmail] = useState("");
  const [megaPassword, setMegaPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Worker name is required";
    if (downloadLocation === "mega") {
      if (!megaEmail.trim()) e.megaEmail = "Mega email is required";
      if (!megaPassword.trim()) e.megaPassword = "Mega password is required";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    const data: CreateWorkerData = {
      name: name.trim(),
      downloadLocation,
      computeType,
      ...(downloadLocation === "mega" ? { megaEmail, megaPassword } : {}),
    };
    await onSubmit(data);
  };

  const handleClose = () => {
    setName("");
    setDownloadLocation("local");
    setComputeType("medium");
    setMegaEmail("");
    setMegaPassword("");
    setErrors({});
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Worker</DialogTitle>
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

            {/* Mega Credentials (conditional) */}
            <AnimatePresence>
              {downloadLocation === "mega" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-3 overflow-hidden"
                >
                  <div>
                    <input
                      type="email"
                      placeholder="Mega email"
                      value={megaEmail}
                      onChange={(e) => setMegaEmail(e.target.value)}
                      className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {errors.megaEmail && (
                      <p className="text-xs text-destructive mt-1">{errors.megaEmail}</p>
                    )}
                  </div>
                  <div>
                    <input
                      type="password"
                      placeholder="Mega password"
                      value={megaPassword}
                      onChange={(e) => setMegaPassword(e.target.value)}
                      className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {errors.megaPassword && (
                      <p className="text-xs text-destructive mt-1">{errors.megaPassword}</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <Button variant="outline" onClick={handleClose} className="flex-1 cursor-pointer">
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
              >
                {loading ? "Creating..." : "Create Worker"}
              </Button>
            </div>
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

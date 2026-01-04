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
import type { AddDownloadModalProps } from "./types";

export function AddDownloadModal({
  isOpen,
  onClose,
  onSubmit,
  loading,
}: AddDownloadModalProps) {
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState<"server" | "mega">("server");

  const handleSubmit = async () => {
    if (!url) return;
    await onSubmit(url, location, fileName || undefined);
    setUrl("");
    setFileName("");
    setLocation("server");
  };

  const handleClose = () => {
    setUrl("");
    setFileName("");
    setLocation("server");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Download</DialogTitle>
        </DialogHeader>
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-4"
          >
            <input
              type="text"
              placeholder="Paste downloadable file URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />

            <input
              type="text"
              placeholder="File name (optional)"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />

            <select
              value={location}
              onChange={(e) => setLocation(e.target.value as "server" | "mega")}
              className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="server">Server</option>
              <option value="mega">Mega</option>
            </select>

            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <Button
                variant="outline"
                onClick={handleClose}
                className="flex-1 cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={loading || !url}
                className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
              >
                {loading ? "Creating..." : "Create"}
              </Button>
            </div>
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

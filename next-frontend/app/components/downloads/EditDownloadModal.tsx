"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EditDownloadModalProps } from "./types";

export function EditDownloadModal({
  file,
  onClose,
  onSubmit,
  loading,
}: EditDownloadModalProps) {
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState<"server" | "mega">("server");

  useEffect(() => {
    if (file) {
      setUrl(file.sourceUrl);
      setFileName(file.fileName || "");
      setLocation((file.location as "server" | "mega") || "server");
    }
  }, [file]);

  const handleSubmit = async () => {
    if (!file || !url) return;
    await onSubmit(file.id, {
      sourceUrl: url,
      fileName: fileName || undefined,
      location,
    });
  };

  const handleClose = () => {
    setUrl("");
    setFileName("");
    setLocation("server");
    onClose();
  };

  return (
    <Dialog open={!!file} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Download</DialogTitle>
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
              <option value="server">Cloud (Server)</option>
              <option value="mega">Cloud</option>
            </select>

            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <Button
                variant="outline"
                onClick={handleClose}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={loading || !url}
                className="flex-1"
              >
                {loading ? "Saving..." : "Save"}
              </Button>
            </div>
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

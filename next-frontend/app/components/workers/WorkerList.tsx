"use client";

import { motion, AnimatePresence } from "motion/react";
import { WorkerItem } from "./WorkerItem";
import type { WorkerListProps } from "./types";

export function WorkerList({ workers, selectedId, onSelect, onDelete, onCopyScript }: WorkerListProps) {
  if (workers.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p className="text-lg font-medium mb-1">No workers yet</p>
        <p className="text-sm">Create a worker to start distributing downloads to Google Colab.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {workers.map((worker) => (
          <motion.div
            key={worker.id}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
          >
            <WorkerItem
              worker={worker}
              isSelected={selectedId === worker.id}
              onSelect={() => onSelect(worker.id)}
              onDelete={() => onDelete(worker.id)}
              onCopyScript={() => onCopyScript(worker.id)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

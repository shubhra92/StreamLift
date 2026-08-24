"use client";

import { AnimatePresence } from "motion/react";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WorkerItem } from "./WorkerItem";
import type { WorkerListProps } from "./types";

export function WorkerList({ workers, selectedId, deletingIds, onSelect, onDelete, onCopyScript }: WorkerListProps) {
  return (
    <div className="bg-card rounded-xl shadow-md border overflow-hidden">
      <Table className="w-full table-fixed">
        <TableHeader className="hidden md:table-header-group">
          <TableRow className="bg-muted/50">
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 min-w-0">Name</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-28">Status</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-28">Compute</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-28">Location</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-40">IP Address</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-40">Created</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600 w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <AnimatePresence mode="popLayout">
            {workers.length === 0 ? (
              <TableRow>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                  No workers yet. Click &quot;Create Worker&quot; to add one.
                </td>
              </TableRow>
            ) : (
              workers.map((worker) => (
                <WorkerItem
                  key={worker.id}
                  worker={worker}
                  isSelected={selectedId === worker.id}
                  isDeleting={deletingIds.has(worker.id)}
                  onSelect={() => onSelect(worker.id)}
                  onDelete={() => onDelete(worker.id)}
                  onCopyScript={() => onCopyScript(worker.id)}
                />
              ))
            )}
          </AnimatePresence>
        </TableBody>
      </Table>
    </div>
  );
}

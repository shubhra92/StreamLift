"use client";

import { AnimatePresence } from "motion/react";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DownloadItem } from "./DownloadItem";
import type { DownloadListProps } from "./types";
import { useCallback, useRef } from "react";
import { getDownloadById } from "@/app/actions/downloads";

export function DownloadList({
  downloads,
  setDownloads,
  downloadingFileId,
  progress,
  onSelect,
  onDelete,
  onEdit,
}: DownloadListProps) {
  const isCalled_getDownloadById = useRef<boolean>(false)
  const handleUpdateDownlodingItem = 
  // useCallback(
    async (itemIndex: number, itemId: string)=>{
    if(isCalled_getDownloadById.current) return null;
    isCalled_getDownloadById.current = true;

    console.log("heeeeyyyyy.....")
    const download = await getDownloadById(itemId)
    if(download) {
      downloads[itemIndex] = download
      setDownloads([...downloads])
    }
    isCalled_getDownloadById.current = false;
  }
  // ,[isItemUpdated,downloads])

  return (
    <div className="bg-card rounded-xl shadow-md border overflow-hidden">
      <Table>
        <TableHeader className="hidden md:table-header-group">
          <TableRow className="bg-muted/50">
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600">File Name</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600">File Size</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600">Location</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600">Status</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium text-gray-600">Created</TableHead>
            <TableHead className="px-4 py-3 text-sm font-medium w-[100px] text-gray-600"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <AnimatePresence mode="popLayout">
            {downloads.length === 0 ? (
              <TableRow>
                <TableCell className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No downloads yet. Click "Add Download" to create one.
                </TableCell>
              </TableRow>
            ) : (
              downloads.map((download, index) => (
                <DownloadItem
                  key={download.id}
                  index={index} 
                  download={download}
                  isDownloading={downloadingFileId === download.id}
                  progress={downloadingFileId === download.id ? progress : null}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  handleUpdateDownlodingItem={handleUpdateDownlodingItem}
                />
              ))
            )}
          </AnimatePresence>
        </TableBody>
      </Table>
    </div>
  );
}

function TableCell({ children, className, colSpan }: { children: React.ReactNode; className?: string; colSpan?: number }) {
  return <td className={className} colSpan={colSpan}>{children}</td>;
}

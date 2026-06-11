"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { FileVideo, FileAudio, FileImage, FileText, FileArchive, File, Check } from "lucide-react";

interface TorrentFile {
  index: number;
  name: string;
  path: string;
  size: number;
  sizeFormatted: string;
  type: string;
}

interface TorrentMetadata {
  name: string;
  infoHash: string;
  totalSize: number;
  totalSizeFormatted: string;
  files: TorrentFile[];
  fileCount: number;
}

interface TorrentFileSelectorProps {
  metadata: TorrentMetadata;
  onConfirm: (selectedIndices: number[], selectedFiles: TorrentFile[]) => void;
  onCancel: () => void;
  loading: boolean;
}

export function TorrentFileSelector({
  metadata,
  onConfirm,
  onCancel,
  loading,
}: TorrentFileSelectorProps) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    // Auto-select the largest file by default
    new Set([metadata.files[0]?.index])
  );

  const toggleFile = (index: number) => {
    const newSelected = new Set(selectedIndices);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedIndices(newSelected);
  };

  const selectAll = () => {
    setSelectedIndices(new Set(metadata.files.map(f => f.index)));
  };

  const deselectAll = () => {
    setSelectedIndices(new Set());
  };

  const getFileIcon = (type: string) => {
    switch (type) {
      case "video": return <FileVideo className="h-5 w-5 text-blue-500" />;
      case "audio": return <FileAudio className="h-5 w-5 text-purple-500" />;
      case "image": return <FileImage className="h-5 w-5 text-green-500" />;
      case "document": return <FileText className="h-5 w-5 text-orange-500" />;
      case "archive": return <FileArchive className="h-5 w-5 text-yellow-500" />;
      default: return <File className="h-5 w-5 text-gray-500" />;
    }
  };

  const selectedSize = metadata.files
    .filter(f => selectedIndices.has(f.index))
    .reduce((sum, f) => sum + f.size, 0);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-4">
      <div className="bg-accent/50 p-4 rounded-lg">
        <h3 className="font-semibold text-lg mb-2 break-words">{metadata.name}</h3>
        <div className="text-sm text-muted-foreground space-y-1">
          <p>Total Files: {metadata.fileCount}</p>
          <p>Total Size: {metadata.totalSizeFormatted}</p>
          <p className="text-blue-600 font-medium">
            Selected: {selectedIndices.size} file(s) ({formatBytes(selectedSize)})
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={selectAll}
          className="cursor-pointer"
        >
          Select All
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={deselectAll}
          className="cursor-pointer"
        >
          Deselect All
        </Button>
      </div>

      <div className="max-h-96 overflow-y-auto overflow-x-hidden border rounded-lg">
        <div className="divide-y">
          {metadata.files.map((file) => {
            const isSelected = selectedIndices.has(file.index);
            return (
              <motion.div
                key={file.index}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`p-3 cursor-pointer hover:bg-accent/50 transition-colors ${
                  isSelected ? "bg-blue-50 dark:bg-blue-950/20" : ""
                }`}
                onClick={() => toggleFile(file.index)}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex-shrink-0">
                    {getFileIcon(file.type)}
                  </div>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className="font-medium text-sm break-words">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{file.sizeFormatted}</p>
                  </div>
                  <div className="flex-shrink-0">
                    {isSelected && (
                      <div className="bg-blue-600 text-white rounded-full p-1">
                        <Check className="h-4 w-4" />
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col-reverse sm:flex-row gap-3">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={loading}
          className="flex-1 cursor-pointer"
        >
          Cancel
        </Button>
        <Button
          onClick={() => {
            const selected = metadata.files.filter(f => selectedIndices.has(f.index));
            onConfirm(Array.from(selectedIndices), selected);
          }}
          disabled={loading || selectedIndices.size === 0}
          className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
        >
          {loading ? "Starting..." : `Download ${selectedIndices.size} File(s)`}
        </Button>
      </div>
    </div>
  );
}

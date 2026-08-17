import type { FileDownload } from "@/app/db/schema";
import type { WorkerLocalFile } from "@/app/lib/workerConnection";
import type { WorkerFileTransfer } from "@/app/lib/sync-worker/workerProtocol";

export interface Progress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  percentFixed2: string | null;
  done?: boolean;
  error?: string;
}

export interface DownloadItemProps {
  download: FileDownload;
  isDownloading: boolean;
  /** True while the delete server action is in-flight for this row */
  isDeleting: boolean;
  /** True when this row's detail panel is open */
  isSelected: boolean;
  progress: Progress | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (file: FileDownload) => void;
  workerFiles?: WorkerLocalFile[];
  onDownloadWorkerFile?: (download: FileDownload, files: WorkerLocalFile[]) => void;
  workerFileTransfer?: WorkerFileTransfer;
}

export interface DownloadListProps {
  downloads: FileDownload[];
  downloadingFileId: string | null;
  /** ID of the row currently being deleted — shows spinner on its delete button */
  deletingId: string | null;
  /** ID of the row whose detail panel is currently open */
  selectedId: string | null;
  progress: Progress | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (file: FileDownload) => void;
  workerFilesByDownload: Record<string, WorkerLocalFile[]>;
  onDownloadWorkerFile: (download: FileDownload, files: WorkerLocalFile[]) => void;
  workerFileTransfers: Record<string, WorkerFileTransfer>;
}

export interface DownloadDetailsProps {
  download: FileDownload | null;
  isDownloading: boolean;
  progress: Progress | null;
  onClose: () => void;
  /** Ref forwarded to the panel element so the parent can detect outside clicks */
  panelRef?: React.RefObject<HTMLDivElement | null>;
}

export interface FileInfo {
  fileName: string;
  fileSize: number | null;
  fileType: string | null;
  fileExtension: string | null;
}

export interface AddDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string, location: string, fileName: string, fileInfo: FileInfo) => Promise<void>;
  loading: boolean;
  workers?: { id: string; name: string; online: boolean }[];
}

export interface EditDownloadModalProps {
  file: FileDownload | null;
  onClose: () => void;
  onSubmit: (id: string, data: { sourceUrl: string; fileName?: string; location: "server" | "cloud" | "mega" }) => Promise<void>;
  loading: boolean;
}

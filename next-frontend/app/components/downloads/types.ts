import type { FileDownload } from "@/app/db/schema";

export interface Progress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  percentFixed2: string | null;
  done?: boolean;
  error?: string;
}

export interface DownloadItemProps {
  index: number;
  download: FileDownload;
  isDownloading: boolean;
  progress: Progress | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (file: FileDownload) => void;
  handleUpdateDownlodingItem: (index:number, fileId: string) => void;
}

export interface DownloadListProps {
  downloads: FileDownload[];
  setDownloads: (files: FileDownload[]) => void;
  downloadingFileId: string | null;
  progress: Progress | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (file: FileDownload) => void;
}

export interface DownloadDetailsProps {
  download: FileDownload;
  isDownloading: boolean;
  progress: Progress | null;
  onClose: () => void;
}

export interface AddDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string, location: "server" | "mega", fileName?: string) => Promise<void>;
  loading: boolean;
  workers?: { id: string; name: string; online: boolean }[];
}

export interface EditDownloadModalProps {
  file: FileDownload | null;
  onClose: () => void;
  onSubmit: (id: string, data: { sourceUrl: string; fileName?: string; location: "server" | "mega" }) => Promise<void>;
  loading: boolean;
}

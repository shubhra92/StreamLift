import type { Worker } from "@/app/db/schema";
import type { WorkerStatus } from "@/app/hooks/useWorkerStatus";
import type { CreateWorkerData } from "@/app/service/workerService";

export type WorkerWithStatus = Omit<Worker, "lastHeartbeat" | "sessionTokenExpiry"> & {
  online:             boolean;
  ipAddress:          string | null;
  lastHeartbeat:      string | null;
  sessionTokenExpiry: string | null;
  totalUptime:        number;
};

export interface WorkerListProps {
  workers: WorkerWithStatus[];
  selectedId: string | null;
  deletingIds: Set<string>;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCopyScript: (id: string) => void;
}

export interface WorkerItemProps {
  worker: WorkerWithStatus;
  isSelected: boolean;
  isDeleting: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onCopyScript: () => void;
}

export interface WorkerDetailsProps {
  worker: WorkerWithStatus | null;
  status: WorkerStatus | null;
  onClose: () => void;
}

export interface AddWorkerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CreateWorkerData) => Promise<void>;
  loading: boolean;
}

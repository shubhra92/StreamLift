import type { Worker } from "@/app/db/schema";
import type { WorkerStatus } from "@/app/hooks/useWorkerStatus";
import type { CreateWorkerData, UpdateWorkerData } from "@/app/service/workerService";

export type WorkerWithStatus = Omit<Worker, "lastHeartbeat" | "sessionTokenExpiry"> & {
  online:               boolean;
  ipAddress:            string | null;
  lastHeartbeat:        string | null;
  sessionTokenExpiry:   string | null;
  totalUptime:          number;
};

export interface WorkerListProps {
  workers:      WorkerWithStatus[];
  selectedId:   string | null;
  deletingIds:  Set<string>;
  onSelect:     (id: string) => void;
  onDelete:     (id: string) => void;
  onCopyScript: (id: string) => void;
  onEdit:       (id: string) => void;
}

export interface WorkerItemProps {
  worker:       WorkerWithStatus;
  isSelected:   boolean;
  isDeleting:   boolean;
  onSelect:     () => void;
  onDelete:     () => void;
  onCopyScript: () => void;
  onEdit:       () => void;
}

export interface WorkerDetailsProps {
  worker:     WorkerWithStatus | null;
  status:     WorkerStatus | null;
  onClose:    () => void;
  onRelinked: () => void;
}

export interface ReLinkMegaDialogProps {
  worker:     WorkerWithStatus | null;
  isOpen:     boolean;
  onClose:    () => void;
  onRelinked: () => void;
}

export interface AddWorkerModalProps {
  isOpen:   boolean;
  onClose:  () => void;
  onSubmit: (data: CreateWorkerData) => Promise<void>;
  loading:  boolean;
}

export interface EditWorkerModalProps {
  isOpen:   boolean;
  worker:   WorkerWithStatus | null;
  onClose:  () => void;
  onSubmit: (data: UpdateWorkerData) => Promise<void>;
  loading:  boolean;
}

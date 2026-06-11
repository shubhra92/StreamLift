import type { Worker } from "@/app/db/schema";
import type { WorkerStatus } from "@/app/hooks/useWorkerStatus";
import type { CreateWorkerData } from "@/app/service/workerService";

export type WorkerWithStatus = Worker & {
  online: boolean;
  ipAddress: string | null;
  lastHeartbeat: string | null;
};

export interface WorkerListProps {
  workers: WorkerWithStatus[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCopyScript: (id: string) => void;
}

export interface WorkerItemProps {
  worker: WorkerWithStatus;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onCopyScript: () => void;
}

export interface WorkerDetailsProps {
  worker: WorkerWithStatus;
  status: WorkerStatus | null;
  onClose: () => void;
}

export interface AddWorkerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CreateWorkerData) => Promise<void>;
  loading: boolean;
}

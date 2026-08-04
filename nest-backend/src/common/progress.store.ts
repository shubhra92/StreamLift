export interface ProgressDetail {
  downloadedBytes: number | null;
  totalBytes: number | null;
  percentFixed2: string | number | null;
  percent: number | null;
  done?: boolean;
}

/**
 * In-memory map that tracks live download progress by file ID.
 * Shared across the progress module and download services.
 */
export const progressMap = new Map<string, ProgressDetail>();

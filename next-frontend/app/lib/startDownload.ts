/**
 * startDownload — fires the Express cloud download endpoint for a given file.
 *
 * Worker-location downloads are a no-op here: the worker picks up 'pending'
 * rows via heartbeat polling. This function only handles Express/cloud paths.
 */

import type { FileDownload } from "@/app/db/schema";

const serverDownloadEnabled = process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true";

/** Resolve "cloud" to the actual backend endpoint segment */
function resolveLocation(location: string): string {
  if (location === "cloud") return serverDownloadEnabled ? "server" : "cloud";
  // Backward compat: old DB rows stored "mega" before the rename
  if (location === "mega") return "cloud";
  return location;
}

export async function startDownload(
  fileDownload: FileDownload
): Promise<{ status: boolean; statusCode?: number; message: string; data?: { id: string } }> {
  const location = resolveLocation(fileDownload.location ?? "");

  // Worker downloads are handled by the worker itself via heartbeat polling.
  if (location.startsWith("worker-") || location === "all-workers") {
    return { status: true, message: "Download queued for worker", data: { id: fileDownload.id } };
  }

  try {
    const response = await fetch(`/api/stream-download/${location}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file_id:    fileDownload.id,
        source_url: fileDownload.sourceUrl,
        file_name:  fileDownload.fileName,
      }),
    });

    if (!response.ok) {
      const errMsg = await response.json();
      return {
        status:     false,
        statusCode: response.status,
        message:    errMsg.details ?? "Server error",
      };
    }

    const { data } = await response.json();
    return { status: true, message: "Download started", data };
  } catch (err: any) {
    return {
      status:  false,
      message: err?.message ?? "Client-side error starting download",
    };
  }
}

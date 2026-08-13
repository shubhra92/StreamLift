"use client";

import type { FileDownload } from "../db/schema";

const serverDownloadEnabled = process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true";

/** Resolve "cloud" to the actual backend endpoint segment */
function resolveLocation(location: string): string {
  if (location === "cloud") return serverDownloadEnabled ? "server" : "cloud";
  // Backward compat: old DB rows stored "mega" before the rename
  if (location === "mega") return "cloud";
  return location;
}

export default function useTorrentService() {
  const startDownload = async (fileDownload: FileDownload) => {
    try {
      // Parse file indices from the DB record (already stored during createTorrentDownload)
      const fileIndices = fileDownload.selectedFileIndices
        ? JSON.parse(fileDownload.selectedFileIndices as string)
        : undefined;

      const location = resolveLocation(fileDownload.location ?? "");

      const response = await fetch(`/api/torrent-download/${location}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          file_id:     fileDownload.id,
          magnet_link: fileDownload.sourceUrl,
          file_name:   fileDownload.fileName,
          file_indices: fileIndices,
        }),
      });

      if (!response.ok) {
        const errMsg = await response.json();
        return {
          status: false,
          statusCode: response.status,
          message: errMsg.details,
          errorType: "server",
        };
      }

      const { data } = await response.json();
      return { status: true, message: "torrent download started", data };
    } catch (err: any) {
      return {
        status: false,
        message: err?.message ?? "client side Service file error",
        errorType: "client",
      };
    }
  };

  return { startDownload };
}

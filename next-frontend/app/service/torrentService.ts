"use client";

import type { FileDownload } from "../db/schema";

export default function useTorrentService() {
  // POST method
  const startDownload = async (fileDownload: FileDownload, fileIndices?: number[]) => {
    try {
      const response = await fetch(`/api/torrent-download/${fileDownload.location}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          file_id: fileDownload.id,
          magnet_link: fileDownload.sourceUrl,
          file_name: fileDownload.fileName,
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
      return {
        status: true,
        message: "torrent download started",
        data: data,
      };
    } catch (err: any) {
      return {
        status: false,
        message: err?.message ?? "client side Service file error",
        errorType: "client",
      };
    }
  };

  return {
    startDownload,
  };
}

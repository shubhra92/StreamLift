"use client"

import type { FileDownload } from "../db/schema";

const serverDownloadEnabled = process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true";

/** Resolve "cloud" to the actual backend endpoint segment */
function resolveLocation(location: string): string {
    if (location === "cloud") return serverDownloadEnabled ? "server" : "mega";
    return location;
}

export default function useHomeService() {
    // POST method
    const startDownload = async ( fileDownload:FileDownload ) => {
        // Worker downloads are handled by the worker itself via heartbeat polling.
        // The download record is already in the DB with status "pending" and workerId set.
        // The worker will pick it up on the next heartbeat and report progress directly.
        const location = resolveLocation(fileDownload.location ?? "");
        if (location.startsWith("worker-") || location === "all-workers") {
            return {
                status: true,
                message: "Download queued for worker",
                data: { id: fileDownload.id },
            };
        }

        try {
            const response = await fetch(`/api/stream-download/${location}`,{
                method: "POST",
                headers: {
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    file_id: fileDownload.id,
                    source_url: fileDownload.sourceUrl,
                    file_name: fileDownload.fileName
                })
            })
            if(!response.ok) {
                const errMsg = await response.json()
                return {
                    status: false,
                    statusCode: response.status,
                    message: errMsg.details,
                    errorType: "server"
                }
            }

            const { data } = await response.json()
            return {
                status: true,
                message: "file downloading started",
                data:data,
            }
        } catch (err: any) {
            return {
                status: false,
                message: err?.message ?? "client side Service file error",
                errorType: "client"
            }
        }
    }

    return {
        startDownload
    }
}
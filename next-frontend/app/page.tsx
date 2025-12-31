"use client";

import { useState, useEffect } from "react";
import { useProgress } from "./hooks/useProgress";

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [fileStatusId, setFileStatusId] = useState<string | null>(null);
  const [location, setLocation] = useState<"server" | "mega">("server");

  const { progress, error, isDone } = useProgress(fileStatusId);

  // Handle progress updates
  useEffect(() => {
    if (isDone) {
      setStatus("Download completed 🎉");
    }
    if (error) {
      setStatus(`Progress error: ${error} ❌`);
    }
  }, [isDone, error]);

  const startStreaming = async () => {
    if (!url) {
      setStatus("Please enter a valid URL");
      return;
    }

    setStatus("Starting streaming...");
    setFileStatusId(null);

    try {
      const res = await fetch(`/api/stream-download/${location}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) throw new Error("Failed");

      const { data } = await res.json();
      setStatus("Streaming started 🚀");
      setFileStatusId(data.fileStatusId);
    } catch (err) {
      setStatus("Error starting stream ❌");
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-6 rounded-xl shadow-md w-full max-w-xl">
        <h1 className="text-2xl font-bold mb-4 text-black">
          Stream Upload App
        </h1>

        <input
          type="text"
          placeholder="Paste downloadable file URL here"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full p-3 border rounded mb-4 text-black"
        />

        <select
          value={location}
          onChange={(e) => setLocation(e.target.value as "server" | "mega")}
          className="w-full p-3 border rounded mb-4 text-black bg-white"
        >
          <option value="server">Server</option>
          <option value="mega">Mega</option>
        </select>

        <button
          onClick={startStreaming}
          className="w-full bg-blue-600 text-white p-3 rounded hover:bg-blue-700"
        >
          Start Streaming Upload
        </button>

        {status && (
          <p className="mt-4 text-sm text-gray-700">
            {status}
          </p>
        )}

        {progress && (
          <div className="mt-4">
            <div className="w-full bg-gray-200 rounded h-3">
              <div
                className="bg-green-600 h-3 rounded"
                style={{ width: `${progress.percent ?? 0}%` }}
              />
            </div>
            <p className="mt-2 text-sm text-gray-700">
              Progress: {progress.percentFixed2 ?? '0.00'}%
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

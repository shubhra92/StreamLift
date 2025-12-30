"use client";

import { useRef, useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [location, setLocation] = useState<"server" | "mega">("server")

  const startStreaming = async () => {
    if (!url) {
      setStatus("Please enter a valid URL");
      return;
    }

    setStatus("Starting streaming...");
    setProgress(0);


    try {
      const res = await fetch(`/api/stream-download/${location}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) throw new Error("Failed");


      const {data} = await res.json();
      setStatus("Streaming started 🚀");

      // 🔥 START LISTENING TO PROGRESS HERE
      const es = new EventSource(`/api/progress/${data.fileStatusId}`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (typeof data.percent === "number") {
          setProgress(data.percent);
        }

        if (data.done) {
          setStatus("Download completed 🎉");
          es.close();
        }
      }

      es.onerror = () => {
        setStatus("Progress connection lost ❌");
        es.close();
      };


      // setStatus("Streaming started successfully 🚀");
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

        {progress !== null && (
          <div className="mt-4">
            <div className="w-full bg-gray-200 rounded h-3">
              <div
                className="bg-green-600 h-3 rounded"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-2 text-sm text-gray-700">
              Progress: {progress}%
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

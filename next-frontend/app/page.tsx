"use client";

import { useState, useEffect } from "react";
import { useProgress } from "./hooks/useProgress";
import { createDownload, getDownloads, deleteDownload, updateDownload } from "./actions/downloads";
import type { FileDownload } from "./db/schema";
import useHomeService from "./service/homeService";

export default function Home() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [location, setLocation] = useState<"server" | "mega">("server");
  const [downloads, setDownloads] = useState<FileDownload[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<FileDownload | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editFileName, setEditFileName] = useState("");
  const [editLocation, setEditLocation] = useState<"server" | "mega">("server");
  const homeService = useHomeService()

  const { progress, isDone } = useProgress(downloadingFileId);

  const fetchDownloads = async () => {
      const data = await getDownloads();
      setDownloads(data);

      let targetFile = null;
      let targetStatus = new Set(["downloading", "pending"])

      for (let f of data) {
        if (!targetStatus.has(f.status!))
          continue

        if (f.status === "downloading") {
          targetFile = f;
          break
        }
        if (!targetFile) {
          targetFile = f;
          continue
        }

        // check updatedAt of f older then targetFile
        const isOlder = new Date(f.updatedAt!) < new Date(targetFile.updatedAt!);
        if (isOlder) {
          targetFile = f
        }
      }


      if(targetFile?.status === "pending"){
        const {status,message} = await homeService.startDownload(targetFile)
        if(!status){
          console.log("-----msg from page-----\n")
          console.log(message)
          console.log("\n-----msg from page-----")
        } else {
          // Just set the downloading file ID, don't recursively fetch
          setDownloadingFileId(targetFile.id)
        }
      } else if(targetFile){
        setDownloadingFileId(targetFile.id)
      } else {
        setDownloadingFileId(null)
      }
  };

  useEffect(() => {
    if (downloadingFileId === null || isDone) {
      fetchDownloads();
    }
  }, [isDone]);

  const handleAddDownload = async () => {
    if (!url) return;
    setLoading(true);
    try {
      await createDownload(url, location, fileName || undefined);
      setUrl("");
      setFileName("");
      setIsModalOpen(false);
      fetchDownloads();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const result = await deleteDownload(id);
    if (result.success) {
      fetchDownloads();
    } else {
      alert(result.message);
    }
    setMenuOpenId(null);
  };

  const openEditModal = (file: FileDownload) => {
    setEditingFile(file);
    setEditUrl(file.sourceUrl);
    setEditFileName(file.fileName || "");
    setEditLocation((file.location as "server" | "mega") || "server");
    setMenuOpenId(null);
  };

  const handleEditSubmit = async () => {
    if (!editingFile || !editUrl) return;
    setLoading(true);
    try {
      const result = await updateDownload(editingFile.id, {
        sourceUrl: editUrl,
        fileName: editFileName || undefined,
        location: editLocation,
      });
      if (result.success) {
        setEditingFile(null);
        fetchDownloads();
      } else {
        alert(result.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "-";
    return new Date(date).toLocaleString();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getStatusColor = (status: string | null) => {
    switch (status) {
      case "completed": return "bg-green-100 text-green-800";
      case "downloading": case "uploading": return "bg-blue-100 text-blue-800";
      case "failed": return "bg-red-100 text-red-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-black">Download Manager</h1>
          <button
            onClick={() => setIsModalOpen(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            + Add Download
          </button>
        </div>

        {/* Downloads List */}
        <div className="bg-white rounded-xl shadow-md">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 rounded-tl-xl">File Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">File Size</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Location</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">Created</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-600 rounded-tr-xl"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {downloads.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No downloads yet. Click "Add Download" to create one.
                  </td>
                </tr>
              ) : (
                downloads.map((download) => (
                  <tr
                    key={download.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => setSelectedId(download.id)}
                  >
                    <td className="px-4 py-3 text-sm text-gray-900 max-w-xs truncate">
                      {download.fileName || "-"}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {download.fileSize ? formatFileSize(download.fileSize) : "-"}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 capitalize">
                      {download.location || "-"}
                    </td>
                    <td className="px-4 py-3">
                      {downloadingFileId ===  download.id ? (
                        <div className="w-full bg-gray-200 rounded h-3">
                          <div
                            className="bg-green-600 h-3 rounded transition-all"
                            style={{ width: `${progress?.percent ?? 0}%` }}
                          />
                        </div>
                      ) : (
                        <span className={`px-2 py-1 text-xs rounded-full ${getStatusColor(download.status)}`}>
                          {download.status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatDate(download.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {download.status !== "downloading" && downloadingFileId !== download.id && (
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(menuOpenId === download.id ? null : download.id);
                            }}
                            className="p-1 hover:bg-gray-200 rounded"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                            </svg>
                          </button>
                          {menuOpenId === download.id && (
                            <div className="absolute right-0 bottom-full mb-1 w-32 bg-white border rounded shadow-lg z-50">
                              {download.status === "pending" && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openEditModal(download);
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 text-gray-700"
                                >
                                  Edit
                                </button>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(download.id);
                                }}
                                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 text-red-600"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Selected file details */}
        {selectedId && (() => {
          const selectedFile = downloads.find(d => d.id === selectedId);
          if (!selectedFile) return null;
          const isDownloading = downloadingFileId === selectedId;
          
          return (
            <div className="mt-4 bg-white p-5 rounded-xl shadow-md">
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-lg font-semibold text-gray-900">File Details</h3>
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">File Name</p>
                  <p className="text-gray-900 font-medium break-all">{selectedFile.fileName || "-"}</p>
                </div>
                <div>
                  <p className="text-gray-500">File Size</p>
                  <p className="text-gray-900 font-medium">{selectedFile.fileSize ? formatFileSize(selectedFile.fileSize) : "-"}</p>
                </div>
                <div>
                  <p className="text-gray-500">File Type</p>
                  <p className="text-gray-900 font-medium">{selectedFile.fileType || "-"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Status</p>
                  <span className={`px-2 py-1 text-xs rounded-full ${getStatusColor(selectedFile.status)}`}>
                    {selectedFile.status}
                  </span>
                </div>
                <div>
                  <p className="text-gray-500">Location</p>
                  <p className="text-gray-900 font-medium capitalize">{selectedFile.location || "-"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Location Path</p>
                  <p className="text-gray-900 font-medium break-all">{selectedFile.locationPath || "-"}</p>
                </div>
                <div>
                  <p className="text-gray-500">Created At</p>
                  <p className="text-gray-900 font-medium">{formatDate(selectedFile.createdAt)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Updated At</p>
                  <p className="text-gray-900 font-medium">{formatDate(selectedFile.updatedAt)}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-gray-500">Source URL</p>
                  <div className="flex items-start gap-2">
                    <p className="text-gray-900 font-medium break-all text-xs flex-1">{selectedFile.sourceUrl}</p>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(selectedFile.sourceUrl);
                      }}
                      className="text-gray-400 hover:text-blue-600 p-1 shrink-0 cursor-pointer"
                      title="Copy URL"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                  </div>
                </div>
                {selectedFile.errorMessage && (
                  <div className="col-span-2">
                    <p className="text-gray-500">Error</p>
                    <p className="text-red-600 font-medium">{selectedFile.errorMessage}</p>
                  </div>
                )}
              </div>

              {/* Progress bar for downloading file */}
              {isDownloading && progress && (
                <div className="mt-4 pt-4 border-t">
                  <p className="text-sm text-gray-700 mb-2">Download Progress: {progress?.percentFixed2 ?? '0.00'}%</p>
                  <div className="w-full bg-gray-200 rounded h-3">
                    <div
                      className="bg-green-600 h-3 rounded transition-all"
                      style={{ width: `${progress?.percent ?? 0}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-xl shadow-lg w-full max-w-md">
            <h2 className="text-xl font-bold mb-4 text-black">Add New Download</h2>
            
            <input
              type="text"
              placeholder="Paste downloadable file URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full p-3 border rounded mb-4 text-black"
            />

            <input
              type="text"
              placeholder="File name (optional)"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
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

            <div className="flex gap-3">
              <button
                onClick={() => setIsModalOpen(false)}
                className="flex-1 p-3 border rounded hover:bg-gray-50 text-black"
              >
                Cancel
              </button>
              <button
                onClick={handleAddDownload}
                disabled={loading || !url}
                className="flex-1 bg-blue-600 text-white p-3 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-xl shadow-lg w-full max-w-md">
            <h2 className="text-xl font-bold mb-4 text-black">Edit Download</h2>
            
            <input
              type="text"
              placeholder="Paste downloadable file URL"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              className="w-full p-3 border rounded mb-4 text-black"
            />

            <input
              type="text"
              placeholder="File name (optional)"
              value={editFileName}
              onChange={(e) => setEditFileName(e.target.value)}
              className="w-full p-3 border rounded mb-4 text-black"
            />

            <select
              value={editLocation}
              onChange={(e) => setEditLocation(e.target.value as "server" | "mega")}
              className="w-full p-3 border rounded mb-4 text-black bg-white"
            >
              <option value="server">Server</option>
              <option value="mega">Mega</option>
            </select>

            <div className="flex gap-3">
              <button
                onClick={() => setEditingFile(null)}
                className="flex-1 p-3 border rounded hover:bg-gray-50 text-black"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSubmit}
                disabled={loading || !editUrl}
                className="flex-1 bg-blue-600 text-white p-3 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

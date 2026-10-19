export const formatDate = (date: Date | null) => {
  if (!date) return "-";
  return new Date(date).toLocaleString();
};

export const formatFileSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

export const getStatusVariant = (status: string | null): "default" | "secondary" | "destructive" | "outline" => {
  switch (status) {
    case "completed": return "default";
    case "downloading": case "uploading": return "secondary";
    case "failed": return "destructive";
    default: return "outline";
  }
};

export const getStatusClass = (status: string | null) => {
  switch (status) {
    case "completed": return "bg-green-100 text-green-800";
    case "downloading": case "uploading": return "bg-blue-100 text-blue-800";
    case "failed": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-800";
  }
}

export const getTypeClass = (type: string | null | undefined) => {
  const t = (type || "http").toLowerCase();
  switch (t) {
    // case "http": return "bg-purple-100 text-purple-800";
    // case "torrent": return "bg-amber-100 text-amber-800";
    case "http": return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300";
    case "torrent": return "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300";
    default: return "bg-slate-100 text-slate-700";
  }
}

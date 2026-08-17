export function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatUptime(seconds: number): string {
  if (!seconds) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function logLevelClass(level: string): string {
  switch (level) {
    case "error":   return "text-red-500";
    case "warning": return "text-yellow-500";
    case "debug":   return "text-muted-foreground";
    default:        return "text-foreground";
  }
}

export const MINIMUM_WORKER_VERSION = "1.0.0";

export function isVersionOutdated(version: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [ma, mi, pa] = parse(version);
  const [mb, mib, pb] = parse(MINIMUM_WORKER_VERSION);
  if (ma !== mb) return ma < mb;
  if (mi !== mib) return mi < mib;
  return pa < pb;
}

/** Convert an ISO 3166-1 alpha-2 country code to its flag emoji. */
export function countryFlag(countryCode: string | null | undefined): string | null {
  if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return null;
  return String.fromCodePoint(
    ...countryCode.toUpperCase().split("").map((letter) => 0x1F1E6 + letter.charCodeAt(0) - 65),
  );
}

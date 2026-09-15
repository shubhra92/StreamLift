"use client";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";

const serverDownloadEnabled = process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true";
const cloudLocation = serverDownloadEnabled ? "server" : "cloud";
const cloudLabel = serverDownloadEnabled ? "Cloud (Server)" : "Cloud";

export interface WorkerOption {
  id: string;
  name: string;
  online: boolean;
}

/** Human-readable label for a stored location value (shared by pickers + read-only badges). */
export function locationName(loc: string, workers: WorkerOption[] = []): string {
  if (loc.startsWith("worker-")) {
    const w = workers.find((x) => x.id === loc.slice("worker-".length));
    return w ? w.name : "Worker";
  }
  if (loc === "server") return cloudLabel;
  if (loc === "cloud" || loc === "mega") return "Cloud";
  if (loc === "all-workers") return "All Workers (auto-assign)";
  return loc;
}

/** Tailwind dot color for a location badge — workers only, by online status; null means no dot. */
export function locationDotClass(loc: string, workers: WorkerOption[] = []): string | null {
  if (!loc.startsWith("worker-")) return null;
  const online = workers.some((w) => w.id === loc.slice("worker-".length) && w.online);
  return online ? "bg-green-500" : "bg-gray-400";
}

interface LocationSelectProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /** Workers list — passed from parent (comes from useWorkers/IDB, not fetched here) */
  workers?: WorkerOption[];
}

export function LocationSelect({ value, onChange, className, workers = [] }: LocationSelectProps) {
  // "cloud" is the UI value; resolve to the actual backend value on change
  const handleChange = (val: string) => {
    if (val === "cloud") {
      onChange(cloudLocation);
    } else {
      onChange(val);
    }
  };

  // Map the actual stored value back to "cloud" for display
  const displayValue =
    value === "cloud" || value === "mega" || value === "server" ? "cloud" : value;

  return (
    <Select value={displayValue} onValueChange={handleChange}>
      <SelectTrigger
        className={
          className ??
          "w-full bg-background text-foreground"
        }
      >
        <SelectValue placeholder="Select location" />
      </SelectTrigger>

      <SelectContent>
        <SelectItem value="cloud">
          {cloudLabel}
        </SelectItem>

        {workers.length > 0 && (
          <>
            <SelectItem value="all-workers">
              All Workers (auto-assign)
            </SelectItem>

            <SelectGroup>
              <SelectLabel>Specific Worker</SelectLabel>

              {workers.map((w) => (
                <SelectItem
                  key={w.id}
                  value={`worker-${w.id}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        w.online ? "bg-green-500" : "bg-gray-400"
                      }`}
                    />
                    <span>{w.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

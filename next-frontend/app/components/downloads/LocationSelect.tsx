"use client";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect, useState } from "react";

const serverDownloadEnabled = process.env.NEXT_PUBLIC_SERVER_DOWNLOAD_ENABLED === "true";
const cloudLocation = serverDownloadEnabled ? "server" : "mega";
const cloudLabel = serverDownloadEnabled ? "Cloud (Server)" : "Cloud";

interface WorkerOption {
  id: string;
  name: string;
  online: boolean;
}

interface LocationSelectProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function LocationSelect({ value, onChange, className }: LocationSelectProps) {
  const [workers, setWorkers] = useState<WorkerOption[]>([]);

  useEffect(() => {
    fetch("/api/worker/list")
      .then((r) => r.json())
      .then((result) => {
        if (result.success && Array.isArray(result.data)) {
          setWorkers(
            result.data.map((w: any) => ({
              id: w.id,
              name: w.name,
              online: w.online,
            }))
          );
        }
      })
      .catch(() => {
        // silently ignore — workers section just won't show
      });
  }, []);

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
    value === "mega" || value === "server" ? "cloud" : value;

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
                      className={`h-2.5 w-2.5 rounded-full ${w.online
                          ? "bg-green-500"
                          : "bg-gray-400"
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
  )
}

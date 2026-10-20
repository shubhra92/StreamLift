"use client";

import { Film, Music, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/app/components/downloads/utils";
import type { WatchFile, WatchGroup } from "./types";

interface Props {
  group: WatchGroup;
  onPlay: (file: WatchFile) => void;
}

export function WatchWorkerSection({ group, onPlay }: Props) {
  const { worker, files } = group;

  return (
    <section className="rounded-lg border bg-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-muted/40">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden="true" />
          <h3 className="text-sm font-semibold truncate">{worker.name}</h3>
          <span className="text-xs text-muted-foreground shrink-0">
            Local storage
          </span>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
      </header>

      <ul>
        {files.map((file) => (
          <li
            key={`${file.downloadId}:${file.index}`}
            className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {file.kind === "video" ? (
                <Film className="h-4 w-4" />
              ) : (
                <Music className="h-4 w-4" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={file.name}>
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(file.size)}
                {file.kind === "audio" ? " · Audio" : " · Video"}
              </p>
            </div>

            <Button
              size="sm"
              onClick={() => onPlay(file)}
              className="bg-blue-600 hover:bg-blue-700 shrink-0"
            >
              <Play className="h-4 w-4" />
              Play
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

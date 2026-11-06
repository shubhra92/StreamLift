"use client";

import { Cloud, Film, Loader2, Music, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/app/components/downloads/utils";
import type { WatchItemDto } from "@/app/lib/watchTypes";

interface Props {
  items: WatchItemDto[];
  onPlay: (item: WatchItemDto) => void;
  onDelete: (item: WatchItemDto) => void;
  deletingIds?: Set<string>;
}

function providerLabel(provider: string): string {
  return provider === "mega" ? "MEGA" : provider.toUpperCase();
}

export function CloudWatchSection({ items, onPlay, onDelete, deletingIds }: Props) {
  if (items.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-muted/40">
        <div className="flex items-center gap-2 min-w-0">
          <Cloud className="h-4 w-4 shrink-0 text-blue-500" />
          <h3 className="text-sm font-semibold truncate">Cloud storage</h3>
          <span className="text-xs text-muted-foreground shrink-0">
            {providerLabel(items[0]?.provider ?? "cloud")}
          </span>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {items.length} {items.length === 1 ? "file" : "files"}
        </span>
      </header>

      <ul>
        {items.map((item) => {
          const deleting = deletingIds?.has(item.id) ?? false;
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {item.kind === "video" ? (
                  <Film className="h-4 w-4" />
                ) : (
                  <Music className="h-4 w-4" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={item.name}>
                  {item.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.fileSize != null ? formatFileSize(item.fileSize) : "Unknown size"}
                  {item.kind === "audio" ? " · Audio" : " · Video"}
                  {" · "}
                  {providerLabel(item.provider)}
                </p>
              </div>

              <Button
                size="icon"
                variant="ghost"
                disabled={deleting}
                onClick={() => onDelete(item)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title="Remove from Watch page (the cloud file stays)"
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                <span className="sr-only">Remove from Watch page</span>
              </Button>

              <Button
                size="sm"
                onClick={() => onPlay(item)}
                className="bg-blue-600 hover:bg-blue-700 shrink-0"
              >
                <Play className="h-4 w-4" />
                Play
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, MonitorPlay } from "lucide-react";
import { useWatchMedia } from "../hooks/useWatchMedia";
import {
  ConnectToTvButton,
  MediaPlayerDialog,
  RenderDialog,
  WatchWorkerSection,
} from "../components/watch";
import { OfflineBanner } from "../components/OfflineBanner";
import type { WatchFile } from "../components/watch/types";

interface Selection {
  workerId: string;
  workerName: string;
  file: WatchFile;
}

export default function WatchPage() {
  const { groups, loading, networkStatus } = useWatchMedia();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [renderSelection, setRenderSelection] = useState<Selection | null>(null);

  return (
    <main className="flex h-full flex-col bg-background">
      <div className="flex-1 min-h-0 overflow-y-auto w-full">
        <div className="max-w-5xl mx-auto px-4 md:px-6 pt-4 md:pt-6 pb-6">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 flex items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <h2 className="text-xl md:text-2xl font-bold">Watch</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Play video and audio files stored on your online workers
              </p>
            </div>
            <ConnectToTvButton />
          </motion.div>

          <OfflineBanner networkStatus={networkStatus} />

          <div className="h-4 md:h-6" />

          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
              <Loader2 className="h-7 w-7 animate-spin" />
              <p className="text-sm">Looking for playable files on your workers…</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-20 text-center">
              <MonitorPlay className="h-10 w-10 text-muted-foreground" />
              <p className="font-medium">Nothing to watch yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Download a video or audio file to an online worker and it will appear
                here automatically.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <WatchWorkerSection
                  key={group.worker.id}
                  group={group}
                  onPlay={(file) =>
                    setSelection({
                      workerId: group.worker.id,
                      workerName: group.worker.name,
                      file,
                    })
                  }
                  onRender={(file) =>
                    setRenderSelection({
                      workerId: group.worker.id,
                      workerName: group.worker.name,
                      file,
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <MediaPlayerDialog
        workerId={selection?.workerId ?? null}
        workerName={selection?.workerName}
        file={selection?.file ?? null}
        files={
          selection
            ? groups.find((group) => group.worker.id === selection.workerId)?.files ?? []
            : []
        }
        onChangeFile={(file) => {
          if (!selection) return;
          setSelection({ ...selection, file });
        }}
        onClose={() => setSelection(null)}
      />

      <RenderDialog
        open={Boolean(renderSelection)}
        onOpenChange={(open) => {
          if (!open) setRenderSelection(null);
        }}
        workerId={renderSelection?.workerId ?? null}
        workerName={renderSelection?.workerName}
        file={renderSelection?.file ?? null}
      />
    </main>
  );
}

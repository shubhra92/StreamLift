"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Cloud, HardDrive, Loader2, MonitorPlay } from "lucide-react";
import { useWatchMedia } from "../hooks/useWatchMedia";
import { useWatchItems } from "../hooks/useWatchItems";
import { deleteWatchItem } from "../actions/watchItems";
import {
  CloudMediaPlayerDialog,
  CloudWatchSection,
  ConnectToTvButton,
  MediaPlayerDialog,
  RenderDialog,
  WatchWorkerSection,
} from "../components/watch";
import { OfflineBanner } from "../components/OfflineBanner";
import type { WatchFile } from "../components/watch/types";
import type { WatchItemDto } from "../lib/watchTypes";

interface Selection {
  workerId: string;
  workerName: string;
  file: WatchFile;
}

function GroupHeading({
  icon,
  title,
  count,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      {icon}
      <h3 className="text-sm font-semibold">{title}</h3>
      <span className="text-xs text-muted-foreground">
        {count} {count === 1 ? "file" : "files"}
      </span>
    </div>
  );
}

export default function WatchPage() {
  const { groups, loading, networkStatus } = useWatchMedia();
  const {
    items: cloudItems,
    loading: cloudLoading,
    refresh: refreshWatchItems,
  } = useWatchItems();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cloudSelection, setCloudSelection] = useState<WatchItemDto | null>(null);
  const [renderSelection, setRenderSelection] = useState<Selection | null>(null);
  const [deletingWatchIds, setDeletingWatchIds] = useState<Set<string>>(new Set());

  const workerFileCount = groups.reduce((total, group) => total + group.files.length, 0);
  // Don't hide already-loaded cloud items behind a slow worker scan.
  const showInitialLoader =
    cloudLoading || (loading && groups.length === 0 && cloudItems.length === 0);
  const isEmpty = !loading && !cloudLoading && groups.length === 0 && cloudItems.length === 0;

  const handleDeleteWatchItem = async (item: WatchItemDto) => {
    const confirmed = window.confirm(
      `Remove "${item.name}" from the Watch page?\n\nThe cloud file and share link will stay in storage.`,
    );
    if (!confirmed) return;

    setDeletingWatchIds((prev) => new Set(prev).add(item.id));
    try {
      const result = await deleteWatchItem(item.id);
      if (!result.success) {
        alert(result.message ?? "Could not remove this Watch item");
        return;
      }
      if (cloudSelection?.id === item.id) setCloudSelection(null);
      await refreshWatchItems();
    } catch (error: any) {
      alert(error?.message ?? "Could not remove this Watch item");
    } finally {
      setDeletingWatchIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

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
                Play files from your workers and saved cloud storage
              </p>
            </div>
            <ConnectToTvButton />
          </motion.div>

          <OfflineBanner networkStatus={networkStatus} />

          <div className="h-4 md:h-6" />

          {showInitialLoader ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
              <Loader2 className="h-7 w-7 animate-spin" />
              <p className="text-sm">Loading your Watch library…</p>
            </div>
          ) : isEmpty ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-20 text-center">
              <MonitorPlay className="h-10 w-10 text-muted-foreground" />
              <p className="font-medium">Nothing to watch yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Download a video or audio file to an online worker, or add a completed
                cloud download from the Downloads page.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {(groups.length > 0 || loading) && (
                <section className="space-y-3">
                  <GroupHeading
                    icon={<HardDrive className="h-4 w-4 text-muted-foreground" />}
                    title="Worker local"
                    count={workerFileCount}
                  />
                  {loading && groups.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Looking for files on your workers…
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
                </section>
              )}

              {cloudItems.length > 0 && (
                <section className="space-y-3">
                  <GroupHeading
                    icon={<Cloud className="h-4 w-4 text-blue-500" />}
                    title="Cloud"
                    count={cloudItems.length}
                  />
                  <CloudWatchSection
                    items={cloudItems}
                    onPlay={setCloudSelection}
                    onDelete={(item) => void handleDeleteWatchItem(item)}
                    deletingIds={deletingWatchIds}
                  />
                </section>
              )}
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

      <CloudMediaPlayerDialog
        item={cloudSelection}
        items={cloudItems}
        onChangeItem={setCloudSelection}
        onClose={() => setCloudSelection(null)}
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

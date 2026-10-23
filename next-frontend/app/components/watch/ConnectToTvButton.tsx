"use client";

import { useEffect, useState } from "react";
import { Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTvDevices } from "@/app/hooks/useTvDevices";
import { ConnectToTvDialog } from "./ConnectToTvDialog";

/**
 * Header action for the watch page. Also supports the optional deep link
 * `/watch?tv=ABC-DEF` (used by the QR code on the TV) by opening the dialog
 * with the code pre-filled.
 */
export function ConnectToTvButton() {
  const { devices, loading, error, refresh } = useTvDevices();
  const [open, setOpen] = useState(false);
  const [initialCode, setInitialCode] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("tv");
    if (!code) return;

    setInitialCode(code);
    setOpen(true);

    // The code is a one-shot deep link; do not reopen it on refresh.
    url.searchParams.delete("tv");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const online = devices.filter((device) => device.online);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setInitialCode("");
          setOpen(true);
        }}
        className="shrink-0 gap-2"
        title={
          online.length > 0
            ? `${online.length} TV${online.length === 1 ? "" : "s"} connected`
            : "Connect an Android TV"
        }
      >
        <Tv className="h-4 w-4" />
        <span className="hidden sm:inline">
          {online.length > 0 ? "TV connected" : "Connect to TV"}
        </span>
        <span className="sm:hidden">TV</span>
        {online.length > 0 && (
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
        )}
      </Button>

      <ConnectToTvDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setInitialCode("");
        }}
        devices={devices}
        loading={loading}
        devicesError={error}
        onRefresh={() => void refresh()}
        initialCode={initialCode}
      />
    </>
  );
}

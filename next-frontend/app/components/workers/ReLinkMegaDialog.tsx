"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { megaLogin } from "@/app/lib/megaLogin";
import type { ReLinkMegaDialogProps } from "./types";

/**
 * Re-links a session-only worker whose Mega session was invalidated.
 * The Mega password is entered here in the browser and never leaves the
 * client — only the fresh session JSON is sent to the backend.
 */
export function ReLinkMegaDialog({ worker, isOpen, onClose, onRelinked }: ReLinkMegaDialogProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && worker) {
      setEmail(worker.megaEmail ?? "");
      setPassword("");
      setLoggingIn(false);
      setSubmitting(false);
      setError(null);
    }
  }, [isOpen, worker?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    if (!worker) return;
    if (!email.trim() || !password) {
      setError("Enter the Mega email and password for this account.");
      return;
    }

    setLoggingIn(true);
    setError(null);
    let session: object;
    try {
      session = await megaLogin(email.trim(), password);
    } catch (err: any) {
      setError(err?.message ?? "Mega login failed. Check your credentials.");
      setLoggingIn(false);
      return;
    }
    setLoggingIn(false);

    setSubmitting(true);
    try {
      const res = await fetch(`/api/worker/${worker.id}/mega-session`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), sessionData: JSON.stringify(session) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.message ?? "Failed to save the new session.");
        return;
      }
      onRelinked();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Re-link Mega Account</DialogTitle>
          <DialogDescription>
            {worker?.megaRelinkReason
              ? `The worker's Mega session is no longer valid: ${worker.megaRelinkReason}.`
              : "The worker's Mega session is no longer valid."}{" "}
            Sign in again to refresh it. Your password is handled in the browser and never stored.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <input
              type="email"
              placeholder="Mega email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <input
              type="password"
              placeholder="Mega password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex flex-col-reverse sm:flex-row gap-3">
            <Button variant="outline" onClick={onClose} disabled={submitting} className="flex-1 cursor-pointer">
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={loggingIn || submitting}
              className="flex-1 bg-blue-600 hover:bg-blue-700 cursor-pointer"
            >
              {loggingIn ? "Logging into Mega..." : submitting ? "Saving session..." : "Re-link"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground text-center">
            Mega login happens in your browser — the password is never sent to the server.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  Lock,
  LogIn,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthCard } from "@/app/components/auth/AuthCard";
import { AuthField } from "@/app/components/auth/AuthField";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(typeof data?.message === "string" ? data.message : "Unable to sign in.");
        setLoading(false);
        return;
      }

      // Full navigation so the in-memory guest cache and the IDB guard reset.
      window.location.assign(next);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  const registerHref = next === "/" ? "/register" : `/register?next=${encodeURIComponent(next)}`;

  return (
    <AuthCard
      eyebrow="Welcome back"
      title="Sign in to StreamLift"
      subtitle="Pick up where you left off — your downloads, workers and paired TVs are waiting."
      footer={
        <div className="space-y-5">
          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link
              href={registerHref}
              className="font-medium text-blue-600 underline-offset-4 transition-colors hover:text-blue-500 hover:underline"
            >
              Create an account
            </Link>
          </p>

          <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/60">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>

          <Link
            href="/"
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border bg-background/60 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Continue as guest
          </Link>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthField
          id="login-email"
          label="Email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="email"
          placeholder="you@example.com"
          autoFocus
          required
          disabled={loading}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          icon={<Mail className="h-[18px] w-[18px]" />}
        />

        <AuthField
          id="login-password"
          label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="Your password"
          revealable
          required
          disabled={loading}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          icon={<Lock className="h-[18px] w-[18px]" />}
        />

        {error ? (
          <div
            role="alert"
            className="flex animate-in fade-in-0 slide-in-from-top-1 items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive duration-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Button
          type="submit"
          size="lg"
          disabled={loading}
          aria-busy={loading}
          className="h-11 w-full rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-600/20 transition-all hover:from-blue-500 hover:to-indigo-500 hover:shadow-blue-600/25"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="h-4 w-4" />
          )}
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthCard>
  );
}

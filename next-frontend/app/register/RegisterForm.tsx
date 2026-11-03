"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Loader2,
  Lock,
  Mail,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthCard } from "@/app/components/auth/AuthCard";
import { AuthField } from "@/app/components/auth/AuthField";
import { cn } from "@/lib/utils";

const STRENGTH = [
  { label: "Too short", bar: "bg-red-500", text: "text-red-500" },
  { label: "Weak", bar: "bg-red-500", text: "text-red-500" },
  { label: "Fair", bar: "bg-amber-500", text: "text-amber-600" },
  { label: "Good", bar: "bg-blue-500", text: "text-blue-600" },
  { label: "Strong", bar: "bg-emerald-500", text: "text-emerald-600" },
] as const;

/** 0–4 score used by the strength meter (capped so it maps to STRENGTH). */
function passwordScore(password: string): number {
  if (!password) return 0;
  const checks = [
    password.length >= 8,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password) || /[^A-Za-z0-9]/.test(password),
    password.length >= 12,
  ];
  return Math.min(4, checks.filter(Boolean).length) as 0 | 1 | 2 | 3 | 4;
}

export function RegisterForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          typeof data?.message === "string"
            ? data.message
            : "Unable to create your account.",
        );
        setLoading(false);
        return;
      }

      // Full navigation so the in-memory guest cache updates.
      window.location.assign(next);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  const loginHref = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

  const score = passwordScore(password);
  const strength = STRENGTH[score];
  const activeSegments = password ? Math.max(1, score) : 0;
  const confirmMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  return (
    <AuthCard
      eyebrow="Get started"
      title="Create your account"
      subtitle="Your downloads, workers and paired TVs stay with this account — on every device."
      footer={
        <div className="space-y-5">
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href={loginHref}
              className="font-medium text-blue-600 underline-offset-4 transition-colors hover:text-blue-500 hover:underline"
            >
              Sign in
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
          id="register-email"
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

        <div>
          <AuthField
            id="register-password"
            label="Password"
            type="password"
            autoComplete="new-password"
            placeholder="Create a password"
            hint="At least 8 characters."
            revealable
            required
            minLength={8}
            maxLength={128}
            disabled={loading}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            icon={<Lock className="h-[18px] w-[18px]" />}
          />

          {password ? (
            <div className="mt-2 animate-in fade-in-0 duration-200">
              <div className="flex gap-1" aria-hidden>
                {[0, 1, 2, 3].map((index) => (
                  <span
                    key={index}
                    className={cn(
                      "h-1 flex-1 rounded-full transition-colors duration-300",
                      index < activeSegments ? strength.bar : "bg-muted",
                    )}
                  />
                ))}
              </div>
              <p
                aria-live="polite"
                className={cn("mt-1.5 text-xs font-medium", strength.text)}
              >
                {strength.label}
              </p>
            </div>
          ) : null}
        </div>

        <AuthField
          id="register-confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat your password"
          revealable
          required
          minLength={8}
          maxLength={128}
          disabled={loading}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          icon={<Lock className="h-[18px] w-[18px]" />}
          invalid={confirmMismatch}
          hint={
            confirmPassword ? (
              confirmMismatch ? (
                <span className="flex items-center gap-1 text-red-500">
                  <X className="h-3.5 w-3.5" />
                  Passwords don&apos;t match yet
                </span>
              ) : (
                <span className="flex items-center gap-1 text-emerald-600">
                  <Check className="h-3.5 w-3.5" />
                  Passwords match
                </span>
              )
            ) : undefined
          }
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
            <UserPlus className="h-4 w-4" />
          )}
          {loading ? "Creating account…" : "Create account"}
        </Button>

        <p className="text-center text-[11px] leading-relaxed text-muted-foreground/70">
          Your current downloads, workers and TV pairings move to this account
          automatically.
        </p>
      </form>
    </AuthCard>
  );
}

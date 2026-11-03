"use client";

import {
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

type AuthFieldProps = Omit<ComponentProps<"input">, "className"> & {
  label: string;
  /** Leading icon shown inside the input. */
  icon?: ReactNode;
  /** Helper text shown below the input. */
  hint?: ReactNode;
  /** When set, replaces the hint and marks the field as invalid. */
  error?: string | null;
  /** Marks the field invalid without showing a message (e.g. live mismatch). */
  invalid?: boolean;
  /** Adds a show/hide toggle. Only meaningful for password inputs. */
  revealable?: boolean;
  className?: string;
};

/**
 * Labelled input used by the sign-in and registration forms: leading icon,
 * optional password reveal toggle, and hint/error messaging wired up with
 * `aria-describedby` and `aria-invalid`.
 */
export function AuthField({
  label,
  icon,
  hint,
  error,
  invalid = false,
  revealable = false,
  id,
  type = "text",
  className,
  ...props
}: AuthFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  const [revealed, setRevealed] = useState(false);

  const canReveal = revealable && type === "password";
  const resolvedType = canReveal && revealed ? "text" : type;
  const message = error || hint;
  const isInvalid = Boolean(error) || invalid;

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        className="text-sm font-medium text-foreground"
      >
        {label}
      </label>

      <div className="group relative mt-1.5">
        {icon ? (
          <span className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center pl-3 text-muted-foreground transition-colors group-focus-within:text-blue-600">
            {icon}
          </span>
        ) : null}

        <input
          {...props}
          id={inputId}
          type={resolvedType}
          aria-invalid={isInvalid || undefined}
          aria-describedby={message ? messageId : undefined}
          className={cn(
            "peer h-11 w-full rounded-lg border border-input bg-background/70 text-sm text-foreground shadow-xs outline-none transition",
            "placeholder:text-muted-foreground/55",
            "hover:border-border focus-visible:border-blue-500 focus-visible:ring-4 focus-visible:ring-blue-500/15",
            "disabled:cursor-not-allowed disabled:opacity-60",
            "aria-[invalid=true]:border-destructive/60 aria-[invalid=true]:focus-visible:ring-destructive/15",
            icon ? "pl-10" : "pl-3.5",
            canReveal ? "pr-11" : "pr-3.5",
          )}
        />

        {canReveal ? (
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          >
            {revealed ? (
              <EyeOff className="h-[18px] w-[18px]" />
            ) : (
              <Eye className="h-[18px] w-[18px]" />
            )}
          </button>
        ) : null}
      </div>

      {message ? (
        <p
          id={messageId}
          className={cn(
            "mt-1.5 text-xs",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

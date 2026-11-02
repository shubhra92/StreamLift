"use client";

interface ConsoleLogsToggleProps {
  enabled:  boolean;
  onChange: (enabled: boolean) => void;
}

/**
 * Per-worker "print logs to the console" switch.
 *
 * The worker always records logs for the dashboard; this only controls whether
 * they are also printed to the console. The value is read at worker startup,
 * so changes apply after the worker is restarted.
 */
export function ConsoleLogsToggle({ enabled, onChange }: ConsoleLogsToggleProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Show logs in console</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Dashboard logs are always available. Applies after the worker restarts.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Show logs in console"
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none ${
          enabled ? "bg-blue-600" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}

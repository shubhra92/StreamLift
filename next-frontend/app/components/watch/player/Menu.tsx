"use client";

import { Check } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface PlayerMenuButtonProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  badge?: string | number | null;
  children: ReactNode;
  panelClassName?: string;
  buttonClassName?: string;
}

interface PanelGeometry {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

/**
 * Icon button with an anchored popover.
 *
 * The panel is portalled into the player root (not the document body) so it
 * stays inside the Radix dialog's focus/outside-click scope. Absolute
 * positioning against the player root lifts it out of the control row's
 * stacking context, and the computed max height keeps it clear of the top bar.
 */
export function PlayerMenuButton({
  open,
  onToggle,
  onClose,
  label,
  icon,
  active,
  disabled,
  badge,
  children,
  panelClassName,
  buttonClassName,
}: PlayerMenuButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<PanelGeometry | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setGeometry(null);
      return;
    }

    const update = () => {
      const button = buttonRef.current;
      const player = button?.closest("[data-player-root]");
      if (!button || !(player instanceof HTMLElement)) {
        setGeometry(null);
        return;
      }
      const rect = button.getBoundingClientRect();
      const root = player.getBoundingClientRect();
      const width = Math.min(352, Math.max(240, root.width - 16));
      const left = Math.min(
        Math.max(8, rect.right - width - root.left),
        Math.max(8, root.width - width - 8),
      );
      // Anchored above the button. `maxHeight` keeps the top edge below the
      // player's top bar so the panel is never hidden behind it.
      const bottom = Math.max(12, root.bottom - rect.top + 8);
      setTarget(player);
      setGeometry({
        left,
        bottom,
        width,
        maxHeight: Math.max(140, rect.top - root.top - 72),
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const clicked = event.target as Node | null;
      if (!clicked) return;
      if (buttonRef.current?.contains(clicked) || panelRef.current?.contains(clicked)) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose, open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
        className={
          buttonClassName ??
          `relative flex h-9 items-center gap-1.5 rounded-md px-2 text-white/80 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${
            active ? "bg-white/10 text-white" : ""
          }`
        }
      >
        {icon}
        {badge !== null && badge !== undefined && (
          <span className="hidden rounded bg-white/15 px-1 text-[10px] font-semibold leading-4 text-white/90 sm:inline">
            {badge}
          </span>
        )}
      </button>

      {open &&
        geometry &&
        target &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            style={{
              position: "absolute",
              left: geometry.left,
              bottom: geometry.bottom,
              width: geometry.width,
              maxHeight: geometry.maxHeight,
            }}
            className={`z-[75] overflow-y-auto rounded-xl border border-white/10 bg-neutral-950/95 p-1.5 text-sm text-white shadow-2xl shadow-black/60 backdrop-blur-md ${
              panelClassName ?? ""
            }`}
          >
            {children}
          </div>,
          target,
        )}
    </>
  );
}

export function MenuSection({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">
      {children}
    </p>
  );
}

interface MenuItemProps {
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  subtitle?: string;
  icon?: ReactNode;
  trailing?: ReactNode;
}

export function MenuItem({
  selected,
  disabled,
  onClick,
  title,
  subtitle,
  icon,
  trailing,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      title={subtitle}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {icon && <span className="shrink-0 text-white/60">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {subtitle && (
          <span className="block truncate text-[11px] text-white/45">{subtitle}</span>
        )}
      </span>
      {trailing}
      {selected && <Check className="h-4 w-4 shrink-0 text-blue-400" />}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-white/10" />;
}

export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-1.5 text-[11px] leading-relaxed text-white/45">{children}</p>;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition hover:bg-white/5">
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {description && (
          <span className="block text-[11px] text-white/45">{description}</span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
          checked ? "bg-blue-500" : "bg-white/20"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? "left-4" : "left-0.5"
          }`}
        />
      </span>
    </label>
  );
}

interface RangeRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}

export function RangeRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: RangeRowProps) {
  return (
    <label className="block px-2.5 py-1.5">
      <span className="mb-1 flex items-center justify-between text-[12px] text-white/70">
        <span>{label}</span>
        <span className="tabular-nums text-white/45">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="player-range w-full"
      />
    </label>
  );
}

export function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-white/70">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <span className="tabular-nums text-white/40">{value.toUpperCase()}</span>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-white/15 bg-transparent p-0.5"
        />
      </span>
    </label>
  );
}

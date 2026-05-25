/**
 * Shared receipt-card primitives used across all routes.
 * stripe-receipt aesthetic: bg-white/dark:bg-zinc-900 cards with hairline borders,
 * ALL-CAPS micro-labels (`text-[10px] uppercase tracking-widest`), bold tabular numerals.
 * No shadows, no backdrop-blur (per DESIGN.md).
 */
import Link from "next/link";

export function Receipt({
  label,
  action,
  pad = "default",
  className = "",
  children,
}: {
  label?: string;
  action?: { href: string; label: string };
  pad?: "default" | "tight" | "loose" | "none";
  className?: string;
  children: React.ReactNode;
}) {
  const padding =
    pad === "none"
      ? ""
      : pad === "tight"
        ? "px-4 py-3"
        : pad === "loose"
          ? "px-6 py-6 md:px-8 md:py-7"
          : "px-4 py-4 md:px-6 md:py-5";
  const hasHeader = !!(label || action);
  return (
    <div
      className={`rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 ${className}`}
    >
      {hasHeader && (
        <div className="flex items-baseline justify-between gap-3 px-4 pt-3 pb-2 border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</div>
          {action && (
            <Link
              href={action.href}
              className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              {action.label} →
            </Link>
          )}
        </div>
      )}
      <div className={`${padding} ${pad === "none" ? "overflow-x-auto" : ""}`}>{children}</div>
    </div>
  );
}

/** Big bold numeral with ALL-CAPS micro-label above. Used in vital-signs grids. */
export function Stat({
  label,
  value,
  hint,
  align = "left",
  size = "lg",
}: {
  label: string;
  value: string;
  hint?: string;
  align?: "left" | "center" | "right";
  size?: "md" | "lg" | "xl";
}) {
  const alignment = align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
  const numeral =
    size === "xl"
      ? "text-3xl"
      : size === "lg"
        ? "text-2xl"
        : "text-xl";
  return (
    <div className={alignment}>
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</div>
      <div className={`${numeral} font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50 mt-1`}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mt-0.5">{hint}</div>
      )}
    </div>
  );
}

/** Small inline numeral + label, used in horizontal breakdown rows inside a Receipt. */
export function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-3 text-center">
      <div className="text-sm font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-widest text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}

/** Tab-style chip, e.g. for `30D · 7D · 90D` time-range selectors. */
export function Chip({
  children,
  active = false,
}: {
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <span
      className={
        "text-[10px] uppercase tracking-widest rounded-full px-2.5 py-1 transition-colors " +
        (active
          ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
          : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100")
      }
    >
      {children}
    </span>
  );
}

/** Section header used inside a Receipt body when the section needs a sub-heading. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-widest text-zinc-500">{children}</div>;
}

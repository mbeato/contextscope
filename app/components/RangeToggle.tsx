"use client";

/**
 * Time-window selector. Renders RANGES as tab-style chips (matching the Chip
 * primitive in Receipt.tsx) that link to the current path with ?days=N. The
 * active chip is derived from the URL, so windows are deep-linkable and each
 * navigation re-renders the force-dynamic server page with fresh data. The
 * default window omits the param to keep canonical URLs clean.
 */
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { RANGES, DEFAULT_DAYS, parseDays } from "@/lib/range";

export function RangeToggle() {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = parseDays(params.get("days") ?? undefined);

  return (
    <div className="flex items-center gap-1">
      {RANGES.map((d) => {
        const active = d === current;
        const next = new URLSearchParams(params.toString());
        if (d === DEFAULT_DAYS) next.delete("days");
        else next.set("days", String(d));
        const qs = next.toString();
        return (
          <Link
            key={d}
            href={qs ? `${pathname}?${qs}` : pathname}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={
              "text-[10px] uppercase tracking-widest rounded-full px-2.5 py-1 transition-colors " +
              (active
                ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100")
            }
          >
            {d}d
          </Link>
        );
      })}
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ROUTES = [
  { href: "/items", label: "items" },
  { href: "/sessions", label: "sessions" },
  { href: "/context", label: "context" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-6 h-12 flex items-center gap-8 text-sm">
        <Link
          href="/"
          className={`font-semibold tracking-tight ${
            pathname === "/" ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          } transition-colors`}
        >
          contextscope
        </Link>
        <div className="flex items-center gap-5">
          {ROUTES.map((r) => {
            const active = pathname === r.href || pathname.startsWith(r.href + "/");
            return (
              <Link
                key={r.href}
                href={r.href}
                className={`${
                  active
                    ? "text-zinc-900 dark:text-zinc-100 underline underline-offset-[6px] decoration-zinc-400 decoration-1"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                } transition-colors`}
              >
                {r.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

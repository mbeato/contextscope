import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./components/Nav";

export const metadata: Metadata = {
  title: "contextscope",
  description:
    "Local dashboard auditing Claude Code's per-turn token context — skills, agents, commands, CLAUDE.md, MEMORY.md, hooks, MCP, and session analytics.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-mono bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <Nav />
        {children}
      </body>
    </html>
  );
}

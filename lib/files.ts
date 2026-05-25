import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const enc = getEncoding("cl100k_base");
const SCAN_ROOTS = [HOME]; // searched for CLAUDE.md
const SCAN_MAX_DEPTH = 4;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  ".cache",
  ".pnpm-store",
  // Dotfile dirs that ship dependency-bundled CLAUDE.md files we don't author
  ".vscode",
  ".antigravity",
  ".bun",
  ".cursor",
  ".windsurf",
  // GSD/Claude worktree shadow copies
  "worktrees",
]);

export type ContextFile = {
  category: "claude-md-global" | "claude-md-project" | "memory-md";
  name: string;          // human-readable label
  filePath: string;
  tokens: number;
  loadedWhen: string;    // human-readable: "every session" / "when cwd matches X" / "in project X"
};

function countTokens(s: string): number {
  return enc.encode(s).length;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTokens(filePath: string): Promise<number> {
  try {
    const raw = await readFile(filePath, "utf8");
    return countTokens(raw);
  } catch {
    return 0;
  }
}

async function findClaudeMds(root: string, depth: number, acc: string[]): Promise<void> {
  if (depth > SCAN_MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".claude") {
      if (SKIP_DIRS.has(e.name)) continue;
      // Skip other dotfiles too — too noisy
      if (depth > 0) continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      await findClaudeMds(p, depth + 1, acc);
    } else if (e.isFile() && e.name === "CLAUDE.md") {
      acc.push(p);
    }
  }
}

export async function getContextFiles(): Promise<ContextFile[]> {
  const out: ContextFile[] = [];

  // 1) Global CLAUDE.md — always loaded
  const globalPath = join(CLAUDE_DIR, "CLAUDE.md");
  if (await exists(globalPath)) {
    out.push({
      category: "claude-md-global",
      name: "~/.claude/CLAUDE.md",
      filePath: globalPath,
      tokens: await readTokens(globalPath),
      loadedWhen: "every session",
    });
  }

  // 2) Project CLAUDE.md files — find under HOME
  const projectClaudeMds: string[] = [];
  for (const root of SCAN_ROOTS) {
    await findClaudeMds(root, 0, projectClaudeMds);
  }
  // Exclude the global one (which lives under ~/.claude)
  for (const p of projectClaudeMds) {
    if (p === globalPath) continue;
    const tokens = await readTokens(p);
    const rel = p.replace(HOME, "~");
    // The directory containing this file is its "project"
    const dirRel = rel.replace(/\/CLAUDE\.md$/, "");
    out.push({
      category: "claude-md-project",
      name: rel,
      filePath: p,
      tokens,
      loadedWhen: `when cwd is ${dirRel} (or below)`,
    });
  }

  // 3) MEMORY.md files — per-project auto-memory
  if (await exists(PROJECTS_DIR)) {
    let projDirs: import("node:fs").Dirent[] = [];
    try {
      projDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      projDirs = [];
    }
    for (const d of projDirs) {
      if (!d.isDirectory()) continue;
      const dirName = String(d.name);
      const memPath = join(PROJECTS_DIR, dirName, "memory", "MEMORY.md");
      if (!(await exists(memPath))) continue;
      // Project dir name encodes cwd, e.g. "-Users-vtx-VTX" => /Users/vtx/VTX
      const inferredCwd = dirName.replace(/^-/, "/").replaceAll("-", "/");
      out.push({
        category: "memory-md",
        name: `${dirName}/memory/MEMORY.md`,
        filePath: memPath,
        tokens: await readTokens(memPath),
        loadedWhen: `in project ${inferredCwd}`,
      });
    }
  }

  return out.sort((a, b) => b.tokens - a.tokens);
}

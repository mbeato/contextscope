import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getEncoding } from "js-tiktoken";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const enc = getEncoding("cl100k_base");

const DRY_RUN_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const DRY_RUN_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 512 * 1024;

export type HookEntry = {
  event: string;
  matcher?: string;
  command: string;
  status: "measured" | "not-run-side-effects" | "error" | "timeout";
  perTurnTokens: number;     // tokenized stdout (0 if not measured)
  loadedWhen: string;        // human description
  output?: string;           // truncated preview of injected text
  error?: string;
};

function countTokens(s: string): number {
  return enc.encode(s).length;
}

async function runHook(command: string, sampleInput: object): Promise<{ stdout: string; error?: string; timeout?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      kill();
      resolve({ stdout, timeout: true });
    }, DRY_RUN_TIMEOUT_MS);
    child.stdout?.on("data", (d) => {
      if (stdout.length >= MAX_STDOUT_BYTES) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          kill();
          resolve({ stdout });
        }
        return;
      }
      stdout += d.toString();
      if (stdout.length > MAX_STDOUT_BYTES) stdout = stdout.slice(0, MAX_STDOUT_BYTES);
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < MAX_STDOUT_BYTES) stderr += d.toString();
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, error: err.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout) resolve({ stdout, error: stderr.trim() || `exit ${code}` });
      else resolve({ stdout });
    });
    try {
      child.stdin?.write(JSON.stringify(sampleInput));
      child.stdin?.end();
    } catch {
      // ignore
    }
  });
}

export async function getHooks(): Promise<HookEntry[]> {
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const hooksMap = (parsed?.hooks ?? {}) as Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>
  >;

  type Pending = { event: string; matcher?: string; command: string; measure: boolean };
  const pending: Pending[] = [];
  for (const [event, blocks] of Object.entries(hooksMap)) {
    for (const block of blocks) {
      const matcher = block.matcher;
      for (const h of block.hooks ?? []) {
        if (h.type !== "command") continue;
        pending.push({ event, matcher, command: h.command, measure: DRY_RUN_EVENTS.has(event) });
      }
    }
  }

  const results = await Promise.all(
    pending.map(async (p): Promise<HookEntry> => {
      const { event, matcher, command, measure } = p;
      if (measure) {
        const sampleInput =
          event === "UserPromptSubmit"
            ? { prompt: "sample prompt for measurement" }
            : {};
        const r = await runHook(command, sampleInput);
        if (r.timeout) {
          return {
            event,
            matcher,
            command,
            status: "timeout",
            perTurnTokens: countTokens(r.stdout),
            loadedWhen: event === "SessionStart" ? "session start" : "every user prompt",
            output: r.stdout.slice(0, 280),
            error: `dry-run hit ${DRY_RUN_TIMEOUT_MS}ms timeout`,
          };
        }
        if (r.error) {
          return {
            event,
            matcher,
            command,
            status: "error",
            perTurnTokens: 0,
            loadedWhen: event === "SessionStart" ? "session start" : "every user prompt",
            error: r.error,
          };
        }
        return {
          event,
          matcher,
          command,
          status: "measured",
          perTurnTokens: countTokens(r.stdout),
          loadedWhen: event === "SessionStart" ? "session start (sticks until restart)" : "every user prompt",
          output: r.stdout.slice(0, 280),
        };
      }
      return {
        event,
        matcher,
        command,
        status: "not-run-side-effects",
        perTurnTokens: 0,
        loadedWhen: describeEvent(event),
      };
    })
  );
  return results;
}

function describeEvent(event: string): string {
  switch (event) {
    case "PreToolUse":
      return "before each tool call (not measured — has side effects)";
    case "PostToolUse":
      return "after each tool call (not measured — has side effects)";
    case "Stop":
      return "on session stop (not measured — has side effects)";
    case "PreCompact":
      return "before context compaction (not measured)";
    default:
      return event;
  }
}

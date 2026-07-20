/**
 * The "visual moments" queue for a meeting.
 *
 * When the orchestrator hears a deictic/visual reference ("make it look like this"), it
 * flags the moment with `./mesh shot --at <sec>`. Each flag is appended here as a JSONL
 * line. After the meeting, the capture step reads the queue, extracts the exact video
 * frame at each `at`, and fills in `framePath`.
 *
 *   <meeting>/.mesh/visuals.jsonl   the queue
 *   <meeting>/media/               where captured images land
 */
import fs from "node:fs";
import path from "node:path";

export interface VisualFlag {
  id: string;
  /** ISO wall-clock time the flag was raised. */
  wallClock: string;
  /** Seconds into the meeting the moment occurred (from transcript start_time). */
  at: number | null;
  /** What the agent expects to see / why it flagged this. */
  note: string;
  /** Live macOS screenshot taken at flag time (best-effort), if any. */
  livePath: string | null;
  /** Exact frame extracted from the Fireflies video post-meeting, once available. */
  framePath?: string | null;
}

export function visualsFile(meeting: string): string {
  return path.join(meeting, ".mesh", "visuals.jsonl");
}

export function mediaDir(meeting: string): string {
  return path.join(meeting, "media");
}

export function ensureMediaDir(meeting: string): string {
  const dir = mediaDir(meeting);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newFlagId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append a flag to the queue. Creates the .mesh dir if needed. */
export function appendVisual(meeting: string, flag: VisualFlag): void {
  const file = visualsFile(meeting);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(flag) + "\n");
}

export function readVisuals(meeting: string): VisualFlag[] {
  try {
    return fs
      .readFileSync(visualsFile(meeting), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as VisualFlag);
  } catch {
    return [];
  }
}

/** Rewrite the whole queue (used to patch in framePath after extraction). */
export function writeVisuals(meeting: string, flags: VisualFlag[]): void {
  const file = visualsFile(meeting);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, flags.map((f) => JSON.stringify(f)).join("\n") + (flags.length ? "\n" : ""));
}

/** Format seconds as M:SS or H:MM:SS for filenames/labels. */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Filesystem-safe slug for filenames. */
export function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "moment"
  );
}

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  // NB: each meeting opens a Ghostty window running the `claude` CLI (see
  // ghostty.ts). It uses your stored Claude Code login — no API key here.

  fireflies: {
    apiKey: () => required("FIREFLIES_API_KEY"),
    apiUrl: optional("FIREFLIES_API_URL", "https://api.fireflies.ai/graphql"),
  },

  buildModel: optional("BUILD_MODEL", "claude-opus-4-8"),
  // Default 10s (not 40s) so the orchestrator sees new transcript quickly and can flag
  // visual moments close to real time — that keeps the live Mac screenshots timely.
  // Faster polling = more Fireflies API calls; raise it if you hit rate limits.
  transcriptPollMs: Number(optional("TRANSCRIPT_POLL_SECONDS", "10")) * 1000,
  // How often the watcher checks Fireflies for meetings that just went live.
  activePollMs: Number(optional("ACTIVE_POLL_SECONDS", "30")) * 1000,

  // Where per-meeting folders are created. Each meeting gets its own
  // <buildsDir>/<date>-<slug>/ that the Ghostty/Claude session works inside.
  buildsDir: optional("BUILDS_DIR", "/Users/ebell/Projects"),

  vision: {
    // Master switch for the post-meeting video frame extraction step.
    captureEnabled: optional("CAPTURE_ENABLED", "true") !== "false",
    // Whether `./mesh shot` also grabs a live macOS screenshot (needs Screen
    // Recording permission). Set to false to only queue the timestamp.
    liveScreenshot: optional("LIVE_SCREENSHOT", "true") !== "false",
    // How long to wait for Fireflies to finish processing the video after a
    // meeting ends before giving up, and how often to poll for it.
    videoWaitMaxMs: Number(optional("VIDEO_WAIT_MAX_SECONDS", "900")) * 1000,
    videoPollMs: Number(optional("VIDEO_POLL_SECONDS", "45")) * 1000,
    // Optional explicit ffmpeg path; otherwise resolved from common locations/PATH.
    ffmpegPath: process.env.FFMPEG_PATH || null,
  },
} as const;

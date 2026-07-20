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
  transcriptPollMs: Number(optional("TRANSCRIPT_POLL_SECONDS", "40")) * 1000,
  // How often the watcher checks Fireflies for meetings that just went live.
  activePollMs: Number(optional("ACTIVE_POLL_SECONDS", "30")) * 1000,

  // Where per-meeting folders are created. Each meeting gets its own
  // <buildsDir>/<date>-<slug>/ that the Ghostty/Claude session works inside.
  buildsDir: optional("BUILDS_DIR", "/Users/ebell/Projects"),
} as const;

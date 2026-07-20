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
  // NB: the build agent runs against the local Claude Code login (your `claude`
  // subscription), not the Anthropic API — see build-agent.ts. No API key here.
  fireflies: {
    apiKey: () => required("FIREFLIES_API_KEY"),
    apiUrl: optional("FIREFLIES_API_URL", "https://api.fireflies.ai/graphql"),
  },

  buildModel: optional("BUILD_MODEL", "claude-opus-4-8"),
  transcriptPollMs: Number(optional("TRANSCRIPT_POLL_SECONDS", "40")) * 1000,
  // How often to check Fireflies for meetings that just went live.
  activePollMs: Number(optional("ACTIVE_POLL_SECONDS", "30")) * 1000,

  buildsDir: path.join(projectRoot, "builds"),
} as const;

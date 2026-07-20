import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Logger } from "./logger.js";

/** Where the Ghostty binary usually lives. First hit wins; else fall back to PATH. */
const GHOSTTY_CANDIDATES = [
  "/Applications/Ghostty.app/Contents/MacOS/ghostty",
  "/opt/homebrew/bin/ghostty",
  "/usr/local/bin/ghostty",
];

function resolveGhostty(): string {
  for (const p of GHOSTTY_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return "ghostty"; // rely on PATH
}

/** Single-quote a string for safe embedding in a zsh command line. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface LaunchOptions {
  /** Folder to open the window in and run claude from (the meeting workspace). */
  workspace: string;
  /** Model to pass to the claude CLI (e.g. claude-opus-4-8). */
  model: string;
  /** Kickoff prompt for the interactive session. Keep it short — point at files. */
  initialPrompt: string;
  logger: Logger;
}

/**
 * Open a new Ghostty window, cd'd into the meeting workspace, running an
 * interactive `claude` session seeded with a kickoff prompt. The window is
 * detached from this process and stays open (drops to a shell) after the
 * session ends so the user can inspect what was built.
 *
 * The launched `claude` inherits the GUI login environment, so it uses the
 * user's stored Claude Code login — no API key involved.
 */
export function launchClaudeInGhostty(opts: LaunchOptions): void {
  // Dev/testing escape hatch: exercise the pipeline (e.g. `npm run replay`)
  // without opening a window or starting a real claude session.
  if (process.env.BUILDBOT_NO_LAUNCH) {
    opts.logger.info(`[BUILDBOT_NO_LAUNCH] would open Ghostty in ${opts.workspace}`);
    return;
  }

  const ghostty = resolveGhostty();

  // cd into the workspace inside the launched command. Ghostty is single-instance
  // on macOS, so a fresh invocation opens a window in the *running* instance and
  // ignores --working-directory (the new window inherits the focused window's cwd).
  // The explicit `cd` is therefore authoritative. Then run claude, then drop to an
  // interactive login shell so the window persists after the session exits.
  const inner =
    `cd ${shQuote(opts.workspace)} && ` +
    `claude --model ${shQuote(opts.model)} ${shQuote(opts.initialPrompt)}; ` +
    `exec /bin/zsh -l`;
  const args = ["-e", "/bin/zsh", "-lc", inner];

  opts.logger.info(`opening Ghostty window in ${opts.workspace}`);
  const child = spawn(ghostty, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (err) => {
    opts.logger.error("failed to launch Ghostty — is it installed?", err);
  });
  child.unref();
}

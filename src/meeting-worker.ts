import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, projectRoot } from "./config.js";
import { makeLogger, type Logger } from "./logger.js";
import { launchClaudeInGhostty } from "./ghostty.js";
import { initBus } from "./mesh/bus.js";
import { fmtClock } from "./vision/visuals.js";
import type { Sentence } from "./fireflies/client.js";

/** A point-in-time view of a meeting's transcript. */
export interface TranscriptSnapshot {
  title: string;
  sentences: Sentence[];
  isLive: boolean;
}

/**
 * Where snapshots come from. The orchestrator injects a Fireflies-backed source;
 * the replay harness injects one that serves growing slices of a past meeting.
 */
export interface TranscriptSource {
  snapshot(): Promise<TranscriptSnapshot>;
}

export interface WorkerOptions {
  meetingId: string;
  source: TranscriptSource;
  /** Poll interval; defaults to config.transcriptPollMs. */
  pollMs?: number;
  /** Return true to abort early (e.g. the user hit "skip current meeting"). */
  shouldStop?: () => boolean;
  /** Override the workspace dir; defaults to builds/<date>-<slug>. */
  workspace?: string;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "meeting"
  );
}

function workspaceFor(title: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(config.buildsDir, `${date}-${slugify(title)}`);
}

function renderSentences(sentences: Sentence[]): string {
  return sentences
    .map((s) => {
      const ts = s.start_time != null ? `[${fmtClock(s.start_time)}] ` : "";
      const who = s.speaker_name ? s.speaker_name + ": " : "";
      return `${ts}${who}${s.text}`;
    })
    .join("\n");
}

/**
 * Spawn the detached post-meeting visual-capture process. It waits for the Fireflies
 * recording, extracts the exact frame for each moment the agents flagged, and messages
 * the orchestrator. Detached so it never blocks the watcher; failures are non-fatal.
 */
function spawnVisualCapture(meeting: string, transcriptId: string, log: Logger): void {
  if (!config.vision.captureEnabled) return;
  const script = path.join(projectRoot, "dist", "vision", "capture.js");
  try {
    const child = spawnNodeScript([script, "--meeting", meeting, "--id", transcriptId], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (e) => log.error("failed to launch visual capture:", e));
    child.unref();
    log.info("post-meeting visual capture spawned (detached)");
  } catch (e) {
    log.error("visual capture spawn error:", e);
  }
}

/**
 * Resolve a real `node` binary. We must NOT use process.execPath here: when this app
 * runs under Electron (the menu-bar app), execPath is the Electron binary, not node.
 * Prefer the common Homebrew locations; fall back to bare `node` on PATH.
 */
function resolveNodeBin(): string {
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(c)) return c;
  }
  return "node";
}

/**
 * Spawn a Node script robustly whether we're running under plain node or under Electron.
 * Uses a real node binary if one exists; otherwise re-runs the Electron binary in
 * node mode (ELECTRON_RUN_AS_NODE) so the script still executes as Node.
 */
function spawnNodeScript(
  scriptArgs: string[],
  opts: { detached?: boolean; stdio?: "ignore" },
): ReturnType<typeof spawn> {
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(c)) return spawn(c, scriptArgs, opts);
  }
  return spawn(process.execPath, scriptArgs, { ...opts, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
}

/**
 * Write an executable `mesh` wrapper into the meeting folder so the orchestrator (and,
 * via its absolute path, the workers) can drive the mesh with a bare `./mesh ...`. The
 * wrapper injects `--meeting <thisFolder>` and points at the built CLI in dist/. It runs
 * a real `node` (not process.execPath, which is Electron in the menu-bar app).
 */
function writeMeshWrapper(workspace: string): void {
  const cli = path.join(projectRoot, "dist", "mesh", "cli.js");
  const wrapper = path.join(workspace, "mesh");
  const script =
    `#!/bin/sh\n` +
    `# Auto-generated. Drives the agent mesh for this meeting.\n` +
    `exec ${JSON.stringify(resolveNodeBin())} ${JSON.stringify(cli)} --meeting ${JSON.stringify(workspace)} "$@"\n`;
  fs.writeFileSync(wrapper, script);
  fs.chmodSync(wrapper, 0o755);
}

/** Instructions the orchestrator reads once at the top of the session. */
const ORCHESTRATOR_MD = `# Orchestrator instructions

You are the **orchestrator** for a live meeting. You do **not** build things yourself —
your job is to deeply understand what people are asking for, break it into parts, and
**delegate each part to a persistent worker agent**. You coordinate them and bring the
pieces together. Staying free to think and to talk to me matters more than doing any
one task, so hand off the actual coding/writing to workers.

## Your team: persistent worker agents

You command a mesh of long-lived worker agents through the \`mesh\` CLI (run it with Bash;
it's in this folder as \`./mesh\`). Workers are **persistent**: each keeps its own memory
and its own folder and stays alive across tasks — they don't vanish after one job. They
can talk to each other and to you.

- Create a worker for a slice of work:  \`./mesh spawn --name <name> --role "<what it owns>"\`
- Give a worker a task:                 \`./mesh send --to <name> --type task --msg "<task>"\`
- Ask a worker something:               \`./mesh send --to <name> --type question --msg "..."\`
- See your team + their status:         \`./mesh agents\`
- Read the shared board (their status): \`./mesh board\`
- Check your inbox (their replies):     \`./mesh inbox\`
- Wind a worker down:                   \`./mesh stop --name <name>\`  (or \`--all\`)

Workers report results back to your inbox and post status to \`BOARD.md\`. Check
\`./mesh inbox\` and \`./mesh board\` regularly — especially when I ask how things are
going — to know where everything stands and to integrate the pieces.

## How to run the meeting

1. Read \`TRANSCRIPT.md\` to understand what's being asked. Every line is prefixed with its
   timestamp, e.g. \`[04:12] Erik: ...\`. Re-read it **frequently** (a watcher refreshes it
   ~every 10s) so you catch new content — and flag visual moments (below) — quickly, and
   so you notice when the meeting ends.
2. Decompose the work into cohesive parts and spin up a worker per part with a clear
   role. Reuse existing workers for follow-on work rather than always spawning new ones.
3. Delegate concrete tasks. Let workers coordinate directly with each other when their
   pieces interconnect (they have the same \`mesh\` CLI).
4. Integrate: pull results together, keep a top-level \`SPEC.md\` describing the whole
   thing and how the parts fit, and resolve conflicts between workers.

## Capturing what people show (screenshots)

The meeting is being video-recorded. Whenever someone refers to something **visual** that
you can't get from words alone — "make it look like *this*", "see this screen", "match that
design", a shared mockup, etc. — flag the moment so its picture can be captured:

    ./mesh shot --at <seconds> --note "<what you expect to see>"

Use the \`[MM:SS]\` timestamp of the line where it was said, converted to **seconds**
(e.g. \`[04:12]\` → \`--at 252\`). This does two things: grabs a best-effort screenshot of my
Mac screen right now, and queues that timestamp. **After the meeting**, the exact frame is
extracted from the recording and you'll get a \`msg\` from \`vision\` plus a \`VISUALS.md\`
index — Read those images (they're in \`media/\`) and reconcile whatever you built against
what was actually shown. Flag generously; unused shots are cheap.

## Be fully autonomous — never stop to ask me

Do not wait for my input and do not ask me questions during the meeting. Make every
judgment call yourself (and instruct workers to do the same). Log anything you or a
worker were unsure about in \`DECISIONS.md\` (newest last): **Question** (what you'd have
asked me), **Decision** (what was chosen), **Why**. That's my after-the-meeting review
list — be honest about shaky calls; we'll adjust together.

## When the meeting ends

The bottom of \`TRANSCRIPT.md\` tells you when the meeting has **ENDED**. This does **not**
mean stop — keep coordinating and let workers keep building. Its one effect: write/refresh
a \`SUMMARY.md\` and print it here so I can catch up. Keep it surface-level:

- **What's being built** — plain-language overview of the whole thing.
- **Who's doing what** — each worker and where its piece stands (pull from \`./mesh board\`).
- **Decisions to review** — point me at \`DECISIONS.md\`.

Then carry on.
`;

/**
 * Rewrite TRANSCRIPT.md with everything captured so far. While the meeting is live the
 * footer is neutral. Once it ends the footer flips to an ENDED note whose ONLY effect is
 * to tell the session to write a SUMMARY.md — it must never tell the session to stop.
 * The session stays fully autonomous and keeps running; the human reviews afterward.
 */
function writeTranscript(workspace: string, snapshot: TranscriptSnapshot): void {
  const header = `# Transcript — ${snapshot.title || "meeting"}\n`;
  const body = renderSentences(snapshot.sentences) || "(no transcript captured yet)";
  const footer = snapshot.isLive
    ? `\n\n---\n_Meeting IN PROGRESS — updated as new transcript arrives. Re-read it for new content._`
    : `\n\n---\n**MEETING ENDED.** This does NOT mean stop — keep building if there is more to do. ` +
      `Its only effect: write/refresh SUMMARY.md (what you're building at a surface level, and ` +
      `where you are) and print it here for me, then carry on. See ORCHESTRATOR.md.`;
  fs.writeFileSync(path.join(workspace, "TRANSCRIPT.md"), header + "\n" + body + footer + "\n");
}

const KICKOFF_PROMPT =
  "You are the ORCHESTRATOR. Read ORCHESTRATOR.md for how to work — you DELEGATE, you " +
  "don't build yourself. Use the ./mesh CLI to spawn persistent worker agents and hand " +
  "them the parts of the work, then integrate their results. Run FULLY AUTONOMOUSLY: " +
  "never ask me questions, decide every call yourself, and log uncertain ones to " +
  "DECISIONS.md. Read TRANSCRIPT.md (lines are timestamped [MM:SS]) for the meeting so " +
  "far, then start decomposing and delegating. When someone references something visual " +
  "('make it look like this', a shared screen/design), flag it with " +
  "`./mesh shot --at <seconds> --note ...` so its picture is captured. Re-read " +
  "TRANSCRIPT.md periodically for new content and to notice when the meeting ends (which " +
  "only means: write SUMMARY.md, then keep coordinating).";

/**
 * Drive one meeting: set up its workspace, open a Ghostty window running an
 * interactive Claude Code session in it, then keep TRANSCRIPT.md up to date as the
 * meeting grows. When the meeting stops being live the watcher writes an ENDED marker
 * into TRANSCRIPT.md — whose only effect is to prompt the session to write a SUMMARY.md —
 * then stops updating and exits. It never tells the session to stop; the session stays
 * fully autonomous and keeps running under the user's control.
 */
export async function runMeetingWorker(opts: WorkerOptions): Promise<string> {
  const pollMs = opts.pollMs ?? config.transcriptPollMs;
  const shouldStop = opts.shouldStop ?? (() => false);
  const log = makeLogger(`worker:${opts.meetingId.slice(0, 8)}`);

  // Prime the workspace from the first snapshot (we need the title for the folder).
  const first = await opts.source.snapshot();
  const workspace = opts.workspace ?? workspaceFor(first.title || opts.meetingId);
  fs.mkdirSync(workspace, { recursive: true });
  log.info(`workspace: ${workspace}`);

  // Seed the folder: orchestrator brief, the agent mesh, the `mesh` CLI wrapper, and
  // the first transcript. Then open the interactive orchestrator session once.
  fs.writeFileSync(path.join(workspace, "ORCHESTRATOR.md"), ORCHESTRATOR_MD);
  initBus(workspace);
  writeMeshWrapper(workspace);
  writeTranscript(workspace, first);
  launchClaudeInGhostty({
    workspace,
    model: config.buildModel,
    initialPrompt: KICKOFF_PROMPT,
    logger: log,
  });

  let processed = first.sentences.length;
  let snapshot = first;
  let emptyPolls = 0;
  const IDLE_WARN_AFTER = 5; // ~poll interval * 5 with no transcript at all
  let warnedIdle = false;

  while (true) {
    if (!snapshot.isLive) {
      // Meeting is over. Write the ENDED marker (the session's cue to produce a
      // SUMMARY.md) and stop polling — but never tell the session to stop. It keeps
      // running autonomously; the only effect of the meeting ending is that summary.
      writeTranscript(workspace, snapshot);
      // Kick off post-meeting visual capture: extract the exact video frames for any
      // moments flagged with `./mesh shot --at`. Runs detached in the background.
      spawnVisualCapture(workspace, opts.meetingId, log);
      log.info(`meeting over — wrote ENDED marker (summary cue); watcher stopping, Claude session left running in ${workspace}`);
      return workspace;
    }

    await sleep(pollMs);
    if (shouldStop()) {
      // The user paused/skipped the watcher. This only stops transcript updates; it
      // does not touch the running Claude session.
      log.warn("stop requested — watcher stopping; Claude session left running");
      return workspace;
    }
    snapshot = await opts.source.snapshot();

    const total = snapshot.sentences.length;
    if (total > processed) {
      log.info(`+${total - processed} new sentence(s) (total ${total}) — updating TRANSCRIPT.md`);
      writeTranscript(workspace, snapshot);
      processed = total;
      emptyPolls = 0;
    } else if (snapshot.isLive && total === 0) {
      // Live but nothing arriving — Fireflies probably isn't recording it.
      if (++emptyPolls === IDLE_WARN_AFTER && !warnedIdle) {
        warnedIdle = true;
        log.warn(
          "matched a live meeting but no transcript after several polls — " +
            "is the Fireflies notetaker actually recording this call?",
        );
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { launchClaudeInGhostty } from "./ghostty.js";
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
    .map((s) => `${s.speaker_name ? s.speaker_name + ": " : ""}${s.text}`)
    .join("\n");
}

/** Instructions Claude reads once at the top of the session. */
const BUILDBOT_MD = `# Build-bot instructions

You are a "build bot" sitting in on a live meeting. As people describe things they
want, you build them right here in this folder — real code and prototypes, plus
specs/docs — without being asked turn by turn.

## The transcript is live

\`TRANSCRIPT.md\` in this folder holds the meeting transcript **so far**. It keeps
growing while the meeting is in progress — a background watcher appends new lines
every ~40 seconds. So:

- Read \`TRANSCRIPT.md\` now to catch up.
- After you finish a build pass, **re-read \`TRANSCRIPT.md\`** to pick up anything new.
  (If you've caught up and want to wait for more, just say so — the human can nudge
  you with "keep going" once there's more to act on.)
- The last line of \`TRANSCRIPT.md\` tells you whether the meeting is still live or has
  ended. When it says the meeting has ENDED, do a final consolidation pass.

## How to build

- Maintain a \`SPEC.md\` at the folder root: what's been discussed and decided, plus a
  short running build log (newest entry last).
- Only build something once the idea is settled enough to act on. If the newest
  transcript is just partial or exploratory chatter, note it in \`SPEC.md\` and wait.
- Prefer APPEND/REFINE over rewrite. Don't restart prior work because a later sentence
  rephrased something — evolve it.
- Everything you produce mid-meeting is a DRAFT. Keep files small, runnable, and
  organized (group a prototype under its own subfolder).
- Don't invent scope that wasn't discussed.

## Final pass (once the meeting has ENDED)

Review everything against the complete transcript: reconcile drafts, remove dead ends
that were explicitly dropped, make prototypes runnable, and finalize \`SPEC.md\` with a
clear summary of what was requested and what you built.
`;

/** Rewrite TRANSCRIPT.md with everything captured so far, plus a live/ended footer. */
function writeTranscript(workspace: string, snapshot: TranscriptSnapshot): void {
  const header = `# Transcript — ${snapshot.title || "meeting"}\n`;
  const body = renderSentences(snapshot.sentences) || "(no transcript captured yet)";
  const footer = snapshot.isLive
    ? `\n\n---\n_Meeting IN PROGRESS — this file will keep growing. Re-read it for new content._`
    : `\n\n---\n**MEETING ENDED.** This is the complete transcript. Do your final consolidation pass.`;
  fs.writeFileSync(path.join(workspace, "TRANSCRIPT.md"), header + "\n" + body + footer + "\n");
}

const KICKOFF_PROMPT =
  "Read BUILDBOT.md for how to work, then read TRANSCRIPT.md for the meeting so far " +
  "and start building. TRANSCRIPT.md keeps growing during the meeting, so re-read it " +
  "after each pass.";

/**
 * Drive one meeting: set up its workspace, open a Ghostty window running an
 * interactive Claude Code session in it, then keep TRANSCRIPT.md up to date as the
 * meeting grows. Marks the transcript ENDED once the meeting stops being live so the
 * session can do its final consolidation pass.
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

  // Seed the folder and open the interactive session once.
  fs.writeFileSync(path.join(workspace, "BUILDBOT.md"), BUILDBOT_MD);
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
      // Ensure the ENDED marker is written, then hand off to the session's final pass.
      writeTranscript(workspace, snapshot);
      log.info(`meeting ended — transcript finalized in ${workspace}`);
      return workspace;
    }

    await sleep(pollMs);
    if (shouldStop()) {
      log.warn("stop requested — marking transcript ended and aborting worker");
      writeTranscript(workspace, { ...snapshot, isLive: false });
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

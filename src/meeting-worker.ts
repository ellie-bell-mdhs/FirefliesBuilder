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

## Be fully autonomous — never stop to ask me

This runs unattended during the meeting. **Do not wait for input and do not ask me
questions.** Whenever you hit something you'd normally ask about — an ambiguity, a
missing detail, a design fork — pick the most reasonable option yourself and keep
moving. Momentum matters more than getting every call perfect; anything uncertain gets
reviewed afterward (see DECISIONS.md below). By the end of the meeting, build as much as
you reasonably can — time willing.

## Log the calls you weren't sure about → DECISIONS.md

Maintain \`DECISIONS.md\` in this folder. Every time you make a judgment call you're not
confident about, append an entry (newest last):

- **Question** — what you would have asked me.
- **Decision** — what you chose to do.
- **Why** — your reasoning.

This is exactly what I review after the meeting to confirm or change your calls, so be
honest about anything shaky — don't hide guesses. We'll go through it together and adjust
whatever needs adjusting.

## The transcript is live

\`TRANSCRIPT.md\` holds the meeting transcript **so far**. A background watcher updates it
every ~40 seconds while the meeting runs. Read it now to catch up, and **re-read it after
each build pass** to pick up new content — and to notice when the meeting ends.

## How to build

- Maintain a \`SPEC.md\` at the folder root: what's been discussed and decided, plus a
  short running build log (newest entry last).
- Only build something once the idea is settled enough to act on. If the newest
  transcript is just partial or exploratory chatter, note it in \`SPEC.md\` and move on.
- Prefer APPEND/REFINE over rewrite. Don't restart prior work because a later sentence
  rephrased something — evolve it.
- Everything you produce is a DRAFT until I confirm it later. Keep files small, runnable,
  and organized (group a prototype under its own subfolder).
- Don't invent scope that wasn't discussed.

## When the meeting ends

The bottom of \`TRANSCRIPT.md\` tells you when the meeting has **ENDED**. This does **not**
mean stop, and it changes nothing about how you work — keep building if there's more to
do. It has exactly one effect: write/refresh a \`SUMMARY.md\` for me and print it in this
session, so I can catch up when I'm back. Keep \`SUMMARY.md\` short and surface-level:

- **What you're building** — a plain-language overview.
- **Where you are right now** — what's done and what's still in progress.
- **Decisions to review** — point me at \`DECISIONS.md\` for the calls you weren't sure of.

Then carry on building.
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
      `where you are) and print it here for me, then carry on. See BUILDBOT.md.`;
  fs.writeFileSync(path.join(workspace, "TRANSCRIPT.md"), header + "\n" + body + footer + "\n");
}

const KICKOFF_PROMPT =
  "Read BUILDBOT.md for how to work — you run FULLY AUTONOMOUSLY: never ask me " +
  "questions, decide every call yourself, and log the uncertain ones to DECISIONS.md. " +
  "Then read TRANSCRIPT.md for the meeting so far and start building. Re-read " +
  "TRANSCRIPT.md after each pass for new content and to notice when the meeting ends " +
  "(which only means: write SUMMARY.md, then keep going).";

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
      // Meeting is over. Write the ENDED marker (the session's cue to produce a
      // SUMMARY.md) and stop polling — but never tell the session to stop. It keeps
      // running autonomously; the only effect of the meeting ending is that summary.
      writeTranscript(workspace, snapshot);
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

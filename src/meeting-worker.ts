import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { runBuildPass } from "./build-agent.js";
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

/**
 * Drive one meeting end to end: poll the transcript, hand each new chunk to the
 * build agent, and run a final consolidation pass once the meeting stops being live.
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

  let processed = 0; // number of sentences already handed to the agent
  let snapshot = first;

  while (true) {
    if (shouldStop()) {
      log.warn("stop requested — aborting worker");
      return workspace;
    }

    const all = snapshot.sentences;
    const fresh = all.slice(processed);

    if (fresh.length > 0) {
      log.info(`+${fresh.length} new sentence(s) (total ${all.length}) — build pass`);
      try {
        await runBuildPass({
          workspace,
          meetingTitle: snapshot.title || opts.meetingId,
          fullTranscript: all,
          newSentences: fresh,
          isFinal: false,
          logger: log,
        });
        processed = all.length;
      } catch (err) {
        log.error("build pass failed (will retry next tick):", err);
      }
    }

    if (!snapshot.isLive) {
      log.info("meeting no longer live — final consolidation pass");
      try {
        await runBuildPass({
          workspace,
          meetingTitle: snapshot.title || opts.meetingId,
          fullTranscript: all,
          newSentences: [],
          isFinal: true,
          logger: log,
        });
      } catch (err) {
        log.error("final pass failed:", err);
      }
      log.info(`done — output in ${workspace}`);
      return workspace;
    }

    await sleep(pollMs);
    if (shouldStop()) {
      log.warn("stop requested — aborting worker");
      return workspace;
    }
    snapshot = await opts.source.snapshot();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

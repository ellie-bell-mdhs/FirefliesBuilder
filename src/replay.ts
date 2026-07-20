/**
 * Offline replay harness (Phase 1 verification).
 *
 * Feeds a past meeting's transcript to the build pipeline in growing slices to
 * simulate a live meeting, with no calendar or menu-bar dependency.
 *
 *   npm run replay -- --id <transcriptId>     # replay a specific Fireflies meeting
 *   npm run replay                            # replay your most recent meeting
 *   npm run replay -- --fixture sample.json   # replay from a local JSON file
 *
 * Flags: --chunk <n> sentences revealed per tick (default 12), --poll <ms> (default 800).
 * A local fixture is a JSON array of { text, speaker_name? }.
 */
import fs from "node:fs";
import { makeLogger } from "./logger.js";
import { FirefliesClient, type Sentence } from "./fireflies/client.js";
import { runMeetingWorker, type TranscriptSource } from "./meeting-worker.js";

const log = makeLogger("replay");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadTranscript(): Promise<{ title: string; sentences: Sentence[] }> {
  const fixture = arg("fixture");
  if (fixture) {
    const raw = JSON.parse(fs.readFileSync(fixture, "utf8")) as Array<{
      text: string;
      speaker_name?: string;
    }>;
    return {
      title: fixture.replace(/\.json$/, ""),
      sentences: raw.map((s, i) => ({
        index: i,
        text: s.text,
        speaker_name: s.speaker_name ?? null,
        start_time: null,
      })),
    };
  }

  const ff = new FirefliesClient();
  let id = arg("id");
  if (!id) {
    const recent = await ff.listTranscripts(1);
    if (!recent.length) throw new Error("No transcripts found on this Fireflies account.");
    id = recent[0].id;
    log.info(`no --id given; using most recent transcript ${id} ("${recent[0].title}")`);
  }
  const t = await ff.getTranscript(id);
  return { title: t.title || "meeting", sentences: t.sentences };
}

/** Serves an ever-larger prefix of the transcript, then flips isLive off. */
function growingSource(title: string, all: Sentence[], chunk: number): TranscriptSource {
  let revealed = 0;
  return {
    async snapshot() {
      revealed = Math.min(all.length, revealed + chunk);
      const isLive = revealed < all.length;
      return { title, sentences: all.slice(0, revealed), isLive };
    },
  };
}

async function main() {
  const chunk = Number(arg("chunk") ?? "12");
  const poll = Number(arg("poll") ?? "800");

  const { title, sentences } = await loadTranscript();
  if (!sentences.length) throw new Error("Transcript has no sentences to replay.");
  log.info(`replaying "${title}" — ${sentences.length} sentences, ${chunk}/tick, ${poll}ms poll`);

  const workspace = await runMeetingWorker({
    meetingId: `replay-${Date.now()}`,
    source: growingSource(title, sentences, chunk),
    pollMs: poll,
  });

  log.info("replay complete. Generated files:");
  for (const f of fs.readdirSync(workspace, { recursive: true }) as string[]) {
    log.info("  " + f);
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { botState } from "./state.js";
import { FirefliesClient } from "./fireflies/client.js";
import { runMeetingWorker, type TranscriptSource } from "./meeting-worker.js";

const log = makeLogger("orchestrator");

/** Transcript source for a real, in-progress Fireflies meeting. */
class FirefliesLiveSource implements TranscriptSource {
  constructor(
    private ff: FirefliesClient,
    private meetingId: string,
    /** True while the meeting is still being recorded (active-meeting membership). */
    private liveHint: () => boolean,
  ) {}

  async snapshot() {
    const t = await this.ff.getTranscript(this.meetingId);
    return {
      title: t.title ?? "",
      sentences: t.sentences,
      // is_live if the account exposes it; otherwise trust active-meeting membership.
      isLive: t.is_live || this.liveHint(),
    };
  }
}

/**
 * Watches Fireflies for meetings that just went live and starts a build worker
 * for each. Fireflies is the calendar here: a meeting only appears once Fireflies
 * has joined it, at which point the full transcript-so-far is already available.
 */
export class Orchestrator {
  private ff = new FirefliesClient();
  private activeMeetingIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    log.info(`started — polling Fireflies for active meetings every ${config.activePollMs / 1000}s`);
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((e) => log.error(e)), config.activePollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!botState.listeningEnabled) {
      // Keep the active set fresh so running workers still see meetings end.
      return;
    }

    let active;
    try {
      active = await this.ff.getActiveMeetings();
    } catch (err) {
      log.error("failed to fetch active meetings:", err instanceof Error ? err.message : err);
      return;
    }
    this.activeMeetingIds = new Set(active.map((m) => m.id));

    for (const m of active) {
      if (botState.isSkipped(m.id) || botState.isActive(m.id)) continue;
      log.info(`live meeting "${m.title ?? m.id}" (${m.id}) — starting worker`);
      this.spawnWorker(m.id);
    }
  }

  private spawnWorker(meetingId: string): void {
    botState.markActive(meetingId);
    const source = new FirefliesLiveSource(this.ff, meetingId, () =>
      this.activeMeetingIds.has(meetingId),
    );
    void runMeetingWorker({
      meetingId,
      source,
      shouldStop: () => botState.isSkipped(meetingId) || !botState.listeningEnabled,
    })
      .catch((err) => log.error(`worker for ${meetingId} failed:`, err))
      .finally(() => botState.clearActive(meetingId));
  }
}

// Allow running the orchestrator standalone (headless, no menu bar) for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const orch = new Orchestrator();
  orch.start().catch((err) => {
    log.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

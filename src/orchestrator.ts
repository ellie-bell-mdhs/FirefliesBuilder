import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { botState } from "./state.js";
import { FirefliesClient } from "./fireflies/client.js";
import { runMeetingWorker, type TranscriptSource } from "./meeting-worker.js";

const log = makeLogger("orchestrator");

export interface OrchestratorState {
  /** A meeting is currently live in Fireflies (so the menu bar should show). */
  pendingSoon: boolean;
  /** Number of build workers currently running. */
  activeCount: number;
}

/** Transcript source for a real, in-progress Fireflies meeting. */
class FirefliesLiveSource implements TranscriptSource {
  constructor(
    private ff: FirefliesClient,
    private meetingId: string,
    private liveHint: () => boolean,
  ) {}
  async snapshot() {
    const t = await this.ff.getTranscript(this.meetingId);
    return { title: t.title ?? "", sentences: t.sentences, isLive: t.is_live || this.liveHint() };
  }
}

/**
 * The always-on watcher. Polls Fireflies for meetings that are live and starts a
 * build worker for each. Fireflies is the trigger: because the notetaker joins
 * early, a meeting appears here around the time it starts, at which point the full
 * transcript-so-far is available. Reports state each tick so the host can show/hide
 * the menu bar.
 */
export class Orchestrator {
  private ff = new FirefliesClient();
  private activeMeetingIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private onState?: (s: OrchestratorState) => void) {}

  async start(): Promise<void> {
    log.info(`watching Fireflies for live meetings every ${config.activePollMs / 1000}s`);
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((e) => log.error(e)), config.activePollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    let active;
    try {
      active = await this.ff.getActiveMeetings();
    } catch (err) {
      log.error("failed to fetch active meetings:", err instanceof Error ? err.message : err);
      this.onState?.({ pendingSoon: false, activeCount: botState.activeIds().length });
      return;
    }
    this.activeMeetingIds = new Set(active.map((m) => m.id));

    if (botState.listeningEnabled) {
      for (const m of active) {
        if (botState.isSkipped(m.id) || botState.isActive(m.id)) continue;
        log.info(`live meeting "${m.title ?? m.id}" (${m.id}) — starting worker`);
        this.spawnWorker(m.id);
      }
    }

    this.onState?.({ pendingSoon: active.length > 0, activeCount: botState.activeIds().length });
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

// Headless run (no menu bar) for debugging.
if (import.meta.url === `file://${process.argv[1]}`) {
  const orch = new Orchestrator((s) => log.info("state:", JSON.stringify(s)));
  orch.start().catch((err) => {
    log.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

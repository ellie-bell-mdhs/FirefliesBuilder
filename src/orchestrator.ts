import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { botState } from "./state.js";
import { FirefliesClient } from "./fireflies/client.js";
import { runMeetingWorker, type TranscriptSource } from "./meeting-worker.js";

const log = makeLogger("orchestrator");

/** Things the orchestrator tells the host (menu bar) about, for notifications/UI. */
export type OrchEvent =
  | { type: "started"; meetings: { id: string; title: string }[] }
  | { type: "already"; count: number }
  | { type: "watching" }
  | { type: "timeout" }
  | { type: "error"; message: string };

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
 * Manual trigger for the build-bot. There is NO background polling — nothing happens
 * until the user presses "Start on current meeting" in the menu bar. That does one
 * check of Fireflies' active_meetings and starts a worker for each live meeting found.
 *
 * If nothing is live yet (you joined before the Fireflies bot did), it arms a bounded,
 * cancelable watch that re-checks every few seconds and auto-starts the moment the bot
 * joins — then disarms.
 */
export class Orchestrator {
  private ff = new FirefliesClient();
  private activeMeetingIds = new Set<string>();
  private watchTimer: NodeJS.Timeout | null = null;
  private watchDeadline = 0;

  constructor(private onEvent?: (e: OrchEvent) => void) {}

  isWatching(): boolean {
    return this.watchTimer !== null;
  }

  /** Menu-bar entry point. Check now; if nothing live, arm the bounded watch. */
  async startOnCurrentMeeting(): Promise<void> {
    let r: CheckResult;
    try {
      r = await this.checkOnce();
    } catch (err) {
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (r.started.length) {
      this.emit({ type: "started", meetings: r.started });
      return;
    }
    if (r.already > 0) {
      this.emit({ type: "already", count: r.already });
      return;
    }
    this.armWatch();
  }

  /** Stop the bounded watch (user pressed "Stop looking", or we started/timed out). */
  cancelWatch(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
      log.info("watch cancelled");
    }
  }

  stop(): void {
    this.cancelWatch();
  }

  private armWatch(): void {
    this.watchDeadline = Date.now() + config.watchMaxMs;
    log.info(
      `no live meeting yet — watching every ${config.watchPollMs / 1000}s ` +
        `for up to ${Math.round(config.watchMaxMs / 60000)} min`,
    );
    this.emit({ type: "watching" });
    this.watchTimer = setInterval(() => void this.watchTick(), config.watchPollMs);
  }

  private async watchTick(): Promise<void> {
    if (Date.now() > this.watchDeadline) {
      this.cancelWatch();
      this.emit({ type: "timeout" });
      return;
    }
    let r: CheckResult;
    try {
      r = await this.checkOnce();
    } catch (err) {
      log.error("watch check failed (will retry):", err instanceof Error ? err.message : err);
      return;
    }
    if (r.started.length) {
      this.cancelWatch();
      this.emit({ type: "started", meetings: r.started });
    }
  }

  /** One check of active_meetings; spawn a worker for each new live meeting. */
  private async checkOnce(): Promise<CheckResult> {
    const active = await this.ff.getActiveMeetings();
    this.activeMeetingIds = new Set(active.map((m) => m.id));
    const started: { id: string; title: string }[] = [];
    let already = 0;
    for (const m of active) {
      if (botState.isActive(m.id)) {
        already++;
        continue;
      }
      if (botState.isSkipped(m.id)) continue;
      log.info(`starting worker for live meeting "${m.title ?? m.id}" (${m.id})`);
      this.spawnWorker(m.id);
      started.push({ id: m.id, title: m.title ?? m.id });
    }
    return { started, already, activeCount: active.length };
  }

  private spawnWorker(meetingId: string): void {
    botState.markActive(meetingId);
    const source = new FirefliesLiveSource(this.ff, meetingId, () =>
      this.activeMeetingIds.has(meetingId),
    );
    void runMeetingWorker({
      meetingId,
      source,
      shouldStop: () => botState.isSkipped(meetingId),
    })
      .catch((err) => log.error(`worker for ${meetingId} failed:`, err))
      .finally(() => botState.clearActive(meetingId));
  }

  private emit(e: OrchEvent): void {
    this.onEvent?.(e);
  }
}

interface CheckResult {
  started: { id: string; title: string }[];
  already: number;
  activeCount: number;
}

// Headless one-shot check for debugging: `npm run watch`. If nothing is live it arms
// the watch and keeps polling (Ctrl+C to exit).
if (import.meta.url === `file://${process.argv[1]}`) {
  const orch = new Orchestrator((e) => log.info("event:", JSON.stringify(e)));
  orch.startOnCurrentMeeting().catch((err) => {
    log.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

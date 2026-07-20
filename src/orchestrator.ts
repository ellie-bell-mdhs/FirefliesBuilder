import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { botState } from "./state.js";
import { GraphCalendar, type CalendarEvent } from "./calendar/graph.js";
import {
  FirefliesClient,
  FirefliesActiveMeetingsUnsupported,
  type ActiveMeeting,
} from "./fireflies/client.js";
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

function normalizeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return (parsed.host + parsed.pathname).toLowerCase().replace(/\/+$/, "");
  } catch {
    return u.toLowerCase();
  }
}

function normalizeTitle(s: string | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Best-effort match of a calendar event to an in-progress Fireflies meeting. */
export function matchMeeting(event: CalendarEvent, active: ActiveMeeting[]): ActiveMeeting | null {
  const evUrl = normalizeUrl(event.joinUrl);
  if (evUrl) {
    const byUrl = active.find((m) => normalizeUrl(m.meeting_link) === evUrl);
    if (byUrl) return byUrl;
  }
  const evTitle = normalizeTitle(event.subject);
  if (evTitle) {
    const byTitle = active.find((m) => {
      const mt = normalizeTitle(m.title);
      return mt && (mt === evTitle || mt.includes(evTitle) || evTitle.includes(mt));
    });
    if (byTitle) return byTitle;
  }
  // Fall back to start-time proximity (±10 min).
  const byTime = active.find(
    (m) => m.start_time != null && Math.abs(m.start_time - event.startUtcMs) < 10 * 60_000,
  );
  return byTime ?? null;
}

export class Orchestrator {
  private ff = new FirefliesClient();
  private cal = new GraphCalendar();
  private activeMeetingIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private activeMeetingsSupported = true;

  async start(onDeviceCode?: (msg: string) => void): Promise<void> {
    await this.cal.signIn(onDeviceCode);
    log.info(`started — calendar poll ${config.calendarPollMs / 1000}s, lead ${config.leadMs / 1000}s`);
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((e) => log.error(e)), config.calendarPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!botState.listeningEnabled) {
      log.info("listening disabled — skipping tick");
      return;
    }

    // Refresh the set of currently-recording meetings (also used as the live hint).
    let active: ActiveMeeting[] = [];
    if (this.activeMeetingsSupported) {
      try {
        active = await this.ff.getActiveMeetings();
        this.activeMeetingIds = new Set(active.map((m) => m.id));
      } catch (err) {
        if (err instanceof FirefliesActiveMeetingsUnsupported) {
          this.activeMeetingsSupported = false;
          log.warn(err.message, "— live matching by active meetings disabled");
        } else {
          throw err;
        }
      }
    }

    const events = await this.cal.upcomingEvents(config.leadMs + 5 * 60_000);
    const now = Date.now();
    for (const ev of events) {
      if (ev.isCancelled) continue;
      const startsIn = ev.startUtcMs - now;
      const inWindow = startsIn <= config.leadMs && now < ev.endUtcMs;
      if (!inWindow) continue;

      const match = matchMeeting(ev, active);
      if (!match) continue; // meeting not being recorded yet — try again next tick
      if (botState.isSkipped(match.id) || botState.isActive(match.id)) continue;

      log.info(`matched "${ev.subject}" -> Fireflies meeting ${match.id} — starting worker`);
      this.spawnWorker(match.id);
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

// Allow running the orchestrator standalone (headless, no menu bar) for Phase 2 testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const orch = new Orchestrator();
  orch.start().catch((err) => {
    log.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

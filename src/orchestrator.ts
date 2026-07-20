import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { botState } from "./state.js";
import { GraphCalendar, type CalendarEvent } from "./calendar/graph.js";
import { FirefliesClient, type ActiveMeeting } from "./fireflies/client.js";
import { runMeetingWorker, type TranscriptSource } from "./meeting-worker.js";

const log = makeLogger("orchestrator");

export interface OrchestratorState {
  /** Any calendar event is within the lead window (about to start / in progress). */
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

function normalizeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return (p.host + p.pathname).toLowerCase().replace(/\/+$/, "");
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
  const byTime = active.find(
    (m) => m.start_time != null && Math.abs(m.start_time - event.startUtcMs) < 10 * 60_000,
  );
  return byTime ?? null;
}

/**
 * The always-on watcher. Polls the Outlook calendar; ~LEAD before an event it
 * reports `pendingSoon` (so the app can show the menu bar) and, once Fireflies is
 * recording the meeting, starts a build worker. Reports state each tick so the
 * host can show/hide the menu bar and keep it current.
 */
export class Orchestrator {
  private ff = new FirefliesClient();
  private cal = new GraphCalendar();
  private activeMeetingIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private onState?: (s: OrchestratorState) => void) {}

  /** Throws NotSignedInError if the calendar login hasn't been set up yet. */
  async start(): Promise<void> {
    await this.cal.signInSilent();
    log.info(`watching Outlook every ${config.calendarPollMs / 1000}s, lead ${config.leadMs / 1000}s`);
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((e) => log.error(e)), config.calendarPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // Refresh currently-recording meetings (for matching + the live hint).
    try {
      const active = await this.ff.getActiveMeetings();
      this.activeMeetingIds = new Set(active.map((m) => m.id));

      const events = await this.cal.upcomingEvents(config.leadMs + 5 * 60_000);
      const now = Date.now();
      let pendingSoon = false;

      for (const ev of events) {
        if (ev.isCancelled) continue;
        const inWindow = ev.startUtcMs - now <= config.leadMs && now < ev.endUtcMs;
        if (!inWindow) continue;
        pendingSoon = true;

        if (!botState.listeningEnabled) continue;
        const match = matchMeeting(ev, active);
        if (!match) continue; // Fireflies hasn't joined yet — retry next tick
        if (botState.isSkipped(match.id) || botState.isActive(match.id)) continue;

        log.info(`matched "${ev.subject}" -> Fireflies ${match.id} — starting worker`);
        this.spawnWorker(match.id);
      }

      this.onState?.({ pendingSoon, activeCount: botState.activeIds().length });
    } catch (err) {
      log.error("tick failed:", err instanceof Error ? err.message : err);
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

// Headless run (no menu bar) for debugging.
if (import.meta.url === `file://${process.argv[1]}`) {
  const orch = new Orchestrator((s) => log.info("state:", JSON.stringify(s)));
  orch.start().catch((err) => {
    log.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

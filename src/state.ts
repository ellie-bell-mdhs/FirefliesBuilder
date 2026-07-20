/**
 * Shared runtime state, owned by the menu-bar app and read by the orchestrator.
 * Kept as a tiny singleton so the tray UI and the orchestrator see the same sets
 * without wiring an event bus.
 */
class BotState {
  /** Fireflies meeting IDs the user chose to skip (e.g. "skip current meeting"). */
  private skipped = new Set<string>();

  /** Fireflies meeting IDs we already have a worker running for. */
  private active = new Set<string>();

  isSkipped(meetingId: string): boolean {
    return this.skipped.has(meetingId);
  }
  skip(meetingId: string): void {
    this.skipped.add(meetingId);
  }

  isActive(meetingId: string): boolean {
    return this.active.has(meetingId);
  }
  markActive(meetingId: string): void {
    this.active.add(meetingId);
  }
  clearActive(meetingId: string): void {
    this.active.delete(meetingId);
  }

  activeIds(): string[] {
    return [...this.active];
  }
}

export const botState = new BotState();

import { config } from "../config.js";

/** One line of transcript. Mirrors Fireflies `sentences` shape. */
export interface Sentence {
  index: number;
  text: string;
  speaker_name: string | null;
  start_time: number | null;
}

export interface Transcript {
  id: string;
  title: string | null;
  date: number | null;
  duration: number | null;
  is_live: boolean;
  sentences: Sentence[];
}

export interface TranscriptSummary {
  id: string;
  title: string | null;
  date: number | null;
  duration: number | null;
}

/** An in-progress meeting Fireflies is currently recording. */
export interface ActiveMeeting {
  id: string;
  title: string | null;
  meeting_link: string | null;
  start_time: number | null;
  state: string | null;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class FirefliesClient {
  constructor(
    private apiKey = config.fireflies.apiKey(),
    private apiUrl = config.fireflies.apiUrl,
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`Fireflies HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as GraphQLResponse<T>;
    if (body.errors?.length) {
      throw new Error(`Fireflies GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!body.data) throw new Error("Fireflies returned no data");
    return body.data;
  }

  /** List recent transcripts — used to grab a real past meeting for offline replay. */
  async listTranscripts(limit = 10): Promise<TranscriptSummary[]> {
    const data = await this.gql<{ transcripts: TranscriptSummary[] }>(
      `query ($limit: Int) {
        transcripts(limit: $limit) { id title date duration }
      }`,
      { limit },
    );
    return data.transcripts ?? [];
  }

  /**
   * Fetch a transcript by id, including sentences. When the meeting is live,
   * this is a point-in-time snapshot of what has been captured so far.
   *
   * NOTE: `is_live` availability depends on your Fireflies plan/API version.
   * If the field is not present for your account, this normalizes it to false;
   * the live-polling path is verified against your account in Phase 2.
   */
  async getTranscript(id: string): Promise<Transcript> {
    const data = await this.gql<{ transcript: RawTranscript }>(
      `query ($id: String!) {
        transcript(id: $id) {
          id
          title
          date
          duration
          sentences { index text speaker_name start_time }
        }
      }`,
      { id },
    );
    const t = data.transcript;
    return {
      id: t.id,
      title: t.title ?? null,
      date: t.date ?? null,
      duration: t.duration ?? null,
      is_live: Boolean((t as { is_live?: boolean }).is_live),
      sentences: (t.sentences ?? []).map((s, i) => ({
        index: s.index ?? i,
        text: s.text ?? "",
        speaker_name: s.speaker_name ?? null,
        start_time: s.start_time ?? null,
      })),
    };
  }

  /**
   * Meetings Fireflies is currently recording (in-progress or paused). This is
   * the trigger for the whole bot: when a meeting appears here, Fireflies has
   * joined and a live transcript is available.
   */
  async getActiveMeetings(): Promise<ActiveMeeting[]> {
    const data = await this.gql<{ active_meetings: RawActiveMeeting[] }>(
      `query {
        active_meetings { id title meeting_link start_time state }
      }`,
    );
    return (data.active_meetings ?? []).map((m) => ({
      id: m.id,
      title: m.title ?? null,
      meeting_link: m.meeting_link ?? null,
      start_time: m.start_time ?? null,
      state: m.state ?? null,
    }));
  }
}

interface RawTranscript {
  id: string;
  title?: string | null;
  date?: number | null;
  duration?: number | null;
  sentences?: Array<Partial<Sentence>> | null;
}

interface RawActiveMeeting {
  id: string;
  title?: string | null;
  meeting_link?: string | null;
  start_time?: number | null;
  state?: string | null;
}

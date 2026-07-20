import fs from "node:fs";
import path from "node:path";
import {
  PublicClientApplication,
  type Configuration,
  type AccountInfo,
  type ICachePlugin,
  type TokenCacheContext,
} from "@azure/msal-node";
import { config } from "../config.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("graph");
const SCOPES = ["Calendars.Read", "offline_access"];
const GRAPH = "https://graph.microsoft.com/v1.0";

export interface CalendarEvent {
  id: string;
  subject: string;
  startUtcMs: number;
  endUtcMs: number;
  /** Teams/online meeting join URL, if any — used to match the Fireflies meeting. */
  joinUrl: string | null;
  isCancelled: boolean;
}

/** Persists the MSAL token cache to .tokens/msal.json so login survives restarts. */
function diskCachePlugin(): ICachePlugin {
  const file = path.join(config.tokensDir, "msal.json");
  return {
    async beforeCacheAccess(ctx: TokenCacheContext) {
      try {
        ctx.tokenCache.deserialize(fs.readFileSync(file, "utf8"));
      } catch {
        /* no cache yet */
      }
    },
    async afterCacheAccess(ctx: TokenCacheContext) {
      if (ctx.cacheHasChanged) {
        fs.mkdirSync(config.tokensDir, { recursive: true });
        fs.writeFileSync(file, ctx.tokenCache.serialize(), { mode: 0o600 });
      }
    },
  };
}

export class GraphCalendar {
  private pca: PublicClientApplication;
  private account: AccountInfo | null = null;

  constructor() {
    const auth: Configuration = {
      auth: {
        clientId: config.ms.clientId(),
        authority: `https://login.microsoftonline.com/${config.ms.tenantId}`,
      },
      cache: { cachePlugin: diskCachePlugin() },
    };
    this.pca = new PublicClientApplication(auth);
  }

  /**
   * Silent sign-in only: use the cached account/refresh token. Throws
   * NotSignedInError if there's no cached login yet (run `npm run login` once).
   * Used by the headless auto-started app so it never blocks on interactive auth.
   */
  async signInSilent(): Promise<void> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (!accounts.length) throw new NotSignedInError();
    this.account = accounts[0];
    await this.pca.acquireTokenSilent({ account: this.account, scopes: SCOPES });
    log.info(`signed in (cached) as ${this.account.username}`);
  }

  /**
   * Interactive device-code login (prints a URL + code). Used by `npm run login`
   * during first-time setup; caches the token to .tokens/ for signInSilent().
   */
  async signIn(onDeviceCode?: (message: string) => void): Promise<void> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length) {
      this.account = accounts[0];
      try {
        await this.pca.acquireTokenSilent({ account: this.account, scopes: SCOPES });
        log.info(`signed in silently as ${this.account.username}`);
        return;
      } catch {
        log.warn("silent token refresh failed — re-running device-code login");
      }
    }
    const result = await this.pca.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (info) => {
        (onDeviceCode ?? ((m) => log.info(m)))(info.message);
      },
    });
    if (!result?.account) throw new Error("Device-code login returned no account");
    this.account = result.account;
    log.info(`signed in as ${this.account.username}`);
  }

  private async token(): Promise<string> {
    if (!this.account) throw new Error("Not signed in — call signIn() first");
    const r = await this.pca.acquireTokenSilent({ account: this.account, scopes: SCOPES });
    if (!r?.accessToken) throw new Error("Failed to acquire access token");
    return r.accessToken;
  }

  /** Events starting between now and now+windowMs (recurrences expanded). */
  async upcomingEvents(windowMs: number): Promise<CalendarEvent[]> {
    const now = new Date();
    const end = new Date(now.getTime() + windowMs);
    const params = new URLSearchParams({
      startDateTime: now.toISOString(),
      endDateTime: end.toISOString(),
      $select: "id,subject,start,end,onlineMeeting,isCancelled",
      $orderby: "start/dateTime",
      $top: "25",
    });
    const res = await fetch(`${GRAPH}/me/calendarView?${params}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) throw new Error(`Graph HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { value: RawEvent[] };
    return body.value.map(normalizeEvent);
  }
}

/** Thrown by signInSilent() when there is no cached login yet. */
export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to Microsoft — run `npm run login` once to connect your calendar.");
    this.name = "NotSignedInError";
  }
}

interface RawEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  isCancelled?: boolean;
}

function normalizeEvent(e: RawEvent): CalendarEvent {
  // Graph returns UTC (per the Prefer header) but omits the trailing Z.
  const toMs = (s?: string) => (s ? Date.parse(s.endsWith("Z") ? s : s + "Z") : 0);
  return {
    id: e.id,
    subject: e.subject ?? "(no subject)",
    startUtcMs: toMs(e.start?.dateTime),
    endUtcMs: toMs(e.end?.dateTime),
    joinUrl: e.onlineMeeting?.joinUrl ?? null,
    isCancelled: Boolean(e.isCancelled),
  };
}

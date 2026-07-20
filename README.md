# Meeting build-bot

A macOS background app that listens to your meetings and **builds things live** — working
code/prototypes and specs — as people describe them, using a Claude coding agent.

**It runs on its own.** Once installed, a headless watcher starts at login and stays
invisible. ~2 minutes before a meeting on your **Outlook calendar** it pops up a menu-bar
icon and starts building from the **Fireflies** transcript. You never launch it manually;
the menu bar exists only to pause or shut it down.

## How it works

```
LaunchAgent (auto-start at login) → headless watcher, invisible while idle
  └─ watcher: polls Outlook every ~60s. ~2 min before a meeting it shows the
       menu bar and waits for Fireflies to start recording the call, then
     └─ worker: polls the live Fireflies transcript every ~40s, tracking what's new
          └─ build agent (Claude Agent SDK, your local Claude Code login / Opus 4.8):
               writes code + SPEC.md into builds/<date>-<meeting>/, refining as the
               meeting goes, and does one consolidation pass when the meeting ends.
```

The menu bar appears only while a meeting is near or a build is running, and disappears
when idle. Outlook provides the ~2-min head start; Fireflies provides the transcript
(which only exists once its notetaker joins the call). Everything built during a meeting
is a **draft**; the final pass reconciles it against the full transcript.

## Setup

### 1. Install

```bash
npm install
# Electron downloads a binary on install; if it was skipped, run:
node node_modules/electron/install.js
```

### 2. Credentials — copy `.env.example` to `.env` and fill in

- **`FIREFLIES_API_KEY`** — Fireflies dashboard → Settings → Developer Settings → API Key.
- **`MS_CLIENT_ID`** (+ `MS_TENANT_ID`) — an Azure app registration for your Outlook
  calendar. In the [Azure portal](https://portal.azure.com): App registrations → New
  registration → Authentication → add a **Mobile and desktop** platform and enable "Allow
  public client flows" → API permissions → Microsoft Graph → **Delegated** →
  `Calendars.Read`. Copy the Application (client) ID.

The build step runs your **local Claude Code login** (your `claude` subscription, on Opus
4.8), not the paid API — make sure you've run `claude` once and signed in, and leave
`ANTHROPIC_API_KEY` blank (setting it would route the build agent to the metered API).

### 3. Connect your calendar (one time)

```bash
npm run login      # prints a URL + code; sign in with Microsoft
```

The token is cached to `.tokens/` and refreshed silently afterward.

### 4. Fireflies must be recording your meetings

The bot reads Fireflies' live transcript — it only exists if the Fireflies notetaker has
**joined the call**. Turn on auto-join in your Fireflies settings.

### 5. Install the auto-start agent

```bash
npm run install:agent      # builds + registers the LaunchAgent (starts now and at every login)
```

From here it runs by itself. To remove it: `npm run uninstall:agent`.

## Using it

You don't start it — it's already running. When a meeting is ~2 minutes away the menu-bar
icon appears (🎙️). Its menu is the only control surface:

- **Listening enabled** — master pause switch.
- **Skip current meeting(s)** — stop building for the meeting(s) in progress.
- **Open output folder** — jump to `builds/`.
- **Quit** — shut the whole thing down until next login (or run `npm run uninstall:agent`
  to stop it starting again).

Logs stream to `logs/buildbot.log`.

To run it in the foreground for debugging (no LaunchAgent): `npm run app`.

## Try it without a live meeting (recommended first step)

Replay a past meeting's transcript in growing slices to exercise the whole build
pipeline — no calendar or menu bar needed:

```bash
npm run replay -- --fixture fixtures/sample-meeting.json   # bundled sample
npm run replay -- --id <firefliesTranscriptId>             # a real past meeting
npm run replay                                             # your most recent meeting
```

Output lands in `builds/<date>-<slug>/` (a prototype plus `SPEC.md`).

## Other commands

```bash
npm run typecheck        # tsc --noEmit
npm run verify:fireflies # sanity-check your Fireflies key + queries
npm run orchestrator     # run the calendar watcher headless (no menu bar), for debugging
```

## Notes & caveats

- **Trigger timing.** Outlook gives the ~2-min head start (`LEAD_SECONDS`); the actual
  build can't start until Fireflies is recording the call, so the worker begins once the
  meeting goes live. No transcript is lost — Fireflies captures from the start.
- **`active_meetings` requires a Fireflies plan that exposes it.** The worker matches a
  calendar event to Fireflies' `active_meetings` query. If your plan/API doesn't return
  live meetings, the watcher logs the error and the offline replay path still works.
  Verify with `npm run orchestrator` while a meeting is live.
- **The `is_live` transcript field is optional.** The bot doesn't depend on it — a meeting
  is treated as live for as long as it appears in `active_meetings`, and the final
  consolidation pass runs once it drops off.
- **Autonomy & safety.** The build agent runs with permissions bypassed but is scoped to
  the per-meeting workspace (`builds/<meeting>/`) via its working directory and a fixed
  tool allowlist (Read/Write/Edit/Bash/Glob/Grep). It won't touch anything outside that
  folder.
- **Model.** Defaults to `claude-opus-4-8` (set `BUILD_MODEL` in `.env`).
- **Packaging.** For a real always-available app, bundle with electron-builder and set
  `LSUIElement=true` in the Info.plist so it never appears in the dock.

# Meeting build-bot

A macOS menu-bar app that listens to your meetings (via Fireflies) and **builds things
live** — working code/prototypes and specs — as people describe them, using a Claude
coding agent. It watches your Outlook calendar, fires ~2 minutes before a meeting, and
you can toggle it off from the menu bar any time.

## How it works

```
menu bar (toggle on/off, skip a meeting)
  └─ orchestrator: polls Outlook every ~60s; ~2 min before a meeting it
       matches the event to the Fireflies meeting being recorded, then
     └─ worker: polls the live transcript every ~40s, tracking what's new
          └─ build agent (Claude Agent SDK): writes code + SPEC.md into
               builds/<date>-<meeting>/, refining as the meeting goes,
               and does one consolidation pass when the meeting ends.
```

Everything built during a meeting is a **draft**; the final pass reconciles it against
the full transcript.

## Setup

### 1. Install

```bash
npm install
# Electron downloads a binary on install; if it was skipped, run:
node node_modules/electron/install.js
```

### 2. Credentials — copy `.env.example` to `.env` and fill in

- **`ANTHROPIC_API_KEY`** — for the build agent. (If you're signed into the `claude`
  CLI, the Agent SDK can use that login instead; the key is optional.)
- **`FIREFLIES_API_KEY`** — Fireflies dashboard → Settings → Developer Settings → API Key.
- **Microsoft Graph** — register an app in the [Azure portal](https://portal.azure.com):
  - Azure Active Directory → App registrations → New registration.
  - Supported account types: your org (or "any org" for `MS_TENANT_ID=common`).
  - Authentication → Add a platform → **Mobile and desktop** → enable
    "Allow public client flows" (this app uses device-code login, no client secret).
  - API permissions → Microsoft Graph → **Delegated** → `Calendars.Read` → grant.
  - Copy the **Application (client) ID** → `MS_CLIENT_ID`; set `MS_TENANT_ID` to your
    tenant ID (or leave `common`).

### 3. Fireflies must be recording your meetings

The bot reads Fireflies' live transcript — it only exists if the Fireflies notetaker has
**joined the call**. Turn on auto-join for your meetings in Fireflies settings. The
menu-bar toggle controls whether *this bot builds*, not whether Fireflies records.

## Run

```bash
npm run app        # build + launch the menu-bar app
```

On first run it shows a Microsoft device-code prompt (a URL + code) to connect your
calendar. After that the login is cached in `.tokens/` and refreshes automatically.

Menu-bar controls: **Listening enabled** (master switch), **Skip current meeting(s)**,
**Open output folder**, **Quit**.

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
npm run orchestrator     # run the calendar loop headless (no menu bar), for debugging
```

## Notes & caveats

- **Fireflies API shape varies by plan.** The live "active meetings" query
  (`getActiveMeetings`) and the `is_live` field aren't available on every account. If
  they're missing, calendar-triggered live building won't match meetings — the offline
  replay path still works, and the orchestrator logs a clear warning. Verify against your
  account with `npm run orchestrator`.
- **Autonomy & safety.** The build agent runs with permissions bypassed but is scoped to
  the per-meeting workspace (`builds/<meeting>/`) via its working directory and a fixed
  tool allowlist (Read/Write/Edit/Bash/Glob/Grep). It won't touch anything outside that
  folder.
- **Model.** Defaults to `claude-opus-4-8` (set `BUILD_MODEL` in `.env`).
- **Packaging.** For a real always-available app, bundle with electron-builder and set
  `LSUIElement=true` in the Info.plist so it never appears in the dock.

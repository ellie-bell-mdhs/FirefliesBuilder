# Meeting build-bot

A macOS menu-bar app that listens to your meetings (via Fireflies) and **builds things
live** — working code/prototypes and specs — as people describe them, using a Claude
coding agent. It watches Fireflies for meetings that go live and you can toggle it off
from the menu bar any time.

## How it works

```
menu bar (toggle on/off, skip a meeting)
  └─ orchestrator: polls Fireflies every ~30s for meetings that just went live
       (Fireflies is the calendar — a meeting appears once its notetaker joins)
     └─ worker: polls the live transcript every ~40s, tracking what's new
          └─ build agent (Claude Agent SDK): writes code + SPEC.md into
               builds/<date>-<meeting>/, refining as the meeting goes,
               and does one consolidation pass when the meeting ends.
```

Because Fireflies only exposes meetings once they're live, the bot engages within one
poll (~30s) of a meeting starting — not before it. You don't lose any content:
`get_transcript` returns everything captured since the meeting began, so the bot just
starts building a little after the call opens. Everything built during a meeting is a
**draft**; the final pass reconciles it against the full transcript.

## Setup

### 1. Install

```bash
npm install
# Electron downloads a binary on install; if it was skipped, run:
node node_modules/electron/install.js
```

### 2. Credentials — copy `.env.example` to `.env` and fill in

- **`FIREFLIES_API_KEY`** — Fireflies dashboard → Settings → Developer Settings → API Key.

That's the only credential you need. The build step runs your **local Claude Code login**
(your `claude` subscription, on Opus 4.8) rather than the paid Anthropic API — so make
sure you've run `claude` once and signed in. Leave `ANTHROPIC_API_KEY` blank; setting it
would route the build agent to the metered API instead. No calendar/Microsoft setup
required.

### 3. Fireflies must be recording your meetings

The bot reads Fireflies' live transcript — it only exists if the Fireflies notetaker has
**joined the call**. Turn on auto-join for your meetings in Fireflies settings. The
menu-bar toggle controls whether *this bot builds*, not whether Fireflies records.

## Run

```bash
npm run app        # build + launch the menu-bar app
```

It runs in the background watching Fireflies for live meetings.

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
npm run orchestrator     # run the Fireflies watch loop headless (no menu bar), for debugging
```

## Notes & caveats

- **`active_meetings` requires a Fireflies plan that exposes it.** The bot triggers on
  Fireflies' `active_meetings` query. If your plan/API doesn't return live meetings, the
  orchestrator logs the error and the offline replay path still works. Verify against your
  account with `npm run orchestrator` while a meeting is live.
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

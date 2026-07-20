# Meeting build-bot

A macOS background app that listens to your meetings and **builds things live** — working
code/prototypes and specs — as people describe them, using a Claude coding agent.

**It runs on its own.** Once installed, a headless watcher starts at login and stays
invisible. When your **Fireflies** notetaker joins a meeting, a menu-bar icon pops up and
the bot starts building from the live transcript. You never launch it manually; the menu
bar exists only to pause or shut it down. (Fireflies joins calls early, so this is your
effective "meeting starting" signal — no calendar integration needed.)

## How it works

```
LaunchAgent (auto-start at login) → headless watcher, invisible while idle
  └─ watcher: polls Fireflies every ~30s for meetings that are live. When one
       appears it shows the menu bar and starts a worker, which
     └─ polls the live transcript every ~40s, tracking what's new
          └─ build agent (Claude Agent SDK, your local Claude Code login / Opus 4.8):
               writes code + SPEC.md into builds/<date>-<meeting>/, refining as the
               meeting goes, and does one consolidation pass when the meeting ends.
```

The menu bar appears only while a meeting is live or a build is running, and disappears
when idle. `get_transcript` returns everything captured since the meeting began, so no
content is lost. Everything built during a meeting is a **draft**; the final pass
reconciles it against the full transcript.

## Setup

### 1. Install

```bash
npm install
# Electron downloads a binary on install; if it was skipped, run:
node node_modules/electron/install.js
```

### 2. Credentials — copy `.env.example` to `.env` and fill in

- **`FIREFLIES_API_KEY`** — Fireflies dashboard → Settings → Developer Settings → API Key.

That's the only credential. The build step runs your **local Claude Code login** (your
`claude` subscription, on Opus 4.8), not the paid API — make sure you've run `claude` once
and signed in, and leave `ANTHROPIC_API_KEY` blank (setting it would route the build agent
to the metered API). No calendar/Microsoft setup.

### 3. Fireflies must be recording your meetings

The bot reads Fireflies' live transcript — it only exists if the Fireflies notetaker has
**joined the call**. Turn on auto-join in your Fireflies settings.

### 4. Install the auto-start agent

```bash
npm run install:agent      # builds + registers the LaunchAgent (starts now and at every login)
```

From here it runs by itself. To remove it: `npm run uninstall:agent`.

## Using it

You don't start it — it's already running. When Fireflies joins a meeting the menu-bar
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

- **Trigger timing.** The bot engages when Fireflies reports the meeting as live
  (`active_meetings`). Since the notetaker joins early, that's around the meeting start; no
  transcript is lost — `get_transcript` captures from the beginning.
- **`active_meetings` requires a Fireflies plan that exposes it.** If your plan/API doesn't
  return live meetings, the watcher logs the error and the offline replay path still works.
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

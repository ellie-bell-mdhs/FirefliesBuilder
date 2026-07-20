# Meeting build-bot

A macOS background app that listens to your meetings and **builds things live** — working
code/prototypes and specs — as people describe them, using Claude Code.

**It runs on its own.** Once installed, a headless watcher starts at login and stays
invisible. When your **Fireflies** notetaker joins a meeting, a menu-bar icon pops up and
a **Ghostty terminal window opens with an interactive Claude Code session** inside a folder
named after the meeting, building from the live transcript. You never launch it manually;
the menu bar exists only to pause or shut it down. (Fireflies joins calls early, so this is
your effective "meeting starting" signal — no calendar integration needed.)

## How it works

```
LaunchAgent (auto-start at login) → headless watcher, invisible while idle
  └─ watcher: polls Fireflies every ~30s for meetings that are live. When one
       appears it shows the menu bar and starts a worker, which
     └─ creates <builds-dir>/<date>-<meeting>/, writes BUILDBOT.md + TRANSCRIPT.md,
        and opens a Ghostty window running `claude` (Opus 4.8) in that folder
          └─ the watcher keeps TRANSCRIPT.md up to date every ~40s while the meeting
             runs; Claude Code builds code + SPEC.md from it FULLY AUTONOMOUSLY — it
             never asks you questions, it decides every call itself and logs the
             uncertain ones to DECISIONS.md for you to review later.
          └─ when the meeting ends, the watcher marks TRANSCRIPT.md ENDED. That does
             ONE thing: the session writes a SUMMARY.md (what it's building, where it's
             at) and keeps going. It is never told to stop.
```

The menu bar appears only while a meeting is live or a build is running, and disappears
when idle. The Claude session runs on your **local Claude Code login** (your `claude`
subscription) — no API key. `get_transcript` returns everything captured since the meeting
began, so no content is lost.

**The session is fully autonomous.** It makes every judgment call on its own so it can build
as much as possible during the meeting, and records anything it wasn't sure about in
`DECISIONS.md` — the question, what it decided, and why. When the meeting ends it writes a
surface-level `SUMMARY.md` and keeps working; ending the meeting never stops or pauses it.
So when you're back you read `SUMMARY.md` and `DECISIONS.md`, then confirm or change the
shaky calls together in the still-open window.

## Setup

### 1. Install

```bash
npm install
# Electron downloads a binary on install; if it was skipped, run:
node node_modules/electron/install.js
```

You also need **Ghostty** (the terminal each meeting opens in) and the **`claude` CLI** on
your PATH. Run `claude` once and sign in — the meeting session uses that stored login.

### 2. Credentials — copy `.env.example` to `.env` and fill in

- **`FIREFLIES_API_KEY`** — Fireflies dashboard → Settings → Developer Settings → API Key.

That's the only credential. The Claude Code session that each meeting opens runs on your
**local Claude Code login** (your `claude` subscription, on Opus 4.8), not the paid API — no
`ANTHROPIC_API_KEY` needed. No calendar/Microsoft setup.

Meeting folders are created in **`/Users/ebell/Projects/`** by default (`<date>-<meeting>/`);
override with `BUILDS_DIR` in `.env`.

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
- **Open output folder** — jump to the meeting folders (`/Users/ebell/Projects/`).
- **Quit** — shut the whole thing down until next login (or run `npm run uninstall:agent`
  to stop it starting again).

Logs stream to `logs/buildbot.log`.

To run it in the foreground for debugging (no LaunchAgent): `npm run app`.

## Try it without a live meeting (recommended first step)

Replay a past meeting's transcript in growing slices to exercise the whole build
pipeline — no calendar or menu bar needed. It creates the meeting folder, writes
`BUILDBOT.md` + `TRANSCRIPT.md`, and opens the Ghostty/Claude session:

```bash
npm run replay -- --fixture fixtures/sample-meeting.json   # bundled sample
npm run replay -- --id <firefliesTranscriptId>             # a real past meeting
npm run replay                                             # your most recent meeting
```

The meeting folder lands in `/Users/ebell/Projects/<date>-<slug>/` (or `BUILDS_DIR`). To
test the pipeline **without** opening a window or starting a real Claude session, set
`BUILDBOT_NO_LAUNCH=1` — it writes the files and logs what it *would* have launched.

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
  is treated as live for as long as it appears in `active_meetings`. Once it drops off, the
  watcher stamps an `ENDED` marker at the bottom of `TRANSCRIPT.md` and stops updating it.
  That marker's only job is to cue the session to write `SUMMARY.md`; it never stops or
  pauses the session, which keeps running for you to pick up.
- **Autonomy & safety.** Each meeting opens an ordinary interactive Claude Code session in
  its own folder (`/Users/ebell/Projects/<date>-<meeting>/`). It behaves like any `claude`
  session you'd start there — your normal permission settings apply, and because it's a
  visible window you can watch and interrupt it.
- **Model.** Defaults to `claude-opus-4-8`, passed to `claude --model` (set `BUILD_MODEL`).
- **Requires Ghostty + the `claude` CLI** on your PATH. Ghostty is single-instance on macOS,
  so the meeting session opens as a new window in your running Ghostty.
- **Packaging.** For a real always-available app, bundle with electron-builder and set
  `LSUIElement=true` in the Info.plist so it never appears in the dock.

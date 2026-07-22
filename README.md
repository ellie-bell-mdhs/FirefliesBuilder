# Meeting build-bot

A macOS background app that listens to your meetings and **builds things live** — working
code/prototypes and specs — as people describe them, using Claude Code.

**It lives in your menu bar.** You toggle it on from **applicationManager** (see Setup); it
then sits in the menu bar doing nothing until you tell it to. When you're in a meeting (with the **Fireflies**
notetaker recording it), you click **"Start on current meeting"** in its dropdown. It finds
the live meeting and opens a **Ghostty terminal window with an interactive Claude Code
session** inside a folder named after the meeting. That session is the **orchestrator**: it
doesn't build things itself — it understands what's being asked, spins up a team of
persistent worker agents, and delegates the parts to them.

If you click before the Fireflies bot has joined, it doesn't give up — it watches for a few
minutes and starts automatically the moment the bot joins (cancelable from the menu).

## How it works

```
toggle on in applicationManager → menu-bar app, idle until you press Start
  └─ you press "Start on current meeting" → one check of Fireflies active_meetings
       ├─ live meeting found → start it (below)
       └─ none yet → watch every ~20s (up to 10 min), auto-start when the bot joins
     └─ starting a meeting: creates <builds-dir>/<date>-<meeting>/, seeds
        ORCHESTRATOR.md + the mesh + a `mesh` CLI + TRANSCRIPT.md, and opens a Ghostty
        window running `claude` (Opus 4.8) in that folder — the ORCHESTRATOR
          ├─ orchestrator: reads the transcript, decomposes the work, and delegates
          │   parts to persistent worker agents via `./mesh`. It stays free to talk
          │   to you and integrates the pieces. It does not code itself.
          ├─ workers: long-lived `claude` processes, one per slice of work, each in
          │   its own folder with its own memory. They build in parallel, message
          │   each other and the orchestrator, and stay alive across tasks.
          └─ a watcher keeps TRANSCRIPT.md fresh every ~10s. When the meeting ends
              it marks it ENDED — which only tells the orchestrator to write SUMMARY.md
              and keep coordinating. Nothing is ever told to stop.
```

The menu bar is always there; nothing runs until you press Start (no background polling).
Every Claude session (orchestrator and workers) runs on your **local Claude Code login**
(your `claude` subscription) — no API key. `get_transcript` returns everything captured
since the meeting began, so no content is lost.

**Why an orchestrator + workers?** So the agent you talk to isn't head-down coding — it
stays free to think, answer you, and steer — while many workers make progress in parallel,
which gets more done faster. See [the mesh](#the-agent-mesh) below.

**Everything is fully autonomous.** The orchestrator and workers make every judgment call
themselves so they build as much as possible during the meeting, and record anything they
weren't sure about in `DECISIONS.md` — the question, what was decided, and why. When the
meeting ends the orchestrator writes a surface-level `SUMMARY.md` and keeps coordinating;
ending the meeting never stops or pauses anything. So when you're back you read `SUMMARY.md`
and `DECISIONS.md`, then confirm or change the shaky calls in the still-open window.

## The agent mesh

The orchestrator commands a mesh of **persistent worker agents** through a small `mesh` CLI
that's written into the meeting folder. Coordination is entirely file-based (no server), so
the whole mesh lives inside the meeting folder and any agent can drive it:

```
mesh spawn --name api --role "build the REST API"   # create a persistent worker
mesh send  --to api --type task --msg "add /health" # delegate a task
mesh send  --from api --to db --type question --msg "schema for users?"   # peer-to-peer
mesh post  --from api --msg "health endpoint live"  # update the shared board
mesh inbox | mesh board | mesh agents               # read replies / status / team
mesh stop  --name api | mesh stop --all             # wind an agent down
```

Each worker is a long-lived process that resumes the **same** Claude session on every
message (so it keeps its memory) and idle-polls its inbox — it doesn't vanish after one
job. Messages are JSON lines in `.mesh/bus/<agent>.inbox.jsonl`; status goes to a shared
`BOARD.md`; each worker builds in `workspaces/<name>/`.

## Visual capture (screenshots)

Text isn't always enough — when someone says "make it look exactly like *this*," the agent
needs to *see* it. Two things make that work:

- **Timestamped transcript.** Every `TRANSCRIPT.md` line is prefixed with its time, e.g.
  `[04:12] Erik: make it look like this`.
- **Flagging moments.** When the orchestrator hits a visual reference, it flags the moment:
  `./mesh shot --at 252 --note "the target design"`. That (a) grabs a best-effort screenshot
  of your Mac screen right then, and (b) queues the timestamp.

**Fireflies video only exists after the meeting processes**, so the accurate capture is
deferred: when the meeting ends, a background step waits for the recording, downloads it, and
uses `ffmpeg` to extract the **exact frame** at each flagged timestamp into `media/`. It then
writes a `VISUALS.md` index and messages the orchestrator, which reads the images (Claude's
Read tool handles PNGs) and reconciles the build against what was actually shown.

```
LIVE:  [04:12] "...like this"  ->  ./mesh shot --at 252 --note "target design"
                                   ├─ screencapture -> media/live-*.png   (immediate, your screen)
                                   └─ queue t=252s in .mesh/visuals.jsonl
END:   wait for Fireflies video -> download -> ffmpeg frame @252s
       -> media/frame-0412-target-design.png + VISUALS.md -> msg to orchestrator
```

**Prerequisites** (feature degrades gracefully without them — you just get fewer/no images):
- **`ffmpeg`** on PATH — `brew install ffmpeg`. Without it, frame extraction is skipped.
- **Fireflies Pro+** with **RECORD MEETING VIDEO** enabled — otherwise `video_url` is null and
  only the live Mac screenshots are produced.
- macOS **Screen Recording** permission for the terminal (Ghostty) that runs `screencapture`,
  or the live shot silently produces nothing.

Caveats: the live Mac screenshot lags the spoken words by up to one transcript poll (~10s by
default; raise `TRANSCRIPT_POLL_SECONDS` if you hit Fireflies rate limits) and only sees *your*
display; the post-meeting Fireflies frame is the exact, authoritative one.

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

Meeting folders are created in **`~/Projects/`** by default (`<date>-<meeting>/`);
override with `BUILDS_DIR` in `.env`.

### 3. Fireflies must be recording your meetings

The bot reads Fireflies' live transcript — it only exists if the Fireflies notetaker has
**joined the call**. Turn on auto-join in your Fireflies settings.

### 4. Add it to applicationManager

The app ships as a small `.app` you toggle on/off from
[applicationManager](../menuBarApplications/applicationManager):

```bash
npm run bundle:app     # builds the app + a MeetingBuildBot.app launcher, installed into
                       # ~/Projects/menuBarApplications/ where applicationManager finds it
```

Then open applicationManager and toggle **MeetingBuildBot** on — the 🎙️ tray appears; toggle
it off and it's gone. It runs only when toggled on (no launch-at-login). Re-run
`npm run bundle:app` after code changes to rebuild the app the launcher runs.

The `.app` is a thin launcher: it runs the Electron app from this repo in a login shell (so
your `claude`/`ghostty`/`ffmpeg`/`node` and `.env` all resolve), and stops just the menu-bar
app when toggled off — any in-progress meeting (Ghostty window + worker agents) keeps running.

> Legacy: `npm run install:agent` (LaunchAgent auto-start) still exists but is superseded by
> applicationManager. If you'd installed it before, remove it with `npm run uninstall:agent`.

## Using it

The app is always in your menu bar (🎙️). When you're in a meeting, open its dropdown and:

- **Start on current meeting** — checks Fireflies for a live meeting and starts the bot on
  it. If the Fireflies bot hasn't joined yet, it switches to **watching** (👀) and starts
  automatically once it does.
- **Stop looking** — shown while watching; cancels the wait.
- **Skip / stop current meeting(s)** — shown while building (🛠️); stops the build(s) in
  progress.
- **Open output folder** — jump to the meeting folders (`~/Projects/`).
- **Quit** — shut down the menu-bar app (same as toggling it off in applicationManager).

Nothing runs until you press Start — there's no background polling. Logs stream to
`logs/buildbot.log`. To run it in the foreground for debugging: `npm run app`.

## Try it without a live meeting (recommended first step)

Replay a past meeting's transcript in growing slices to exercise the whole pipeline — no
calendar or menu bar needed. It creates the meeting folder, seeds `ORCHESTRATOR.md`, the
mesh, the `mesh` CLI, and `TRANSCRIPT.md`, and opens the Ghostty/Claude orchestrator:

```bash
npm run replay -- --fixture fixtures/sample-meeting.json   # bundled sample
npm run replay -- --id <firefliesTranscriptId>             # a real past meeting
npm run replay                                             # your most recent meeting
```

The meeting folder lands in `~/Projects/<date>-<slug>/` (or `BUILDS_DIR`). To
test the pipeline **without** opening a window or starting a real Claude session, set
`BUILDBOT_NO_LAUNCH=1` — it writes the files and logs what it *would* have launched.

## Other commands

```bash
npm run typecheck        # tsc --noEmit
npm run test:mesh        # offline integration test of the agent mesh (fake Claude)
npm run verify:fireflies # sanity-check your Fireflies key + queries
npm run watch            # one-shot: check for a live meeting now (headless), for debugging
```

## Notes & caveats

- **Trigger.** You press "Start"; the bot engages when Fireflies reports the meeting as live
  (`active_meetings`). If you press before the bot has joined, it watches and starts once it
  does. No transcript is lost — `get_transcript` captures from the beginning.
- **`active_meetings` requires a Fireflies plan that exposes it.** If your plan/API doesn't
  return live meetings, Start reports an error and the offline replay path still works.
  Verify with `npm run watch` while a meeting is live.
- **The `is_live` transcript field is optional.** The bot doesn't depend on it — a meeting
  is treated as live for as long as it appears in `active_meetings`. Once it drops off, the
  watcher stamps an `ENDED` marker at the bottom of `TRANSCRIPT.md` and stops updating it.
  That marker's only job is to cue the orchestrator to write `SUMMARY.md`; it never stops
  or pauses anything, and the orchestrator and its workers keep running for you to pick up.
- **Autonomy & safety.** The orchestrator opens as a visible, interactive Claude Code
  session in the meeting folder, so you can watch and interrupt it. Workers, by contrast,
  run **headless** (`claude -p`) with permissions bypassed, each scoped to its own
  `workspaces/<name>/` folder. They're autonomous by design — that's the point — so treat
  the meeting folder as a sandbox and review `DECISIONS.md` before shipping anything.
- **Cost.** Each active worker is a separate Opus session on your subscription, and several
  can run at once. Workers only invoke Claude when handling a message (idle-polling is free),
  and you can cap the team with `mesh stop`. Spawn workers deliberately.
- **Model.** Defaults to `claude-opus-4-8`, passed to `claude --model` (set `BUILD_MODEL`);
  used by both the orchestrator and the workers.
- **Requires Ghostty + the `claude` CLI** on your PATH. Ghostty is single-instance on macOS,
  so the orchestrator opens as a new window in your running Ghostty.
- **The mesh needs the build.** The `mesh` CLI runs from `dist/`, so `npm run bundle:app`
  (or `npm run app`) must have built the project. `npm run replay` seeds a real `mesh`
  wrapper too, but it points at `dist/` — run `npm run build` first if you'll drive it.
- **Toggling off doesn't stop a meeting.** applicationManager's off just quits the menu-bar
  app; any in-progress Ghostty/orchestrator + worker agents keep running — close them
  yourself, or use the tray's "Skip / stop" before toggling off.
- **Packaging.** The `.app` is a launcher that runs this repo (not a self-contained bundle),
  so keep the repo at `~/Projects/Fireflies`. For a fully standalone build you'd instead use
  electron-builder to embed Electron — heavier, and it'd need the node/PATH/.env fixes the
  launcher sidesteps.

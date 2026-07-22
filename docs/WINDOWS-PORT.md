# Porting the Meeting Build-Bot to Windows

**Audience: this file is written for the Claude that will do the port.** A friend built
this on macOS and handed you the whole repo plus this guide. Your job is to make it run on
**Windows** at full fidelity. Read this end to end before editing anything.

The golden rule: **port the *intent*, not the lines.** Most of this app is plain Node and
already cross-platform. A thin macOS "surface" (how it opens a terminal, takes screenshots,
finds binaries, and how it's switched on) is the only thing you need to replace. This guide
tells you exactly what's portable (leave it alone) and, for each macOS piece, the
*behavioral contract* it must satisfy on Windows — plus concrete options. Where a decision
is yours to make, it says so.

---

## 1. What this app is (architecture)

A meeting "build-bot." You trigger it manually; it watches your live Fireflies meeting
transcript and turns the conversation into real work using Claude agents.

```
 [manual trigger]                          ← macOS: menu-bar item. Windows: YOUR CHOICE (§4A)
        │
        ▼
 Orchestrator.startOnCurrentMeeting()      ← pure logic, portable (src/orchestrator.ts)
        │  asks Fireflies: active_meetings?
        ▼
 for each LIVE meeting:
        │
        ├── make a per-meeting folder  <buildsDir>/<date>-<title>/
        │
        ├── open an INTERACTIVE claude session in a terminal window, cd'd into that folder
        │        └─ this Claude is the ORCHESTRATOR (reads ORCHESTRATOR.md)   ← macOS: Ghostty (§4B)
        │
        ├── watcher loop: every ~10s re-fetch the transcript, diff it, and rewrite
        │        TRANSCRIPT.md (lines timestamped "[MM:SS] Speaker: text")     ← portable
        │
        │   The orchestrator DELEGATES: it spawns a mesh of PERSISTENT worker
        │   agents through a generated `mesh` CLI. Each worker is a headless
        │   `claude` that keeps its memory across turns via --resume <session_id>.
        │   Workers talk to each other over a file-based bus (inboxes + BOARD.md). ← portable (§3)
        │
        └── when the meeting ends: write SUMMARY.md, then a DETACHED process
                 downloads the Fireflies recording and extracts the exact video
                 frame for every "visual moment" the orchestrator flagged with
                 `mesh shot --at <sec>` (plus live screenshots taken during the call). ← macOS: screencapture + ffmpeg (§4C/§4D)
```

Design principles worth preserving:
- **Manual and bounded.** Nothing runs in the background; the trigger does one check of
  `active_meetings` and, if the Fireflies bot hasn't joined yet, arms a *bounded* watch that
  re-checks for a few minutes then gives up.
- **Fully autonomous session.** The orchestrator never stops to ask the user questions
  mid-meeting; it decides and logs shaky calls to `DECISIONS.md`.
- **Persistence via session resume.** A "persistent agent" is just headless
  `claude -p --resume <session_id>` called repeatedly — that's what gives a worker memory.
- **No API key.** Every `claude` invocation uses the local Claude Code login, not the
  Anthropic API. Keep it that way.

---

## 2. Prerequisites on Windows

- **Node 18+** (the code relies on global `fetch`). Verify: `node --version`.
- **The `claude` CLI, logged in.** Claude Code runs on Windows. Run `claude` once and sign
  in. No API key/env needed. Verify a headless call works:
  `echo hello | claude -p --output-format json`.
- **ffmpeg** on PATH (for post-meeting video frames). Verify: `where ffmpeg`.
- **git**, and a terminal you can script (Windows Terminal `wt.exe` is ideal).

### ⚠️ The first decision you must make: WSL vs native Windows

This is the single most important architectural choice, and getting it wrong causes
confusing, silent failures. The app spawns four external things: **`claude`**, a **terminal
window**, a **screenshot tool**, and **ffmpeg**. They must ALL live in the *same* world.

- If the user runs Claude Code (and this app) under **WSL**, then the terminal you open,
  the screenshot tool, and ffmpeg must be reachable from WSL — but WSL can't easily capture
  the Windows desktop or open a native GUI terminal. This path is painful for the
  screenshot/terminal features.
- **Recommendation: run this natively on Windows** (native Node + native `claude` +
  `wt.exe` + a native screenshot tool + native ffmpeg). Everything in one world. Only choose
  WSL if the user insists and is willing to drop or bridge live screen capture.

Decide this first and keep every spawned process in that world.

---

## 3. The portable core — DO NOT rewrite these

These modules are plain Node (fs/path/fetch) with no OS assumptions that matter on Windows.
Read them to understand the system, but **do not port them** — changing them just adds bugs.

| Module | What it does | Note |
|---|---|---|
| `src/fireflies/client.ts` | Fireflies GraphQL: `getActiveMeetings` (the trigger), `getTranscript`, `listTranscripts`, `getRecording`. Pure `fetch`. | Fully portable. |
| `src/config.ts` | Env/`.env` config, timers. | Logic portable; only some *default values* are macOS paths — fix in §4G. |
| `src/state.ts` | In-memory active/skipped meeting sets. | Fully portable. |
| `src/orchestrator.ts` | `startOnCurrentMeeting` / `checkOnce` / `armWatch` — the whole trigger-and-watch flow. | Fully portable. This is what your Windows trigger (§4A) calls. |
| `src/mesh/bus.ts` | File-based agent message bus (JSONL inboxes, registry, `BOARD.md`). | Portable. Uses `path.join`. `pidAlive()` uses `process.kill(pid,0)` — works on Windows (existence check). |
| `src/mesh/worker.ts` | The persistent-worker loop (poll inbox → resume session → reply). | Portable except POSIX signal handlers (harmless). |
| `src/mesh/claude.ts` | Builds and spawns the headless `claude` call; parses JSON; resumes sessions. | Portable **if `claude` is on PATH**. See §5. |
| `src/vision/visuals.ts` | The "visual moments" JSONL queue + `[MM:SS]` formatting. | Fully portable. |
| `src/vision/capture.ts` | Post-meeting orchestration: wait for recording → download → extract frames → write `VISUALS.md`. | Portable; its only OS reliance is ffmpeg, via §4D. |
| poll/diff loop in `src/meeting-worker.ts` | `runMeetingWorker` workspace setup + transcript diffing + ENDED/summary flow. | The *logic* is portable; it just calls three OS helpers you'll fix in §4B/§4E. |

---

## 4. The porting surface — replace each of these

For every item: **what it does today → the contract it must satisfy on Windows → options.**
Pick whatever fits the user's setup; where the choice is explicitly yours, it says so.

### 4A. Activation / trigger — *this one is entirely your call*

**Today (macOS):** the app is a menu-bar (tray) app. `src/main.ts` creates a tray via
`src/tray.ts`; clicking **"Start on current meeting"** calls
`orchestrator.startOnCurrentMeeting()`. It's also packaged as a tiny Swift launcher
(`launcher/`) that a separate macOS app toggles on/off, with an optional login-autostart
LaunchAgent (`scripts/launchagent.mjs`). **Windows has none of this** — no menu bar, no
`applicationManager`, no `launchctl`.

**Delete outright** (macOS-only, no Windows equivalent):
- the entire `launcher/` folder (`MeetingBuildBot.swift`, `Info.plist`, `build.sh`)
- `scripts/launchagent.mjs`
- the `bundle:app`, `install:agent`, `uninstall:agent` scripts in `package.json`

**The contract — this is all that actually matters:** the user needs a **manual,
always-available way to fire `Orchestrator.startOnCurrentMeeting()`** while they're in a
meeting, and ideally to see the resulting events (`started` / `already` / `watching` /
`timeout` / `error`) and to stop the bounded watch (`orchestrator.cancelWatch()`). How that
surface looks is **your decision** — choose what fits her setup. Whatever you build must
wire into the same `Orchestrator` methods `src/main.ts` currently uses.

**Options (not a prescription — pick one, or invent your own):**
- **Windows system-tray app (Electron).** Electron's `Tray` works on Windows. Closest to the
  original feel. Caveat: the macOS-only `tray.setTitle("🎙️")` emoji-in-menubar trick doesn't
  exist on Windows — use a real tray **icon** + **tooltip**, and show status text as a
  disabled menu item (see §4F).
- **Global hotkey.** A tiny always-running process (Electron `globalShortcut`, or an
  AutoHotkey script) that calls the trigger. Fastest for the user mid-call; no window.
- **A CLI command / double-clickable `.bat`.** Simplest and most robust: a `start.bat` (or
  `npm run go`) that runs the headless orchestrator entry (`src/orchestrator.ts` already has
  a `import.meta.url === ...` main block: `npm run watch`). No GUI at all.
- **A tiny always-on-top window** with one button.
- **Task Scheduler** if she'd rather it be available without thinking about it.

Recommendation if you want the least-surprise path: a **system-tray Electron app** (keeps
`src/main.ts`'s structure, just fix the tray rendering) — but a `start.bat` is the safest
minimum if the GUI fights you. Confirm the choice with the user if unsure.

### 4B. Interactive terminal Claude session — `src/ghostty.ts`

**Today (macOS):** `launchClaudeInGhostty()` opens the **Ghostty** terminal running, via
`/bin/zsh -lc`, roughly:
```
cd '<workspace>' && claude --model '<model>' '<initialPrompt>'; exec /bin/zsh -l
```
i.e. it opens a visible window, cd's into the meeting folder, starts an **interactive**
`claude` with the kickoff prompt, then drops to a shell so the window stays open.

**Contract on Windows:** open a **new, visible terminal window**, working directory = the
meeting workspace, running **interactive** `claude --model <model> "<initialPrompt>"`, and
**keep the window open afterward** so the user can keep talking to the orchestrator.

**Options:**
- **Windows Terminal (recommended):**
  ```
  wt.exe -d "<workspace>" cmd /k claude --model <model> "<initialPrompt>"
  ```
  `cmd /k` keeps the window open after `claude` exits. Spawn it detached
  (`spawn(..., { detached: true, stdio: "ignore" }).unref()`).
- **Plain cmd:** `start "" cmd /k "cd /d "<workspace>" && claude --model <model> "<prompt>""`
- **PowerShell:** `start powershell -NoExit -Command "cd '<workspace>'; claude --model <model> '<prompt>'"`

Rewrite `src/ghostty.ts` (rename it if you like, e.g. `terminal.ts`) to keep the same
exported function signature so `src/meeting-worker.ts` doesn't change. **Keep the
`BUILDBOT_NO_LAUNCH` env escape hatch** — it lets you run the pipeline in tests without
popping a window. Watch out for quoting: the `initialPrompt` is long and contains spaces and
punctuation; prefer passing it as a single argv element (avoid manual string interpolation
into a `cmd` line where possible), or write the prompt to a temp file and pass a short
"read PROMPT.txt" instruction.

### 4C. Live screen capture — `src/vision/screen.ts`

**Today (macOS):** `captureScreen(dest)` runs `screencapture -x -t png <dest>` and returns
true if a non-empty file was produced. Used by the `mesh shot` command (gated by
`config.vision.liveScreenshot`).

**Contract:** capture the **primary display** to a PNG at `dest`; return true on success
(non-empty file). No macOS-style permission prompt exists on Windows.

**Options:**
- **PowerShell + .NET (no install):**
  ```powershell
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
  $bmp.Save("<dest>",[System.Drawing.Imaging.ImageFormat]::Png)
  ```
  Invoke via `spawnSync("powershell", ["-NoProfile","-Command", script])`.
- **nircmd** (if installed): `nircmd savescreenshot "<dest>"`.
- **A Node lib:** `screenshot-desktop` (adds a dependency, but clean and cross-platform).

Keep the same `captureScreen(dest): boolean` signature.

### 4D. Video frame extraction — `src/vision/video.ts`

**Today:** mostly portable already. It streams the signed Fireflies recording URL to disk
with `fetch`, then runs ffmpeg: `-ss <seconds> -i <video> -frames:v 1 -q:v 2 -y <out>`.
**The ffmpeg args and the download are identical on Windows** — do not change them.

**Only fix the binary lookup.** `FFMPEG_CANDIDATES` hardcodes `/opt/homebrew/bin/ffmpeg`,
`/usr/local/bin/ffmpeg`, `/usr/bin/ffmpeg`. Change `resolveFfmpeg()`/`ffmpegAvailable()` to:
1. honor `config.vision.ffmpegPath` (`FFMPEG_PATH` env) if set,
2. else use `ffmpeg` on PATH (rely on `where ffmpeg`),
3. else try common Windows install dirs (e.g. `C:\ffmpeg\bin\ffmpeg.exe`,
   `%ProgramFiles%\ffmpeg\bin\ffmpeg.exe`).

### 4E. The `mesh` wrapper + node/shell assumptions — `src/meeting-worker.ts`

**Today:** `writeMeshWrapper()` writes an executable shell script named `mesh` into each
meeting folder with a `#!/bin/sh` shebang and `chmod 0o755`, so the orchestrator can run
`./mesh spawn …`, `./mesh shot …`, etc. Windows can't run a bare `./mesh` and has no
`chmod`. Also `resolveNodeBin()`/`spawnNodeScript()` probe Homebrew node paths.

**Fixes:**
- Emit a **`mesh.cmd`** batch file instead of the `#!/bin/sh` script (no chmod needed):
  ```bat
  @echo off
  node "<abs path to dist/mesh/cli.js>" --meeting "<workspace>" %*
  ```
  (Use the same resolved node as below instead of bare `node` if node isn't reliably on
  PATH.) You may keep writing the POSIX `mesh` too if the user is on WSL; on native Windows
  the `.cmd` is what runs.
- **Update `ORCHESTRATOR_MD`** (the big instruction string in `meeting-worker.ts`): change
  every `./mesh …` to `mesh …` (or `.\mesh.cmd …`), including the `./mesh shot --at …`
  examples, so the orchestrator invokes the right thing. This is the doc the orchestrator
  Claude reads — if the commands are wrong, the whole mesh is unusable.
- **`resolveNodeBin()` / `spawnNodeScript()`:** replace the Homebrew probing with: `node` on
  PATH (via `where node`), else fall back to `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1` (this handles the case where the app runs under Electron, whose
  `execPath` is Electron, not node). `src/mesh/cli.ts`'s `spawnWorker` using
  `process.execPath` is already correct (it runs under real node) — leave it.

### 4F. Electron macOS-only bits

- `src/main.ts`: `app.dock?.hide()` is already guarded by `process.platform === "darwin"` —
  no change needed.
- `src/tray.ts`: `tray.setTitle("🎙️"/"👀"/"🛠️")` renders text in the macOS menu bar and does
  **nothing on Windows**. If you keep an Electron tray (§4A), give it a real **icon** file
  and set the status via `tray.setToolTip(...)` and a disabled menu item, instead of the
  title glyph.

### 4G. Path & shell defaults — `src/config.ts`, `.env.example`

- `config.buildsDir` defaults to `/Users/ebell/Projects`. Change the default to
  `path.join(os.homedir(), "Projects")` (or require the user to set `BUILDS_DIR`).
- Scrub any remaining `/bin/zsh`, `~`-as-literal, or POSIX-only assumptions you meet.
- Update `.env.example`: a Windows-style `BUILDS_DIR` and a `FFMPEG_PATH` example
  (e.g. `C:\ffmpeg\bin\ffmpeg.exe`).

---

## 5. The `claude` CLI on Windows

Every flag the mesh uses works in Windows Claude Code:
```
-p --output-format json --model <m> --append-system-prompt <s>
--permission-mode bypassPermissions --dangerously-skip-permissions
--resume <session_id> --add-dir <dir>
```
- **Persistence is unchanged:** the first call returns `session_id` in the JSON; later calls
  pass it back with `--resume`. That's the worker's memory. Don't reinvent it.
- **Keep the login-auth trick** in `src/mesh/claude.ts`: it deletes an empty
  `ANTHROPIC_API_KEY` from the child env so the local Claude Code login wins instead of a
  blank key failing auth.
- Make sure `claude` resolves on PATH in whatever world you chose in §2. If it doesn't,
  resolve it once (`where claude`) and pass an absolute path to `spawn`.

---

## 6. Suggested port order (each milestone is independently testable)

Do these in order; don't move on until the current one works.

1. **Core, headless.** `npm install`, set `.env` (`FIREFLIES_API_KEY`), fix §4G paths, then
   `npm run build` and `npm run replay -- --recent`. This exercises the Fireflies client +
   poll/diff loop + workspace creation with **no** terminal/screenshot/video — pure logic.
   (Use `BUILDBOT_NO_LAUNCH=1` so no window tries to open yet.)
2. **Mesh offline, then live.** Run the mesh test with `MESH_FAKE_CLAUDE=1`
   (`npm run test:mesh`) to prove the bus/worker/CLI logic. Then do a real headless `claude`
   worker round-trip to confirm §5.
3. **Terminal launch (§4B).** Turn off `BUILDBOT_NO_LAUNCH`; confirm a window opens in the
   right folder with an interactive orchestrator, and stays open.
4. **Activation trigger (§4A).** Wire your chosen mechanism to `startOnCurrentMeeting()`.
5. **Live screen capture (§4C).** Confirm `mesh shot` writes a PNG.
6. **Video frame extraction (§4D).** Confirm post-meeting frames land in `media/`.

---

## 7. Verification (on Windows)

- `npm run typecheck && npm run build` — clean.
- `npm run replay -- --recent` — builds a workspace + `TRANSCRIPT.md` from a past meeting.
- `MESH_FAKE_CLAUDE=1 npm run test:mesh` — mesh bus/worker logic passes offline.
- Terminal smoke test: with `BUILDBOT_NO_LAUNCH` unset, a replay/trigger opens a real
  window running `claude` in the workspace.
- **Live dry run:** the user joins a real meeting (with the Fireflies notetaker recording) →
  fire the trigger → confirm a per-meeting folder appears, the interactive orchestrator
  window opens, and `TRANSCRIPT.md` updates every ~10s as people talk.
- Generated `mesh.cmd` runs from the workspace (`mesh agents` prints the roster).

---

## 8. Pointers & gotchas

- The repo's `README.md` and `CLAUDE.md` describe the **macOS** behavior. Treat them as the
  source of truth for **intent**, not for platform specifics.
- Ignore `~/Projects/documentation/macos-menu-bar-apps-and-applicationManager.md` if it came
  along — it's a macOS-only packaging reference and has no Windows equivalent.
- Don't mix worlds (§2). Most "it silently does nothing" bugs on this port are a spawned
  process living in a different world (WSL vs native) than the thing it's trying to reach.
- Keep every `claude` call on the **local login**, never the API.
- When in doubt about the activation UX (§4A) or WSL-vs-native (§2), **ask the user** — those
  are preference calls, not technical ones.

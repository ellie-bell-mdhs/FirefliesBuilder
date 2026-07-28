# /fireflies-builder — run the meeting build-bot in any directory

**Date:** 2026-07-28
**Status:** Approved

## Goal

Launch the meeting build-bot from an interactive Claude Code session in any directory the
user chooses, instead of the menu-bar app creating `<builds-dir>/<date>-<meeting>/`. The
session the user is already in becomes the orchestrator; the full mesh machinery is
re-homed into that directory; workers build directly in the project tree.

## Architecture

Two pieces:

1. **`seed.js` CLI** — new `src/seed.ts` in this repo. The workspace-seeding logic
   currently inside `meeting-worker.ts` is extracted into a shared module used by both
   the menu-bar path and the CLI. The only difference between the two callers is the
   target directory.
2. **`/fireflies-builder` global skill** — `~/.claude/skills/fireflies-builder/SKILL.md`.
   Invocable from any Claude session in any directory. Runs the seeder against `$PWD`,
   then turns the current session into the orchestrator.

## The seeder

Invocation: `node ~/Projects/Fireflies/dist/seed.js --dir "$PWD" --watch 10m`

- Finds the live meeting via Fireflies `active_meetings`. If the bot has not joined yet,
  re-checks every ~20s for up to 10 minutes (matching today's bounded watch) and starts
  the moment it joins. Exits nonzero with a clear message on timeout. If more than one
  meeting is live, seeds the most recently started one and prints which it picked plus
  a `--meeting <id>` override for choosing another.
- Seeds **all plumbing under `.fireflies/`** in the target directory:
  - `TRANSCRIPT.md` (timestamped lines, watcher-maintained)
  - `BOARD.md`, `DECISIONS.md`, `ORCHESTRATOR.md`
  - mesh bus at `.fireflies/mesh/bus/`
  - `./mesh` wrapper script pointing at the existing `dist/mesh/cli.js` with the bus
    re-homed to `.fireflies/mesh/`
- Appends `.fireflies/` to `.gitignore` when the target is a git repo (idempotent).
- Starts the ~10s **transcript watcher** as a detached background process (PID file in
  `.fireflies/`). The watcher marks `ENDED` in `TRANSCRIPT.md` when the meeting closes —
  unchanged from today.
- **Worker re-homing:** spawned workers run with cwd = project root and their role prompt
  instructs them to build directly in the tree (no `workspaces/<name>/`), respect the
  existing repo's conventions, and never touch `.fireflies/` internals.
- `meeting-worker.ts` is refactored to call the same seeding module with
  `<builds-dir>/<date>-<meeting>/` — menu-bar behavior is unchanged.

## The skill / loop mechanics

`/fireflies-builder` instructs the invoking session to:

1. **Preflight:** Fireflies repo built (`dist/` exists) and API key present; on failure,
   stop and report fix instructions.
2. **Seed:** run the seeder against `$PWD` (blocking through the bounded watch).
3. **Orchestrate:** read `.fireflies/ORCHESTRATOR.md` and become the orchestrator — a
   self-paced wakeup loop (dynamic /loop, ~45–60s cadence) that on each firing diffs
   `TRANSCRIPT.md` since the last check, reads `mesh inbox` and `BOARD.md`, decomposes
   new asks, and delegates via `./mesh`. The orchestrator never codes itself and stays
   free to talk to the user.
4. **Resume:** if invoked in a directory that already has a live `.fireflies/`
   (watcher PID alive), re-attach — do not reseed.

## Meeting end

Watcher marks `ENDED` → on the next wakeup the orchestrator writes `SUMMARY.md` at the
project root (not inside `.fireflies/`), does a final integration pass over worker
output, then **stops its wakeup loop but leaves workers alive**. `mesh stop --all`
remains the explicit wind-down. (Deliberate change from the menu-bar flow's
"keep coordinating forever": the user launched this session and will keep using it, so
post-meeting auto-pinging wastes tokens.)

## Error handling

- Seeder timeout / no meeting found → skill reports and ends; no partial `.fireflies/`
  left behind (seeder cleans up on failure).
- Fireflies API hiccups → the watcher already retries. The orchestrator treats a stale
  `TRANSCRIPT.md` (no growth and no `ENDED` for >3 minutes) as "watcher died" and
  restarts it using the PID-file state.
- Concurrent runs in different directories are independent — each `.fireflies/` is
  self-contained.

## Testing

- Unit test for the seeding module: asserts the `.fireflies/` layout, `mesh` wrapper,
  and idempotent gitignore append. Mesh tests already exist.
- End-to-end without a real meeting: `--replay` flag on the seeder wires `replay.ts` +
  `fixtures/sample-meeting` as the transcript source, allowing a full rehearsal — seed →
  transcript grows → delegate → `ENDED` → `SUMMARY.md` — in a scratch directory.

## Decisions log

- Full orchestrator + mesh retained, re-homed to the launch directory (user choice).
- Entry point is a skill named `/fireflies-builder` (user choice; not `/meeting-builder`).
- Bot-not-joined behavior: bounded watch, ~20s × 10 min (user choice).
- Workers build directly in the project tree; plumbing isolated in `.fireflies/`
  (user choice).
- Loop stops after `SUMMARY.md`; workers stay alive (approved in design review).

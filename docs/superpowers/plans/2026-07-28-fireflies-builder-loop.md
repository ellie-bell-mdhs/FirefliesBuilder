# /fireflies-builder Run-In-Place Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user invoke `/fireflies-builder` from a Claude session in any directory; that session becomes the orchestrator, all mesh plumbing is seeded into `.fireflies/` in that directory, and workers build directly in the project tree.

**Architecture:** Extract the workspace-seeding logic out of `meeting-worker.ts` into `src/seeding.ts` with two layouts (standalone = today's builds folder; in-place = `.fireflies/` inside an existing project). A new `src/seed.ts` CLI finds the live meeting (bounded watch), seeds in-place, and spawns a detached transcript watcher (`src/watcher.ts`). A new global skill instructs the invoking Claude session to run the seeder and orchestrate via the mesh.

**Tech Stack:** TypeScript (ESM, `tsc` build), Node 22, existing hand-rolled test pattern (`tsx src/<x>.test.ts` run via npm scripts). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-fireflies-builder-loop-design.md` — follow it exactly.
- Skill name is `/fireflies-builder` (NOT meeting-builder).
- All in-place plumbing lives under `.fireflies/`; never write mesh files at the project root except `SUMMARY.md` (written by the orchestrator at meeting end, not by this code).
- Menu-bar behavior must not change (standalone layout output byte-identical to today except for code location).
- Bounded watch: re-check every `config.watchPollMs` (20s) up to `config.watchMaxMs` (10 min).
- Env loading: `seed.ts` and `watcher.ts` may run with any cwd — load `.env` from the Fireflies `projectRoot`, never from `process.cwd()`.
- Commit after each task; repo has standing authorization to commit/push to main.

## File Structure

- `src/seeding.ts` (new) — templates (`ORCHESTRATOR_MD`, in-place variant), `renderSentences`, `writeTranscript`, `writeMeshWrapper`, `seedStandalone()`, `seedInPlace()`, `resolveNodeBin()`.
- `src/seeding.test.ts` (new) — layout + gitignore idempotence tests.
- `src/meeting-worker.ts` (modify) — delete moved code, import from seeding.
- `src/mesh/worker.ts` (modify) — build-root override for worker cwd.
- `src/watcher.ts` (new) — detached transcript watcher for in-place mode.
- `src/seed.ts` (new) — the CLI entry the skill calls.
- `~/.claude/skills/fireflies-builder/SKILL.md` (new) — global skill.
- `package.json` (modify) — `test:seeding`, `seed` scripts.
- `README.md` (modify) — new "Run in place" section.

---

### Task 1: Extract seeding module with standalone layout

**Files:**
- Create: `src/seeding.ts`
- Create: `src/seeding.test.ts`
- Modify: `src/meeting-worker.ts` (remove moved code, import instead)
- Modify: `package.json` (add `"test:seeding": "tsx src/seeding.test.ts"`)

**Interfaces:**
- Consumes: `initBus` from `./mesh/bus.js`, `projectRoot` from `./config.js`, `Sentence` from `./fireflies/client.js`, `fmtClock` from `./vision/visuals.js`.
- Produces (later tasks rely on these exact signatures):
  - `interface TranscriptSnapshot { title: string; sentences: Sentence[]; isLive: boolean }` (moved here from meeting-worker; meeting-worker re-exports it)
  - `function writeTranscript(plumbingDir: string, snapshot: TranscriptSnapshot): void`
  - `function seedStandalone(workspace: string): void` — writes ORCHESTRATOR.md, initBus, mesh wrapper, into `workspace` (today's layout)
  - `function resolveNodeBin(): string`

- [ ] **Step 1: Write the failing test** — `src/seeding.test.ts`, following the assert-style of `src/mesh/mesh.test.ts`:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { seedStandalone, writeTranscript } from "./seeding.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-standalone-"));
seedStandalone(tmp);
assert.ok(fs.existsSync(path.join(tmp, "ORCHESTRATOR.md")), "ORCHESTRATOR.md");
assert.ok(fs.existsSync(path.join(tmp, "mesh")), "mesh wrapper");
assert.ok((fs.statSync(path.join(tmp, "mesh")).mode & 0o111) !== 0, "mesh executable");
assert.ok(fs.existsSync(path.join(tmp, ".mesh")), "bus initialized");
writeTranscript(tmp, { title: "t", sentences: [], isLive: true });
assert.match(fs.readFileSync(path.join(tmp, "TRANSCRIPT.md"), "utf8"), /IN PROGRESS/);
writeTranscript(tmp, { title: "t", sentences: [], isLive: false });
assert.match(fs.readFileSync(path.join(tmp, "TRANSCRIPT.md"), "utf8"), /MEETING ENDED/);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("seeding standalone: OK");
```

- [ ] **Step 2: Run to verify failure** — `npm run test:seeding` → FAIL (module not found).
- [ ] **Step 3: Create `src/seeding.ts`** by MOVING (not copying) from `meeting-worker.ts`: `TranscriptSnapshot`, `renderSentences`, `resolveNodeBin`, `writeMeshWrapper`, `ORCHESTRATOR_MD`, `writeTranscript`. Add:

```typescript
/** Seed a standalone meeting folder (menu-bar layout): plumbing at the folder root. */
export function seedStandalone(workspace: string): void {
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "ORCHESTRATOR.md"), ORCHESTRATOR_MD);
  initBus(workspace);
  writeMeshWrapper(workspace, workspace);
}
```

Change `writeMeshWrapper(workspace)` to `writeMeshWrapper(dir: string, meshHome: string)` — `dir` is where the `mesh` script file goes, `meshHome` is the `--meeting` value baked into it (identical in standalone; different in Task 3).

- [ ] **Step 4: Update `meeting-worker.ts`** — delete the moved code; `import { seedStandalone, writeTranscript, type TranscriptSnapshot } from "./seeding.js";` and `export type { TranscriptSnapshot }` for existing importers. Replace the four seeding lines in `runMeetingWorker` with `seedStandalone(workspace)` + `writeTranscript(workspace, first)`.
- [ ] **Step 5: Verify** — `npm run typecheck && npm run test:seeding && npm run test:mesh` → all pass.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "refactor: extract workspace seeding into src/seeding.ts"`

### Task 2: In-place layout (`seedInPlace`)

**Files:**
- Modify: `src/seeding.ts`, `src/seeding.test.ts`

**Interfaces:**
- Produces:
  - `const PLUMBING_DIR = ".fireflies"`
  - `interface InPlacePaths { plumbing: string; transcript: string; meshWrapper: string; pidFile: string; buildRootFile: string }`
  - `function inPlacePaths(projectDir: string): InPlacePaths`
  - `function seedInPlace(projectDir: string): InPlacePaths` — creates `.fireflies/` with ORCHESTRATOR.md (in-place variant), bus, mesh wrapper, `buildroot` file containing `projectDir`, and appends `.fireflies/` to `.gitignore` iff `.git` exists (idempotent).
  - `const ORCHESTRATOR_MD_INPLACE: string` — copy of `ORCHESTRATOR_MD` with these edits: every `./mesh` → `./.fireflies/mesh`; `TRANSCRIPT.md` → `.fireflies/TRANSCRIPT.md`; add a section "## Build target" stating: workers build DIRECTLY in this project tree (the current directory), must follow the repo's existing conventions, and must never modify `.fireflies/` internals; `SUMMARY.md` is written at the project root.

- [ ] **Step 1: Extend the test** (append to `seeding.test.ts`):

```typescript
import { seedInPlace, PLUMBING_DIR } from "./seeding.js";
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "seed-inplace-"));
fs.mkdirSync(path.join(proj, ".git")); // simulate a git repo
const p = seedInPlace(proj);
assert.ok(fs.existsSync(path.join(proj, PLUMBING_DIR, "ORCHESTRATOR.md")));
assert.ok(fs.existsSync(p.meshWrapper), "mesh wrapper inside .fireflies");
assert.equal(fs.readFileSync(p.buildRootFile, "utf8").trim(), proj);
const md = fs.readFileSync(path.join(proj, PLUMBING_DIR, "ORCHESTRATOR.md"), "utf8");
assert.match(md, /\.fireflies\/mesh/); assert.match(md, /Build target/);
assert.match(fs.readFileSync(path.join(proj, ".gitignore"), "utf8"), /^\.fireflies\/$/m);
seedInPlace(proj); // idempotent: no duplicate gitignore line, no crash
const gi = fs.readFileSync(path.join(proj, ".gitignore"), "utf8");
assert.equal(gi.match(/\.fireflies\//g)!.length, 1, "gitignore appended once");
fs.rmSync(proj, { recursive: true, force: true });
console.log("seeding in-place: OK");
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**:

```typescript
export const PLUMBING_DIR = ".fireflies";
export interface InPlacePaths { plumbing: string; transcript: string; meshWrapper: string; pidFile: string; buildRootFile: string }
export function inPlacePaths(projectDir: string): InPlacePaths {
  const plumbing = path.join(projectDir, PLUMBING_DIR);
  return { plumbing, transcript: path.join(plumbing, "TRANSCRIPT.md"),
    meshWrapper: path.join(plumbing, "mesh"), pidFile: path.join(plumbing, "watcher.pid"),
    buildRootFile: path.join(plumbing, "buildroot") };
}
export function seedInPlace(projectDir: string): InPlacePaths {
  const p = inPlacePaths(projectDir);
  fs.mkdirSync(p.plumbing, { recursive: true });
  fs.writeFileSync(path.join(p.plumbing, "ORCHESTRATOR.md"), ORCHESTRATOR_MD_INPLACE);
  initBus(p.plumbing);
  writeMeshWrapper(p.plumbing, p.plumbing);
  fs.writeFileSync(p.buildRootFile, projectDir + "\n");
  if (fs.existsSync(path.join(projectDir, ".git"))) {
    const gi = path.join(projectDir, ".gitignore");
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    if (!cur.split("\n").includes(".fireflies/"))
      fs.writeFileSync(gi, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + ".fireflies/\n");
  }
  return p;
}
```

- [ ] **Step 4: Verify** — `npm run typecheck && npm run test:seeding` → PASS. **Step 5: Commit** `feat: add in-place .fireflies/ seeding layout`.

### Task 3: Workers honor build root

**Files:**
- Modify: `src/mesh/worker.ts` (~lines 38, 82–94, 124), `src/mesh/mesh.test.ts`

**Interfaces:**
- Consumes: `buildroot` file at `<meeting>/buildroot` (written by `seedInPlace`; absent in standalone).
- Produces: worker Claude processes run with `cwd = buildRoot` when the file exists; worker state/session files stay in `workspacesDir/<name>` unchanged.

- [ ] **Step 1: Add failing assertion to `mesh.test.ts`**: create a temp meeting dir with a `buildroot` file pointing at a second temp dir; call the exported cwd-resolution helper (add `export function resolveWorkerCwd(meeting: string, workspace: string): string` to worker.ts) and assert it returns the buildroot; without the file it returns `workspace`.
- [ ] **Step 2: Run** `npm run test:mesh` → FAIL. **Step 3: Implement**:

```typescript
export function resolveWorkerCwd(meeting: string, workspace: string): string {
  const f = path.join(meeting, "buildroot");
  try { const root = fs.readFileSync(f, "utf8").trim(); if (root && fs.existsSync(root)) return root; } catch {}
  return workspace;
}
```

Use it at the `spawn`/`cwd: workspace` sites (worker.ts line ~124 and the `upsertAgent(... cwd: workspace)` record). When cwd is the build root, swap the worker prompt line "You work inside your own folder (your cwd)" for: "You work directly in the project repository (your cwd). Follow its existing conventions; never modify `.fireflies/` internals; coordinate file ownership with other workers via the board so you don't collide."
- [ ] **Step 4: Verify** `npm run typecheck && npm run test:mesh` → PASS. **Step 5: Commit** `feat: mesh workers build in project root when buildroot is set`.

### Task 4: Detached transcript watcher (`src/watcher.ts`)

**Files:**
- Create: `src/watcher.ts`

**Interfaces:**
- CLI: `node dist/watcher.js --dir <projectDir> --meeting-id <id>` (plus `--fixture <json> --chunk 12 --poll-ms 800` for replay mode).
- Consumes: `writeTranscript`, `inPlacePaths` from `./seeding.js`; `FirefliesClient`; growing-slice logic modeled on `replay.ts`'s `growingSource`.
- Produces: keeps `.fireflies/TRANSCRIPT.md` fresh every `config.transcriptPollMs`; writes own PID to `.fireflies/watcher.pid` on start; on meeting end writes the ENDED transcript, removes the PID file, exits 0.

- [ ] **Step 1: Implement** — top of file: `import dotenv from "dotenv"; dotenv.config({ path: path.join(projectRoot, ".env") });` BEFORE importing `config` consumers that call `required()`. Main loop mirrors `runMeetingWorker`'s polling body (live source = `FirefliesClient.getTranscript(meetingId)` snapshot exactly like `FirefliesLiveSource` in orchestrator.ts; fixture source = growing slices) but writes to `inPlacePaths(dir).transcript`, no Ghostty, no mesh seeding, no visual capture. Wrap each poll in try/catch with a warn log and continue (API hiccup tolerance). On `!isLive`: final `writeTranscript`, `fs.rmSync(pidFile, {force:true})`, exit.
- [ ] **Step 2: Verify by replay** — in a scratch dir: seed via a tiny tsx one-liner (`tsx -e 'import {seedInPlace} from "./src/seeding.js"; seedInPlace(process.argv[1])' <scratch>`), then `tsx src/watcher.ts --dir <scratch> --fixture fixtures/sample-meeting.json --poll-ms 200 --chunk 20`; confirm TRANSCRIPT.md grows, ends with MEETING ENDED, and watcher.pid is gone.
- [ ] **Step 3: Commit** `feat: standalone transcript watcher for in-place mode`.

### Task 5: `seed.js` CLI

**Files:**
- Create: `src/seed.ts`
- Modify: `package.json` (`"seed": "tsx src/seed.ts"`)

**Interfaces:**
- CLI: `node ~/Projects/Fireflies/dist/seed.js --dir <path> [--watch 10m] [--meeting <id>] [--replay [fixture.json]]`
- Consumes: `seedInPlace`, `inPlacePaths`; `FirefliesClient.getActiveMeetings()`; `config.watchPollMs/watchMaxMs`; spawns `dist/watcher.js` detached using the `spawnNodeScript` pattern from meeting-worker.ts (move that helper into seeding.ts and import it in both).
- Produces stdout contract the skill parses (exact lines): `SEEDED dir=<abs> meeting=<id> title=<title>` on success; `TIMEOUT no live meeting after <n>m` (exit 2); `ERROR <message>` (exit 1). Multi-meeting: picks most recently started (`ActiveMeeting` list order from API; if it has a start field use it, else last item) and prints `PICKED <id> "<title>" (override with --meeting <id>)`.

- [ ] **Step 1: Implement** — flow: parse args (reuse the `arg()` helper pattern from replay.ts); load dotenv from projectRoot as in Task 4. Resolve meeting: `--replay` skips Fireflies entirely; `--meeting` uses it directly; otherwise `getActiveMeetings()` once, then bounded watch loop (`watchPollMs` interval, `--watch` overriding `watchMaxMs`, parse `10m`/`600s` suffixes). Then `seedInPlace(dir)`, first `writeTranscript` with an empty live snapshot, spawn watcher detached (`{detached:true, stdio:"ignore"}`, `.unref()`), print `SEEDED ...`. On any failure AFTER `seedInPlace` began, `fs.rmSync(plumbing, {recursive:true, force:true})` before exiting (spec: no partial `.fireflies/` left behind) — but never delete a pre-existing `.fireflies/` (check existence before seeding; if present and `watcher.pid` alive, print `RESUME dir=<abs>` and exit 0 — the skill handles resume; if present and pid dead, reseed transcript/watcher but keep bus state).
- [ ] **Step 2: Verify** — `npm run build`, then in a scratch git repo: `node dist/seed.js --dir "$PWD" --replay fixtures/sample-meeting.json` → prints SEEDED, `.fireflies/` populated, gitignore updated, watcher running then exiting with ENDED. Run again mid-replay → prints RESUME.
- [ ] **Step 3: Commit** `feat: seed.js CLI — find meeting, seed in place, launch watcher`.

### Task 6: The `/fireflies-builder` global skill

**Files:**
- Create: `~/.claude/skills/fireflies-builder/SKILL.md` (NOT in this repo; also add a copy at `skills/fireflies-builder/SKILL.md` in-repo as the source of truth, with a README note to symlink/copy it)

**Interfaces:**
- Consumes: the stdout contract from Task 5 (`SEEDED`/`RESUME`/`TIMEOUT`/`ERROR` lines).

- [ ] **Step 1: Write SKILL.md** with frontmatter `name: fireflies-builder` and description "Run the Fireflies meeting build-bot in the current directory — the invoking session becomes the orchestrator. Use when the user says /fireflies-builder or wants to build from a live meeting in this repo." Body instructs the session to:
  1. Preflight: `test -f ~/Projects/Fireflies/dist/seed.js` (else run `npm run build` in `~/Projects/Fireflies`; if `.env`/`FIREFLIES_API_KEY` missing, stop and tell the user).
  2. Run `node ~/Projects/Fireflies/dist/seed.js --dir "$PWD" --watch 10m` in the background (it can block up to 10 min); report which meeting was picked.
  3. On `SEEDED`/`RESUME`: read `.fireflies/ORCHESTRATOR.md` and follow it — you are the orchestrator; delegate via `./.fireflies/mesh`, never build yourself.
  4. Run a self-paced loop (dynamic /loop-style wakeups, 45–60s): each firing, diff `.fireflies/TRANSCRIPT.md` against the last-seen line count, check `./.fireflies/mesh inbox` and `board`, decompose/delegate new asks, stay responsive to the user.
  5. On ENDED marker: write `SUMMARY.md` at the project root, one final inbox/board integration pass, then STOP the wakeup loop; leave workers alive; remind the user `./.fireflies/mesh stop --all` winds down.
  6. On `TIMEOUT`/`ERROR`: report the line verbatim and stop.
- [ ] **Step 2: Verify** — `/reload-skills` in a fresh session lists `fireflies-builder`; dry-run invoke in a scratch dir with `--replay` (edit the seeder line accordingly) and watch a full seed → delegate → ENDED → SUMMARY.md pass.
- [ ] **Step 3: Commit** `feat: /fireflies-builder skill (in-repo copy)` and copy to `~/.claude/skills/`.

### Task 7: End-to-end replay rehearsal + README

**Files:**
- Modify: `README.md` (new "## Run in place (/fireflies-builder)" section documenting the skill, the `.fireflies/` layout, resume, and wind-down)

- [ ] **Step 1:** Full rehearsal in a fresh scratch git repo per Task 6 Step 2; fix anything that surfaces.
- [ ] **Step 2:** Write the README section (layout table: TRANSCRIPT.md, BOARD.md, DECISIONS.md, mesh, watcher.pid, buildroot; SUMMARY.md at root).
- [ ] **Step 3:** `npm run typecheck && npm run test:mesh && npm run test:seeding` all green. Commit `docs: run-in-place mode` and push.

## Self-Review Notes

- Spec coverage: seeder (Task 2/5), watcher + ENDED (Task 4), bounded watch + multi-meeting pick (Task 5), workers-in-tree (Task 3), skill + loop + meeting-end stop (Task 6), resume (Task 5 §RESUME), error handling (Tasks 4/5), replay testing (Tasks 4/5/7), menu-bar unchanged (Task 1). Gitignore idempotence tested (Task 2).
- Type consistency: `writeMeshWrapper(dir, meshHome)` defined Task 1, used Task 2; `resolveWorkerCwd(meeting, workspace)` defined Task 3; `inPlacePaths` defined Task 2, consumed Tasks 4/5.

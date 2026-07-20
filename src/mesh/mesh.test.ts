/**
 * Offline integration test for the agent mesh. Uses MESH_FAKE_CLAUDE so no real claude
 * sessions are spawned; the fake honors `@send:<to>:<type>:<body>` directives in a task
 * body, letting us drive peer-to-peer messaging deterministically.
 *
 *   npm run test:mesh
 *
 * Proves: workers spawn and stay alive (persistent), the orchestrator delegates, a
 * worker messages a peer directly, results route back to the orchestrator, the board
 * records activity, and `stop` winds workers down.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATOR,
  initBus,
  listAgents,
  peekNewMessages,
  pidAlive,
  readBoard,
  readNewMessages,
  sendMessage,
} from "./bus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const tsxBin = path.join(projectRoot, "node_modules", ".bin", "tsx");
const workerTs = path.join(here, "worker.ts");

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 8000, stepMs = 150): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

function spawnWorker(meeting: string, name: string, role: string): void {
  const child = spawn(tsxBin, [workerTs, "--meeting", meeting, "--name", name, "--role", role], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MESH_FAKE_CLAUDE: "1", MESH_WORKER_POLL_MS: "250" },
  });
  child.unref();
}

async function main(): Promise<void> {
  const meeting = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
  initBus(meeting);
  console.log(`meeting dir: ${meeting}\n`);

  // 1. Spawn two persistent workers.
  spawnWorker(meeting, "alpha", "front end");
  spawnWorker(meeting, "beta", "back end");

  const bothOnline = await waitFor(() => {
    const names = listAgents(meeting).map((a) => a.name);
    return names.includes("alpha") && names.includes("beta");
  });
  check(bothOnline, "both workers registered and came online");

  // 2. Orchestrator delegates to alpha; alpha's task tells it to message peer beta and
  //    report back to the orchestrator (via fake-claude directives).
  sendMessage(meeting, {
    from: ORCHESTRATOR,
    to: "alpha",
    type: "task",
    body: "build the UI. @send:beta:task:alpha needs a /users endpoint @send:orchestrator:result:alpha: UI scaffolded",
  });
  // 3. Orchestrator also delegates to beta directly.
  sendMessage(meeting, {
    from: ORCHESTRATOR,
    to: "beta",
    type: "task",
    body: "build the API. @send:orchestrator:result:beta: API scaffolded",
  });

  // 4. Results should route back to the orchestrator inbox.
  const gotResults = await waitFor(() => {
    const inbox = peekNewMessages(meeting, ORCHESTRATOR);
    const froms = inbox.map((m) => m.from);
    return froms.includes("alpha") && froms.includes("beta");
  });
  check(gotResults, "results from alpha and beta routed back to the orchestrator");

  const orchInbox = readNewMessages(meeting, ORCHESTRATOR);
  check(
    orchInbox.some((m) => m.from === "alpha" && /UI scaffolded/.test(m.body)),
    "orchestrator received alpha's result payload",
  );

  // 5. Peer-to-peer: beta should have received alpha's direct task (board records it).
  const peerDelivered = await waitFor(() => /beta.*working on message from alpha/s.test(readBoard(meeting)));
  check(peerDelivered, "peer-to-peer: alpha's message reached beta directly");

  // 6. Workers are still alive after finishing (persistent, not one-shot).
  const alphaRec = listAgents(meeting).find((a) => a.name === "alpha");
  check(!!alphaRec && pidAlive(alphaRec.pid), "alpha is still alive after completing its task");

  // 7. Stop them and confirm they wind down.
  sendMessage(meeting, { from: ORCHESTRATOR, to: "alpha", type: "stop", body: "stop" });
  sendMessage(meeting, { from: ORCHESTRATOR, to: "beta", type: "stop", body: "stop" });
  const stopped = await waitFor(() => {
    const recs = listAgents(meeting);
    return recs.every((a) => a.status === "stopped" || !pidAlive(a.pid));
  });
  check(stopped, "workers stopped on the stop message");

  console.log(`\n--- BOARD.md ---\n${readBoard(meeting)}`);
  fs.rmSync(meeting, { recursive: true, force: true });

  console.log(failures === 0 ? "\nALL MESH TESTS PASSED" : `\n${failures} MESH TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

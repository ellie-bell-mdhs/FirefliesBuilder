/**
 * A persistent worker agent. This is a long-lived process: it registers itself, then
 * idle-polls its inbox forever. Each incoming message is handled by resuming the SAME
 * claude session (so the agent keeps its memory), and the agent reports/coordinates by
 * calling the shared `mesh` CLI itself (peer-to-peer or back to the orchestrator).
 *
 * Launched by `mesh spawn`. Stays alive across tasks until it receives a `stop` message.
 *
 *   node dist/mesh/worker.js --meeting <dir> --name <name> --role <role> --model <id>
 */
import fs from "node:fs";
import path from "node:path";
import {
  busPaths,
  getAgent,
  initBus,
  postBoard,
  readNewMessages,
  sendMessage,
  upsertAgent,
  type MeshMessage,
} from "./bus.js";
import { runClaude } from "./claude.js";

const POLL_MS = Number(process.env.MESH_WORKER_POLL_MS ?? "2000");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function workerSystemPrompt(name: string, role: string, meshCmd: string, meeting: string): string {
  return [
    `You are "${name}", a persistent worker agent in a multi-agent mesh coordinated by an`,
    `orchestrator. Your role: ${role}`,
    ``,
    `You are long-lived: you keep your memory between messages, so build on prior work.`,
    `You work inside your own folder (your cwd). Shared files (BOARD.md, the mesh CLI) are`,
    `in the meeting folder: ${meeting}`,
    ``,
    `## Talking to other agents`,
    `Use the mesh CLI (call it with Bash) to coordinate. It is at: ${meshCmd}`,
    `- Report progress/results to whoever asked:   ${meshCmd} send --from ${name} --to <agent> --type result --msg "..."`,
    `- Ask another agent (or the orchestrator) something: ${meshCmd} send --from ${name} --to <agent> --type question --msg "..."`,
    `- Delegate/hand off to a peer:                 ${meshCmd} send --from ${name} --to <peer> --type task --msg "..."`,
    `- Post a short status to the shared board:     ${meshCmd} post --from ${name} --msg "..."`,
    `- See who else is around:                      ${meshCmd} agents`,
    `- Read the board:                              ${meshCmd} board`,
    ``,
    `Always finish a task by reporting the outcome with a "result" message to the sender,`,
    `and post a one-line board update so the orchestrator can integrate. Be autonomous:`,
    `decide judgment calls yourself and note anything uncertain in your report.`,
  ].join("\n");
}

function turnPrompt(msg: MeshMessage): string {
  return [
    `New message on your inbox.`,
    `From: ${msg.from}`,
    `Type: ${msg.type}`,
    `--- message ---`,
    msg.body,
    `---------------`,
    ``,
    `Handle it now. Do the work in your own folder, coordinate via the mesh CLI as needed,`,
    `and report the result back to ${msg.from}.`,
  ].join("\n");
}

async function main(): Promise<void> {
  const meeting = arg("meeting");
  const name = arg("name");
  const role = arg("role", "general worker");
  const model = arg("model", process.env.BUILD_MODEL || "claude-opus-4-8");
  if (!meeting || !name) {
    console.error("worker requires --meeting and --name");
    process.exit(1);
  }

  initBus(meeting);
  const p = busPaths(meeting);
  const workspace = path.join(p.workspacesDir, name);
  fs.mkdirSync(workspace, { recursive: true });
  const logFile = path.join(p.logsDir, `${name}.log`);
  const meshCmd = path.join(meeting, "mesh");

  const log = (m: string) => {
    const line = `${new Date().toISOString()} ${m}\n`;
    fs.appendFileSync(logFile, line);
  };

  upsertAgent(meeting, { name, role, status: "idle", pid: process.pid, cwd: workspace });
  postBoard(meeting, name, `online (${role})`);
  log(`worker "${name}" started, role="${role}", cwd=${workspace}`);

  const system = workerSystemPrompt(name, role, meshCmd, meeting);
  // Fake-mode plumbing: let the stubbed claude know who/where it is.
  process.env.MESH_FAKE_MEETING = meeting;
  process.env.MESH_FAKE_AGENT = name;

  let stop = false;
  const handleSignal = () => {
    stop = true;
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  while (!stop) {
    const msgs = readNewMessages(meeting, name);
    for (const msg of msgs) {
      if (msg.type === "stop") {
        log("received stop");
        postBoard(meeting, name, "stopping");
        upsertAgent(meeting, { name, status: "stopped", pid: null });
        process.exit(0);
      }

      upsertAgent(meeting, { name, status: "busy" });
      postBoard(meeting, name, `working on message from ${msg.from}`);
      log(`handling msg ${msg.id} from ${msg.from} (${msg.type})`);

      const prior = getAgent(meeting, name);
      const res = await runClaude({
        cwd: workspace,
        prompt: turnPrompt(msg),
        model,
        appendSystemPrompt: system,
        resumeSessionId: prior?.sessionId ?? undefined,
        addDirs: [meeting],
      });

      upsertAgent(meeting, { name, status: "idle", sessionId: res.sessionId });
      log(`done msg ${msg.id}: ${res.isError ? "ERROR " : ""}${res.result.slice(0, 200)}`);
      if (res.isError) {
        postBoard(meeting, name, `error handling message from ${msg.from} (see logs)`);
        // Surface the failure to the sender so work isn't silently dropped.
        sendMessage(meeting, {
          from: name,
          to: msg.from,
          type: "result",
          body: `I hit an error handling your message: ${res.result.slice(0, 300)}`,
        });
      }
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

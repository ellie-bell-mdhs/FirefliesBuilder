/**
 * The `mesh` CLI — the single control surface for the agent mesh, used by both the
 * orchestrator (interactively, via Bash) and the worker agents.
 *
 * The `mesh` wrapper written into each meeting folder injects `--meeting <dir>`, so
 * callers just run `./mesh <command> ...`.
 *
 *   mesh spawn --name api --role "build the REST API"
 *   mesh send --to api --type task --msg "add a /health endpoint"
 *   mesh send --from api --to orchestrator --type result --msg "done: /health returns 200"
 *   mesh post --from api --msg "health endpoint live"
 *   mesh board | mesh agents | mesh inbox [--as orchestrator] [--peek]
 *   mesh stop --name api | mesh stop --all
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATOR,
  initBus,
  listAgents,
  peekNewMessages,
  pidAlive,
  postBoard,
  readBoard,
  readNewMessages,
  sendMessage,
  upsertAgent,
  type MeshMessage,
  type MessageType,
} from "./bus.js";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function fmt(m: MeshMessage): string {
  return `[${m.ts.slice(11, 19)}] ${m.from} → ${m.to} (${m.type}): ${m.body}`;
}

function spawnWorker(meeting: string, name: string, role: string, model: string): void {
  const workerJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.js");
  const child = spawn(
    process.execPath,
    [workerJs, "--meeting", meeting, "--name", name, "--role", role, "--model", model],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  upsertAgent(meeting, { name, role, status: "starting", cwd: "", pid: child.pid ?? null });
}

/** First positional token = the subcommand. The wrapper injects `--meeting <dir>`
 *  ahead of the user's args, so we can't rely on a fixed argv index. */
function subcommand(): string {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      i++; // skip this flag's value
      continue;
    }
    return a[i];
  }
  return "";
}

function main(): void {
  const meeting = arg("meeting");
  const cmd = subcommand();
  if (!meeting) {
    console.error("mesh: missing --meeting (the wrapper should inject it)");
    process.exit(1);
  }
  initBus(meeting);
  const model = arg("model", process.env.BUILD_MODEL || "claude-opus-4-8");

  switch (cmd) {
    case "spawn": {
      const name = arg("name");
      const role = arg("role", "general worker");
      if (!name) return fail("spawn requires --name");
      spawnWorker(meeting, name, role, model);
      console.log(`spawned worker "${name}" (${role})`);
      return;
    }
    case "send": {
      const to = arg("to");
      const body = arg("msg");
      if (!to || !body) return fail("send requires --to and --msg");
      const from = arg("from", ORCHESTRATOR);
      const type = (arg("type", "task") as MessageType);
      const m = sendMessage(meeting, { from, to, type, body });
      console.log(`sent ${m.id} → ${to}`);
      return;
    }
    case "post": {
      const body = arg("msg");
      if (!body) return fail("post requires --msg");
      postBoard(meeting, arg("from", ORCHESTRATOR), body);
      console.log("posted to board");
      return;
    }
    case "board":
      console.log(readBoard(meeting));
      return;
    case "inbox": {
      const as = arg("as", ORCHESTRATOR);
      const msgs = flag("peek") ? peekNewMessages(meeting, as) : readNewMessages(meeting, as);
      if (!msgs.length) console.log(`(no new messages for ${as})`);
      else msgs.forEach((m) => console.log(fmt(m)));
      return;
    }
    case "agents": {
      const agents = listAgents(meeting).filter((a) => a.name !== ORCHESTRATOR);
      if (!agents.length) {
        console.log("(no worker agents yet — spawn one with: mesh spawn --name <n> --role <r>)");
        return;
      }
      for (const a of agents) {
        const alive = a.status === "stopped" ? "stopped" : pidAlive(a.pid) ? a.status : "dead";
        console.log(`${a.name.padEnd(16)} ${alive.padEnd(9)} ${a.role}`);
      }
      return;
    }
    case "stop": {
      const targets = flag("all")
        ? listAgents(meeting).filter((a) => a.name !== ORCHESTRATOR && a.status !== "stopped")
        : [{ name: arg("name") }].filter((t) => t.name);
      if (!targets.length) return fail("stop requires --name <n> or --all");
      for (const t of targets) {
        sendMessage(meeting, { from: ORCHESTRATOR, to: t.name, type: "stop", body: "stop" });
        console.log(`stop sent → ${t.name}`);
      }
      return;
    }
    default:
      console.log(
        "usage: mesh <spawn|send|post|board|inbox|agents|stop> ...\n" +
          "  spawn --name <n> --role <r>\n" +
          "  send --to <n> [--from <n>] [--type task|msg|result|question] --msg <text>\n" +
          "  post [--from <n>] --msg <text>\n" +
          "  inbox [--as <n>] [--peek]   board   agents\n" +
          "  stop --name <n> | --all",
      );
  }
}

function fail(msg: string): void {
  console.error(`mesh: ${msg}`);
  process.exit(1);
}

main();

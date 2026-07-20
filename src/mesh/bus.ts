/**
 * File-based message bus for the agent mesh.
 *
 * Everything lives under the meeting folder so a mesh is entirely self-contained:
 *
 *   <meeting>/
 *     BOARD.md                     shared, human-readable coordination board
 *     .mesh/
 *       agents/<name>.json         one registry file per agent (no r/m/w races)
 *       bus/<name>.inbox.jsonl     append-only inbox, one JSON message per line
 *       cursors/<name>             integer: how many inbox lines <name> has consumed
 *       logs/<name>.log            per-agent runner log
 *     workspaces/<name>/           each worker's own working directory
 *
 * Messaging is just appending a line to the recipient's inbox; peer-to-peer and
 * agent->orchestrator use the exact same path. A single agent's inbox has exactly one
 * consumer (its own runner, or the orchestrator CLI), so cursor advances never race.
 */
import fs from "node:fs";
import path from "node:path";

export const ORCHESTRATOR = "orchestrator";

export type MessageType = "task" | "msg" | "result" | "question" | "stop";

export interface MeshMessage {
  id: string;
  ts: string;
  from: string;
  to: string;
  type: MessageType;
  body: string;
}

export interface AgentRecord {
  name: string;
  role: string;
  status: "idle" | "busy" | "starting" | "stopped";
  pid: number | null;
  cwd: string;
  sessionId: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface BusPaths {
  meeting: string;
  meshDir: string;
  agentsDir: string;
  busDir: string;
  cursorsDir: string;
  logsDir: string;
  workspacesDir: string;
  board: string;
}

export function busPaths(meeting: string): BusPaths {
  const meshDir = path.join(meeting, ".mesh");
  return {
    meeting,
    meshDir,
    agentsDir: path.join(meshDir, "agents"),
    busDir: path.join(meshDir, "bus"),
    cursorsDir: path.join(meshDir, "cursors"),
    logsDir: path.join(meshDir, "logs"),
    workspacesDir: path.join(meeting, "workspaces"),
    board: path.join(meeting, "BOARD.md"),
  };
}

export function initBus(meeting: string): BusPaths {
  const p = busPaths(meeting);
  for (const dir of [p.meshDir, p.agentsDir, p.busDir, p.cursorsDir, p.logsDir, p.workspacesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(p.board)) {
    fs.writeFileSync(
      p.board,
      "# Board\n\nShared coordination board. Agents append status here; the orchestrator reads it to integrate.\n",
    );
  }
  // Make sure the orchestrator has an inbox so workers can report to it.
  ensureInbox(meeting, ORCHESTRATOR);
  return p;
}

function ensureInbox(meeting: string, agent: string): string {
  const p = busPaths(meeting);
  const inbox = path.join(p.busDir, `${agent}.inbox.jsonl`);
  if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, "");
  return inbox;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append a message to the recipient's inbox. This is the only send primitive. */
export function sendMessage(
  meeting: string,
  msg: { from: string; to: string; type: MessageType; body: string },
): MeshMessage {
  const full: MeshMessage = { id: newId(), ts: new Date().toISOString(), ...msg };
  const inbox = ensureInbox(meeting, msg.to);
  fs.appendFileSync(inbox, JSON.stringify(full) + "\n");
  return full;
}

function cursorFile(meeting: string, agent: string): string {
  return path.join(busPaths(meeting).cursorsDir, agent);
}

function readCursor(meeting: string, agent: string): number {
  try {
    return parseInt(fs.readFileSync(cursorFile(meeting, agent), "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writeCursor(meeting: string, agent: string, n: number): void {
  fs.writeFileSync(cursorFile(meeting, agent), String(n));
}

function parseInbox(meeting: string, agent: string): MeshMessage[] {
  const inbox = ensureInbox(meeting, agent);
  const lines = fs.readFileSync(inbox, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const out: MeshMessage[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as MeshMessage);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Return messages not yet consumed by `agent` and advance its cursor past them. */
export function readNewMessages(meeting: string, agent: string): MeshMessage[] {
  const all = parseInbox(meeting, agent);
  const cursor = readCursor(meeting, agent);
  const fresh = all.slice(cursor);
  writeCursor(meeting, agent, all.length);
  return fresh;
}

/** Return unconsumed messages without advancing the cursor. */
export function peekNewMessages(meeting: string, agent: string): MeshMessage[] {
  return parseInbox(meeting, agent).slice(readCursor(meeting, agent));
}

/** Append a timestamped line to the shared board. */
export function postBoard(meeting: string, from: string, text: string): void {
  const p = busPaths(meeting);
  if (!fs.existsSync(p.board)) initBus(meeting);
  const stamp = new Date().toISOString().slice(11, 19);
  fs.appendFileSync(p.board, `- \`${stamp}\` **${from}**: ${text}\n`);
}

export function readBoard(meeting: string): string {
  const p = busPaths(meeting);
  return fs.existsSync(p.board) ? fs.readFileSync(p.board, "utf8") : "(no board yet)";
}

function agentFile(meeting: string, name: string): string {
  return path.join(busPaths(meeting).agentsDir, `${name}.json`);
}

export function upsertAgent(meeting: string, rec: Partial<AgentRecord> & { name: string }): AgentRecord {
  const file = agentFile(meeting, rec.name);
  let existing: AgentRecord | null = null;
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as AgentRecord;
  } catch {
    /* new agent */
  }
  const now = new Date().toISOString();
  const merged: AgentRecord = {
    name: rec.name,
    role: rec.role ?? existing?.role ?? "",
    status: rec.status ?? existing?.status ?? "starting",
    pid: rec.pid ?? existing?.pid ?? null,
    cwd: rec.cwd ?? existing?.cwd ?? "",
    sessionId: rec.sessionId ?? existing?.sessionId ?? null,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return merged;
}

export function listAgents(meeting: string): AgentRecord[] {
  const p = busPaths(meeting);
  if (!fs.existsSync(p.agentsDir)) return [];
  return fs
    .readdirSync(p.agentsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(p.agentsDir, f), "utf8")) as AgentRecord);
}

export function getAgent(meeting: string, name: string): AgentRecord | null {
  try {
    return JSON.parse(fs.readFileSync(agentFile(meeting, name), "utf8")) as AgentRecord;
  } catch {
    return null;
  }
}

/** True if a process with this pid is currently alive. */
export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

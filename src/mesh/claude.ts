/**
 * Invoke a headless `claude` turn for a worker agent and capture its result.
 *
 * Persistence works via session resume: the first call returns a session_id; every
 * later call passes it back with --resume, so the agent keeps its full memory across
 * messages. That is what makes a worker a long-lived agent rather than a one-shot.
 *
 * The prompt is fed on stdin (avoids arg-length/quoting limits). The session runs with
 * permissions bypassed but is naturally scoped to its own workspace cwd; it is given
 * --add-dir for the meeting folder so it can reach the shared `mesh` CLI and board.
 */
import { spawn } from "node:child_process";
import { sendMessage, type MessageType } from "./bus.js";

export interface ClaudeResult {
  result: string;
  sessionId: string | null;
  isError: boolean;
}

export interface RunClaudeOptions {
  cwd: string;
  prompt: string;
  model: string;
  appendSystemPrompt: string;
  resumeSessionId?: string | null;
  addDirs?: string[];
}

export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  if (process.env.MESH_FAKE_CLAUDE) return fakeClaude(opts);

  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    opts.model,
    "--append-system-prompt",
    opts.appendSystemPrompt,
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
  ];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  // Local Claude Code login, not the API: an empty ANTHROPIC_API_KEY still "wins"
  // auth and fails, so strip it.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;

  return new Promise<ClaudeResult>((resolve) => {
    const child = spawn("claude", args, { cwd: opts.cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ result: `spawn error: ${err.message}`, sessionId: null, isError: true }));
    child.on("close", () => {
      try {
        const j = JSON.parse(stdout);
        resolve({
          result: typeof j.result === "string" ? j.result : "",
          sessionId: j.session_id ?? null,
          isError: Boolean(j.is_error),
        });
      } catch {
        resolve({
          result: stderr.trim() || stdout.trim() || "no output",
          sessionId: null,
          isError: true,
        });
      }
    });
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

/**
 * Deterministic stand-in for `claude` used when MESH_FAKE_CLAUDE is set. It does not
 * call the model; instead it honors literal `@send:<to>:<type>:<body>` directives in
 * the prompt by routing real bus messages, so the mesh (peer messaging, board, runner
 * loop) can be exercised offline. Meeting dir is taken from MESH_FAKE_MEETING.
 */
function fakeClaude(opts: RunClaudeOptions): ClaudeResult {
  const meeting = process.env.MESH_FAKE_MEETING;
  const me = process.env.MESH_FAKE_AGENT ?? "worker";
  // Parse each `@send:<to>:<type>:<body>` directive, stopping <body> at the next
  // directive or end of string (non-greedy, so multiple directives on one line work).
  const directives = [...opts.prompt.matchAll(/@send:([^:\s]+):([^:\s]+):(.*?)(?=@send:|$)/gm)];
  if (meeting) {
    for (const [, to, type, body] of directives) {
      sendMessage(meeting, { from: me, to: to.trim(), type: type.trim() as MessageType, body: body.trim() });
    }
  }
  return {
    result: `[fake] handled ${directives.length} directive(s)`,
    sessionId: opts.resumeSessionId ?? "fake-session",
    isError: false,
  };
}

import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import type { Logger } from "./logger.js";
import type { Sentence } from "./fireflies/client.js";

export interface BuildPassInput {
  /** Absolute path to this meeting's workspace (the agent's cwd). */
  workspace: string;
  meetingTitle: string;
  /** Every sentence captured so far (full context). */
  fullTranscript: Sentence[];
  /** Only the sentences new since the last pass (what to act on now). */
  newSentences: Sentence[];
  /** True for the one-shot consolidation pass after the meeting ends. */
  isFinal: boolean;
  logger: Logger;
}

function renderSentences(sentences: Sentence[]): string {
  return sentences
    .map((s) => `${s.speaker_name ? s.speaker_name + ": " : ""}${s.text}`)
    .join("\n");
}

const SYSTEM_APPEND = `
You are a "build bot" listening to a live meeting transcript. As people describe
things they want, you build them into this working directory — real code and
prototypes, plus specs/docs — without being asked turn by turn.

Operating rules:
- Maintain a file called SPEC.md at the workspace root. It captures what has been
  discussed and decided, and a short running build log (newest entry last).
- Only build something once the idea is settled enough to act on. If the new
  transcript is just partial or exploratory chatter, update SPEC.md notes and wait.
- Prefer APPEND/REFINE over rewrite. Do not delete or restart prior work because a
  later sentence rephrased something — evolve it.
- Everything you produce during the meeting is a DRAFT. Keep files small, runnable,
  and clearly organized (e.g. group a prototype under its own subfolder).
- Never touch anything outside this working directory.
- When you have nothing to build from the new transcript, say so briefly and stop —
  do not invent scope that was not discussed.
`.trim();

/**
 * Run one build pass. Called repeatedly during a meeting with growing transcript,
 * and once more with isFinal=true after the meeting ends to consolidate the drafts.
 * Returns the agent's final result text (for logging).
 */
export async function runBuildPass(input: BuildPassInput): Promise<string> {
  const { workspace, meetingTitle, fullTranscript, newSentences, isFinal, logger } = input;

  const prompt = isFinal
    ? finalPrompt(meetingTitle, fullTranscript)
    : livePrompt(meetingTitle, fullTranscript, newSentences);

  // Run against the LOCAL Claude Code login (your `claude` subscription), not the
  // Anthropic API. The Agent SDK already runs Claude Code locally; auth resolves to
  // the stored login only when ANTHROPIC_API_KEY is absent — an empty-string key
  // (e.g. a blank line in .env) still "wins" auth and fails, so strip it here.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  if (!childEnv.ANTHROPIC_API_KEY) delete childEnv.ANTHROPIC_API_KEY;

  const q = query({
    prompt,
    options: {
      cwd: workspace,
      model: config.buildModel,
      // Autonomous: no human is watching to approve tool calls. Scope is limited
      // by cwd (the per-meeting workspace) and the tool allowlist below.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true, // required by the SDK for bypassPermissions
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
      maxTurns: isFinal ? 40 : 20,
      env: childEnv,
    },
  });

  let finalText = "";
  try {
    for await (const message of q as AsyncIterable<AgentMessage>) {
      if (message.type === "result") {
        const m = message as ResultMessage;
        if (m.subtype === "success" && typeof m.result === "string") {
          finalText = m.result;
        } else {
          logger.error(`build pass ended: ${m.subtype}`, m.errors ?? []);
        }
        break;
      }
    }
  } finally {
    (q as { close?: () => void }).close?.();
  }
  return finalText;
}

function livePrompt(title: string, full: Sentence[], next: Sentence[]): string {
  return [
    `Meeting: "${title}" (in progress).`,
    ``,
    `NEW transcript since your last pass — act on this:`,
    `"""`,
    renderSentences(next) || "(no new lines)",
    `"""`,
    ``,
    `Full transcript so far, for context only:`,
    `"""`,
    renderSentences(full),
    `"""`,
    ``,
    `Build or refine whatever the new lines clearly call for, following your rules.`,
    `Update SPEC.md. If nothing is actionable yet, just note it in SPEC.md and stop.`,
  ].join("\n");
}

function finalPrompt(title: string, full: Sentence[]): string {
  return [
    `Meeting: "${title}" has ENDED. Do a final consolidation pass.`,
    ``,
    `Full transcript:`,
    `"""`,
    renderSentences(full),
    `"""`,
    ``,
    `Review everything you built during the meeting against the complete transcript.`,
    `Reconcile drafts, remove dead ends that were explicitly dropped in the meeting,`,
    `make prototypes runnable, and finalize SPEC.md with a clear summary of what was`,
    `requested and what you built. Do not add scope that was never discussed.`,
  ].join("\n");
}

interface AgentMessage {
  type: string;
}

/** Shape of the SDK's `type: "result"` message (see coreTypes.d.ts SDKResultMessage). */
interface ResultMessage extends AgentMessage {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  result?: string;
  errors?: string[];
}

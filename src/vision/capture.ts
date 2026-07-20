/**
 * Post-meeting visual capture (runs detached, spawned by meeting-worker when a meeting
 * ends). Waits for the Fireflies recording to finish processing, downloads it once, and
 * extracts the exact frame for every moment the agents flagged during the meeting. Then
 * writes a VISUALS.md index and messages the orchestrator so it can review the images.
 *
 *   node dist/vision/capture.js --meeting <dir> --id <transcriptId>
 *
 * Degrades gracefully: if video is unavailable (plan/setting) or ffmpeg is missing, it
 * posts a note and exits — the live Mac screenshots taken during the meeting still stand.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { FirefliesClient } from "../fireflies/client.js";
import { ORCHESTRATOR, postBoard, sendMessage } from "../mesh/bus.js";
import { downloadFile, extractFrame, ffmpegAvailable } from "./video.js";
import {
  ensureMediaDir,
  fmtClock,
  readVisuals,
  slug,
  writeVisuals,
  type VisualFlag,
} from "./visuals.js";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function makeLog(meeting: string) {
  const file = path.join(meeting, ".mesh", "logs", "vision.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (m: string) => fs.appendFileSync(file, `${new Date().toISOString()} ${m}\n`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForVideo(
  ff: FirefliesClient,
  id: string,
  log: (m: string) => void,
): Promise<string | null> {
  const deadline = Date.now() + config.vision.videoWaitMaxMs;
  while (Date.now() < deadline) {
    try {
      const rec = await ff.getRecording(id);
      if (rec.video_url) return rec.video_url;
      log("video not ready yet (still processing)");
    } catch (err) {
      log(`getRecording error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(config.vision.videoPollMs);
  }
  return null;
}

function writeIndex(meeting: string, flags: VisualFlag[]): void {
  const rel = (p: string | null | undefined) => (p ? path.relative(meeting, p) : null);
  const lines = [
    "# Visual moments",
    "",
    "Moments the agents flagged during the meeting. **Live** = a screenshot of the Mac",
    "screen at flag time (best-effort, may lag the words by a poll interval). **Frame** =",
    "the exact frame from the Fireflies recording at that timestamp (the accurate one).",
    "",
  ];
  for (const f of flags) {
    const t = f.at != null ? `[${fmtClock(f.at)}] ` : "";
    lines.push(`## ${t}${f.note}`);
    const live = rel(f.livePath);
    const frame = rel(f.framePath);
    if (frame) lines.push(`- Frame: \`${frame}\``);
    if (live) lines.push(`- Live: \`${live}\``);
    if (!frame && !live) lines.push(`- _(no image captured)_`);
    lines.push("");
  }
  fs.writeFileSync(path.join(meeting, "VISUALS.md"), lines.join("\n"));
}

async function main(): Promise<void> {
  const meeting = arg("meeting");
  const id = arg("id");
  const log = makeLog(meeting);
  if (!meeting || !id) {
    log("capture requires --meeting and --id");
    process.exit(1);
  }
  if (!config.vision.captureEnabled) {
    log("capture disabled (CAPTURE_ENABLED=false) — exiting");
    return;
  }

  const flags = readVisuals(meeting);
  const targets = flags.filter((f) => f.at != null);
  log(`starting: ${flags.length} flag(s), ${targets.length} with a timestamp`);
  if (targets.length === 0) {
    postBoard(meeting, "vision", "no timestamped visual moments to extract — nothing to do");
    return;
  }
  if (!ffmpegAvailable()) {
    postBoard(meeting, "vision", "ffmpeg not found — cannot extract frames (install ffmpeg). Live screenshots still stand.");
    log("ffmpeg not available");
    return;
  }

  postBoard(meeting, "vision", `meeting ended — waiting for Fireflies video to extract ${targets.length} moment(s)`);
  const ff = new FirefliesClient();
  const videoUrl = await waitForVideo(ff, id, log);
  if (!videoUrl) {
    postBoard(meeting, "vision", "Fireflies video never became available (plan/setting?) — using live screenshots only");
    log("timed out waiting for video");
    return;
  }

  const media = ensureMediaDir(meeting);
  const videoPath = path.join(media, "recording.mp4");
  try {
    log(`downloading video → ${videoPath}`);
    const bytes = await downloadFile(videoUrl, videoPath);
    log(`downloaded ${bytes} bytes`);
  } catch (err) {
    postBoard(meeting, "vision", `video download failed: ${err instanceof Error ? err.message : String(err)}`);
    log(`download failed: ${err}`);
    return;
  }

  let ok = 0;
  for (const f of targets) {
    const at = f.at as number;
    const out = path.join(media, `frame-${fmtClock(at).replace(/:/g, "")}-${slug(f.note)}.png`);
    const got = await extractFrame(videoPath, at, out);
    if (got) {
      f.framePath = out;
      ok++;
      log(`extracted frame @${at}s → ${out}`);
    } else {
      log(`FAILED to extract frame @${at}s`);
    }
  }
  writeVisuals(meeting, flags);
  writeIndex(meeting, flags);

  const summary = flags
    .filter((f) => f.at != null)
    .map((f) => {
      const bits = [`[${fmtClock(f.at as number)}] ${f.note}`];
      if (f.framePath) bits.push(`frame: ${path.relative(meeting, f.framePath)}`);
      if (f.livePath) bits.push(`live: ${path.relative(meeting, f.livePath)}`);
      return "- " + bits.join(" | ");
    })
    .join("\n");
  sendMessage(meeting, {
    from: "vision",
    to: ORCHESTRATOR,
    type: "msg",
    body:
      `Post-meeting visual capture done — extracted ${ok}/${targets.length} frame(s). ` +
      `See VISUALS.md. Read these images and reconcile the build against what was actually shown:\n${summary}`,
  });
  postBoard(meeting, "vision", `extracted ${ok}/${targets.length} frame(s); see VISUALS.md`);
  log("done");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

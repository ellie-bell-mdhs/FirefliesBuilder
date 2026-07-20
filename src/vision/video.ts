/**
 * Download the Fireflies recording and extract still frames with ffmpeg.
 *
 * The video_url is a signed GCS URL fetched with a plain GET (auth is in the query
 * string). It can be large (~GB), so we stream it to disk rather than buffering. Frames
 * are pulled with a fast pre-input seek (`-ss` before `-i`).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";

const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

export function resolveFfmpeg(): string {
  if (config.vision.ffmpegPath) return config.vision.ffmpegPath;
  for (const p of FFMPEG_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return "ffmpeg"; // rely on PATH
}

/** True if an ffmpeg binary can be resolved on this machine. */
export function ffmpegAvailable(): boolean {
  const bin = resolveFfmpeg();
  if (bin.includes("/")) return fs.existsSync(bin);
  // bare "ffmpeg" — check PATH via `which`-style existence in common dirs already tried
  return FFMPEG_CANDIDATES.some((p) => fs.existsSync(p));
}

/** Stream a URL to a file. Returns bytes written. Throws on HTTP error. */
export async function downloadFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} for ${dest}`);
  }
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
  return fs.statSync(dest).size;
}

/**
 * Extract a single frame at `seconds` from `videoPath` into `outPath` (PNG). Returns
 * true if a non-empty file was produced.
 */
export function extractFrame(videoPath: string, seconds: number, outPath: string): Promise<boolean> {
  const bin = resolveFfmpeg();
  const args = [
    "-ss",
    String(Math.max(0, seconds)),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    outPath,
  ];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => {
      try {
        resolve(fs.statSync(outPath).size > 0);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Live macOS screen capture via the built-in `screencapture` CLI.
 *
 * Best-effort: capturing the screen needs Screen Recording permission for whichever
 * app is the responsible parent (the terminal running the mesh CLI, e.g. Ghostty). If
 * permission is missing, `screencapture` fails or writes nothing — callers treat this
 * as non-fatal and just log it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/**
 * Capture all displays to `dest` (PNG). Returns true if a file was actually written.
 * `-x` silences the shutter sound; `-t png` sets the format.
 */
export function captureScreen(dest: string): boolean {
  const res = spawnSync("screencapture", ["-x", "-t", "png", dest], { stdio: "ignore" });
  if (res.error) return false;
  try {
    return fs.statSync(dest).size > 0;
  } catch {
    return false;
  }
}

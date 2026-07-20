/**
 * Install/uninstall a macOS LaunchAgent so the meeting build-bot starts on its
 * own at login and stays running (no manual launch). Usage:
 *
 *   node scripts/launchagent.mjs install
 *   node scripts/launchagent.mjs uninstall
 *
 * (Prefer the npm wrappers: `npm run install:agent` / `npm run uninstall:agent`.)
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.megadata.meeting-buildbot";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function electronBinary() {
  // Outside the Electron runtime, `require('electron')` resolves to the binary path.
  const p = require("electron");
  if (typeof p !== "string") throw new Error("Could not resolve the Electron binary path");
  return p;
}

function install() {
  const entry = path.join(projectRoot, "dist", "main.js");
  if (!fs.existsSync(entry)) throw new Error(`Missing ${entry} — run \`npm run build\` first.`);

  const logDir = path.join(projectRoot, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${electronBinary()}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${projectRoot}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, "buildbot.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "buildbot.err.log")}</string>
</dict>
</plist>
`;

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });
  console.log(`Installed and loaded LaunchAgent: ${plistPath}`);
  console.log("It will run at every login. Logs: logs/buildbot.log");
}

function uninstall() {
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
  console.log(`Removed LaunchAgent: ${plistPath}`);
}

const cmd = process.argv[2];
if (cmd === "install") install();
else if (cmd === "uninstall") uninstall();
else {
  console.error("Usage: node scripts/launchagent.mjs <install|uninstall>");
  process.exit(1);
}

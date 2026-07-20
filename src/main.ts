import fs from "node:fs";
import { app, dialog } from "electron";
import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { NotSignedInError } from "./calendar/graph.js";
import { createTray, type TrayController } from "./tray.js";

const log = makeLogger("app");

let orchestrator: Orchestrator | null = null;
let tray: TrayController | null = null;

/** Show the menu bar only while a meeting is near or a build is running. */
function syncTray(pendingSoon: boolean, activeCount: number): void {
  const shouldShow = pendingSoon || activeCount > 0;
  if (shouldShow && !tray) {
    tray = createTray();
    log.info("menu bar shown (meeting near / building)");
  } else if (!shouldShow && tray) {
    tray.destroy();
    tray = null;
    log.info("menu bar hidden (idle)");
  } else {
    tray?.refresh();
  }
}

async function startWatching(): Promise<void> {
  orchestrator = new Orchestrator((s) => syncTray(s.pendingSoon, s.activeCount));
  try {
    await orchestrator.start();
    log.info("watcher running");
  } catch (err) {
    if (err instanceof NotSignedInError) {
      // Headless: don't block. Tell the user to log in once, then retry silently.
      void dialog.showMessageBox({
        type: "warning",
        title: "Connect your Outlook calendar",
        message: "The meeting build-bot needs to see your calendar.",
        detail: "Run this once in the project folder:\n\n    npm run login\n\nIt will reconnect automatically after that — no need to restart.",
        buttons: ["OK"],
      });
      log.warn("not signed in — retrying in 5 min (run `npm run login`)");
      setTimeout(() => void startWatching(), 5 * 60_000);
      return;
    }
    log.error("startup failed:", err);
    dialog.showErrorBox("Startup failed", err instanceof Error ? err.message : String(err));
  }
}

app.whenReady().then(() => {
  // Invisible background app: no dock icon, no window, no tray until a meeting is near.
  if (process.platform === "darwin") app.dock?.hide();
  fs.mkdirSync(config.buildsDir, { recursive: true });
  void startWatching();
});

// Background app — never quit just because no window is open.
app.on("window-all-closed", () => {
  /* intentionally do nothing */
});

app.on("before-quit", () => {
  orchestrator?.stop();
  tray?.destroy();
});

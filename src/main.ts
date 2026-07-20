import fs from "node:fs";
import { app, dialog } from "electron";
import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { createTray, type TrayController } from "./tray.js";

const log = makeLogger("app");
let orchestrator: Orchestrator | null = null;
let tray: TrayController | null = null;

app.whenReady().then(async () => {
  // Menu-bar-only app: no dock icon, no windows. (For a packaged .app, also set
  // LSUIElement=true in Info.plist so it never flashes in the dock.)
  if (process.platform === "darwin") app.dock?.hide();

  fs.mkdirSync(config.buildsDir, { recursive: true });
  tray = createTray();

  orchestrator = new Orchestrator();
  try {
    await orchestrator.start((deviceCodeMessage) => {
      // Surface the Microsoft device-code login instructions in a dialog.
      void dialog.showMessageBox({
        type: "info",
        title: "Connect Outlook calendar",
        message: "Sign in to Microsoft 365 to let the bot see your meetings.",
        detail: deviceCodeMessage,
        buttons: ["OK"],
      });
    });
    tray.refresh();
    log.info("orchestrator running");
  } catch (err) {
    log.error("startup failed:", err);
    dialog.showErrorBox("Startup failed", err instanceof Error ? err.message : String(err));
  }
});

// Keep running when there are no windows — this is a background menu-bar app.
app.on("window-all-closed", () => {
  /* intentionally do nothing */
});

app.on("before-quit", () => {
  orchestrator?.stop();
  tray?.destroy();
});

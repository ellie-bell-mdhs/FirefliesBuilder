import fs from "node:fs";
import { app, Notification } from "electron";
import { config } from "./config.js";
import { makeLogger } from "./logger.js";
import { Orchestrator, type OrchEvent } from "./orchestrator.js";
import { botState } from "./state.js";
import { createTray, type TrayController } from "./tray.js";

const log = makeLogger("app");

let orchestrator: Orchestrator | null = null;
let tray: TrayController | null = null;

function notify(title: string, body: string): void {
  try {
    new Notification({ title, body }).show();
  } catch {
    /* notifications may be unavailable in some environments */
  }
}

/** Turn orchestrator events into menu-bar notifications + a tray refresh. */
function onEvent(e: OrchEvent): void {
  switch (e.type) {
    case "started":
      notify("Build-bot started", `Working on: ${e.meetings.map((m) => m.title).join(", ")}`);
      break;
    case "already":
      notify("Already running", `Build-bot is already on ${e.count} meeting(s).`);
      break;
    case "watching":
      notify(
        "Watching for Fireflies",
        "No live meeting yet — I'll start the moment the Fireflies bot joins. (Stop looking from the menu.)",
      );
      break;
    case "timeout":
      notify("Stopped watching", "Fireflies didn't join in time. Press Start again once you're in the call.");
      break;
    case "error":
      notify("Couldn't check meetings", e.message);
      break;
  }
  log.info("event:", e.type);
  tray?.refresh();
}

app.whenReady().then(() => {
  // Menu-bar-only app: no dock icon, no window. The tray is always present and is the
  // only control surface; nothing runs until the user presses "Start".
  if (process.platform === "darwin") app.dock?.hide();
  fs.mkdirSync(config.buildsDir, { recursive: true });

  orchestrator = new Orchestrator(onEvent);
  tray = createTray({
    onStart: () => void orchestrator?.startOnCurrentMeeting(),
    onStopLooking: () => {
      orchestrator?.cancelWatch();
      tray?.refresh();
    },
    getStatus: () => ({
      watching: orchestrator?.isWatching() ?? false,
      active: botState.activeIds(),
    }),
  });
  log.info("menu bar ready (manual trigger)");
});

// Background app — never quit just because no window is open.
app.on("window-all-closed", () => {
  /* intentionally do nothing */
});

app.on("before-quit", () => {
  orchestrator?.stop();
  tray?.destroy();
});

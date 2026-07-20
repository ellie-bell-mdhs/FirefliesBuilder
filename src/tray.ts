import { Tray, Menu, nativeImage, shell } from "electron";
import { botState } from "./state.js";
import { config } from "./config.js";

export interface TrayController {
  refresh(): void;
  destroy(): void;
}

/**
 * The menu-bar item. Uses an empty image + a text/emoji title so no icon asset
 * is required. Re-renders on a timer so the active-meeting count and toggle state
 * stay current.
 */
export function createTray(): TrayController {
  const tray = new Tray(nativeImage.createEmpty());

  function render(): void {
    const on = botState.listeningEnabled;
    const active = botState.activeIds();

    tray.setTitle(on ? "🎙️" : "⏸️");
    tray.setToolTip(
      `Meeting build-bot — ${on ? "listening" : "paused"}` +
        (active.length ? `, ${active.length} active` : ""),
    );

    const menu = Menu.buildFromTemplate([
      { label: on ? "Status: listening" : "Status: paused", enabled: false },
      {
        label: active.length ? `Building ${active.length} meeting(s)` : "No active meeting",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Listening enabled",
        type: "checkbox",
        checked: on,
        click: () => {
          botState.listeningEnabled = !botState.listeningEnabled;
          render();
        },
      },
      {
        label: "Skip current meeting(s)",
        enabled: active.length > 0,
        click: () => {
          for (const id of active) botState.skip(id);
          render();
        },
      },
      { label: "Open output folder", click: () => void shell.openPath(config.buildsDir) },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]);
    tray.setContextMenu(menu);
  }

  render();
  const timer = setInterval(render, 3000);
  return {
    refresh: render,
    destroy: () => {
      clearInterval(timer);
      tray.destroy();
    },
  };
}

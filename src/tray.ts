import { Tray, Menu, nativeImage, shell, type MenuItemConstructorOptions } from "electron";
import { botState } from "./state.js";
import { config } from "./config.js";

export interface TrayController {
  refresh(): void;
  destroy(): void;
}

export interface TrayOptions {
  /** Press "Start on current meeting". */
  onStart: () => void;
  /** Cancel the bounded watch. */
  onStopLooking: () => void;
  /** Current status for rendering the menu. */
  getStatus: () => { watching: boolean; active: string[] };
}

/**
 * The always-present menu-bar item. Uses an empty image + an emoji title so no icon
 * asset is needed. It's the only control surface: nothing happens until you press
 * "Start on current meeting". Re-renders on a timer so status stays current.
 */
export function createTray(opts: TrayOptions): TrayController {
  const tray = new Tray(nativeImage.createEmpty());

  function render(): void {
    const { watching, active } = opts.getStatus();
    const building = active.length > 0;

    tray.setTitle(building ? "🛠️" : watching ? "👀" : "🎙️");
    const status = building
      ? `Building ${active.length} meeting(s)`
      : watching
        ? "Watching for Fireflies to join…"
        : "Idle";
    tray.setToolTip(`Meeting build-bot — ${status}`);

    const items: MenuItemConstructorOptions[] = [
      { label: `Status: ${status}`, enabled: false },
      { type: "separator" },
      {
        label: watching ? "Looking for a meeting…" : "Start on current meeting",
        enabled: !watching,
        click: () => opts.onStart(),
      },
    ];
    if (watching) {
      items.push({ label: "Stop looking", click: () => opts.onStopLooking() });
    }
    if (building) {
      items.push({
        label: "Skip / stop current meeting(s)",
        click: () => {
          for (const id of active) botState.skip(id);
          render();
        },
      });
    }
    items.push(
      { label: "Open output folder", click: () => void shell.openPath(config.buildsDir) },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    );

    tray.setContextMenu(Menu.buildFromTemplate(items));
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

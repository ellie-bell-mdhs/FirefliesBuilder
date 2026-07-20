// MeetingBuildBot launcher — a tiny LSUIElement (menu-bar/agent) app whose only job is
// to supervise the real Electron build-bot so it can be toggled on/off by
// applicationManager. applicationManager starts this via LaunchServices and stops it via
// NSRunningApplication.terminate(); because this is a proper bundle with our own
// identity, that matching works. On launch we run the Electron app from the repo in a
// login shell (so PATH/.env/node/dist all resolve); on quit we stop only the Electron
// child — any in-progress meeting (Ghostty windows, worker agents) is left running.

import AppKit
import Foundation

// The repo the Electron app lives in. The launcher intentionally runs the dev build
// rather than embedding Electron, so all the local tooling (claude, ghostty, ffmpeg,
// node, .env) resolves exactly as when run by hand.
let repoPath = ("~/Projects/Fireflies" as NSString).expandingTildeInPath

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private let child = Process()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Build dist if missing, then exec the real Electron binary (not the npm shim,
        // so our child pid IS Electron and terminate() reaches it directly).
        let cmd = """
        cd \"\(repoPath)\" && { [ -d dist ] || npm run build; } && \
        exec \"node_modules/electron/dist/$(cat node_modules/electron/path.txt)\" dist/main.js
        """
        child.executableURL = URL(fileURLWithPath: "/bin/zsh")
        child.arguments = ["-lc", cmd]
        // If Electron exits on its own, the launcher exits too, so applicationManager's
        // live-state (running or not) stays accurate.
        child.terminationHandler = { _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        do {
            try child.run()
        } catch {
            NSLog("MeetingBuildBot launcher: failed to start Electron: \(error)")
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Don't let the child's own exit re-trigger termination while we're shutting down.
        child.terminationHandler = nil
        guard child.isRunning else { return }
        // SIGTERM → Electron quits itself (its before-quit handler runs). We return
        // immediately rather than blocking: applicationManager force-terminates us ~0.5s
        // after a graceful quit, so a long wait here would just get us SIGKILL'd mid-wait
        // and could orphan Electron. Signaling and returning lets both exit cleanly.
        child.terminate()
    }
}

let app = NSApplication.shared
let delegate = LauncherDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // no Dock icon (also LSUIElement in Info.plist)
app.run()

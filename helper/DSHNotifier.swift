// DSHNotifier — a minimal macOS notification helper for dsh-mac-notify.
//
// macOS always draws a notification's icon from the bundle that posted it, and
// neither AppleScript nor terminal-notifier can override it. This helper is a
// real (LSUIElement) app bundle that borrows DeepSeek Harness's icon, so the
// banner looks native:
//
//   DSHNotifier --post --title "..." --body "..." [--subtitle ...] [--sound Name] [--id group]
//
// Launching it without --post (which is what a notification click does) brings
// DeepSeek Harness to the front and exits.

import AppKit
import UserNotifications

let harnessBundleId = "com.deepseek.dsh"

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

/// Bring DeepSeek Harness forward; this is the click action.
func activateHarness() -> Never {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: harnessBundleId) {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            exit(error == nil ? 0 : 1)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(2))
        exit(0)
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-b", harnessBundleId]
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        fail("cannot activate \(harnessBundleId): \(error.localizedDescription)", code: 5)
    }
    exit(process.terminationStatus)
}

// A notification click relaunches this app with no --post flag.
guard CommandLine.arguments.contains("--post") else { activateHarness() }

guard let title = argument("--title"), let body = argument("--body") else {
    fail("usage: DSHNotifier --post --title <title> --body <body> [--subtitle <subtitle>] [--sound <name>] [--id <group>]", code: 2)
}
let subtitle = argument("--subtitle") ?? ""
let soundName = argument("--sound") ?? ""
let group = argument("--id") ?? UUID().uuidString

let center = UNUserNotificationCenter.current()
center.requestAuthorization(options: [.alert, .sound]) { granted, error in
    if let error = error {
        fail("authorization failed: \(error.localizedDescription)", code: 3)
    }
    guard granted else {
        fail("notifications are blocked for this helper; allow it in System Settings > Notifications", code: 3)
    }
    let content = UNMutableNotificationContent()
    content.title = title
    if !subtitle.isEmpty { content.subtitle = subtitle }
    content.body = body
    content.threadIdentifier = group
    if soundName.isEmpty {
        content.sound = nil
    } else {
        content.sound = UNNotificationSound(named: UNNotificationSoundName(soundName))
    }
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    center.add(request) { error in
        if let error = error {
            fail("delivery failed: \(error.localizedDescription)", code: 4)
        }
        // Give the daemon a moment to accept the request before exiting.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { exit(0) }
    }
}
RunLoop.main.run()

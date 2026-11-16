# Changelog

## 0.4.0 — market readiness

- Declare `dsh.bundle.platforms: ["darwin"]` so non-macOS hosts skip the bundle instead of installing a no-op plugin.
- Ship an icon (`assets/icon.svg`) for the plugin list and the market tile.
- Build `DSHNotifier.app` automatically on first mount when it is missing (needs Xcode Command Line Tools); notifications keep working through osascript meanwhile. Disable with `DSH_MAC_NOTIFY_NO_BUILD=1`.
- Default backend is now `auto`: Electron → native helper → terminal-notifier → osascript.

## 0.3.0 — native icon and click

- New `helper` backend: a small native app bundle that posts notifications with DeepSeek Harness's icon; clicking a banner activates DeepSeek Harness.
- Action-first wording: "…已完成任务", "…需要你的批准", "…有一个问题等待你回答", "…需要你做出一个选择", with option labels listed for choices.

## 0.2.0 — any tone

- `completeSoundFile` / `errorSoundFile` / `approvalSoundFile` / `questionSoundFile` play caf/aiff/wav/mp3 through `afplay`, so any app's notification sound can be reused (e.g. WeChat's `notify.caf`).
- Backend diagnostics: `mac_notify_test` reports the host runtime and which backend is usable.

## 0.1.0 — first release

- macOS banners for task completion, failures, approval requests, user questions and plan review.
- `approval/request` and `user-questions/request` listeners delegate with `next()`, so a notification can never change an approval outcome.
- Subagent turns are silent by default; identical completion/error banners are throttled.
- Backends: osascript, Electron, terminal-notifier, custom command.

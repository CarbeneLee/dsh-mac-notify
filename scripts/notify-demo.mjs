#!/usr/bin/env node
// Send one notification through dsh-mac-notify's own delivery layer.
//
//   node scripts/notify-demo.mjs                 # uses the default backend
//   node scripts/notify-demo.mjs electron        # force a backend
//   DSH_NOTIFY_TEXT="hello" node scripts/notify-demo.mjs
//
// Useful on a machine where the plugin has not been mounted yet: if this does
// not pop a banner, the problem is macOS notification settings, not DSH.

import { normalizeConfig } from '../dsh/config.js'
import { createSender } from '../dsh/notify.js'

const backend = process.argv[2] ?? process.env.DSH_NOTIFY_BACKEND ?? 'osascript'
const config = normalizeConfig({ backend, debug: false })
const sender = createSender({ config, log: (line) => console.log('[log] ' + line) })

const text = process.env.DSH_NOTIFY_TEXT ?? '如果你看到这条通知，dsh-mac-notify 可以正常投递。'
try {
  const used = await sender.send({
    title: config.appName,
    subtitle: '🔔 dsh-mac-notify 投递测试',
    body: text,
    sound: config.approvalSound,
    group: 'dsh-demo',
  })
  console.log('delivered via: ' + used)
  console.log('backends: ' + JSON.stringify(await sender.describe()))
} catch (error) {
  console.error('delivery failed: ' + (error?.message ?? error))
  process.exitCode = 1
}

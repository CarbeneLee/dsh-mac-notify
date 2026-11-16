// macOS notification delivery for dsh-mac-notify.
//
// One `send()` call becomes one banner. Four backends are supported and all of
// them are additive: the plugin works on a plain `node` host (osascript) and
// gets a native app identity for free when it runs inside the Electron desktop
// app (the Electron Notification API) or when terminal-notifier is installed.
//
// Nothing in this file throws into the agent loop: callers get a rejected
// promise and decide what to log.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const MAC = process.platform === 'darwin'

/** Where Homebrew puts terminal-notifier; PATH lookup is tried first. */
const TERMINAL_NOTIFIER_CANDIDATES = [
  '/opt/homebrew/bin/terminal-notifier',
  '/usr/local/bin/terminal-notifier',
]

/**
 * Run a command without a shell; reject on non-zero exit or timeout.
 * @param {string} command - executable name or absolute path.
 * @param {string[]} args - argv passed verbatim.
 * @param {number} timeoutMs - hard deadline.
 * @returns {Promise<string>} stdout.
 */
export function runFile(command, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout ?? ''))
    })
  })
}

/**
 * Build the argument-safe `display notification` snippet.
 *
 * Values arrive as `on run argv` items, so a body containing quotes,
 * backslashes or newlines can never be parsed as AppleScript.
 * @param {{ hasSubtitle: boolean, hasSound: boolean }} shape - which argv items exist.
 * @returns {string[]} the `-e` statements for osascript.
 */
export function osascriptStatements({ hasSubtitle, hasSound }) {
  let command = 'display notification (item 1 of argv) with title (item 2 of argv)'
  let next = 3
  if (hasSubtitle) command += ` subtitle (item ${next++} of argv)`
  if (hasSound) command += ` sound name (item ${next++} of argv)`
  return ['-e', 'on run argv', '-e', command, '-e', 'end run']
}

/**
 * @typedef {object} NotificationPayload
 * @property {string} title - bold first line.
 * @property {string} [subtitle] - secondary line.
 * @property {string} body - notification body.
 * @property {string} [sound] - macOS sound name; empty means silent.
 * @property {string} [group] - grouping key on backends that support it.
 */

/**
 * Build the delivery object shared by the plugin and its tests.
 * @param {{ config: import('./config.js').DEFAULTS, log?: (message: string) => void }} options
 * @returns {{ send: (payload: NotificationPayload) => Promise<string>, describe: () => Promise<object> }}
 */
export function createSender({ config, log = () => {} }) {
  /** Resolved Electron Notification constructor: undefined = not tried, null = unavailable. */
  let electronNotification
  let terminalNotifierPath // undefined = not probed, null = absent
  // Notifications stay reachable until they are delivered/closed; Electron may
  // otherwise garbage-collect a pending banner before macOS shows it.
  const liveNotifications = new Set()

  async function loadElectronNotification() {
    if (electronNotification !== undefined) return electronNotification
    if (!MAC || !process.versions.electron) {
      electronNotification = null
      return null
    }
    try {
      const module = await import('electron')
      const Notification = module?.Notification ?? module?.default?.Notification
      const supported = typeof Notification === 'function'
        && (typeof Notification.isSupported !== 'function' || Notification.isSupported())
      electronNotification = supported ? Notification : null
      if (!supported) log('electron: Notification API unavailable')
    } catch (error) {
      log(`electron: import failed (${error?.message ?? error})`)
      electronNotification = null
    }
    return electronNotification
  }

  function findTerminalNotifier() {
    if (terminalNotifierPath !== undefined) return terminalNotifierPath
    for (const candidate of TERMINAL_NOTIFIER_CANDIDATES) {
      if (existsSync(candidate)) {
        terminalNotifierPath = candidate
        return candidate
      }
    }
    terminalNotifierPath = null
    return null
  }

  async function activateApp() {
    try {
      await runFile('open', ['-b', config.bundleId], 3000)
    } catch (error) {
      log(`activate: ${error?.message ?? error}`)
    }
  }

  async function sendWithElectron(Notification, payload) {
    const options = {
      title: payload.title,
      body: payload.body,
      silent: !payload.sound,
    }
    if (payload.subtitle) options.subtitle = payload.subtitle
    if (payload.sound) options.sound = payload.sound
    const notification = new Notification(options)
    liveNotifications.add(notification)
    const settle = () => liveNotifications.delete(notification)
    notification.on('close', settle)
    notification.on('failed', (_event, error) => {
      settle()
      log(`electron: delivery failed (${error?.message ?? error})`)
    })
    notification.on('click', () => {
      settle()
      void activateApp()
    })
    notification.show()
    return 'electron'
  }

  async function sendWithTerminalNotifier(payload) {
    const binary = findTerminalNotifier()
    if (!binary) throw new Error('terminal-notifier not found')
    const args = ['-title', payload.title, '-message', payload.body]
    if (payload.subtitle) args.push('-subtitle', payload.subtitle)
    if (payload.sound) args.push('-sound', payload.sound)
    if (payload.group) args.push('-group', payload.group)
    if (config.bundleId) args.push('-activate', config.bundleId)
    await runFile(binary, args)
    return 'terminal-notifier'
  }

  async function sendWithOsascript(payload) {
    if (!MAC) throw new Error('osascript is only available on macOS')
    const hasSubtitle = Boolean(payload.subtitle)
    const hasSound = Boolean(payload.sound)
    const argv = [payload.body, payload.title]
    if (hasSubtitle) argv.push(payload.subtitle)
    if (hasSound) argv.push(payload.sound)
    const args = [...osascriptStatements({ hasSubtitle, hasSound }), ...argv]
    await runFile('osascript', args)
    return 'osascript'
  }

  async function sendWithCommand(payload) {
    if (!config.command) throw new Error('backend "command" needs a command template')
    await runFile('sh', ['-c', config.command], 10000)
    return 'command'
  }

  // A command template reads its values from the environment, so a payload
  // containing quotes or $(...) can never be re-parsed as shell code.
  const runCommand = (payload) => new Promise((resolve, reject) => {
    execFile('sh', ['-c', config.command], {
      timeout: 10000,
      env: {
        ...process.env,
        DSH_NOTIFY_TITLE: payload.title,
        DSH_NOTIFY_SUBTITLE: payload.subtitle ?? '',
        DSH_NOTIFY_BODY: payload.body,
        DSH_NOTIFY_SOUND: payload.sound ?? '',
        DSH_NOTIFY_GROUP: payload.group ?? '',
      },
    }, (error) => (error ? reject(error) : resolve('command')))
  })

  const named = {
    osascript: sendWithOsascript,
    'terminal-notifier': sendWithTerminalNotifier,
    command: runCommand,
  }

  /**
   * Deliver one notification.
   * @param {NotificationPayload} payload - already clamped, human-ready text.
   * @returns {Promise<string>} the backend that delivered it.
   */
  async function send(payload) {
    if (!MAC) return 'skipped: not macOS'
    if (config.backend === 'electron' || config.backend === 'auto') {
      const Notification = await loadElectronNotification()
      if (Notification) {
        try {
          return await sendWithElectron(Notification, payload)
        } catch (error) {
          if (config.backend === 'electron') throw error
          log(`electron: falling back (${error?.message ?? error})`)
        }
      }
      if (config.backend === 'electron') throw new Error('Electron Notification is unavailable here')
    }
    if (config.backend === 'auto') {
      try {
        return await sendWithTerminalNotifier(payload)
      } catch (error) {
        log(`terminal-notifier: falling back (${error?.message ?? error})`)
      }
      return sendWithOsascript(payload)
    }
    const backend = named[config.backend]
    if (!backend) throw new Error(`unknown backend "${config.backend}"`)
    return backend(payload)
  }

  /** @returns {Promise<{platform: string, backend: string, electron: boolean, terminalNotifier: boolean}>} */
  async function describe() {
    return {
      platform: process.platform,
      backend: config.backend,
      electron: Boolean(await loadElectronNotification()),
      terminalNotifier: Boolean(findTerminalNotifier()),
    }
  }

  return { send, describe }
}

/**
 * Name of the frontmost application, or "" when it cannot be read.
 *
 * `lsappinfo` needs no Accessibility grant, unlike System Events, so the
 * "do not notify while the user is already looking at DSH" mode stays silent
 * about permissions.
 * @returns {Promise<string>} frontmost app display name.
 */
export async function frontmostAppName() {
  if (!MAC) return ''
  try {
    const asn = (await runFile('lsappinfo', ['front'], 1500)).trim()
    if (!asn) return ''
    const info = await runFile('lsappinfo', ['info', '-only', 'name', asn], 1500)
    const match = info.match(/"([^"]+)"/)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

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
 * @property {string} [soundFile] - audio file played with afplay; wins over `sound`.
 * @property {string} [group] - grouping key on backends that support it.
 */

/** Expand a leading "~" so config can keep a readable $HOME path. */
export function expandHome(path) {
  if (typeof path !== 'string' || !path.startsWith('~/')) return path
  return (process.env.HOME || '') + path.slice(1)
}

/**
 * Play one audio file; failures only reach the log. This is what lets the
 * notification reuse another app's tone (caf/aiff/wav/mp3 all work).
 */
async function playSoundFile(file, log) {
  try {
    await runFile('afplay', [file], 15000)
  } catch (error) {
    log(`afplay failed (${error?.message ?? error})`)
  }
}

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
    // The Electron main process exposes 'electron' through CJS require; a
    // dynamic import can also resolve, so try the CJS route first and only
    // then ESM. Both are contained: any failure just disables this backend.
    let api
    try {
      const { createRequire } = await import('node:module')
      api = createRequire(import.meta.url)('electron')
      log('electron: loaded through require')
    } catch (error) {
      log(`electron: require failed (${error?.message ?? error})`)
    }
    if (!api || typeof api.Notification !== 'function') {
      try {
        const module = await import('electron')
        api = module?.default ?? module
        log('electron: loaded through import')
      } catch (error) {
        log(`electron: import failed (${error?.message ?? error})`)
      }
    }
    const Notification = api?.Notification
    const supported = typeof Notification === 'function'
      && (typeof Notification.isSupported !== 'function' || Notification.isSupported())
    if (!supported) {
      const shape = api && typeof api === 'object' ? Object.keys(api).slice(0, 10).join(',') : typeof api
      log('electron: Notification API unavailable (module=' + shape + ', notification=' + typeof Notification + ')')
    }
    electronNotification = supported ? Notification : null
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
    // A sound file takes over the sound: the banner is posted silently while
    // afplay plays the exact tone, so any app's notification sound can be reused.
    let effective = payload
    if (payload.soundFile) {
      const file = expandHome(payload.soundFile)
      if (existsSync(file)) {
        effective = { ...payload, sound: '' }
        void playSoundFile(file, log)
      } else {
        log('sound file missing: ' + file)
      }
    }
    if (config.backend === 'electron' || config.backend === 'auto') {
      const Notification = await loadElectronNotification()
      if (Notification) {
        try {
          return await sendWithElectron(Notification, effective)
        } catch (error) {
          if (config.backend === 'electron') throw error
          log(`electron: falling back (${error?.message ?? error})`)
        }
      }
      if (config.backend === 'electron') throw new Error('Electron Notification is unavailable here')
    }
    if (config.backend === 'auto') {
      try {
        return await sendWithTerminalNotifier(effective)
      } catch (error) {
        log(`terminal-notifier: falling back (${error?.message ?? error})`)
      }
      return sendWithOsascript(effective)
    }
    const backend = named[config.backend]
    if (!backend) throw new Error(`unknown backend "${config.backend}"`)
    return backend(effective)
  }

  /** @returns {Promise<object>} what this host process can actually deliver through. */
  async function describe() {
    return {
      platform: process.platform,
      backend: config.backend,
      electron: Boolean(await loadElectronNotification()),
      terminalNotifier: Boolean(findTerminalNotifier()),
      runtime: {
        pid: process.pid,
        execPath: process.execPath,
        electron: process.versions.electron ?? null,
        node: process.versions.node,
      },
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

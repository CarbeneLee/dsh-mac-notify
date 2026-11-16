// Configuration for dsh-mac-notify.
//
// Everything is optional: the plugin ships working defaults and this module only
// merges the profile's YAML config over them and coerces the values that reach
// execFile() or the notification payload. Unknown keys are ignored on purpose so
// a newer profile patch never breaks an older plugin (and vice versa).

/** Built-in defaults; every field is documented in README.md. */
export const DEFAULTS = Object.freeze({
  /** Master switch. false unmounts nothing, it only stops sending. */
  enabled: true,
  /** Bold first line of the notification. */
  appName: 'DeepSeek Harness',
  /** Bundle id used by the click-to-focus helpers (Electron / terminal-notifier). */
  bundleId: 'com.deepseek.dsh',
  /** "zh" | "en" — notification wording. "auto" reads LANG/LC_ALL. */
  locale: 'auto',

  /** Per-event switches. */
  notifyOnComplete: true,
  notifyOnError: true,
  notifyOnApproval: true,
  notifyOnQuestion: true,
  notifyOnBlocked: false,

  /** Subagent turns are noisy; opt in only if you want them. */
  includeSubagents: false,
  /** Skip a notification while the DeepSeek Harness window is frontmost (macOS only). */
  suppressWhenFocused: false,

  /** Sounds by macOS name ("Glass", "Ping", "Basso", ...); "" disables the sound. */
  completeSound: 'Glass',
  errorSound: 'Basso',
  approvalSound: 'Ping',
  questionSound: 'Ping',
  /**
   * Optional audio files (caf/aiff/wav/mp3/...) played with afplay. They win
   * over the named sound above, so any app's tone can be reused — e.g. WeChat's
   * notify.caf or your own download.
   */
  completeSoundFile: '',
  errorSoundFile: '',
  approvalSoundFile: '',
  questionSoundFile: '',

  /** "osascript" (default) | "electron" | "terminal-notifier" | "command" | "auto". */
  backend: 'osascript',
  /** Shell command for backend "command"; TITLE/SUBTITLE/BODY/SOUND arrive as env vars. */
  command: '',

  /** Two identical completion/error notifications closer than this are merged. */
  minIntervalMs: 300,
  /** Notification body is clamped to this many characters. */
  maxBodyChars: 220,
  /** Session label (the task prompt) is clamped to this many characters. */
  maxLabelChars: 70,
  /** Print backend decisions and deliveries to the debug log. */
  debug: false,
})

const BACKENDS = ['osascript', 'electron', 'terminal-notifier', 'command', 'auto']
const LOCALES = ['auto', 'zh', 'en']

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function string(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function integer(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Detect the notification language from the environment.
 * @returns {'zh' | 'en'} the locale used for generated wording.
 */
export function detectLocale() {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  return /^en([_.]|$)/i.test(raw) ? 'en' : 'zh'
}

/**
 * Merge one profile config over {@link DEFAULTS}.
 * @param {unknown} raw - the config object the Cordis loader passed in, if any.
 * @returns {typeof DEFAULTS & { locale: 'zh' | 'en' }} a validated, frozen config.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const locale = LOCALES.includes(input.locale) && input.locale !== 'auto'
    ? input.locale
    : detectLocale()
  const maxBodyChars = integer(input.maxBodyChars, DEFAULTS.maxBodyChars, 20, 4000)
  const maxLabelChars = integer(input.maxLabelChars, DEFAULTS.maxLabelChars, 10, 400)

  return Object.freeze({
    enabled: bool(input.enabled, DEFAULTS.enabled),
    appName: string(input.appName, DEFAULTS.appName),
    bundleId: string(input.bundleId, DEFAULTS.bundleId),
    locale,

    notifyOnComplete: bool(input.notifyOnComplete, DEFAULTS.notifyOnComplete),
    notifyOnError: bool(input.notifyOnError, DEFAULTS.notifyOnError),
    notifyOnApproval: bool(input.notifyOnApproval, DEFAULTS.notifyOnApproval),
    notifyOnQuestion: bool(input.notifyOnQuestion, DEFAULTS.notifyOnQuestion),
    notifyOnBlocked: bool(input.notifyOnBlocked, DEFAULTS.notifyOnBlocked),

    includeSubagents: bool(input.includeSubagents, DEFAULTS.includeSubagents),
    suppressWhenFocused: bool(input.suppressWhenFocused, DEFAULTS.suppressWhenFocused),

    completeSound: string(input.completeSound, DEFAULTS.completeSound),
    errorSound: string(input.errorSound, DEFAULTS.errorSound),
    approvalSound: string(input.approvalSound, DEFAULTS.approvalSound),
    questionSound: string(input.questionSound, DEFAULTS.questionSound),
    completeSoundFile: string(input.completeSoundFile, DEFAULTS.completeSoundFile),
    errorSoundFile: string(input.errorSoundFile, DEFAULTS.errorSoundFile),
    approvalSoundFile: string(input.approvalSoundFile, DEFAULTS.approvalSoundFile),
    questionSoundFile: string(input.questionSoundFile, DEFAULTS.questionSoundFile),

    backend: BACKENDS.includes(input.backend) ? input.backend : DEFAULTS.backend,
    command: string(input.command, DEFAULTS.command),

    minIntervalMs: integer(input.minIntervalMs, DEFAULTS.minIntervalMs, 0, 60000),
    maxBodyChars,
    maxLabelChars,
    debug: bool(input.debug, DEFAULTS.debug),
  })
}

// dsh-mac-notify — native macOS notifications for DeepSeek Harness.
//
// Three DSH seams become banners:
//   approval/request        -> "needs your approval"
//   user-questions/request  -> "needs your answer or a choice"
//   session/event turn/end  -> "task complete" / "task failed"
//
// The plugin is host-only and dependency-free: it listens to core events, never
// calls a service that may be absent, and never throws into the agent loop.
// Delivery details live in ./notify.js; wording lives here.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './config.js'
import { createSender, defaultHelperPath, expandHome, frontmostAppName } from './notify.js'

/** Package root, so the helper build script can be found after install. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Build DSHNotifier.app on first use when it is missing.
 *
 * The helper is what gives the banner DSH's icon; without it the plugin still
 * works through osascript. Building needs Xcode Command Line Tools, so a
 * missing toolchain is a logged downgrade, never a failure.
 * @param {object} config - normalized plugin config.
 * @param {(message: string) => void} log - debug logger.
 */
function maybeBuildHelper(config, log) {
  if (process.env.DSH_MAC_NOTIFY_NO_BUILD === '1' || process.platform !== 'darwin') return
  try {
    if (existsSync(expandHome(config.helperPath || defaultHelperPath()))) return
    const script = join(PACKAGE_ROOT, 'scripts', 'build-helper.sh')
    if (!existsSync(script)) {
      log('helper missing and build script absent')
      return
    }
    log('helper missing; building in the background')
    const child = spawn('sh', [script], { detached: true, stdio: 'ignore' })
    child.on('error', (error) => log('helper build failed: ' + (error?.message ?? error)))
    child.unref()
  } catch (error) {
    log('helper build setup failed: ' + (error?.message ?? error))
  }
}
import { clampText, formatDuration, messageText } from './text.js'

/** Cordis plugin name. */
export const name = 'dsh-mac-notify'

/** Notification wording. Keys mirror the seams above. */
const LABELS = {
  zh: {
    complete: '已完成任务',
    error: '任务失败',
    blocked: '任务被阻塞',
    maxTokens: '输出达到上限',
    approval: '需要你的批准',
    question: '有一个问题等待你回答',
    choice: '需要你做出一个选择',
    planReview: '有一个计划等待你确认',
    test: '通知测试',
    testBody: '如果你看到这条通知，dsh-mac-notify 已经生效。',
    noDetail: '任务已结束',
    questionMany: (count) => '（共 ' + count + ' 个问题）',
    options: (list) => '（选项：' + list + '）',
  },
  en: {
    complete: 'finished the task',
    error: 'hit an error',
    blocked: 'is blocked',
    maxTokens: 'hit the output limit',
    approval: 'needs your approval',
    question: 'has a question for you',
    choice: 'needs you to choose',
    planReview: 'has a plan for you to review',
    test: 'notification test',
    testBody: 'If you can read this, dsh-mac-notify is working.',
    noDetail: 'The task ended',
    questionMany: (count) => ' (' + count + ' questions)',
    options: (list) => ' (options: ' + list + ')',
  },
}

/**
 * The bold banner line: the app name plus what the app wants from you, so a
 * glance answers "do I need to do something?".
 * @param {string} appName - configured sender name.
 * @param {string} phrase - action phrase from LABELS.
 * @returns {string} the notification title.
 */
function bannerTitle(appName, phrase) {
  return appName + ' ' + phrase
}

/**
 * Append-only debug log under $DSH_HOME/dsh-mac-notify/debug.log.
 * Delivery must never fail because logging failed, so every write is contained.
 * @param {object} config - normalized plugin config.
 * @returns {(message: string) => void} the logger.
 */
function createLogger(config) {
  if (!config.debug) return () => {}
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-mac-notify')
  const file = join(dir, 'debug.log')
  return (message) => {
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, new Date().toISOString() + ' ' + message + '\n')
    } catch {
      // Logging is best-effort only.
    }
  }
}

/** @param {string} label @param {string} duration */
function withDuration(label, duration) {
  return duration ? label + ' · ' + duration : label
}

/** @param {unknown} value @returns {string} */
function describeError(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value.message === 'string') return value.message
  if (typeof value.error === 'string') return value.error
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Pick the localized presentation reason the asker supplied, if any.
 * @param {{ en?: string, [locale: string]: string } | undefined} display
 * @param {'zh' | 'en'} locale
 * @returns {string}
 */
function localizedReason(display, locale) {
  if (!display || typeof display !== 'object') return ''
  const preferred = display[locale]
  if (typeof preferred === 'string' && preferred) return preferred
  return typeof display.en === 'string' ? display.en : ''
}

/**
 * Mount the notifier on a Cordis context.
 * @param {object} ctx - Cordis context (approval/questions/session events are core).
 * @param {object} [rawConfig] - the profile's config block, or undefined.
 * @param {{ sender?: object, frontmost?: () => Promise<string> }} [deps] - test seams.
 * @returns {{ flush: () => Promise<unknown[]> }} a handle so tests can await in-flight banners.
 */
export function apply(ctx, rawConfig, deps) {
  const config = normalizeConfig(rawConfig)
  const log = createLogger(config)
  const labels = LABELS[config.locale]
  const sessions = new Map()
  const lastSentAt = new Map()
  const pending = new Set()

  if (process.env.DSH_MAC_NOTIFY_DISABLE === '1') {
    log('disabled by DSH_MAC_NOTIFY_DISABLE=1')
    return { flush: () => Promise.resolve([]) }
  }
  if (!config.enabled) {
    log('disabled by config.enabled=false')
    return { flush: () => Promise.resolve([]) }
  }

  const sender = deps?.sender ?? createSender({ config, log })
  const frontmost = deps?.frontmost ?? frontmostAppName
  if (!deps?.sender) maybeBuildHelper(config, log)

  /** Per-session scratch state: the task prompt, the last answer and turn timing. */
  function stateOf(session) {
    const id = session?.id ?? 'unknown'
    let state = sessions.get(id)
    if (!state) {
      state = { prompt: '', answer: '', startedAt: 0 }
      sessions.set(id, state)
    }
    return state
  }

  function taskLabel(session, state) {
    if (state?.prompt) return clampText(state.prompt, config.maxLabelChars)
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd ? basename(cwd) : ''
  }

  function isSubagent(session) {
    return session?.header?.origin === 'subagent' || (session?.header?.delegationDepth ?? 0) > 0
  }

  /** Collapse identical completion/error banners fired in the same burst. */
  function throttled(kind) {
    if (config.minIntervalMs <= 0) return false
    const now = Date.now()
    const last = lastSentAt.get(kind) ?? 0
    if (now - last < config.minIntervalMs) return true
    lastSentAt.set(kind, now)
    return false
  }

  /** Fire-and-forget delivery with every failure contained and logged. */
  function deliver(payload, kind) {
    const task = (async () => {
      try {
        if (throttled(kind)) {
          log('throttled: ' + kind)
          return
        }
        if (config.suppressWhenFocused) {
          const name = await frontmost()
          if (name && name.toLowerCase() === config.appName.toLowerCase()) {
            log('suppressed: ' + name + ' is frontmost')
            return
          }
        }
        const backend = await sender.send(payload)
        log('sent via ' + backend + ': ' + payload.title + ' | ' + (payload.subtitle ?? '') + ' | ' + payload.body)
      } catch (error) {
        log('send failed: ' + (error && error.message ? error.message : String(error)))
      }
    })()
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  function notifyTurnEnd(session, state, data) {
    const reason = data?.reason ?? {}
    const duration = state.startedAt ? formatDuration(Date.now() - state.startedAt, config.locale) : ''
    const label = taskLabel(session, state)
    const answer = clampText(state.answer, config.maxBodyChars)
    state.startedAt = 0
    state.answer = ''

    // A subagent turn ends constantly while the task it serves is still
    // running; only the session the human is watching announces itself.
    if (isSubagent(session) && !config.includeSubagents) return

    switch (reason.kind) {
      case 'completed': {
        if (!config.notifyOnComplete) return
        const detail = [duration, answer].filter(Boolean).join(' · ')
        deliver({
          title: bannerTitle(config.appName, labels.complete),
          subtitle: label || undefined,
          body: clampText(detail || labels.noDetail, config.maxBodyChars),
          sound: config.completeSound,
          soundFile: config.completeSoundFile,
          group: 'dsh-complete',
        }, 'complete')
        return
      }
      case 'error': {
        if (!config.notifyOnError) return
        const message = clampText(describeError(reason.error), config.maxBodyChars)
        deliver({
          title: bannerTitle(config.appName, labels.error),
          subtitle: label || undefined,
          body: clampText(message || labels.noDetail, config.maxBodyChars),
          sound: config.errorSound,
          soundFile: config.errorSoundFile,
          group: 'dsh-error',
        }, 'error')
        return
      }
      case 'max-tokens': {
        if (!config.notifyOnError) return
        deliver({
          title: bannerTitle(config.appName, labels.maxTokens),
          subtitle: label || undefined,
          body: clampText(answer || labels.noDetail, config.maxBodyChars),
          sound: config.errorSound,
          soundFile: config.errorSoundFile,
          group: 'dsh-error',
        }, 'error')
        return
      }
      case 'blocked': {
        if (!config.notifyOnBlocked) return
        deliver({
          title: bannerTitle(config.appName, labels.blocked),
          subtitle: label || undefined,
          body: clampText(labels.noDetail, config.maxBodyChars),
          sound: config.completeSound,
          soundFile: config.completeSoundFile,
          group: 'dsh-blocked',
        }, 'blocked')
        return
      }
      // 'aborted' is the human cancelling, 'interrupted'/'forked' are
      // recovery markers: none of them deserve a banner.
      default:
        return
    }
  }

  function onSessionEvent(session, event) {
    if (!event || typeof event !== 'object') return
    const state = stateOf(session)
    switch (event.type) {
      case 'user/message': {
        // Only a real human prompt names the task; injected context (goal
        // rounds, file notices, late question replies) does not.
        const source = event.data?.source
        if (source && source.kind === 'user') state.prompt = messageText(event.data)
        return
      }
      case 'assistant/message': {
        const text = messageText(event.data?.message)
        if (text) state.answer = text
        return
      }
      case 'turn/start': {
        state.startedAt = Date.now()
        state.answer = ''
        return
      }
      case 'turn/end': {
        notifyTurnEnd(session, state, event.data)
        return
      }
      default:
        return
    }
  }

  function onApproval(request, next) {
    try {
      if (config.notifyOnApproval) {
        const session = request?.agent?.session
        const state = session ? stateOf(session) : undefined
        const tool = typeof request?.toolName === 'string' && request.toolName ? request.toolName : 'tool'
        const reason = localizedReason(request?.displayReason, config.locale) || request?.reason || ''
        const detail = reason ? tool + ' · ' + reason : tool
        const label = taskLabel(session, state)
        deliver({
          title: bannerTitle(config.appName, labels.approval),
          subtitle: label || undefined,
          body: clampText(detail, config.maxBodyChars),
          sound: config.approvalSound,
          soundFile: config.approvalSoundFile,
          group: 'dsh-approval',
        }, 'approval')
      }
    } catch (error) {
      log('approval hook failed: ' + (error && error.message ? error.message : String(error)))
    }
    return next()
  }

  function onQuestion(request, next) {
    try {
      if (config.notifyOnQuestion) {
        const questions = Array.isArray(request?.questions) ? request.questions : []
        const first = questions[0]
        const text = typeof first?.question === 'string' ? first.question : ''
        const options = Array.isArray(first?.options) ? first.options : []
        const isPlanReview = first?.intent?.kind === 'plan-review'
        // Options (or an approval-style intent) mean a decision is wanted, not
        // a free-text answer — say so in the bold line.
        const isChoice = !isPlanReview && (options.length > 0 || first?.intent?.kind === 'approval')
        const phrase = isPlanReview ? labels.planReview : (isChoice ? labels.choice : labels.question)
        const session = request?.agent?.session
        const label = taskLabel(session, session ? stateOf(session) : undefined)
        const suffix = questions.length > 1 ? labels.questionMany(questions.length) : ''
        const optionList = isChoice && options.length > 0
          ? labels.options(options.slice(0, 4).map((option) => (typeof option?.label === 'string' ? option.label : '')).filter(Boolean).join(' / '))
          : ''
        deliver({
          title: bannerTitle(config.appName, phrase),
          subtitle: label || undefined,
          body: clampText((text || label || labels.noDetail) + optionList + suffix, config.maxBodyChars),
          sound: config.questionSound,
          soundFile: config.questionSoundFile,
          group: 'dsh-question',
        }, 'question')
      }
    } catch (error) {
      log('question hook failed: ' + (error && error.message ? error.message : String(error)))
    }
    return next()
  }

  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session, event)
    } catch (error) {
      log('session hook failed: ' + (error && error.message ? error.message : String(error)))
    }
  }, { global: true })

  // prepend: the banner must go out before any interactive answerer waits.
  ctx.on('approval/request', onApproval, { global: true, prepend: true })
  ctx.on('user-questions/request', onQuestion, { global: true, prepend: true })
  ctx.on('session/disposed', (session) => {
    if (session?.id) sessions.delete(session.id)
  }, { global: true })

  // A tiny on-demand probe: useful when a user asks "did the notifier start?".
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      try {
        scope.tools.register({
          name: 'mac_notify_test',
          description: 'Send a test macOS notification through dsh-mac-notify and report which backend delivers it. Use when the user asks to verify or debug DSH notifications.',
          parameters: { type: 'object', properties: {} },
          output: {
            // Any JSON object: the probe reports backend information and config.
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          async execute() {
            const backend = await sender.send({
              title: bannerTitle(config.appName, labels.test),
              body: labels.testBody,
              sound: config.approvalSound,
              soundFile: config.approvalSoundFile,
              group: 'dsh-test',
            })
            return {
              ok: true,
              backend,
              info: await sender.describe(),
              config: {
                appName: config.appName,
                locale: config.locale,
                notifyOnComplete: config.notifyOnComplete,
                notifyOnError: config.notifyOnError,
                notifyOnApproval: config.notifyOnApproval,
                notifyOnQuestion: config.notifyOnQuestion,
                includeSubagents: config.includeSubagents,
                suppressWhenFocused: config.suppressWhenFocused,
              },
            }
          },
        })
      } catch (error) {
        log('tool registration failed: ' + (error && error.message ? error.message : String(error)))
      }
    })
  }

  log('mounted (backend=' + config.backend + ', locale=' + config.locale + ', pid=' + process.pid
    + ', electron=' + (process.versions.electron ?? 'no')
    + ', process.type=' + (process.type ?? 'n/a') + ')')
  return { flush: () => Promise.all([...pending]) }
}

// Small text helpers shared by the event router and the notification builder.

/**
 * Join the text blocks of a DSH message into one line of plain text.
 * Images, reasoning and tool blocks are skipped: a banner cannot show them.
 * @param {{ content?: readonly { type?: string, text?: string }[] }} message - a Session message event payload.
 * @returns {string} the concatenated text, or "" when the message carries none.
 */
export function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/**
 * Collapse whitespace (banners are single-line) and clamp to a character budget.
 * @param {unknown} value - raw text.
 * @param {number} max - maximum characters, including the ellipsis.
 * @returns {string} the display string.
 */
export function clampText(value, max) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Format an elapsed duration the way a human reads it.
 * @param {number} ms - elapsed milliseconds.
 * @param {'zh' | 'en'} locale - wording language.
 * @returns {string} e.g. "2分13秒" / "2m13s".
 */
export function formatDuration(ms, locale) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 1) return locale === 'en' ? '<1s' : '不到 1 秒'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (locale === 'en') {
    if (hours > 0) return `${hours}h${minutes ? `${minutes}m` : ''}`
    if (minutes > 0) return `${minutes}m${seconds ? `${seconds}s` : ''}`
    return `${seconds}s`
  }
  if (hours > 0) return `${hours}小时${minutes ? `${minutes}分` : ''}`
  if (minutes > 0) return `${minutes}分${seconds ? `${seconds}秒` : ''}`
  return `${seconds}秒`
}

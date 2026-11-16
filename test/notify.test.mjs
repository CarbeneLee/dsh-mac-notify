import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultHelperPath, expandHome, osascriptStatements } from '../dsh/notify.js'

test('expandHome only expands a leading ~/', () => {
  const home = process.env.HOME
  assert.equal(expandHome('~/Music/tone.caf'), home + '/Music/tone.caf')
  assert.equal(expandHome('/absolute/tone.caf'), '/absolute/tone.caf')
  assert.equal(expandHome('relative/tone.caf'), 'relative/tone.caf')
  assert.equal(expandHome(undefined), undefined)
})

test('defaultHelperPath points at the bundled helper app', () => {
  assert.match(defaultHelperPath(), /dsh-mac-notify\/DSHNotifier\.app\/Contents\/MacOS\/DSHNotifier$/)
})

test('osascript statements keep every value in argv', () => {
  const full = osascriptStatements({ hasSubtitle: true, hasSound: true })
  assert.deepEqual(full, ['-e', 'on run argv', '-e',
    'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name (item 4 of argv)',
    '-e', 'end run'])
  const minimal = osascriptStatements({ hasSubtitle: false, hasSound: false })
  assert.equal(minimal[3], 'display notification (item 1 of argv) with title (item 2 of argv)')
})

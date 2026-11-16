import test from 'node:test'
import assert from 'node:assert/strict'
import { clampText, formatDuration, messageText } from '../dsh/text.js'

test('messageText keeps text blocks only', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'hello' }, { type: 'image' }, { type: 'text', text: 'world' }] }), 'hello world')
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText(undefined), '')
})

test('clampText flattens whitespace and truncates with an ellipsis', () => {
  assert.equal(clampText('  a\n\tb  ', 20), 'a b')
  const clamped = clampText('x'.repeat(100), 10)
  assert.equal(clamped.length, 10)
  assert.ok(clamped.endsWith('…'))
})

test('formatDuration speaks both locales', () => {
  assert.equal(formatDuration(0, 'zh'), '不到 1 秒')
  assert.equal(formatDuration(133000, 'zh'), '2分13秒')
  assert.equal(formatDuration(133000, 'en'), '2m13s')
  assert.equal(formatDuration(3720000, 'zh'), '1小时2分')
})

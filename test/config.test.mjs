import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig } from '../dsh/config.js'

test('defaults apply to an empty config', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.appName, 'DeepSeek Harness')
  assert.equal(config.backend, 'auto')
  assert.equal(config.notifyOnApproval, true)
  assert.equal(config.completeSound, 'Glass')
  assert.ok(['zh', 'en'].includes(config.locale))
  assert.ok(Object.isFrozen(config))
})

test('known fields are coerced, unknown fields dropped', () => {
  const config = normalizeConfig({
    enabled: false,
    appName: 'My Harness',
    notifyOnComplete: 'yes',
    minIntervalMs: 999999,
    maxBodyChars: -5,
    backend: 'nonsense',
    futureField: 'ignored',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.appName, 'My Harness')
  assert.equal(config.notifyOnComplete, DEFAULTS.notifyOnComplete)
  assert.equal(config.minIntervalMs, 60000)
  assert.equal(config.maxBodyChars, 20)
  assert.equal(config.backend, 'auto')
  assert.equal('futureField' in config, false)
})

test('an explicit locale is honored', () => {
  assert.equal(normalizeConfig({ locale: 'en' }).locale, 'en')
  assert.equal(normalizeConfig({ locale: 'zh' }).locale, 'zh')
})

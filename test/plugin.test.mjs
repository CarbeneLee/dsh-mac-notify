import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dsh/index.js'

const BANNER_ZH = { complete: '✅ 任务完成', error: '❌ 任务失败', approval: '🔐 需要你的批准', question: '❓ 需要你的回答', planReview: '📋 计划等待你的确认' }

/** Minimal Cordis stand-in: records listeners, exposes emit(). */
function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(event, listener, options) {
      handlers.set(event, { listener, options })
      return () => handlers.delete(event)
    },
    inject() {},
    emit(event, ...args) {
      const entry = handlers.get(event)
      assert.ok(entry, 'no listener registered for ' + event)
      return entry.listener(...args)
    },
  }
}

function fakeSender() {
  const sent = []
  return {
    sent,
    async send(payload) {
      sent.push(payload)
      return 'fake'
    },
    async describe() {
      return { platform: 'darwin', backend: 'fake', electron: false, terminalNotifier: false }
    },
  }
}

function makeSession(id = 's1', header = {}) {
  return { id, header: { cwd: '/tmp/project', delegationDepth: 0, ...header } }
}

function mount(overrides = {}, deps = {}) {
  const ctx = fakeCtx()
  const sender = fakeSender()
  const handle = apply(ctx, { locale: 'zh', ...overrides }, { sender, frontmost: async () => 'Safari', ...deps })
  return { ctx, sender, handle }
}

function prompt(session, text) {
  return { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function answer(session, text) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function endTurn(session, reason) {
  return { type: 'turn/end', data: { turn: 1, reason } }
}

test('completion banner names the task and the answer', async () => {
  const { ctx, sender, handle } = mount()
  const session = makeSession()
  ctx.emit('session/event', session, prompt(session, '修复登录页样式'))
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', session, answer(session, '已修复三处样式，刷新页面验证。'))
  ctx.emit('session/event', session, endTurn(session, { kind: 'completed' }))
  await handle.flush()

  assert.equal(sender.sent.length, 1)
  const [banner] = sender.sent
  assert.equal(banner.title, 'DeepSeek Harness')
  assert.ok(banner.subtitle.startsWith(BANNER_ZH.complete), banner.subtitle)
  assert.match(banner.body, /修复登录页样式/)
  assert.match(banner.body, /已修复三处样式/)
  assert.equal(banner.sound, 'Glass')
})

test('failed turn reports the error message', async () => {
  const { ctx, sender, handle } = mount()
  const session = makeSession()
  ctx.emit('session/event', session, prompt(session, '跑一遍测试'))
  ctx.emit('session/event', session, endTurn(session, { kind: 'error', error: { message: 'HTTP 429 Too Many Requests' } }))
  await handle.flush()

  assert.equal(sender.sent.length, 1)
  assert.equal(sender.sent[0].subtitle, BANNER_ZH.error)
  assert.match(sender.sent[0].body, /HTTP 429/)
  assert.equal(sender.sent[0].sound, 'Basso')
})

test('subagent turns stay silent unless opted in', async () => {
  const { ctx, sender, handle } = mount()
  const child = makeSession('child', { origin: 'subagent', delegationDepth: 1 })
  ctx.emit('session/event', child, endTurn(child, { kind: 'completed' }))
  await handle.flush()
  assert.equal(sender.sent.length, 0)

  const opted = mount({ includeSubagents: true })
  const child2 = makeSession('child2', { origin: 'subagent', delegationDepth: 1 })
  opted.ctx.emit('session/event', child2, endTurn(child2, { kind: 'completed' }))
  await opted.handle.flush()
  assert.equal(opted.sender.sent.length, 1)
})

test('a cancelled turn does not notify', async () => {
  const { ctx, sender, handle } = mount()
  const session = makeSession()
  ctx.emit('session/event', session, endTurn(session, { kind: 'aborted', reason: 'user' }))
  await handle.flush()
  assert.equal(sender.sent.length, 0)
})

test('approval requests notify and still delegate', async () => {
  const { ctx, sender, handle } = mount()
  const session = makeSession()
  let delegated = 0
  const outcome = await ctx.emit('approval/request', {
    agent: { session },
    toolName: 'bash',
    reason: '需要访问工作区外的文件',
  }, async () => {
    delegated += 1
    return 'allowed-once'
  })
  await handle.flush()

  assert.equal(outcome, 'allowed-once')
  assert.equal(delegated, 1)
  assert.equal(sender.sent.length, 1)
  assert.equal(sender.sent[0].subtitle, BANNER_ZH.approval)
  assert.match(sender.sent[0].body, /bash/)
  assert.match(sender.sent[0].body, /工作区外/)
})

test('localized display reasons are preferred', async () => {
  const { ctx, sender, handle } = mount()
  const session = makeSession()
  await ctx.emit('approval/request', {
    agent: { session },
    toolName: 'write',
    reason: 'raw-reason',
    displayReason: { en: 'Write outside workspace', zh: '写入工作区之外' },
  }, async () => 'rejected')
  await handle.flush()
  assert.match(sender.sent[0].body, /写入工作区之外/)
})

test('questions notify with the question text and count', async () => {
  const { ctx, sender, handle } = mount()
  const session = makeSession()
  await ctx.emit('user-questions/request', {
    agent: { session },
    questions: [
      { id: 'q1', question: '要部署到哪个环境？' },
      { id: 'q2', question: '要不要顺带升级依赖？' },
    ],
  }, async () => ({ answers: [] }))
  await handle.flush()

  assert.equal(sender.sent.length, 1)
  assert.equal(sender.sent[0].subtitle, BANNER_ZH.question)
  assert.match(sender.sent[0].body, /要部署到哪个环境/)
  assert.match(sender.sent[0].body, /共 2 个问题/)
})

test('plan review gets its own label', async () => {
  const { ctx, sender, handle } = mount()
  const session = makeSession()
  await ctx.emit('user-questions/request', {
    agent: { session },
    questions: [{ id: 'plan', question: '批准这个计划吗？', intent: { kind: 'plan-review', approve: '批准' } }],
  }, async () => ({ answers: [] }))
  await handle.flush()
  assert.equal(sender.sent[0].subtitle, BANNER_ZH.planReview)
})

test('disabled config registers no listeners', () => {
  const { ctx } = mount({ enabled: false })
  assert.equal(ctx.handlers.size, 0)
})

test('identical completions inside the throttle window collapse', async () => {
  const { ctx, sender, handle } = mount({ minIntervalMs: 10000 })
  const session = makeSession()
  ctx.emit('session/event', session, endTurn(session, { kind: 'completed' }))
  ctx.emit('session/event', session, endTurn(session, { kind: 'completed' }))
  await handle.flush()
  assert.equal(sender.sent.length, 1)
})

test('suppressWhenFocused skips while the app is frontmost', async () => {
  const { ctx, sender, handle } = mount({ suppressWhenFocused: true }, { frontmost: async () => 'DeepSeek Harness' })
  const session = makeSession()
  ctx.emit('session/event', session, endTurn(session, { kind: 'completed' }))
  await handle.flush()
  assert.equal(sender.sent.length, 0)

  const other = mount({ suppressWhenFocused: true }, { frontmost: async () => 'Safari' })
  other.ctx.emit('session/event', makeSession(), endTurn(makeSession(), { kind: 'completed' }))
  await other.handle.flush()
  assert.equal(other.sender.sent.length, 1)
})

test('a throwing sender never breaks the approval chain', async () => {
  const ctx = fakeCtx()
  let delegated = 0
  apply(ctx, { locale: 'zh' }, {
    sender: { send: async () => { throw new Error('boom') }, describe: async () => ({}) },
  })
  const outcome = await ctx.emit('approval/request', { agent: { session: makeSession() }, toolName: 'bash' }, async () => {
    delegated += 1
    return 'allowed-once'
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(outcome, 'allowed-once')
  assert.equal(delegated, 1)
})

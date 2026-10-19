import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let failures = 0
async function test(name, run) {
  try { await run(); console.log(`ok   client: ${name}`) }
  catch (error) { failures++; console.error(`FAIL client: ${name}\n${error.stack}`) }
}

// React and the Harness slot boundary are external. Keep the shipped component,
// its effects, HTTP requests, cache and native-renderer props under test.
function loadClient(nativeChanges = {}) {
  const registrations = []
  const calls = []
  const timers = new Map()
  let now = Date.now()
  let nextTimer = 0
  let active
  const native = {
    component: function NativeAssistant() {},
    options: { key: 'assistant-step', priority: 0 },
    locale: 'chat', registrant: '@deepseek-ai/dsh-client-ui-chat',
    children: { 'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' } },
    inject: () => ({ hooks: { presentation: {} } }),
    ...nativeChanges,
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children } : {}) } }),
    useState(value) {
      const mount = active
      const hook = mount.hooks[mount.cursor++] ??= { value: typeof value === 'function' ? value() : value }
      return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next; mount.dirty = true }]
    },
    useRef(value) { return active.hooks[active.cursor++] ??= { current: value } },
    useEffect(fn, deps) {
      const mount = active
      const index = mount.cursor++
      const previous = mount.hooks[index]
      if (previous && deps && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return
      mount.effects.push(() => { previous?.cleanup?.(); mount.hooks[index] = { deps, cleanup: fn() } })
    },
    useMemo: (fn) => fn(), useCallback: (fn) => fn,
    Fragment: Symbol('Fragment'),
  }
  let bundle
  const locale = { language: 'zh-CN' }
  const fakeFetch = async (url, options) => {
    const request = JSON.parse(options.body)
    calls.push({ url, request })
    const payload = await api.reply(request)
    return { ok: payload.ok !== false, status: payload.ok === false ? 502 : 200, json: async () => payload }
  }
  const run = new Function('window', 'navigator', 'fetch', 'setTimeout', 'clearTimeout', 'Date', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  run({ __ModuleLoader__: { load: (value) => { bundle = value } } }, locale, fakeFetch,
    (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id },
    (id) => timers.delete(id), class extends Date { static now() { return now } })
  const plugin = bundle.factory((id) => { assert.equal(id, 'react'); return React })
  plugin.apply({
    uiConversation: { events: { register: () => () => {} } },
    slots: {
      entries: () => [native, ...registrations],
      inject: (_key, fn) => fn(),
      register: (options, component) => {
        registrations.push({ component, options, locale: options.locale, registrant: options.registrant, children: options.children, inject: options.inject })
        return () => {}
      },
      subscribe: () => () => {},
    },
    sessions: { binding: () => ({ session: { eventSource: {} } }) },
    effect: (fn) => fn(), logger: { warn() {} },
  })
  const api = {
    calls, registrations, native, locale,
    nativeView: (mount) => mount.output?.type === React.Fragment ? mount.output.props.children[0] : mount.output,
    card: (mount) => mount.output?.type === React.Fragment ? mount.output.props.children[1] : null,
    reply: async () => ({ ok: true, title: '检查加载链路', summary: '我会先检查加载链路，再确定摘要的展示位置。' }),
    mount(props = fixture(now), component) {
      const registration = registrations.find((entry) => (entry.options?.key ?? entry.key) === 'assistant-step')
      assert.ok(registration, 'the plugin must decorate the native assistant-step renderer')
      const mount = { hooks: [], effects: [], cursor: 0, dirty: true, props, output: null }
      mount.render = () => {
        do {
          mount.dirty = false; mount.cursor = 0; active = mount
          mount.output = (component ?? registration.component)(mount.props)
          for (const effect of mount.effects.splice(0)) effect()
        } while (mount.dirty)
        return mount.output
      }
      mount.update = (next) => { mount.props = next; return mount.render() }
      mount.unmount = () => { for (const hook of mount.hooks) hook?.cleanup?.() }
      mount.render()
      return mount
    },
    async advance(ms, mounts = []) {
      now += ms
      for (let pass = 0; pass < 30; pass++) {
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
        await Promise.resolve()
        for (const mount of mounts) if (mount.dirty) mount.render()
      }
    },
  }
  return api
}

function fixture(now = Date.now(), changes = {}) {
  const reasoning = '检查当前项目的插件加载链路和前端扩展点。'.repeat(12)
  return {
    sessionId: 's1',
    node: { key: 'assistant:1:1', anchorSeq: 5, location: { kind: 'step', turn: { status: 'open' } },
      data: { turn: 1, step: 1, time: now, status: 'running', blocks: [{ kind: 'reasoning', text: reasoning }, { kind: 'text', text: '回答正文' }] } },
    useThinkingSummaryEvents: (select) => select({ entries: [
      { event: { type: 'request/header', seq: 2, data: { header: { config: { provider: 'p', model: 'm' } } } } },
    ] }),
    renderSlot: (name, props) => ({ name, props }),
    renderFactorySlot: (name, props) => ({ name, props }),
    ...changes,
  }
}

await test('keeps the native renderer, answer blocks and disclosure contract', () => {
  const api = loadClient()
  const props = fixture()
  const original = JSON.stringify(props.node)
  const mount = api.mount(props)
  assert.equal(api.nativeView(mount).type, api.native.component)
  assert.equal(api.nativeView(mount).props.node.data.blocks[1], props.node.data.blocks[1])
  assert.equal(JSON.stringify(props.node), original, 'display projection must never mutate session data')
  const assistantRegistrations = api.registrations.filter((entry) => (entry.options?.key ?? entry.key) === 'assistant-step')
  assert.equal(assistantRegistrations.length, 1, 'no extra transcript row beneath the final answer')
  assert.equal(assistantRegistrations[0].options.key, 'assistant-step')
  assert.equal(assistantRegistrations[0].children, undefined, 'the native entry already declares the child slots')
  assert.ok(api.registrations.some((entry) => entry.options?.name === 'plugins.bundle.config' && entry.options?.key === 'dsh-thinking-summary'), 'the settings form is registered on the installed bundle page')
  const image = api.nativeView(mount).props.renderSlot('conversation.chat.message.images', { images: ['image'] })
  assert.equal(image.name, 'conversation.chat.message.images')
  mount.unmount()
})

await test('also decorates loaders that give the native registration an inherited name', () => {
  const api = loadClient({ registrant: 'ui-chat' })
  const mount = api.mount()
  assert.equal(api.nativeView(mount).type, api.native.component)
  mount.unmount()
})

await test('generates during a running step and replaces raw preview with a short title', async () => {
  const api = loadClient()
  const mount = api.mount()
  assert.doesNotMatch(api.nativeView(mount).props.node.data.blocks[0].text, /检查当前项目/)
  await api.advance(1500, [mount])
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].request.provider, 'p')
  assert.match(api.nativeView(mount).props.node.data.blocks[0].text, /^\*\*检查加载链路\*\*/)
  assert.ok(api.nativeView(mount).props.node.data.blocks.some((block) => block.kind === 'text' && block.text.includes('**思考摘要**') && block.text.includes('我会先检查加载链路')), 'the summary must also be a visible intermediate paragraph')
  const card = api.card(mount)
  assert.ok(card !== null && card !== undefined, 'the summary card must be rendered beside the reasoning row')
  assert.equal(card.props['data-plugin'], 'dsh-thinking-summary')
  const body = api.nativeView(mount).props.renderSlot('conversation.chat.reasoning.body', { text: 'display', running: true })
  assert.equal(typeof body.type, 'function', 'expanded body must offer the original reasoning')
  mount.unmount()
})

await test('expanded summary can switch to the exact original body and back', async () => {
  const api = loadClient()
  const props = fixture()
  const mount = api.mount(props)
  await api.advance(1500, [mount])
  const bodyElement = api.nativeView(mount).props.renderSlot('conversation.chat.reasoning.body', {})
  const body = api.mount(bodyElement.props, bodyElement.type)
  assert.equal(body.output.props.children[0].name, 'conversation.chat.reasoning.content')
  body.output.props.children[1].props.children[0].props.onClick()
  body.render()
  assert.equal(body.output.props.children[0].name, 'conversation.chat.reasoning.body')
  assert.equal(body.output.props.children[0].props.text, props.node.data.blocks[0].text)
  assert.equal(body.output.props.children[0].props.running, true)
  body.output.props.children[1].props.children[0].props.onClick()
  body.render()
  assert.equal(body.output.props.children[0].props.text, '我会先检查加载链路，再确定摘要的展示位置。')
  body.unmount(); mount.unmount()
})

await test('split native outlets share an in-flight request and survive one unmount', async () => {
  const api = loadClient()
  let finish
  api.reply = () => new Promise((resolve) => { finish = resolve })
  const first = api.mount()
  const second = api.mount()
  await api.advance(1500, [first, second])
  assert.equal(api.calls.length, 1)
  first.unmount()
  finish({ ok: true, title: '共享摘要', summary: '检查当前步骤。' })
  await api.advance(0, [second])
  assert.match(api.nativeView(second).props.node.data.blocks[0].text, /共享摘要/)
  second.unmount()
})

await test('visible historical steps backfill automatically', async () => {
  const api = loadClient()
  const props = fixture()
  props.node.data.status = 'settled'; props.node.data.time = Date.now() - 60000
  props.node.location.turn.status = 'closed'
  const mount = api.mount(props)
  await api.advance(1500, [mount])
  assert.equal(api.calls.length, 1)
  assert.match(api.nativeView(mount).props.node.data.blocks[0].text, /检查加载链路/)
  mount.unmount()
})

await test('a failed live summary still allows one final snapshot attempt', async () => {
  const api = loadClient()
  api.reply = async () => api.calls.length === 1
    ? { ok: false, error: 'temporary provider failure' }
    : { ok: true, title: '最终阶段', summary: '我会继续核对最终结果。' }
  const mount = api.mount()
  await api.advance(1500, [mount])
  const props = fixture()
  props.node.data.blocks[0].text += 'x'.repeat(1000)
  props.node.data.status = 'settled'
  mount.update(props)
  await api.advance(1500, [mount])
  assert.equal(api.calls.length, 2)
  assert.equal(api.calls[1].request.text, props.node.data.blocks[0].text)
  assert.match(api.nativeView(mount).props.node.data.blocks[0].text, /最终阶段/)
  mount.unmount()
})

await test('a failed final attempt never creates an automatic retry loop', async () => {
  const api = loadClient()
  api.reply = async () => ({ ok: false, error: 'provider unavailable' })
  const mount = api.mount()
  await api.advance(1500, [mount])
  const props = fixture()
  props.node.data.status = 'settled'
  mount.update(props)
  await api.advance(1500, [mount])
  await api.advance(30000, [mount])
  assert.equal(api.calls.length, 2)
  mount.unmount()
})

await test('identical thinking on different models or locales has separate results', async () => {
  const api = loadClient()
  const first = api.mount()
  await api.advance(1500, [first]); first.unmount()
  const props = fixture()
  props.useThinkingSummaryEvents = (select) => select({ entries: [
    { event: { type: 'request/header', seq: 2, data: { header: { config: { provider: 'p', model: 'other' } } } } },
  ] })
  const second = api.mount(props)
  await api.advance(1500, [second]); second.unmount()
  api.locale.language = 'en-US'
  const third = api.mount(props)
  await api.advance(1500, [third]); third.unmount()
  assert.equal(api.calls.length, 3)
  assert.equal(api.calls[1].request.model, 'other')
  assert.equal(api.calls[2].request.locale, 'en-US')
})

await test('ignores an obsolete response after a retry replaces the reasoning', async () => {
  const api = loadClient()
  let finish
  api.reply = () => new Promise((resolve) => { finish = resolve })
  const mount = api.mount()
  await api.advance(1500, [mount])
  const props = fixture()
  props.node.data.blocks[0].text = '重新检查另一个问题。'.repeat(40)
  mount.update(props)
  finish({ ok: true, title: '过期标题', summary: '不应显示过期结果。' })
  await api.advance(0, [mount])
  assert.doesNotMatch(api.nativeView(mount).props.node.data.blocks[0].text, /过期/)
  mount.unmount()
})

await test('streaming updates are throttled and the final snapshot is summarized', async () => {
  const api = loadClient()
  const mount = api.mount()
  await api.advance(1500, [mount])
  const props = fixture()
  props.node.data.blocks[0].text += 'x'.repeat(1000)
  mount.update(props)
  await api.advance(1000, [mount])
  assert.equal(api.calls.length, 1)
  props.node = { ...props.node, data: { ...props.node.data, status: 'settled' } }
  mount.update(props)
  await api.advance(1500, [mount])
  assert.equal(api.calls.length, 2)
  assert.equal(api.calls[1].request.text, props.node.data.blocks[0].text)
  mount.unmount()
})

if (failures) process.exitCode = 1

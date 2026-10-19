/**
 * Dependency-free smoke tests for both halves of dsh-thinking-summary.
 *
 * Run with: node tests/smoke.mjs
 *
 * The host half is exercised through its real HTTP handler with a fake
 * `ctx.llm`; the browser half is loaded through a fake ModuleLoader so the
 * shipped `lib/client.js` is evaluated exactly as the shell would evaluate it.
 */

import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Model fixtures must never load or write the user's real summary cache.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-summary-test-'))
let failures = 0

/**
 * Run one named test.
 * @param {string} label - test name.
 * @param {() => Promise<void> | void} body - assertions.
 * @returns {Promise<void>} completion.
 */
async function test(label, body) {
  try {
    await body()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label}\n     ${error?.stack ?? error}`)
  }
}

//#region host half ---------------------------------------------------------------

/**
 * Build a fake `ctx.llm` that reports the requests it received.
 * @param {{text?: string, chunks?: object[], throwOn?: string}} options - behavior.
 * @returns {{llm: object, calls: object[]}} fake service and call log.
 */
function fakeLlm(options = {}) {
  const calls = []
  const llm = {
    stream(request, ...rest) {
      calls.push({ request, rest })
      if (options.throwOn !== undefined) throw Object.assign(new Error(options.throwOn), { code: options.throwOn })
      const chunks = options.chunks ?? [
        { type: 'text-delta', text: options.text ?? '先定位插件机制，再决定摘要放在哪里。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* iterate() {
        for (const chunk of chunks) yield chunk
      })()
    },
    listProviders() {
      return options.providers ?? [{ id: 'p', name: 'Provider' }]
    },
    async listModels(provider) {
      return options.models ?? [{ provider, id: 'm', name: 'Model' }]
    },
  }
  return { llm, calls }
}

/**
 * Build a fake host context that captures the registered route.
 * @param {object} llm - fake LLM service.
 * @returns {{ctx: object, route: () => object | undefined}} fake context and route reader.
 */
function fakeHostContext(llm) {
  let registered
  const ctx = {
    llm,
    logger: { error() {}, warn() {}, info() {} },
    get(service) {
      if (service === 'webServer') {
        return {
          register(route) {
            registered = route
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
  }
  return { ctx, route: () => registered }
}

/**
 * Call the captured route handler with a JSON body.
 * @param {object} handler - route handler.
 * @param {string} method - HTTP method.
 * @param {string} path - request path.
 * @param {unknown} body - JSON body, omitted for GET.
 * @returns {Promise<{status: number, body: any}>} response.
 */
async function call(handler, method, path, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload)
  req.method = method
  req.url = path
  req.headers = { 'content-type': 'application/json' }
  let status = 0
  let text = ''
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(nextStatus) {
      status = nextStatus
      this.headersSent = true
    },
    end(chunk) {
      text = chunk ?? ''
      this.writableEnded = true
    },
    on() {},
    once() {},
  }
  await handler(req, res)
  return { status, body: text === '' ? undefined : JSON.parse(text) }
}

const host = await import(new URL('../lib/index.js', import.meta.url))

await test('host: module exports the Cordis plugin surface', () => {
  assert.equal(host.name, 'dsh-thinking-summary')
  assert.deepEqual(host.inject, ['llm'])
  assert.equal(typeof host.apply, 'function')
})

await test('host: health route answers without a model call', async () => {
  const { llm, calls } = fakeLlm()
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, {})
  const handler = route().handler
  assert.equal(route().kind, 'prefix')
  const response = await call(handler, 'GET', '/dsh-thinking-summary/health')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(calls.length, 0)
})

await test('host: rejects a body without text', async () => {
  const { llm } = fakeLlm()
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, {})
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', { provider: 'p', model: 'm' })
  assert.equal(response.status, 400)
  assert.match(response.body.error, /text/u)
})

await test('host: skips a trace below the configured threshold', async () => {
  const { llm, calls } = fakeLlm()
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 120 })
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', { text: 'short trace' })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.skipped, 'too-short')
  assert.equal(calls.length, 0)
})

await test('host: summarizes through the requested route and caches by content', async () => {
  const { llm, calls } = fakeLlm({ text: '**摘要**\n先确认插件机制，再把摘要放在回答之后。' })
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40 })
  const handler = route().handler
  const trace = `先把插件的加载链路查清楚。${'x'.repeat(200)}`
  const first = await call(handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: trace,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    locale: 'zh-CN',
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.cached, undefined)
  assert.match(first.body.summary, /插件机制/u)

  const request = calls[0].request
  assert.equal(request.provider, 'deepseek-account')
  assert.equal(request.model, 'deepseek-flash')
  assert.equal(request.reasoningEffort, 'off')
  assert.match(request.system, /zh-CN/u)
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].role, 'user')
  assert.match(request.messages[0].content[0].text, /reasoning/u)

  const second = await call(handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: trace,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    locale: 'zh-CN',
  })
  assert.equal(second.body.cached, true)
  assert.equal(calls.length, 1, 'the second call must be served from the cache')
})

await test('host: forces Simplified Chinese even when the browser is English', async () => {
  const { llm, calls } = fakeLlm({ text: '**检查插件**\n先确认加载链路，再查看摘要结果。' })
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40, language: 'zh-CN' })
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: `先检查插件。${'x'.repeat(200)}`,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    locale: 'en-US',
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.language, 'zh-CN')
  assert.match(calls[0].request.system, /Simplified Chinese/u)
  assert.match(calls[0].request.system, /zh-CN/u)
})

await test('host: retries once when the provider rejects reasoning effort "off"', async () => {
  const calls = []
  const llm = {
    stream(request) {
      calls.push(request)
      if (calls.length === 1) {
        return (async function* iterate() {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'nope' } } }
        })()
      }
      return (async function* iterate() {
        yield { type: 'text-delta', text: '降级后的摘要。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40 })
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: 'y'.repeat(200),
    provider: 'gpt',
    model: 'gpt-5.6',
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.summary, '降级后的摘要。')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].reasoningEffort, undefined)
})

await test('host: returns a clean short title and body from structured model output', async () => {
  const { llm } = fakeLlm({ text: '```json\n{"title":"**检查加载链路**","summary":"我会先检查加载链路，再确认可用的前端扩展点。"}\n```' })
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40, cacheSize: 0 })
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: '检查前端事件和插件扩展点。'.repeat(20), provider: 'p', model: 'm', locale: 'zh-CN',
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.title, '检查加载链路')
  assert.equal(response.body.summary, '我会先检查加载链路，再确认可用的前端扩展点。')
  assert.doesNotMatch(response.body.summary, /```|"title"/)
})

await test('host: accepts legacy plain text without leaking a markdown heading into the title', async () => {
  const { llm } = fakeLlm({ text: '**检查路由**\n\n我会核对当前步骤使用的模型。' })
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40, cacheSize: 0 })
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: '核对请求路由。'.repeat(30), provider: 'p', model: 'm',
  })
  assert.equal(response.body.title, '检查路由')
  assert.equal(response.body.summary, '我会核对当前步骤使用的模型。')
})

await test('host: reports a provider failure as a retryable 502', async () => {
  const { llm } = fakeLlm({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }],
  })
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40 })
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: 'z'.repeat(200),
    provider: 'p',
    model: 'm',
  })
  assert.equal(response.status, 502)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.code, 'RATE_LIMIT')
})

await test('host: bounds paid generations with a rolling rate limit', async () => {
  const { llm } = fakeLlm({ text: '一段摘要。' })
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40, cacheSize: 0 })
  const handler = route().handler
  let limited = 0
  for (let index = 0; index < 22; index += 1) {
    const response = await call(handler, 'POST', '/dsh-thinking-summary/summarize', {
      text: `${'w'.repeat(200)} #${index}`,
      provider: 'p',
      model: 'm',
    })
    if (response.status === 429) limited += 1
  }
  assert.equal(limited, 2, 'the 21st and 22nd generations within a minute must be refused')
})

await test('host: rejects a half-configured route at boot', () => {
  const { llm } = fakeLlm()
  const { ctx } = fakeHostContext(llm)
  assert.throws(() => host.apply(ctx, { provider: 'only-provider' }), /provider and model/u)
})

await test('host: inert without a Web server (headless composition)', () => {
  const { llm } = fakeLlm()
  let registered
  const ctx = {
    llm,
    logger: { error() {} },
    get: () => undefined,
    effect(fn) {
      registered = fn()
      return () => {}
    },
  }
  host.apply(ctx, {})
  assert.equal(registered, undefined)
})

await test('host: mounts routes when the Web service becomes ready after plugin startup', () => {
  let activate
  let registered
  host.apply({
    llm: fakeLlm().llm,
    get: () => undefined,
    inject(dependencies, callback) { activate = callback },
    effect: (fn) => fn(),
  }, {})
  assert.equal(typeof activate, 'function')
  activate({ webServer: { register: (route) => { registered = route; return () => {} } }, effect: (fn) => fn() })
  assert.equal(registered.path, '/dsh-thinking-summary')
})

await test('host: grounds the summary in user, tool and answer context', async () => {
  const { llm, calls } = fakeLlm()
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40 })
  const response = await call(route().handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: `先检查上下文。${'x'.repeat(200)}`,
    provider: 'p',
    model: 'm',
    context: {
      user: '把摘要改成中文',
      tools: [{ name: 'pwsh', arguments: 'Get-ChildItem', result: 'ok' }],
      answer: '已修改',
    },
  })
  assert.equal(response.status, 200)
  const prompt = calls[0].request.messages[0].content[0].text
  assert.match(prompt, /把摘要改成中文/u)
  assert.match(prompt, /Get-ChildItem/u)
  assert.match(prompt, /已修改/u)
})

await test('host: runtime settings override the request route and language', async () => {
  const { llm, calls } = fakeLlm()
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40 })
  const handler = route().handler
  await call(handler, 'POST', '/dsh-thinking-summary/settings', {
    provider: 'p2',
    model: 'm2',
    language: 'zh',
  })
  const response = await call(handler, 'POST', '/dsh-thinking-summary/summarize', {
    text: 'y'.repeat(200),
    provider: 'p',
    model: 'm',
    locale: 'en-US',
  })
  assert.equal(response.status, 200)
  assert.equal(calls[0].request.provider, 'p2')
  assert.equal(calls[0].request.model, 'm2')
  assert.match(calls[0].request.system, /Simplified Chinese/u)
  await call(handler, 'POST', '/dsh-thinking-summary/settings', { provider: '', model: '', language: 'auto' })
})

await test('host: settings route persists the selected model and language', async () => {
  const { llm } = fakeLlm()
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, { minReasoningChars: 40 })
  const handler = route().handler
  const initial = await call(handler, 'GET', '/dsh-thinking-summary/settings')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.provider, '')
  assert.equal(initial.body.language, 'auto')
  const saved = await call(handler, 'POST', '/dsh-thinking-summary/settings', {
    provider: 'p',
    model: 'm',
    language: 'zh',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.provider, 'p')
  assert.equal(saved.body.model, 'm')
  assert.equal(saved.body.language, 'zh')
  const after = await call(handler, 'GET', '/dsh-thinking-summary/settings')
  assert.equal(after.body.provider, 'p')
  assert.equal(after.body.language, 'zh')
})

await test('host: model catalog exposes provider groups', async () => {
  const { llm } = fakeLlm()
  const { ctx, route } = fakeHostContext(llm)
  host.apply(ctx, {})
  const response = await call(route().handler, 'GET', '/dsh-thinking-summary/models')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.deepEqual(response.body.providers, [
    { id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] },
  ])
})

//#endregion

await import('./frontend.mjs')

console.log(failures === 0 ? '\nall host smoke tests passed' : `\n${failures} host smoke test(s) failed`)
process.exitCode = failures === 0 ? process.exitCode ?? 0 : 1

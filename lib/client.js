/**
 * Per-step reasoning presentation. Decorate the native assistant slot instead
 * of adding transcript rows or changing model-visible events. Only React is
 * imported; all Harness services arrive through the plugin context.
 */
window.__ModuleLoader__.load({
  id: 'dsh-thinking-summary',
  factory: (require) => {
    const React = require('react')
    const NAME = 'dsh-thinking-summary'
    const SLOT = 'conversation.chat.node'
    const results = new Map()
    const inflight = new Map()
    const waiting = []
    let nextSequence = 0
    let draining = false
    let lastFetchAt = 0
    // Historical rows backfill in the background. One request every few
    // seconds stays under the host's rolling rate limit (20 per minute).
    const HISTORY_PACE_MS = 3500
    const RATE_LIMIT_RETRY_MS = 65000

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function addressOf(request) {
      return JSON.stringify([request.provider, request.model, request.locale, request.text, request.context ?? null])
    }

    async function fetchSummary(request) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 130000)
        try {
          const response = await fetch('/dsh-thinking-summary/summarize', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request), signal: controller.signal,
          })
          const payload = await response.json()
          if (response.status === 429 && attempt < 2) {
            await sleep(RATE_LIMIT_RETRY_MS)
            continue
          }
          if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
          return { ...payload, status: payload.skipped ? 'skipped' : 'ok' }
        } finally { clearTimeout(timer) }
      }
      throw new Error('summary rate limit reached')
    }

    function nextJob() {
      let selected = 0
      for (let index = 1; index < waiting.length; index += 1) {
        const candidate = waiting[index]
        const current = waiting[selected]
        const newer = candidate.priority === current.priority && candidate.sequence > current.sequence
        if (candidate.priority > current.priority || newer) selected = index
      }
      return waiting.splice(selected, 1)[0]
    }

    /**
     * Serialize auxiliary calls across steps and split reasoning/response
     * outlets. Live and manual calls jump ahead of the historical backfill;
     * within one priority the most recently mounted row runs first.
     */
    async function drain() {
      if (draining) return
      draining = true
      try {
        while (waiting.length > 0) {
          const job = nextJob()
          if (results.has(job.address)) { job.resolve(results.get(job.address)); continue }
          if (job.pace) {
            const wait = Math.max(0, lastFetchAt + HISTORY_PACE_MS - Date.now())
            if (wait > 0) await sleep(wait)
          }
          lastFetchAt = Date.now()
          try {
            const result = await fetchSummary(job.request)
            results.set(job.address, result)
            while (results.size > 240) results.delete(results.keys().next().value)
            job.resolve(result)
          } catch (error) {
            job.reject(error)
          }
        }
      } finally { draining = false }
    }

    function requestSummary(request, priority = 1, pace = false) {
      const address = addressOf(request)
      if (results.has(address)) return Promise.resolve(results.get(address))
      if (inflight.has(address)) return inflight.get(address)
      const task = new Promise((resolve, reject) => {
        waiting.push({ request, address, priority, pace, sequence: nextSequence += 1, resolve, reject })
      })
      inflight.set(address, task)
      task.then(() => inflight.delete(address), () => inflight.delete(address))
      void drain()
      return task
    }

    /** Read the route in force at this step, never another session's route. */
    function routeOf(entries, node) {
      let route = { provider: '', model: '' }
      const boundary = node.data.finalNode?.seq ?? node.anchorSeq
      for (const record of entries) {
        // The session event source publishes log records (`{ event }`); an
        // event-shaped fixture is accepted too so the projection stays
        // testable without a live session controller.
        const event = record?.event ?? record
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'request/header' && event.seq <= boundary) {
          const config = event.data?.header?.config
          if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
            route = { provider: config.provider, model: config.model }
          }
        }
        if (event.type === 'assistant/message' && event.data?.turn === node.data.turn && event.data?.step === node.data.step) {
          const source = event.data.message?.source
          if (typeof source?.provider === 'string' && typeof source?.model === 'string') {
            return { provider: source.provider, model: source.model }
          }
        }
      }
      return route
    }

    function clipText(value, limit) {
      const text = typeof value === 'string' ? value.trim() : ''
      return text.length <= limit ? text : `${text.slice(0, limit)}…`
    }

    function messageText(content) {
      if (!Array.isArray(content)) return ''
      return content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()
    }

    /**
     * Collect the user request, tool activity and visible answer for one step.
     * Codex summaries describe the work, not just the private trace.
     */
    function contextOf(entries, node) {
      const boundary = node.data.finalNode?.seq ?? node.anchorSeq
      let user = ''
      const results = []
      for (const record of entries) {
        const event = record?.event ?? record
        if (event === null || typeof event !== 'object') continue
        if (event.seq > boundary) continue
        if (event.type === 'user/message') {
          const text = messageText(event.data?.message?.content)
          if (text !== '') user = text
        }
        if (event.type === 'tool/result' && event.data?.turn === node.data.turn && event.data?.step === node.data.step) {
          const text = messageText(event.data?.message?.content)
          if (text !== '') results.push(text)
        }
      }
      const calls = node.data.blocks.filter((block) => block.kind === 'tool-call')
      const tools = calls.slice(-6).map((block, index) => {
        const tool = {}
        if (typeof block.name === 'string' && block.name !== '') tool.name = block.name
        const args = clipText(block.arguments, 400)
        if (args !== '') tool.arguments = args
        const result = clipText(results[Math.max(0, results.length - calls.length + index)] ?? '', 500)
        if (result !== '') tool.result = result
        return tool
      }).filter((tool) => Object.keys(tool).length > 0)
      const answer = clipText(node.data.blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n'), 1200)
      return {
        ...(user === '' ? {} : { user: clipText(user, 1200) }),
        ...(tools.length === 0 ? {} : { tools }),
        ...(answer === '' ? {} : { answer }),
      }
    }

    const zh = {
      thinking: '正在思考', pending: '正在整理思路…', idle: '思考摘要',
      generate: '生成摘要', original: '查看原始思考', summary: '返回摘要', retry: '重试',
      failed: '摘要暂时不可用', historical: '可生成这一阶段的摘要。', short: '这段思考较短，可直接查看原文。',
    }
    const en = {
      thinking: 'Thinking', pending: 'Summarizing this step…', idle: 'Reasoning summary',
      generate: 'Generate summary', original: 'View original thinking', summary: 'Back to summary', retry: 'Retry',
      failed: 'Summary unavailable', historical: 'Generate a summary for this step.', short: 'This step is short. You can view the original thinking.',
    }

    /** Coalesce live deltas without restarting a debounce on every token. */
    function useSummary(request, running, inView) {
      const identity = JSON.stringify([request.provider, request.model, request.locale])
      const address = addressOf(request)
      const [entry, setEntry] = React.useState(() => results.get(address) ?? { status: 'idle' })
      const latest = React.useRef()
      const work = React.useRef({ alive: true, busy: false, timer: null, lastAt: 0, lastText: '', lastWasRunning: false, failed: false, identity, seenLive: running, inView })
      const pump = React.useRef()
      latest.current = { request, identity, running, address, inView }

      pump.current = (manual = false) => {
        const state = work.current
        const current = latest.current
        const finalRetry = state.failed && !current.running && state.lastWasRunning
        if (!state.alive || state.busy || state.timer !== null || state.failed && !manual && !finalRetry) return
        if (!manual && !current.running && !current.inView) return
        if (current.request.text.length < 40) return
        if (!manual && (current.request.provider === '' || current.request.model === '')) return
        const cached = results.get(current.address)
        if (cached !== undefined) { setEntry({ ...cached, identity: current.identity, text: current.request.text }); return }
        if (!manual && !finalRetry && current.request.text === state.lastText) return
        if (!manual && current.running && state.lastText !== '' && current.request.text.length - state.lastText.length < 600) return
        const delay = manual || !current.running ? 0 : Math.max(1200, state.lastAt + 8000 - Date.now())
        state.timer = setTimeout(() => {
          state.timer = null
          if (!state.alive) return
          const snapshot = latest.current
          const liveRequest = snapshot.running || state.lastWasRunning
          state.busy = true
          state.failed = false
          state.lastAt = Date.now()
          state.lastText = snapshot.request.text
          state.lastWasRunning = snapshot.running
          setEntry((previous) => ({ ...previous, status: 'loading', identity: snapshot.identity, text: snapshot.request.text }))
          requestSummary(
            snapshot.request,
            manual ? 3 : liveRequest ? 2 : 1,
            !manual && !liveRequest,
          ).then(
            (result) => {
              const current = latest.current
              if (state.alive && current.identity === snapshot.identity && current.request.text.startsWith(snapshot.request.text)) {
                setEntry({ ...result, identity: snapshot.identity, text: snapshot.request.text })
              }
            },
            (error) => {
              const current = latest.current
              if (state.alive && current.identity === snapshot.identity && current.request.text.startsWith(snapshot.request.text)) {
                state.failed = true
                setEntry({ status: 'error', identity: snapshot.identity, text: snapshot.request.text, message: String(error?.message ?? error) })
              }
            },
          ).finally(() => { state.busy = false; pump.current() })
        }, delay)
      }

      React.useEffect(() => {
        const state = work.current
        state.alive = true
        return () => { state.alive = false; clearTimeout(state.timer); state.timer = null }
      }, [])
      React.useEffect(() => {
        const state = work.current
        state.seenLive ||= running
        state.inView = inView
        if (state.identity !== identity || !request.text.startsWith(state.lastText)) {
          clearTimeout(state.timer); state.timer = null
          state.identity = identity; state.lastText = ''; state.failed = false; state.lastAt = 0
          setEntry(results.get(address) ?? { status: 'idle' })
        }
        // A final message should not wait for the live-update throttle.
        if (!running && state.timer !== null) { clearTimeout(state.timer); state.timer = null }
        pump.current()
      }, [address, running, inView])

      const visible = entry.identity !== undefined && (entry.identity !== identity || !request.text.startsWith(entry.text))
        ? { status: 'idle' } : entry
      return [request.text.length < 40 ? { status: 'skipped' } : visible,
        () => { work.current.failed = false; work.current.seenLive = true; pump.current(true) }]
    }

    function SummaryBody({ entry, raw, running, start, labels, renderSlot, renderFactorySlot }) {
      const [original, setOriginal] = React.useState(false)
      const button = (label, action) => React.createElement('button', { type: 'button', className: 'dts-btn', onClick: action }, label)
      let content
      if (original) {
        content = renderSlot('conversation.chat.reasoning.body', { text: raw, running })
      } else if (entry.summary) {
        content = renderFactorySlot('conversation.chat.reasoning.content', { text: entry.summary, running: false })
      } else {
        content = React.createElement('span', { className: 'dts-status', role: 'status' },
          entry.status === 'error' ? labels.failed : entry.status === 'loading' ? labels.pending : entry.status === 'skipped' ? labels.short : labels.historical)
      }
      return React.createElement('div', { className: 'dts-body', 'data-plugin': NAME },
        content,
        React.createElement('div', { className: 'dts-actions' },
          button(original ? labels.summary : labels.original, () => setOriginal((value) => !value)),
          entry.status === 'idle' || entry.status === 'error' ? button(entry.status === 'error' ? labels.retry : labels.generate, start) : null,
          entry.status === 'loading' ? React.createElement('span', { className: 'dts-status', role: 'status' }, labels.pending) : null,
        ))
    }

    function decorate(NativeAssistant, getLocale) {
      return function SummaryAssistant(props) {
        const node = props.node
        const entries = props.useThinkingSummaryEvents((snapshot) => snapshot.entries)
        const route = React.useMemo(() => routeOf(entries, node), [entries, node.data.turn, node.data.step, node.anchorSeq, node.data.finalNode?.seq])
        const context = React.useMemo(() => contextOf(entries, node), [entries, node.data.turn, node.data.step, node.anchorSeq, node.data.finalNode?.seq])
        const locale = getLocale()
        const labels = locale.startsWith('zh') ? zh : en
        const raw = node.data.blocks.filter((block) => block.kind === 'reasoning').map((block) => block.text).join('\n\n')
        const running = node.data.status === 'running'
        // Historical rows backfill only once they are near the viewport, so
        // opening a long session does not bill the entire transcript at once.
        const [inView, setInView] = React.useState(() => typeof document === 'undefined' || typeof IntersectionObserver === 'undefined')
        React.useEffect(() => {
          if (inView) return undefined
          const key = String(node.key ?? '')
          const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(key)
            : key.replace(/["\\]/g, '\\$&')
          const row = key === '' ? null : document.querySelector(`[data-chat-node-key="${escaped}"]`)
          if (row === null) { setInView(true); return undefined }
          const observer = new IntersectionObserver((records) => {
            if (records.some((record) => record.isIntersecting)) {
              setInView(true)
              observer.disconnect()
            }
          }, { rootMargin: '400px' })
          observer.observe(row)
          return () => observer.disconnect()
        }, [node.key, inView])
        const [entry, start] = useSummary({ text: raw, ...route, locale, context }, running, inView)
        let used = false
        const blocks = node.data.blocks.flatMap((block) => {
          if (block.kind !== 'reasoning') return [block]
          if (used || raw.trim() === '') return []
          used = true
          const title = entry.title || (entry.summary ? entry.summary.split('\n')[0].slice(0, 48) : running ? labels.thinking : labels.idle)
          return [{ ...block, text: `**${title.replaceAll('**', '')}**\n\n${entry.summary || labels.pending}` }]
        })
        // Show the summary as a normal intermediate paragraph, not only inside
        // the thinking disclosure. This block is display-only: it never reaches
        // the session log or the model-facing history.
        if (entry.summary) {
          const card = { kind: 'text', text: `**${labels.idle}**\n\n${entry.summary}` }
          const firstText = blocks.findIndex((block) => block.kind === 'text')
          if (firstText === -1) blocks.push(card)
          else blocks.splice(firstText, 0, card)
        }
        const native = React.createElement(NativeAssistant, {
          ...props, node: { ...node, data: { ...node.data, blocks } },
          renderSlot: (name, owner, options) => name === 'conversation.chat.reasoning.body'
            ? React.createElement(SummaryBody, { entry, raw, running, start, labels, renderSlot: props.renderSlot, renderFactorySlot: props.renderFactorySlot })
            : props.renderSlot(name, owner, options),
        })
        if (!entry.summary || props.groupPart === 'response') return native
        // The reasoning group member is the intermediate row; render the
        // Chinese summary beside it so it is visible without expanding the
        // disclosure. The response group already shows the answer.
        return React.createElement(React.Fragment, null, native,
          React.createElement('div', { className: 'dts-card', 'data-plugin': NAME },
            React.createElement('div', { className: 'dts-card-title' }, entry.title || labels.idle),
            React.createElement('div', { className: 'dts-card-body' }, entry.summary)))
      }
    }

    const settingsZh = {
      title: '思考摘要', summary: '选择摘要模型与语言', model: '摘要模型', follow: '跟随对话模型',
      language: '摘要语言', hint: 'auto 跟随 DSH 语言；也可输入 zh、en、zh-CN 等', followDsh: '跟随 DSH',
      save: '保存', saved: '已保存', refresh: '刷新模型', loading: '读取中…', failed: '读取失败',
      retry: '重试', empty: '没有可用模型', auto: '自动',
    }
    const settingsEn = {
      title: 'Thinking summary', summary: 'Choose the summary model and language', model: 'Summary model', follow: 'Follow the conversation model',
      language: 'Summary language', hint: 'auto follows the DSH locale; you can also enter zh, en, zh-CN, etc.', followDsh: 'Follow DSH',
      save: 'Save', saved: 'Saved', refresh: 'Refresh models', loading: 'Loading…', failed: 'Load failed',
      retry: 'Retry', empty: 'No models available', auto: 'Auto',
    }

    function SettingsItem(props) {
      const locale = typeof props.currentLocale === 'function' ? props.currentLocale() : 'zh'
      const labels = locale.startsWith('zh') ? settingsZh : settingsEn
      if (props.view === 'summary') return React.createElement('span', null, labels.summary)
      return React.createElement(SettingsForm, { ...props, labels })
    }

    function SettingsForm({ labels, currentLocale }) {
      const [settings, setSettings] = React.useState({ provider: '', model: '', language: 'auto' })
      const [providers, setProviders] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [error, setError] = React.useState('')

      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const [settingsResponse, modelsResponse] = await Promise.all([
            fetch('/dsh-thinking-summary/settings'),
            fetch('/dsh-thinking-summary/models'),
          ])
          const settingsPayload = await settingsResponse.json()
          const modelsPayload = await modelsResponse.json()
          if (!settingsResponse.ok || settingsPayload.ok !== true) throw new Error(settingsPayload.error ?? `HTTP ${settingsResponse.status}`)
          if (!modelsResponse.ok || modelsPayload.ok !== true) throw new Error(modelsPayload.error ?? `HTTP ${modelsResponse.status}`)
          setSettings({
            provider: typeof settingsPayload.provider === 'string' ? settingsPayload.provider : '',
            model: typeof settingsPayload.model === 'string' ? settingsPayload.model : '',
            language: typeof settingsPayload.language === 'string' ? settingsPayload.language : 'auto',
          })
          setProviders(Array.isArray(modelsPayload.providers) ? modelsPayload.providers : [])
        } catch (loadError) {
          setError(String(loadError?.message ?? loadError))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const selected = settings.provider !== '' && settings.model !== ''
        ? JSON.stringify([settings.provider, settings.model])
        : ''
      const groups = providers.map((provider) => React.createElement('optgroup', { key: provider.id, label: provider.name },
        (provider.models ?? []).map((model) => React.createElement('option', {
          key: JSON.stringify([provider.id, model.id]),
          value: JSON.stringify([provider.id, model.id]),
        }, `${model.name} (${model.id})`))))
      const dshLocale = typeof currentLocale === 'function' ? currentLocale() : 'zh'

      const save = async () => {
        setSaving(true)
        setMessage('')
        setError('')
        try {
          const response = await fetch('/dsh-thinking-summary/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider: settings.provider,
              model: settings.model,
              language: settings.language,
            }),
          })
          const payload = await response.json()
          if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
          setSettings({
            provider: typeof payload.provider === 'string' ? payload.provider : '',
            model: typeof payload.model === 'string' ? payload.model : '',
            language: typeof payload.language === 'string' ? payload.language : 'auto',
          })
          setMessage(labels.saved)
        } catch (saveError) {
          setError(String(saveError?.message ?? saveError))
        } finally {
          setSaving(false)
        }
      }

      const status = error !== '' ? React.createElement('span', { className: 'dts-settings-status dts-settings-error' }, `${labels.failed}: ${error}`)
        : message !== '' ? React.createElement('span', { className: 'dts-settings-status' }, message)
          : loading ? React.createElement('span', { className: 'dts-settings-status' }, labels.loading) : null

      return React.createElement('div', { className: 'dts-settings' },
        React.createElement('div', { className: 'dts-settings-heading' }, labels.title),
        React.createElement('div', { className: 'dts-settings-hint' }, labels.summary),
        React.createElement('div', { className: 'dts-settings-row' },
          React.createElement('label', { className: 'dts-settings-label' }, labels.model),
          React.createElement('select', {
            className: 'dts-settings-select',
            value: selected,
            disabled: loading || saving,
            onChange: (event) => {
              const value = event.currentTarget.value
              if (value === '') setSettings((previous) => ({ ...previous, provider: '', model: '' }))
              else {
                const [provider, model] = JSON.parse(value)
                setSettings((previous) => ({ ...previous, provider, model }))
              }
            },
          },
          React.createElement('option', { value: '' }, labels.follow),
          groups)),
        React.createElement('div', { className: 'dts-settings-row' },
          React.createElement('label', { className: 'dts-settings-label' }, labels.language),
          React.createElement('input', {
            className: 'dts-settings-input',
            value: settings.language,
            disabled: loading || saving,
            placeholder: `auto (${labels.followDsh}: ${dshLocale})`,
            onChange: (event) => setSettings((previous) => ({ ...previous, language: event.currentTarget.value })),
          }),
          React.createElement('span', { className: 'dts-settings-hint' }, labels.hint)),
        React.createElement('div', { className: 'dts-settings-actions' },
          React.createElement('button', {
            type: 'button', className: 'dts-settings-button', disabled: saving || loading, onClick: save,
          }, labels.save),
          React.createElement('button', {
            type: 'button', className: 'dts-settings-button', disabled: saving || loading, onClick: () => {
              setSettings((previous) => ({ ...previous, language: 'auto' }))
            },
          }, labels.followDsh),
          React.createElement('button', {
            type: 'button', className: 'dts-settings-button', disabled: saving || loading, onClick: () => { void load() },
          }, labels.refresh),
          status))
    }

    const STYLE_ID = `${NAME}/thinking-summary.css`
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)?.remove()
      const style = document.createElement('style')
      style.dataset.pluginCss = STYLE_ID
      style.textContent = '.dts-body{display:flex;flex-direction:column;gap:8px}.dts-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.dts-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}.dts-btn{appearance:none;background:none;border:0;padding:0;color:var(--dsw-alias-label-secondary,#8a8f98);font:inherit;font-size:12px;cursor:pointer}.dts-btn:hover{text-decoration:underline}.dts-btn:focus-visible{outline:2px solid currentColor;outline-offset:3px}.dts-card{margin:8px 0 12px;padding:10px 14px;border-left:3px solid var(--dsw-alias-state-business-primary,#4d6bfe);border-radius:8px;background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,#8a8f98);font-size:13px;line-height:1.6}.dts-card-title{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8);margin-bottom:4px}.dts-settings{display:flex;flex-direction:column;gap:14px;max-width:640px;padding:4px 0}.dts-settings-heading{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e8e8e8)}.dts-settings-row{display:flex;flex-direction:column;gap:6px}.dts-settings-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#e8e8e8)}.dts-settings-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}.dts-settings-input,.dts-settings-select{box-sizing:border-box;width:100%;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;font-size:13px}.dts-settings-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.dts-settings-button{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;font-size:12px;padding:5px 10px;cursor:pointer}.dts-settings-button:disabled{opacity:.5;cursor:default}.dts-settings-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}.dts-settings-error{color:var(--dsw-alias-state-error-primary,#e5484d)}'
      document.head.appendChild(style)
      return () => style.remove()
    }

    return {
      name: NAME,
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        const getLocale = () => {
          try {
            const active = ctx.locale?.getSnapshot?.().active
            if (typeof active === 'string' && active !== '') return active
          } catch {}
          return typeof navigator?.language === 'string' ? navigator.language : 'en'
        }
        ctx.effect(installStyles, `${NAME}: styles`)
        // The installed bundle's own detail page hosts this configuration, so
        // the plugin does not appear as a separate built-in configuration item.
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-thinking-summary',
          inject: () => ({ currentLocale: getLocale }),
        }, SettingsItem)), `${NAME}: bundle settings`)
        ctx.slots.inject(SLOT, () => {
          let dispose
          let original
          const wrappers = new WeakSet()
          const reconcile = () => {
            // The registry exposes stored entries as `{ component, options }`;
            // only custom registrations may carry the flattened key/priority.
            const keyOf = (entry) => entry?.options?.key ?? entry?.key
            const priorityOf = (entry) => entry?.options?.priority ?? entry?.priority ?? 0
            const candidates = ctx.slots.entries(SLOT).filter((entry) => keyOf(entry) === 'assistant-step' && !wrappers.has(entry.component))
            const native = candidates.find((entry) => entry.registrant === '@deepseek-ai/dsh-client-ui-chat') ?? candidates[0]
            if (native === original) return
            dispose?.(); dispose = undefined; original = native
            if (native === undefined) return
            // Preserve locale and the native presentation/lookup injection.
            const wrapper = decorate(native.component, getLocale)
            wrappers.add(wrapper)
            dispose = ctx.slots.register({
              name: SLOT, key: 'assistant-step', priority: priorityOf(native) - 1,
              locale: native.locale,
              // The native entry already declares the child slots; declaring
              // them again from the shadowing wrapper is rejected. The child
              // outlets stay resolvable through the native declaration.
              inject: (sessionId, ...args) => {
                const face = native.inject?.(sessionId, ...args) ?? {}
                return { ...face, hooks: { ...face.hooks, thinkingSummaryEvents: ctx.sessions.binding(sessionId).session.eventSource } }
              },
            }, wrapper)
          }
          const unsubscribe = ctx.slots.subscribe(SLOT, reconcile)
          reconcile()
          return () => { unsubscribe(); dispose?.() }
        })
      },
    }
  },
})

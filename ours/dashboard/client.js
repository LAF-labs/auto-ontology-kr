/**
 * Browser runtime for dashboards: a `main` panel (first screen) with one tab
 * per dashboard. It loads a spec, places widgets on its grid, loads each
 * widget's ES module from the store by type and version, and feeds it the
 * saved-analysis result through props only (rows, columns, options, theme,
 * locale). Refreshing calls /api/ao/run-batch and nothing else; no model is
 * involved. A widget whose analysis fails keeps showing the last successful
 * result with its time (from the server's last_success or this page's own
 * last good result, whichever is newer) and never shows an invented value.
 *
 * Drafts are per browser (owner id in localStorage). Publishing and reverting
 * are buttons; a publish that lost a race shows a warning and an explicit
 * overwrite.
 *
 * The edit button starts an edit Session on this browser's draft (POST
 * /api/dashboard/edit) and opens it with the draft panel in the right sidebar:
 * a live preview of the draft, verification of the draft analyses the agent
 * saved, and the publish and discard buttons. Only a person publishes.
 *
 * Widget modules stored as `basic` (seeded by a host package) are imported into
 * the page. Every other module runs in an iframe with `sandbox="allow-scripts"`
 * (an opaque origin: no cookies, no storage, no access to this page) and a
 * `default-src 'none'` policy (no network); its props arrive by postMessage.
 */
window.__ModuleLoader__.load({
  id: '@ours/dashboard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState, useCallback } = React

    const PANEL_ID = 'ours-dashboard'
    const DRAFT_TAB_ID = '@ours/dashboard/draft'
    const DRAFT_TAB_KIND = 'ours-dashboard-draft'
    const EDITOR_POLL_MS = 3000
    let clientCtx = null
    const OWNER_KEY = 'ours.dashboard.owner'
    const OWNER_HEADER = 'x-ours-draft-owner'
    const TICK_MS = 5000
    const LIST_POLL_MS = 30000
    const DEFAULT_REFRESH_S = 300

    const COPY = {
      ko: {
        dashboards: '대시보드', empty: '게시된 대시보드가 없습니다.', loading: '불러오는 중', refreshAll: '새로고침',
        edit: '수정', editOpening: '수정 세션을 여는 중', published: '게시본', draft: '내 초안',
        panelTitle: '대시보드 초안', panelNone: '이 브라우저에서 연 수정 세션이 아닙니다.', draftGone: '이 초안은 게시되었거나 버려졌습니다. 다시 고치려면 대시보드에서 수정을 누르세요.',
        basedOn: v => v === 0 ? '새 대시보드' : `v${v}에서 시작`, updated: '마지막 변경', unverifiedTitle: '검증이 필요한 분석',
        unverifiedHelp: '검증되지 않은 분석을 쓰는 초안은 게시할 수 없습니다. SQL과 미리보기를 확인한 뒤 검증하세요.',
        verify: '검증', showSql: 'SQL 보기', hideSql: 'SQL 닫기', verified: (name, v) => `${name} v${v}을(를) 검증했습니다.`,
        reason: { draft: '초안 버전', no_verified_version: '검증된 버전 없음', not_found: '분석 없음', retired: '폐기된 버전' },
        publishBlocked: n => `검증되지 않은 분석 ${n}개 때문에 게시할 수 없습니다.`, sandboxed: '격리 실행',
        syncFailed: code => `질문 검색용 복사본은 만들지 못했습니다(${code}).`,
        publish: '게시', discard: '초안 버리기', versions: '버전', revert: '이 버전으로 되돌리기', current: '현재',
        home: '첫 화면', makeHome: '첫 화면으로 지정', isHome: '첫 화면', newVersion: v => `다른 곳에서 v${v}이(가) 게시되어 다시 불러왔습니다.`,
        baseChanged: (base, now, at) => `이 초안은 v${base}에서 시작했는데, 그 사이 v${now}이(가) 게시되었습니다${at ? ` (${at})` : ''}. 게시하면 그 버전을 덮습니다.`,
        overwrite: '덮어쓰고 게시', cancel: '취소', publishedAs: v => `v${v}로 게시했습니다.`, revertedTo: v => `v${v}로 되돌렸습니다.`,
        revertRace: now => `그 사이 v${now}이(가) 게시되어 되돌리지 않았습니다. 다시 확인하세요.`,
        executed: '실행', cached: '캐시', lastSuccess: '마지막 성공 값', noValue: '표시할 성공 결과가 없습니다', widgetFailed: '위젯을 그리지 못했습니다',
        error: '오류', viewingDraft: '이 브라우저에만 보이는 초안입니다.', unpublished: '아직 게시되지 않음', next: '다음 갱신',
      },
      en: {
        dashboards: 'Dashboards', empty: 'No published dashboards.', loading: 'Loading', refreshAll: 'Refresh',
        edit: 'Edit', editOpening: 'Opening the edit session', published: 'Published', draft: 'My draft',
        panelTitle: 'Dashboard draft', panelNone: 'This is not an edit session opened in this browser.', draftGone: 'This draft was published or discarded. Press Edit on the dashboard to change it again.',
        basedOn: v => v === 0 ? 'New dashboard' : `Started from v${v}`, updated: 'Last change', unverifiedTitle: 'Analyses to verify',
        unverifiedHelp: 'A draft that reads an unverified analysis cannot be published. Check the SQL and the preview, then verify.',
        verify: 'Verify', showSql: 'Show SQL', hideSql: 'Hide SQL', verified: (name, v) => `Verified ${name} v${v}.`,
        reason: { draft: 'draft version', no_verified_version: 'no verified version', not_found: 'analysis not found', retired: 'retired version' },
        publishBlocked: n => `${n} unverified analysis version(s) block publishing.`, sandboxed: 'sandboxed',
        syncFailed: code => `Its copy for question search was not created (${code}).`,
        publish: 'Publish', discard: 'Discard draft', versions: 'Versions', revert: 'Revert to this version', current: 'current',
        home: 'Home', makeHome: 'Make first screen', isHome: 'First screen', newVersion: v => `v${v} was published elsewhere; reloaded.`,
        baseChanged: (base, now, at) => `This draft started from v${base}, but v${now} was published since${at ? ` (${at})` : ''}. Publishing replaces it.`,
        overwrite: 'Publish anyway', cancel: 'Cancel', publishedAs: v => `Published as v${v}.`, revertedTo: v => `Reverted to v${v}.`,
        revertRace: now => `v${now} was published meanwhile; nothing was reverted. Check again.`,
        executed: 'Ran', cached: 'cached', lastSuccess: 'Last successful value', noValue: 'No successful result to show', widgetFailed: 'The widget failed to render',
        error: 'Error', viewingDraft: 'This draft is visible only in this browser.', unpublished: 'not published yet', next: 'next',
      },
    }
    const t = String(globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ko') ? COPY.ko : COPY.en
    const locale = globalThis.navigator?.language

    // ── Browser identity for drafts ──────────────────────────────────────────
    function ownerId() {
      try {
        let id = localStorage.getItem(OWNER_KEY)
        if (id === null || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
          id = crypto.randomUUID().replace(/-/g, '')
          localStorage.setItem(OWNER_KEY, id)
        }
        return id
      } catch {
        return undefined
      }
    }

    async function api(path, { method = 'GET', body } = {}) {
      const owner = ownerId()
      const response = await fetch(path, {
        method,
        headers: { ...owner === undefined ? {} : { [OWNER_HEADER]: owner }, ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      let json
      try { json = await response.json() } catch { json = undefined }
      if (!response.ok) {
        const error = json?.error ?? {}
        return { ok: false, status: response.status, error: { code: error.code ?? 'http_error', message: error.message ?? `HTTP ${response.status}`, details: error.details ?? null, last_success: error.last_success ?? null } }
      }
      return { ok: true, status: response.status, body: json }
    }

    const formatTime = iso => {
      if (typeof iso !== 'string') return ''
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    // ── Theme values handed to widgets ───────────────────────────────────────
    function themeFrom(el) {
      const style = getComputedStyle(el ?? document.documentElement)
      const v = (name, fallback) => style.getPropertyValue(name).trim() || fallback
      const series = [
        v('--dsw-alias-state-business-primary', '#3b82f6'), v('--dsw-alias-state-success-primary', '#22a06b'),
        v('--dsw-alias-state-warn-primary', '#d97706'), v('--dsw-alias-state-error-primary', '#dc2626'),
        v('--dsw-alias-brand-primary', '#6366f1'), v('--dsw-alias-label-secondary', '#888888'),
      ]
      return {
        text: v('--dsw-alias-label-primary', 'CanvasText'), textSecondary: v('--dsw-alias-label-secondary', 'GrayText'),
        textTertiary: v('--dsw-alias-label-tertiary', 'GrayText'), border: v('--dsw-alias-border-l2', 'rgba(127,127,127,.25)'),
        background: v('--dsw-alias-bg-base', 'Canvas'), surface: v('--dsw-alias-bg-layer-1', 'Canvas'),
        accent: series[0], positive: series[1], warning: series[2], negative: series[3], series,
        font: style.fontFamily,
      }
    }

    // ── Widget modules ───────────────────────────────────────────────────────
    // Origins come from the store's widget list; a module missing from the
    // last list read is looked up again and treated as generated until known.
    let origins = new Map()
    let originsLoad = null
    function widgetOrigin(type, version) {
      const key = `${type}@${version}`
      if (origins.has(key)) return Promise.resolve(origins.get(key))
      if (originsLoad === null) {
        originsLoad = api('api/dashboard/widgets').then(result => {
          if (result.ok) origins = new Map(result.body.data.map(w => [`${w.type}@${w.version}`, w.origin]))
        }).finally(() => { originsLoad = null })
      }
      return originsLoad.then(() => origins.get(key) ?? 'generated')
    }

    const sources = new Map()
    function loadWidgetSource(type, version) {
      const key = `${type}@${version}`
      if (!sources.has(key)) {
        const promise = fetch(`api/dashboard/widget-module?type=${encodeURIComponent(type)}&version=${version}`).then(response => {
          if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`)
          return response.text()
        })
        promise.catch(() => sources.delete(key))
        sources.set(key, promise)
      }
      return sources.get(key)
    }

    // The frame document. Its policy forbids every fetch, form, frame and
    // non-data resource; scripts run only inline (this bootstrap) and from the
    // blob made of the module source the page sends in.
    const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'"
    const FRAME_BOOT = `(() => {
  let handle = null
  const send = message => parent.postMessage(Object.assign({ __oursWidget: true }, message), '*')
  const fail = error => send({ kind: 'error', message: String((error && error.message) || error) })
  addEventListener('error', event => fail(event.error || event.message))
  addEventListener('unhandledrejection', event => fail(event.reason))
  addEventListener('message', async event => {
    if (event.source !== parent) return
    const message = event.data
    if (!message || message.__oursWidget !== true) return
    try {
      if (message.kind === 'init' && handle === null) {
        document.documentElement.style.colorScheme = message.colorScheme || 'normal'
        const url = URL.createObjectURL(new Blob([message.source], { type: 'text/javascript' }))
        const module = await import(url)
        // The contract is a default object with mount; a named mount export is accepted too.
        const widget = module.default && typeof module.default.mount === 'function' ? module.default : module
        if (typeof widget.mount !== 'function') throw new Error('the module exports no mount(el, props)')
        handle = widget.mount(document.getElementById('root'), message.props)
        send({ kind: 'mounted' })
      } else if (message.kind === 'update' && handle !== null) {
        handle.update(message.props)
        send({ kind: 'mounted' })
      }
    } catch (error) { fail(error) }
  })
  send({ kind: 'ready' })
})()`
    const FRAME_DOC = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#root{position:absolute;inset:0}</style></head><body><div id="root"></div><script>${FRAME_BOOT}</script></body></html>`

    const modules = new Map()
    function loadWidget(type, version) {
      const key = `${type}@${version}`
      if (!modules.has(key)) {
        const url = new URL(`api/dashboard/widget-module?type=${encodeURIComponent(type)}&version=${version}`, document.baseURI).href
        const promise = import(/* webpackIgnore: true */ url).then(module => {
          const widget = typeof module.default?.mount === 'function' ? module.default : module
          if (typeof widget.mount !== 'function') throw new Error(`${key} exports no mount(el, props)`)
          return widget
        })
        promise.catch(() => modules.delete(key))
        modules.set(key, promise)
      }
      return modules.get(key)
    }

    // ── Data controller: one per loaded spec ─────────────────────────────────
    class Feed {
      constructor(spec, runtime) {
        this.spec = spec
        this.runtime = runtime ?? {}
        this.listeners = new Set()
        this.state = new Map()
        this.lastGood = new Map()
        this.due = new Map()
        this.inFlight = new Set()
        this.timer = undefined
        this.stopped = false
        for (const widget of spec.widgets) this.state.set(widget.id, { phase: 'loading' })
      }

      timing(widget) {
        const refreshS = widget.refresh_s ?? this.spec.refresh_s ?? DEFAULT_REFRESH_S
        return { refreshS, maxAgeS: Math.min(this.spec.max_age_s ?? refreshS, refreshS) }
      }

      subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
      emit() { for (const listener of this.listeners) listener() }
      get(id) { return this.state.get(id) }

      start() {
        this.run(this.spec.widgets, false)
        this.timer = setInterval(() => {
          if (document.hidden) return
          const now = Date.now()
          const due = this.spec.widgets.filter(widget => !this.inFlight.has(widget.id) && (this.due.get(widget.id) ?? 0) <= now)
          if (due.length > 0) this.run(due, false)
        }, TICK_MS)
      }

      stop() { this.stopped = true; clearInterval(this.timer) }

      refreshAll() { this.run(this.spec.widgets.filter(widget => !this.inFlight.has(widget.id)), true) }

      async run(widgets, force) {
        const size = this.runtime.max_batch_items ?? 50
        for (let i = 0; i < widgets.length; i += size) await this.runBatch(widgets.slice(i, i + size), force)
      }

      async runBatch(widgets, force) {
        if (widgets.length === 0 || this.stopped) return
        for (const widget of widgets) this.inFlight.add(widget.id)
        const items = widgets.map(widget => ({
          key: widget.id,
          analysis_id: widget.source.analysis_id,
          ...widget.source.version === undefined ? {} : { version: widget.source.version },
          ...widget.source.params === undefined ? {} : { params: widget.source.params },
          ...widget.source.row_limit === undefined ? {} : { row_limit: widget.source.row_limit },
          max_age_s: force ? 0 : this.timing(widget).maxAgeS,
        }))
        const body = { items, ...this.runtime.deadline_s === undefined ? {} : { deadline_s: this.runtime.deadline_s } }
        let result
        try {
          result = await api('api/ao/run-batch', { method: 'POST', body })
        } catch (error) {
          result = { ok: false, error: { code: 'network', message: String(error?.message ?? error), last_success: null } }
        }
        if (this.stopped) return
        const fetchedAt = new Date().toISOString()
        for (const widget of widgets) {
          this.inFlight.delete(widget.id)
          this.due.set(widget.id, Date.now() + this.timing(widget).refreshS * 1000)
          const entry = result.ok ? result.body?.data?.[widget.id] : { error: result.error }
          if (entry?.data !== undefined) {
            this.lastGood.set(widget.id, entry.data)
            this.state.set(widget.id, { phase: 'ok', data: entry.data, fetchedAt })
          } else {
            const error = entry?.error ?? { code: 'missing', message: 'no result for this widget' }
            const fromServer = error.last_success ?? null
            const local = this.lastGood.get(widget.id) ?? null
            const newer = [fromServer, local].filter(Boolean).sort((a, b) => String(b.executed_at).localeCompare(String(a.executed_at)))[0] ?? null
            this.state.set(widget.id, { phase: 'error', error, data: newer, fetchedAt })
          }
        }
        this.emit()
      }
    }

    function useFeed(feed) {
      const [, setTick] = useState(0)
      useEffect(() => feed?.subscribe(() => setTick(n => n + 1)), [feed])
    }

    // ── Styles ───────────────────────────────────────────────────────────────
    const css = {
      root: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' },
      bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: 4, flex: '1 1 auto', overflowX: 'auto', minWidth: 0 },
      tab: active => ({ border: 'none', background: active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent', color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', padding: '5px 10px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', font: 'inherit', fontSize: 13, fontWeight: active ? 600 : 400 }),
      button: (kind = 'plain', disabled = false) => ({
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 10px', font: 'inherit', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        background: kind === 'primary' ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary))' : 'transparent',
        color: kind === 'primary' ? 'var(--dsw-alias-label-primary-inverted, #fff)' : kind === 'danger' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
      }),
      notice: tone => ({ margin: '8px 16px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        background: tone === 'warn' ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)' : tone === 'error' ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)' : 'var(--dsw-alias-bg-layer-1)' }),
      scroll: { flex: '1 1 auto', overflow: 'auto', padding: 16, minHeight: 0 },
      card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6, minWidth: 0 },
      cardTitle: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      body: { flex: '1 1 auto', minHeight: 0, position: 'relative' },
      foot: tone => ({ fontSize: 11, marginTop: 6, color: tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
      badge: tone => ({ fontSize: 11, padding: '1px 6px', borderRadius: 999, background: tone === 'warn' ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent)' : 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }),
      menu: { position: 'absolute', right: 16, top: 48, zIndex: 20, background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 6, minWidth: 280, boxShadow: '0 8px 24px rgba(0,0,0,.25)' },
      menuRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 12 },
    }

    // ── Widget card ──────────────────────────────────────────────────────────
    function WidgetBody({ widget, data, theme }) {
      const [origin, setOrigin] = useState(null)
      useEffect(() => {
        let cancelled = false
        widgetOrigin(widget.type, widget.type_version).then(value => { if (!cancelled) setOrigin(value) })
        return () => { cancelled = true }
      }, [widget.type, widget.type_version])
      if (origin === null) return h('div', { style: css.body })
      return origin === 'basic' ? h(PageWidget, { widget, data, theme }) : h(FramedWidget, { key: `${widget.type}@${widget.type_version}`, widget, data, theme })
    }

    function FramedWidget({ widget, data, theme }) {
      const frame = useRef(null)
      const [ready, setReady] = useState(false)
      const [mounted, setMounted] = useState(false)
      const [failure, setFailure] = useState(null)
      const sent = useRef(false)
      const props = useMemo(() => data === null || data === undefined ? null : {
        rows: data.rows ?? [], columns: data.columns ?? [], options: widget.options ?? {}, theme, locale,
      }, [data, widget, theme])
      useEffect(() => {
        const onMessage = event => {
          if (frame.current === null || event.source !== frame.current.contentWindow) return
          const message = event.data
          if (message === null || typeof message !== 'object' || message.__oursWidget !== true) return
          if (message.kind === 'ready') setReady(true)
          else if (message.kind === 'mounted') { setMounted(true); setFailure(null) }
          else if (message.kind === 'error') setFailure(String(message.message).slice(0, 300))
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])
      useEffect(() => {
        if (!ready || props === null || frame.current === null) return undefined
        let cancelled = false
        const target = frame.current.contentWindow
        if (!sent.current) {
          sent.current = true
          loadWidgetSource(widget.type, widget.type_version).then(source => {
            if (!cancelled) target.postMessage({ __oursWidget: true, kind: 'init', source, props, colorScheme: getComputedStyle(document.documentElement).colorScheme }, '*')
          }, error => { if (!cancelled) setFailure(String(error?.message ?? error)) })
        } else if (mounted) {
          target.postMessage({ __oursWidget: true, kind: 'update', props }, '*')
        }
        return () => { cancelled = true }
      }, [ready, mounted, props, widget.type, widget.type_version])
      if (props === null) return h('div', { style: { ...css.body, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, t.noValue)
      return h('div', { style: css.body },
        failure !== null && h('div', { style: css.foot('error') }, `${t.widgetFailed}: ${failure}`),
        h('iframe', {
          ref: frame, sandbox: 'allow-scripts', srcDoc: FRAME_DOC, title: widget.title ?? widget.id, referrerPolicy: 'no-referrer',
          'data-sandboxed-widget': `${widget.type}@${widget.type_version}`,
          style: { position: 'absolute', inset: failure !== null ? '18px 0 0 0' : 0, width: '100%', height: failure !== null ? 'calc(100% - 18px)' : '100%', border: 0, background: 'transparent', colorScheme: 'normal' },
        }))
    }

    function PageWidget({ widget, data, theme }) {
      const ref = useRef(null)
      const handle = useRef(null)
      const [failure, setFailure] = useState(null)
      const props = useMemo(() => data === null || data === undefined ? null : {
        rows: data.rows ?? [], columns: data.columns ?? [], options: widget.options ?? {}, theme, locale,
      }, [data, widget, theme])
      useEffect(() => {
        let cancelled = false
        if (props === null || ref.current === null) return undefined
        loadWidget(widget.type, widget.type_version).then(module => {
          if (cancelled) return
          try {
            if (handle.current === null) handle.current = module.mount(ref.current, props)
            else handle.current.update(props)
            setFailure(null)
          } catch (error) {
            setFailure(String(error?.message ?? error))
          }
        }, error => { if (!cancelled) setFailure(String(error?.message ?? error)) })
        return () => { cancelled = true }
      }, [props, widget.type, widget.type_version])
      useEffect(() => () => { try { handle.current?.destroy() } catch { /* widget teardown errors stay in the widget */ } handle.current = null }, [widget.type, widget.type_version])
      if (props === null) return h('div', { style: { ...css.body, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, t.noValue)
      return h('div', { style: css.body },
        failure !== null && h('div', { style: css.foot('error') }, `${t.widgetFailed}: ${failure}`),
        h('div', { ref, style: { position: 'absolute', inset: failure !== null ? '18px 0 0 0' : 0 } }))
    }

    function WidgetCard({ widget, feed, theme, rowHeight }) {
      const state = feed.get(widget.id) ?? { phase: 'loading' }
      const data = state.data ?? null
      const layout = widget.layout
      const title = widget.title ?? data?.name ?? widget.id
      const stale = state.phase === 'error'
      return h('section', {
        style: { ...css.card, gridColumn: `${layout.x + 1} / span ${layout.w}`, gridRow: `${layout.y + 1} / span ${layout.h}`, minHeight: layout.h * rowHeight },
        'data-widget': widget.id, 'data-phase': state.phase,
      },
        h('div', { style: css.cardHead },
          h('div', { style: css.cardTitle, title }, title),
          stale && data !== null && h('span', { style: css.badge('warn') }, t.lastSuccess),
          data?.status === 'draft' && h('span', { style: css.badge('warn') }, 'draft'),
          state.phase === 'loading' && h('span', { style: css.meta }, t.loading)),
        state.phase === 'loading' && data === null ? h('div', { style: css.body }) : h(WidgetBody, { widget, data, theme }),
        data !== null && h('div', { style: css.foot() },
          `${stale ? t.lastSuccess : t.executed} ${formatTime(data.executed_at)}${!stale && data.cache?.hit ? ` · ${t.cached}` : ''}${data.version ? ` · v${data.version}` : ''}`),
        stale && h('div', { style: css.foot('error'), title: state.error?.message }, `${t.error} ${state.error?.code}: ${state.error?.message ?? ''}`))
    }

    function Grid({ spec, feed }) {
      useFeed(feed)
      const rootRef = useRef(null)
      const [theme, setTheme] = useState(() => themeFrom(document.documentElement))
      useEffect(() => {
        const update = () => setTheme(themeFrom(rootRef.current ?? document.documentElement))
        update()
        const observer = new MutationObserver(update)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
        return () => observer.disconnect()
      }, [])
      const columns = spec.grid?.columns ?? 12
      const rowHeight = spec.grid?.row_height ?? 90
      return h('div', { ref: rootRef, style: { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: `${rowHeight}px`, gap: 12 } },
        spec.widgets.map(widget => h(WidgetCard, { key: widget.id, widget, feed, theme, rowHeight })))
    }

    // ── Panel ────────────────────────────────────────────────────────────────
    function Dashboard() {
      const [list, setList] = useState(null)
      const [active, setActive] = useState(null)
      const [view, setView] = useState('published')
      const [doc, setDoc] = useState(null)
      const [notice, setNotice] = useState(null)
      const [conflict, setConflict] = useState(null)
      const [versions, setVersions] = useState(null)
      const [feed, setFeed] = useState(null)
      const docRef = useRef(null)
      docRef.current = doc

      const loadList = useCallback(async () => {
        const result = await api('api/dashboard/list')
        if (!result.ok) { setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` }); return null }
        setList(result.body)
        return result.body
      }, [])

      const loadDoc = useCallback(async (id, which) => {
        if (id === null) { setDoc(null); return }
        const result = await api(`api/dashboard/get?id=${encodeURIComponent(id)}&view=${which}`)
        if (!result.ok) { setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` }); setDoc(null); return }
        setDoc(result.body.data)
      }, [])

      useEffect(() => {
        loadList().then(body => {
          if (body === null) return
          const first = body.home ?? body.data.find(d => d.published_version !== null)?.id ?? body.data[0]?.id ?? null
          setActive(first)
        })
      }, [loadList])

      useEffect(() => {
        if (active === null || list === null) return
        const entry = list.data.find(d => d.id === active)
        const which = view === 'draft' && entry?.has_draft ? 'draft' : entry?.published_version === null ? 'draft' : 'published'
        if (which !== view) { setView(which); return }
        loadDoc(active, which)
      }, [active, view, list === null, loadDoc])

      // A new feed per loaded spec; the old one stops.
      useEffect(() => {
        if (doc === null || list === null) { setFeed(null); return undefined }
        const next = new Feed(doc.spec, list.runtime)
        setFeed(next)
        next.start()
        return () => next.stop()
      }, [doc])

      // Another browser may publish or revert: poll the list and reload the published view.
      useEffect(() => {
        const check = async () => {
          const body = await loadList()
          const current = docRef.current
          if (body === null || current === null || current.view !== 'published') return
          const entry = body.data.find(d => d.id === current.id)
          if (entry !== undefined && entry.published_version !== current.published_version) {
            await loadDoc(current.id, 'published')
            setNotice({ tone: 'info', text: t.newVersion(entry.published_version) })
          }
        }
        const timer = setInterval(check, LIST_POLL_MS)
        const onFocus = () => { check() }
        window.addEventListener('focus', onFocus)
        return () => { clearInterval(timer); window.removeEventListener('focus', onFocus) }
      }, [loadList, loadDoc])

      const entry = list?.data.find(d => d.id === active)

      async function publish(force) {
        const result = await api('api/dashboard/publish', { method: 'POST', body: { id: active, ...force ? { force: true } : {} } })
        if (!result.ok && result.error.code === 'base_changed') {
          setConflict(result.error.details)
          return
        }
        setConflict(null)
        if (!result.ok) { setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` }); return }
        setNotice({ tone: 'info', text: t.publishedAs(result.body.data.version) })
        setView('published')
        await loadList()
        await loadDoc(active, 'published')
      }

      async function discard() {
        const result = await api('api/dashboard/discard', { method: 'POST', body: { id: active } })
        if (!result.ok) { setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` }); return }
        setConflict(null)
        setView('published')
        await loadList()
      }

      async function openVersions() {
        if (versions !== null) { setVersions(null); return }
        const result = await api(`api/dashboard/versions?id=${encodeURIComponent(active)}`)
        if (result.ok) setVersions(result.body.data)
      }

      async function revert(version) {
        const result = await api('api/dashboard/revert', { method: 'POST', body: { id: active, version, expected: versions?.published_version ?? undefined } })
        setVersions(null)
        if (!result.ok && result.error.code === 'base_changed') {
          setNotice({ tone: 'warn', text: t.revertRace(result.error.details?.published_version) })
        } else if (!result.ok) {
          setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` })
        } else {
          setNotice({ tone: 'info', text: t.revertedTo(version) })
        }
        await loadList()
        if (view === 'published') await loadDoc(active, 'published')
      }

      const [opening, setOpening] = useState(false)
      async function startEdit() {
        setOpening(true)
        try {
          const result = await api('api/dashboard/edit', { method: 'POST', body: { id: active } })
          if (!result.ok) { setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` }); return }
          openEditSession(result.body.data.session_id)
        } finally {
          setOpening(false)
        }
      }

      async function makeHome() {
        const result = await api('api/dashboard/home', { method: 'POST', body: { id: active } })
        if (result.ok) await loadList()
      }

      if (list === null) return h('div', { style: { ...css.root, padding: 24 } }, notice ? notice.text : t.loading)

      return h('div', { style: { ...css.root, position: 'relative' }, 'data-ours-dashboard': active ?? '' },
        h('div', { style: css.bar },
          h('div', { style: css.tabs, role: 'tablist' },
            list.data.length === 0 && h('span', { style: css.meta }, t.empty),
            list.data.map(d => h('button', {
              key: d.id, role: 'tab', 'aria-selected': d.id === active, style: css.tab(d.id === active),
              onClick: () => { setActive(d.id); setView('published'); setVersions(null); setConflict(null); setNotice(null) },
            }, d.title, list.home === d.id ? ' ★' : '', d.published_version === null ? ` (${t.unpublished})` : ''))),
          entry?.has_draft && entry.published_version !== null && h('div', { style: { display: 'flex', gap: 2 } },
            h('button', { style: css.tab(view === 'published'), onClick: () => setView('published') }, `${t.published} v${entry.published_version}`),
            h('button', { style: css.tab(view === 'draft'), onClick: () => setView('draft') }, t.draft)),
          view === 'draft' && h('button', { style: css.button('primary'), onClick: () => publish(false), 'data-action': 'publish' }, t.publish),
          view === 'draft' && h('button', { style: css.button('danger'), onClick: discard }, t.discard),
          doc !== null && h('button', { style: css.button(), onClick: () => feed?.refreshAll(), 'data-action': 'refresh' }, t.refreshAll),
          entry?.published_version !== null && entry !== undefined && list.home !== active && h('button', { style: css.button(), onClick: makeHome }, t.makeHome),
          entry?.published_version !== null && entry !== undefined && h('button', { style: css.button(), onClick: openVersions, 'data-action': 'versions' }, t.versions),
          entry !== undefined && h('button', { style: css.button('plain', opening), disabled: opening, onClick: startEdit, 'data-action': 'edit', title: opening ? t.editOpening : undefined }, t.edit)),
        versions !== null && h('div', { style: css.menu, 'data-menu': 'versions' },
          versions.versions.map(v => h('div', { key: v.version, style: css.menuRow },
            h('span', { style: { fontWeight: v.version === versions.published_version ? 600 : 400 } }, `v${v.version}`),
            h('span', { style: { ...css.meta, flex: '1 1 auto' } }, `${formatTime(v.created_at)} · ${v.title}`),
            v.version === versions.published_version
              ? h('span', { style: css.badge() }, t.current)
              : h('button', { style: css.button(), onClick: () => revert(v.version), 'data-revert': v.version }, t.revert)))),
        view === 'draft' && h('div', { style: css.notice() }, t.viewingDraft),
        conflict !== null && h('div', { style: css.notice('warn'), 'data-notice': 'base-changed' },
          h('span', { style: { flex: '1 1 auto' } }, t.baseChanged(conflict.base_version, conflict.published_version, formatTime(conflict.published_at))),
          h('button', { style: css.button('primary'), onClick: () => publish(true) }, t.overwrite),
          h('button', { style: css.button(), onClick: () => setConflict(null) }, t.cancel)),
        notice !== null && h('div', { style: css.notice(notice.tone), 'data-notice': notice.tone },
          h('span', { style: { flex: '1 1 auto' } }, notice.text),
          h('button', { style: css.button(), onClick: () => setNotice(null) }, '×')),
        h('div', { style: css.scroll }, doc !== null && feed !== null && h(Grid, { key: `${doc.id}:${doc.view}:${doc.version}:${doc.updated_at ?? ''}`, spec: doc.spec, feed })))
    }

    // ── Edit Sessions ────────────────────────────────────────────────────────
    // Sessions this page started from the edit button wait here until the
    // Session is on screen, then get the draft panel.
    const pendingPanels = new Set()
    const knownEditors = new Map()

    function openDraftTab(sessionId, attempt = 0) {
      const sidebar = clientCtx?.sidebarRight
      if (sidebar === undefined || sidebar === null) return
      if (sidebar.mounted.getSnapshot() !== sessionId) return
      try {
        sidebar.openTab(DRAFT_TAB_KIND)
      } catch (error) {
        // The Session's surface mints its store in the render after `mounted` moves.
        if (attempt < 20) setTimeout(() => openDraftTab(sessionId, attempt + 1), 100)
        else console.warn('ours-dashboard: draft panel did not open:', error)
      }
    }

    function openEditSession(sessionId) {
      knownEditors.set(sessionId, true)
      pendingPanels.add(sessionId)
      clientCtx.uiWorkspace.openSession(sessionId)
      if (clientCtx.sidebarRight.mounted.getSnapshot() === sessionId) { pendingPanels.delete(sessionId); openDraftTab(sessionId) }
    }

    async function onSessionMounted(sessionId) {
      if (sessionId === undefined) return
      if (pendingPanels.delete(sessionId)) { openDraftTab(sessionId); return }
      if (!knownEditors.has(sessionId)) {
        const result = await api(`api/dashboard/editor?session=${encodeURIComponent(sessionId)}`)
        knownEditors.set(sessionId, result.ok)
        // Reopened from the session list: show the panel once per page load.
        if (result.ok) openDraftTab(sessionId)
      }
    }

    function EditPanel({ sessionId }) {
      const [state, setState] = useState(null)
      const [notice, setNotice] = useState(null)
      const [conflict, setConflict] = useState(null)
      const [busy, setBusy] = useState(false)
      const [sql, setSql] = useState({})
      const [runtime, setRuntime] = useState(null)

      const load = useCallback(async () => {
        const result = await api(`api/dashboard/editor?session=${encodeURIComponent(sessionId)}`)
        setState(result.ok ? result.body.data : { missing: true, error: result.error })
      }, [sessionId])

      useEffect(() => {
        load()
        api('api/dashboard/list').then(result => { if (result.ok) setRuntime(result.body.runtime) })
        const timer = setInterval(() => { if (!document.hidden) load() }, EDITOR_POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const draft = state?.draft ?? null
      const stamp = draft === null ? null : `${draft.id}:${draft.updated_at}`

      // Notices describe one action on one draft revision. They go stale when the
      // agent changes the draft, and when the kept-mounted tab is shown again.
      const seenStamp = useRef(stamp)
      useEffect(() => {
        if (stamp !== null && seenStamp.current !== null && stamp !== seenStamp.current) { setNotice(null); setConflict(null) }
        seenStamp.current = stamp
      }, [stamp])
      const visibility = useRef(null)
      const rootRef = useCallback(el => {
        visibility.current?.disconnect()
        visibility.current = null
        if (el === null) return
        let shown = true
        const observer = new IntersectionObserver(entries => {
          const visible = entries.some(entry => entry.isIntersecting)
          if (visible && !shown) { setNotice(null); setConflict(null) }
          shown = visible
        })
        observer.observe(el)
        visibility.current = observer
      }, [])

      const [feed, setFeed] = useState(null)
      useEffect(() => {
        if (draft === null || runtime === null) { setFeed(null); return undefined }
        const next = new Feed(draft.spec, runtime)
        setFeed(next)
        next.start()
        return () => next.stop()
      }, [stamp, runtime === null])

      async function publish(force) {
        setBusy(true)
        try {
          const result = await api('api/dashboard/publish', { method: 'POST', body: { id: state.dashboard_id, ...force ? { force: true } : {} } })
          if (!result.ok && result.error.code === 'base_changed') { setConflict(result.error.details); return }
          setConflict(null)
          if (!result.ok && result.error.code === 'unverified_analyses') { setNotice({ tone: 'warn', text: t.publishBlocked(result.error.details?.analyses?.length ?? 0) }); await load(); return }
          if (!result.ok) { setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` }); return }
          setNotice({ tone: 'info', text: t.publishedAs(result.body.data.version) })
          await load()
        } finally { setBusy(false) }
      }

      async function discard() {
        setBusy(true)
        try {
          const result = await api('api/dashboard/discard', { method: 'POST', body: { id: state.dashboard_id } })
          if (!result.ok) setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` })
          await load()
        } finally { setBusy(false) }
      }

      async function verify(entry) {
        const version = entry.version ?? entry.latest_version
        setBusy(true)
        try {
          const result = await api('api/ao/verify', { method: 'POST', body: { analysis_id: entry.analysis_id, version } })
          if (!result.ok) { setNotice({ tone: 'error', text: `${result.error.code}: ${result.error.message}` }); return }
          const sync = result.body.data?.custom_analysis_sync
          setNotice(sync?.action === 'error'
            ? { tone: 'warn', text: `${t.verified(entry.name ?? entry.analysis_id, version)} ${t.syncFailed(sync.error?.code ?? 'failed')}` }
            : { tone: 'info', text: t.verified(entry.name ?? entry.analysis_id, version) })
          await load()
        } finally { setBusy(false) }
      }

      async function toggleSql(entry) {
        const key = `${entry.analysis_id}@${entry.version ?? ''}`
        if (sql[key] !== undefined) { setSql(({ [key]: _, ...rest }) => rest); return }
        const version = entry.version ?? entry.latest_version
        const result = await api(`api/ao/analysis?id=${encodeURIComponent(entry.analysis_id)}${version ? `&version=${version}` : ''}`)
        setSql(current => ({ ...current, [key]: result.ok ? result.body.data.version?.sql ?? '' : `${result.error.code}: ${result.error.message}` }))
      }

      if (state === null) return h('div', { style: { padding: 16, fontSize: 13 } }, t.loading)
      if (state.missing) return h('div', { style: { padding: 16, fontSize: 13 }, 'data-edit-panel': 'none' }, t.panelNone)
      const unverified = state.unverified_analyses ?? []
      return h('div', { ref: rootRef, style: { ...css.root, height: '100%' }, 'data-edit-panel': state.dashboard_id },
        h('div', { style: css.bar },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, draft?.spec.title ?? state.dashboard_id),
            draft !== null && h('div', { style: css.meta }, `${t.basedOn(draft.base_version)} · ${t.updated} ${formatTime(draft.updated_at)}`)),
          draft !== null && h('button', { style: css.button('primary', busy || unverified.length > 0), disabled: busy, onClick: () => publish(false), 'data-action': 'panel-publish', title: unverified.length > 0 ? t.publishBlocked(unverified.length) : undefined }, t.publish),
          draft !== null && h('button', { style: css.button('danger', busy), disabled: busy, onClick: discard, 'data-action': 'panel-discard' }, t.discard),
          draft !== null && feed !== null && h('button', { style: css.button(), onClick: () => feed.refreshAll() }, t.refreshAll)),
        conflict !== null && h('div', { style: css.notice('warn'), 'data-notice': 'base-changed' },
          h('span', { style: { flex: '1 1 auto' } }, t.baseChanged(conflict.base_version, conflict.published_version, formatTime(conflict.published_at))),
          h('button', { style: css.button('primary'), onClick: () => publish(true) }, t.overwrite),
          h('button', { style: css.button(), onClick: () => setConflict(null) }, t.cancel)),
        notice !== null && h('div', { style: css.notice(notice.tone), 'data-notice': notice.tone },
          h('span', { style: { flex: '1 1 auto' } }, notice.text),
          h('button', { style: css.button(), onClick: () => setNotice(null) }, '×')),
        draft === null && h('div', { style: css.notice('info'), 'data-notice': 'draft-gone' }, t.draftGone),
        unverified.length > 0 && h('div', { style: { ...css.notice('warn'), flexDirection: 'column', alignItems: 'stretch' }, 'data-unverified': unverified.length },
          h('div', { style: { fontWeight: 600 } }, t.unverifiedTitle),
          h('div', { style: { fontSize: 12 } }, t.unverifiedHelp),
          unverified.map(entry => {
            const key = `${entry.analysis_id}@${entry.version ?? ''}`
            const canVerify = entry.reason === 'draft' || (entry.reason === 'no_verified_version' && entry.latest_version)
            return h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { flex: '1 1 auto', fontSize: 12 } }, `${entry.name ?? entry.analysis_id} · v${entry.version ?? entry.latest_version ?? '?'} · ${t.reason[entry.reason] ?? entry.reason}`),
                h('button', { style: css.button(), onClick: () => toggleSql(entry) }, sql[key] !== undefined ? t.hideSql : t.showSql),
                canVerify && h('button', { style: css.button('primary', busy), disabled: busy, onClick: () => verify(entry), 'data-verify': entry.analysis_id }, t.verify)),
              sql[key] !== undefined && h('pre', { style: { margin: 0, padding: 8, fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))', borderRadius: 6, maxHeight: 200, overflow: 'auto' } }, sql[key]))
          })),
        h('div', { style: css.scroll }, draft !== null && feed !== null && h(Grid, { key: stamp, spec: draft.spec, feed })))
    }

    function DraftTabBody({ sessionId }) {
      return h(EditPanel, { key: sessionId, sessionId })
    }

    function Icon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('rect', { x: 2, y: 2, width: 5, height: 5, rx: 1, fill: 'currentColor' }), h('rect', { x: 9, y: 2, width: 5, height: 5, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 2, y: 9, width: 5, height: 5, rx: 1, fill: 'currentColor' }), h('rect', { x: 9, y: 9, width: 5, height: 5, rx: 1, fill: 'currentColor' }))
    }

    return {
      inject: ['slots', 'layout', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        clientCtx = ctx
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Dashboard))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: -100, label: () => t.dashboards,
        }, Icon))
        ctx.effect(() => ctx.sidebarRightTabs.register({ id: DRAFT_TAB_ID, kind: DRAFT_TAB_KIND, keepMounted: true, title: () => t.panelTitle }), 'ours-dashboard: draft tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: DRAFT_TAB_ID, inject: sessionId => ({ sessionId }),
        }, DraftTabBody)), 'ours-dashboard: draft tab body')
        ctx.effect(() => ctx.sidebarRight.mounted.subscribe(() => { onSessionMounted(ctx.sidebarRight.mounted.getSnapshot()) }), 'ours-dashboard: edit sessions')
        ctx.layout.selectPanel(PANEL_ID)
      },
    }
  },
})

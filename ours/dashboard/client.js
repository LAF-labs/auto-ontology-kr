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
 * overwrite. The edit button is a placeholder for the draft editor session.
 */
window.__ModuleLoader__.load({
  id: '@ours/dashboard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState, useCallback } = React

    const PANEL_ID = 'ours-dashboard'
    const OWNER_KEY = 'ours.dashboard.owner'
    const OWNER_HEADER = 'x-ours-draft-owner'
    const TICK_MS = 5000
    const LIST_POLL_MS = 30000
    const DEFAULT_REFRESH_S = 300

    const COPY = {
      ko: {
        dashboards: '대시보드', empty: '게시된 대시보드가 없습니다.', loading: '불러오는 중', refreshAll: '새로고침',
        edit: '수정', editSoon: '수정 세션은 다음 단계에서 연결됩니다', published: '게시본', draft: '내 초안',
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
        edit: 'Edit', editSoon: 'The editing session arrives in the next stage', published: 'Published', draft: 'My draft',
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
    const modules = new Map()
    function loadWidget(type, version) {
      const key = `${type}@${version}`
      if (!modules.has(key)) {
        const url = new URL(`api/dashboard/widget-module?type=${encodeURIComponent(type)}&version=${version}`, document.baseURI).href
        const promise = import(/* webpackIgnore: true */ url).then(module => {
          const widget = module.default ?? module
          if (typeof widget?.mount !== 'function') throw new Error(`${key} has no mount(el, props)`)
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
          h('button', { style: css.button('plain', true), disabled: true, title: t.editSoon }, t.edit)),
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

    function Icon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('rect', { x: 2, y: 2, width: 5, height: 5, rx: 1, fill: 'currentColor' }), h('rect', { x: 9, y: 2, width: 5, height: 5, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 2, y: 9, width: 5, height: 5, rx: 1, fill: 'currentColor' }), h('rect', { x: 9, y: 9, width: 5, height: 5, rx: 1, fill: 'currentColor' }))
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Dashboard))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: -100, label: () => t.dashboards,
        }, Icon))
        ctx.layout.selectPanel(PANEL_ID)
      },
    }
  },
})

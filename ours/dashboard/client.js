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
    const EDITOR_POLL_MS = 1000
    let clientCtx = null
    const OWNER_KEY = 'ours.dashboard.owner'
    const OWNER_HEADER = 'x-ours-draft-owner'
    const TICK_MS = 5000
    const LIST_POLL_MS = 30000
    const DEFAULT_REFRESH_S = 300

    const COPY = {
      ko: {
        dashboards: '대시보드', empty: '아직 대시보드가 없습니다.', loading: '불러오는 중', refreshAll: '새로고침', refreshing: '새로고침 중…',
        edit: '수정', editOpening: '여는 중…', published: '게시본', draft: '내 초안', draftBadge: '초안',
        emptyHelp: '대시보드가 만들어지면 이 화면에 회사의 주요 숫자가 표시됩니다.',
        panelTitle: '대시보드 초안', panelNone: '이 대화에서는 대시보드를 고칠 수 없습니다. 대시보드 화면에서 수정을 눌러 주세요.', draftGone: '이 초안은 게시되었거나 버려졌습니다. 다시 고치려면 대시보드에서 수정을 누르세요.',
        backToDashboard: '대시보드 보기',
        basedOn: v => v === 0 ? '새 대시보드' : `게시본 v${v}에서 시작`, updated: '마지막 변경', unverifiedTitle: '검증이 필요한 분석',
        unverifiedHelp: '새로 만든 분석은 사람이 확인해야 대시보드에 게시할 수 있습니다. 계산식(SQL)과 아래 미리보기 숫자를 확인한 뒤 검증을 눌러 주세요.',
        verify: '검증', showSql: 'SQL 보기', hideSql: 'SQL 닫기', verified: name => `'${name}' 분석을 검증했습니다. 이제 게시할 수 있습니다.`,
        reason: { draft: '검증 전', no_verified_version: '검증 전', not_found: '분석을 찾을 수 없음', retired: '폐기된 분석' }, reasonUnchecked: '확인하지 못함',
        publishBlocked: n => `검증되지 않은 분석이 ${n}개 있어 게시할 수 없습니다. 먼저 검증해 주세요.`, sandboxed: '격리 실행',
        syncFailed: () => '다만 이 분석을 질문 답변에 바로 쓰도록 등록하지는 못했습니다.',
        publish: '게시', discard: '초안 버리기', versions: '변경 이력', revert: '이 버전으로 되돌리기', current: '현재 게시본',
        home: '첫 화면', makeHome: '첫 화면으로 지정', isHome: '첫 화면', newVersion: () => '대시보드가 새로 게시되어 다시 불러왔습니다.',
        baseChanged: (base, now, at) => `이 초안을 고치는 동안 다른 사람이 대시보드를 새로 게시했습니다${at ? ` (${at})` : ''}. 지금 게시하면 그 변경을 덮어씁니다.`,
        overwrite: '덮어쓰고 게시', cancel: '취소', publishedAs: () => '게시했습니다. 회사 대시보드에 반영되었습니다.', revertedTo: v => `v${v} 내용으로 되돌렸습니다.`,
        revertRace: () => '그 사이 다른 사람이 새로 게시해서 되돌리지 않았습니다. 변경 이력을 다시 확인해 주세요.',
        asOf: time => `${time} 기준`, executedDetail: '계산 시각', cached: '저장된 결과 사용', analysisVersion: '분석 버전', lastSuccess: '이전 값', noValue: '아직 표시할 값이 없습니다', widgetFailed: '이 위젯을 그리지 못했습니다',
        staleNote: '새 값을 가져오지 못해 이전 값을 보여 줍니다', viewingDraft: '나에게만 보이는 초안입니다. 게시하면 회사 전체에 반영됩니다.', unpublished: '아직 게시되지 않음', next: '다음 갱신',
        close: '닫기', previewTitle: '미리보기',
        steps: {
          dashboard_read_draft: ['초안을 읽는 중', '초안을 읽음'], dashboard_edit_draft: ['초안을 고치는 중', '초안을 고침. 오른쪽 미리보기에 반영되었습니다'],
          dashboard_save_analysis: ['새 분석을 저장하고 계산해 보는 중', '새 분석을 저장함'], dashboard_save_widget_type: ['새 위젯 모양을 만드는 중', '새 위젯 모양을 만듦'],
        },
        stepRetry: '다시 시도합니다',
        errors: {
          network: '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', unreachable: '데이터 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
          timeout: '계산이 제한 시간 안에 끝나지 않았습니다.', busy: '지금 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.', not_found: '찾을 수 없습니다. 이미 지워졌을 수 있습니다.',
          not_verified: '아직 검증되지 않은 분석입니다.', db_error: '데이터베이스에서 값을 읽지 못했습니다.', session: '수정 대화를 열지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
          unauthorized: '데이터 서버 접근 권한을 확인해 주세요.', fallback: '요청을 처리하지 못했습니다.',
        },
      },
      en: {
        dashboards: 'Dashboards', empty: 'No dashboards yet.', loading: 'Loading', refreshAll: 'Refresh', refreshing: 'Refreshing…',
        edit: 'Edit', editOpening: 'Opening…', published: 'Published', draft: 'My draft', draftBadge: 'draft',
        emptyHelp: 'Once a dashboard exists, the company\'s key numbers show here.',
        panelTitle: 'Dashboard draft', backToDashboard: 'View dashboard', panelNone: 'This conversation cannot change a dashboard. Press Edit on the dashboard.', draftGone: 'This draft was published or discarded. Press Edit on the dashboard to change it again.',
        basedOn: v => v === 0 ? 'New dashboard' : `Started from v${v}`, updated: 'Last change', unverifiedTitle: 'Analyses to verify',
        unverifiedHelp: 'A draft that reads an unverified analysis cannot be published. Check the SQL and the preview, then verify.',
        verify: 'Verify', showSql: 'Show SQL', hideSql: 'Hide SQL', verified: name => `Verified '${name}'. It can be published now.`,
        reason: { draft: 'not verified', no_verified_version: 'not verified', not_found: 'analysis not found', retired: 'retired analysis' }, reasonUnchecked: 'could not check',
        publishBlocked: n => `${n} unverified analysis version(s) block publishing.`, sandboxed: 'sandboxed',
        syncFailed: () => 'It was not registered for question answering, though.',
        publish: 'Publish', discard: 'Discard draft', versions: 'Versions', revert: 'Revert to this version', current: 'current',
        home: 'Home', makeHome: 'Make first screen', isHome: 'First screen', newVersion: () => 'The dashboard was published again; reloaded.',
        baseChanged: (base, now, at) => `This draft started from v${base}, but v${now} was published since${at ? ` (${at})` : ''}. Publishing replaces it.`,
        overwrite: 'Publish anyway', cancel: 'Cancel', publishedAs: () => 'Published. The company dashboard now shows it.', revertedTo: v => `Reverted to v${v}.`,
        revertRace: () => 'Someone published meanwhile; nothing was reverted. Check the history again.',
        asOf: time => `as of ${time}`, executedDetail: 'Computed', cached: 'stored result', analysisVersion: 'analysis version', lastSuccess: 'Earlier value', noValue: 'No value to show yet', widgetFailed: 'This widget failed to render',
        staleNote: 'A new value could not be read; showing the earlier one', viewingDraft: 'Only you see this draft. Publishing shows it to the whole company.', unpublished: 'not published yet', next: 'next',
        close: 'Close', previewTitle: 'Preview',
        steps: {
          dashboard_read_draft: ['Reading the draft', 'Read the draft'], dashboard_edit_draft: ['Changing the draft', 'Changed the draft. The preview on the right shows it'],
          dashboard_save_analysis: ['Saving and trying the new analysis', 'Saved the new analysis'], dashboard_save_widget_type: ['Making the new widget type', 'Made the new widget type'],
        },
        stepRetry: 'trying again',
        errors: {
          network: 'The server could not be reached. Try again shortly.', unreachable: 'The data server could not be reached. Try again shortly.',
          timeout: 'The calculation did not finish in time.', busy: 'Too many requests right now. Try again shortly.', not_found: 'Not found. It may have been removed.',
          not_verified: 'This analysis is not verified yet.', db_error: 'The database could not be read.', session: 'The edit conversation could not be opened. Try again shortly.',
          unauthorized: 'Check the access to the data server.', fallback: 'The request could not be completed.',
        },
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

    const formatTime = (iso, seconds = false) => {
      if (typeof iso !== 'string') return ''
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', ...seconds ? { second: '2-digit' } : {} })
    }

    // What a person reads for a failure; the code and the server's message stay available as a tooltip.
    const ERROR_KIND = {
      network: 'network', http_error: 'network', unreachable: 'unreachable', gateway_error: 'unreachable', bad_response: 'unreachable',
      timeout: 'timeout', connector_timeout: 'timeout', deadline_exceeded: 'timeout', busy: 'busy', not_found: 'not_found', not_verified: 'not_verified',
      db_error: 'db_error', session_create_failed: 'session', session_prompt_failed: 'session', editing_unavailable: 'session',
      missing_token: 'unauthorized', unauthorized: 'unauthorized', forbidden: 'unauthorized',
    }
    const errorText = error => t.errors[ERROR_KIND[error?.code] ?? 'fallback']
    const errorDetail = error => `${error?.code ?? ''}${error?.message ? `: ${error.message}` : ''}`
    const errorNotice = error => ({ tone: 'error', text: errorText(error), detail: errorDetail(error) })

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
      if (message.colorScheme) document.documentElement.style.colorScheme = message.colorScheme
      if (message.kind === 'init' && handle === null) {
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

    const pageScheme = () => getComputedStyle(document.documentElement).colorScheme || 'normal'

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
        this.refreshing = false
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

      /** Run every idle widget now, bypassing stored results; `refreshing` is true until they return. */
      async refreshAll() {
        if (this.refreshing) return
        this.refreshing = true
        this.emit()
        try { await this.run(this.spec.widgets.filter(widget => !this.inFlight.has(widget.id)), true) } finally { this.refreshing = false; this.emit() }
      }

      async run(widgets, force) {
        const size = this.runtime.max_batch_items ?? 50
        for (let i = 0; i < widgets.length; i += size) await this.runBatch(widgets.slice(i, i + size), force)
      }

      async runBatch(widgets, force) {
        if (widgets.length === 0 || this.stopped) return
        for (const widget of widgets) this.inFlight.add(widget.id)
        this.emit()
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
      useEffect(() => feed?.subscribe(() => setTick(n => n + 1)) ?? undefined, [feed])
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
      spinner: { width: 10, height: 10, flex: '0 0 auto', alignSelf: 'center', borderRadius: '50%', border: '2px solid var(--dsw-alias-border-l2)', borderTopColor: 'var(--dsw-alias-label-secondary)', animation: 'ours-dashboard-spin .8s linear infinite' },
      skeleton: { borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))', animation: 'ours-dashboard-pulse 1.4s ease-in-out infinite' },
      empty: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--dsw-alias-label-secondary)', fontSize: 14, textAlign: 'center', padding: 24 },
    }
    if (document.getElementById('ours-dashboard-keyframes') === null) {
      const style = document.createElement('style')
      style.id = 'ours-dashboard-keyframes'
      style.textContent = '@keyframes ours-dashboard-spin{to{transform:rotate(360deg)}}@keyframes ours-dashboard-pulse{0%,100%{opacity:.45}50%{opacity:1}}'
      document.head.append(style)
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
            if (!cancelled) target.postMessage({ __oursWidget: true, kind: 'init', source, props, colorScheme: pageScheme() }, '*')
          }, error => { if (!cancelled) setFailure(String(error?.message ?? error)) })
        } else if (mounted) {
          target.postMessage({ __oursWidget: true, kind: 'update', props, colorScheme: pageScheme() }, '*')
        }
        return () => { cancelled = true }
      }, [ready, mounted, props, widget.type, widget.type_version])
      if (props === null) return h('div', { style: { ...css.body, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, t.noValue)
      return h('div', { style: css.body },
        failure !== null && h('div', { style: css.foot('error') }, `${t.widgetFailed}: ${failure}`),
        h('iframe', {
          ref: frame, sandbox: 'allow-scripts', srcDoc: FRAME_DOC, title: widget.title ?? widget.id, referrerPolicy: 'no-referrer',
          'data-sandboxed-widget': `${widget.type}@${widget.type_version}`,
          style: { position: 'absolute', inset: failure !== null ? '18px 0 0 0' : 0, width: '100%', height: failure !== null ? 'calc(100% - 18px)' : '100%', border: 0, background: 'transparent', colorScheme: pageScheme() },
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
          data?.status === 'draft' && h('span', { style: css.badge('warn') }, t.draftBadge),
          (state.phase === 'loading' || feed.inFlight.has(widget.id)) && h('span', { style: css.spinner, 'aria-label': t.loading, role: 'status' })),
        state.phase === 'loading' && data === null ? h('div', { style: { ...css.body, ...css.skeleton } }) : h(WidgetBody, { widget, data, theme }),
        data !== null && h('div', {
          style: css.foot(),
          title: `${t.executedDetail} ${formatTime(data.executed_at, true)}${data.cache?.hit ? ` · ${t.cached}` : ''}${data.version ? ` · ${t.analysisVersion} v${data.version}` : ''}`,
        }, t.asOf(formatTime(data.executed_at))),
        stale && h('div', { style: css.foot('error'), title: errorDetail(state.error) }, data === null ? errorText(state.error) : `${t.staleNote} · ${errorText(state.error)}`))
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
      useFeed(feed)

      const loadList = useCallback(async () => {
        const result = await api('api/dashboard/list')
        if (!result.ok) { setNotice(errorNotice(result.error)); return null }
        setList(result.body)
        return result.body
      }, [])

      const loadDoc = useCallback(async (id, which) => {
        if (id === null) { setDoc(null); return }
        const result = await api(`api/dashboard/get?id=${encodeURIComponent(id)}&view=${which}`)
        if (!result.ok) { setNotice(errorNotice(result.error)); setDoc(null); return }
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
            setNotice({ tone: 'info', text: t.newVersion() })
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
        if (!result.ok) { setNotice(errorNotice(result.error)); return }
        setNotice({ tone: 'info', text: t.publishedAs() })
        setView('published')
        await loadList()
        await loadDoc(active, 'published')
      }

      async function discard() {
        const result = await api('api/dashboard/discard', { method: 'POST', body: { id: active } })
        if (!result.ok) { setNotice(errorNotice(result.error)); return }
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
          setNotice({ tone: 'warn', text: t.revertRace() })
        } else if (!result.ok) {
          setNotice(errorNotice(result.error))
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
          if (!result.ok) { setNotice(errorNotice(result.error)); return }
          openEditSession(result.body.data.session_id)
        } finally {
          setOpening(false)
        }
      }

      async function makeHome() {
        const result = await api('api/dashboard/home', { method: 'POST', body: { id: active } })
        if (result.ok) await loadList()
      }

      if (list === null) return h('div', { style: css.root }, h('div', { style: css.empty }, notice ? notice.text : t.loading))

      return h('div', { style: { ...css.root, position: 'relative' }, 'data-ours-dashboard': active ?? '' },
        h('div', { style: css.bar },
          h('div', { style: css.tabs, role: 'tablist' },
            list.data.map(d => h('button', {
              key: d.id, role: 'tab', 'aria-selected': d.id === active, style: css.tab(d.id === active),
              onClick: () => { setActive(d.id); setView('published'); setVersions(null); setConflict(null); setNotice(null) },
            }, d.title, list.home === d.id ? ' ★' : '', d.published_version === null ? ` (${t.unpublished})` : ''))),
          entry?.has_draft && entry.published_version !== null && h('div', { style: { display: 'flex', gap: 2 } },
            h('button', { style: css.tab(view === 'published'), onClick: () => setView('published') }, `${t.published} v${entry.published_version}`),
            h('button', { style: css.tab(view === 'draft'), onClick: () => setView('draft') }, t.draft)),
          view === 'draft' && h('button', { style: css.button('primary'), onClick: () => publish(false), 'data-action': 'publish' }, t.publish),
          view === 'draft' && h('button', { style: css.button('danger'), onClick: discard }, t.discard),
          doc !== null && h('button', { style: css.button('plain', feed?.refreshing === true), disabled: feed?.refreshing === true, onClick: () => feed?.refreshAll(), 'data-action': 'refresh' }, feed?.refreshing === true ? t.refreshing : t.refreshAll),
          entry?.published_version !== null && entry !== undefined && list.home !== active && h('button', { style: css.button(), onClick: makeHome }, t.makeHome),
          entry?.published_version !== null && entry !== undefined && h('button', { style: css.button(), onClick: openVersions, 'data-action': 'versions' }, t.versions),
          entry !== undefined && h('button', { style: css.button('plain', opening), disabled: opening, onClick: startEdit, 'data-action': 'edit' }, opening ? t.editOpening : t.edit)),
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
          h('span', { style: { flex: '1 1 auto' }, title: notice.detail }, notice.text),
          h('button', { style: css.button(), onClick: () => setNotice(null), 'aria-label': t.close }, '×')),
        list.data.length === 0
          ? h('div', { style: css.empty, 'data-empty': 'dashboards' }, h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t.empty), h('div', null, t.emptyHelp))
          : h('div', { style: css.scroll }, doc !== null && feed !== null && h(Grid, { key: `${doc.id}:${doc.view}:${doc.version}:${doc.updated_at ?? ''}`, spec: doc.spec, feed })))
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

      const onScreen = useRef(true)
      const loading = useRef(false)
      const load = useCallback(async (fresh = false) => {
        if (loading.current && !fresh) return
        loading.current = true
        try {
          const result = await api(`api/dashboard/editor?session=${encodeURIComponent(sessionId)}${fresh ? '&fresh=1' : ''}`)
          // A failed poll keeps what is on screen; only a definite answer replaces it.
          if (result.ok) setState(result.body.data)
          else if (result.status === 404) setState({ missing: true })
          else setState(current => current ?? { missing: true })
        } finally { loading.current = false }
      }, [sessionId])

      useEffect(() => {
        load()
        api('api/dashboard/list').then(result => { if (result.ok) setRuntime(result.body.runtime) })
        const timer = setInterval(() => { if (!document.hidden && onScreen.current) load() }, EDITOR_POLL_MS)
        const onChanged = () => { if (onScreen.current) load(true) }
        window.addEventListener(DRAFT_CHANGED, onChanged)
        return () => { clearInterval(timer); window.removeEventListener(DRAFT_CHANGED, onChanged) }
      }, [load])

      const draft = state?.draft ?? null
      const stamp = draft === null ? null : `${draft.id}:${draft.updated_at}`
      const lastTitle = useRef(null)
      if (draft !== null) lastTitle.current = draft.spec.title

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
          if (visible && !shown) { setNotice(null); setConflict(null); load() }
          shown = visible
          onScreen.current = visible
        })
        observer.observe(el)
        visibility.current = observer
      }, [load])

      const [feed, setFeed] = useState(null)
      useFeed(feed)
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
          if (!result.ok && result.error.code === 'unverified_analyses') { setNotice({ tone: 'warn', text: t.publishBlocked(result.error.details?.analyses?.length ?? 0) }); await load(true); return }
          if (!result.ok) { setNotice(errorNotice(result.error)); return }
          setNotice({ tone: 'info', text: t.publishedAs() })
          await load()
        } finally { setBusy(false) }
      }

      async function discard() {
        setBusy(true)
        try {
          const result = await api('api/dashboard/discard', { method: 'POST', body: { id: state.dashboard_id } })
          if (!result.ok) setNotice(errorNotice(result.error))
          await load()
        } finally { setBusy(false) }
      }

      async function verify(entry) {
        const version = entry.version ?? entry.latest_version
        setBusy(true)
        try {
          const result = await api('api/ao/verify', { method: 'POST', body: { analysis_id: entry.analysis_id, version } })
          if (!result.ok) { setNotice(errorNotice(result.error)); return }
          const sync = result.body.data?.custom_analysis_sync
          setNotice(sync?.action === 'error'
            ? { tone: 'warn', text: `${t.verified(entry.name ?? entry.analysis_id)} ${t.syncFailed()}`, detail: errorDetail(sync.error) }
            : { tone: 'info', text: t.verified(entry.name ?? entry.analysis_id) })
          await load(true)
        } finally { setBusy(false) }
      }

      async function toggleSql(entry) {
        const key = `${entry.analysis_id}@${entry.version ?? ''}`
        if (sql[key] !== undefined) { setSql(({ [key]: _, ...rest }) => rest); return }
        const version = entry.version ?? entry.latest_version
        const result = await api(`api/ao/analysis?id=${encodeURIComponent(entry.analysis_id)}${version ? `&version=${version}` : ''}`)
        setSql(current => ({ ...current, [key]: result.ok ? result.body.data.version?.sql ?? '' : errorText(result.error) }))
      }

      if (state === null) return h('div', { style: { padding: 16, fontSize: 13 } }, t.loading)
      if (state.missing) return h('div', { style: { padding: 16, fontSize: 13 }, 'data-edit-panel': 'none' }, t.panelNone)
      const unverified = state.unverified_analyses ?? []
      return h('div', { ref: rootRef, style: { ...css.root, height: '100%' }, 'data-edit-panel': state.dashboard_id },
        h('div', { style: css.bar },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, draft?.spec.title ?? lastTitle.current ?? t.panelTitle),
            draft !== null && h('div', { style: css.meta }, `${t.basedOn(draft.base_version)} · ${t.updated} ${formatTime(draft.updated_at)}`)),
          draft !== null && h('button', { style: css.button('primary', busy || unverified.length > 0), disabled: busy, onClick: () => publish(false), 'data-action': 'panel-publish', title: unverified.length > 0 ? t.publishBlocked(unverified.length) : undefined }, t.publish),
          draft !== null && h('button', { style: css.button('danger', busy), disabled: busy, onClick: discard, 'data-action': 'panel-discard' }, t.discard),
          draft !== null && feed !== null && h('button', { style: css.button('plain', feed.refreshing), disabled: feed.refreshing, onClick: () => feed.refreshAll() }, feed.refreshing ? t.refreshing : t.refreshAll)),
        conflict !== null && h('div', { style: css.notice('warn'), 'data-notice': 'base-changed' },
          h('span', { style: { flex: '1 1 auto' } }, t.baseChanged(conflict.base_version, conflict.published_version, formatTime(conflict.published_at))),
          h('button', { style: css.button('primary'), onClick: () => publish(true) }, t.overwrite),
          h('button', { style: css.button(), onClick: () => setConflict(null) }, t.cancel)),
        notice !== null && h('div', { style: css.notice(notice.tone), 'data-notice': notice.tone },
          h('span', { style: { flex: '1 1 auto' }, title: notice.detail }, notice.text),
          h('button', { style: css.button(), onClick: () => setNotice(null), 'aria-label': t.close }, '×')),
        draft === null && h('div', { style: css.notice('info'), 'data-notice': 'draft-gone' },
          h('span', { style: { flex: '1 1 auto' } }, t.draftGone),
          h('button', { style: css.button('primary'), onClick: () => clientCtx?.layout.selectPanel(PANEL_ID) }, t.backToDashboard)),
        unverified.length > 0 && h('div', { style: { ...css.notice('warn'), flexDirection: 'column', alignItems: 'stretch' }, 'data-unverified': unverified.length },
          h('div', { style: { fontWeight: 600 } }, t.unverifiedTitle),
          h('div', { style: { fontSize: 12 } }, t.unverifiedHelp),
          unverified.map(entry => {
            const key = `${entry.analysis_id}@${entry.version ?? ''}`
            const canVerify = entry.reason === 'draft' || (entry.reason === 'no_verified_version' && entry.latest_version)
            return h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { flex: '1 1 auto', fontSize: 12 }, title: `v${entry.version ?? entry.latest_version ?? '?'} · ${entry.reason}` }, `${entry.name ?? entry.analysis_id} · ${t.reason[entry.reason] ?? t.reasonUnchecked}`),
                h('button', { style: css.button(), onClick: () => toggleSql(entry) }, sql[key] !== undefined ? t.hideSql : t.showSql),
                canVerify && h('button', { style: css.button('primary', busy), disabled: busy, onClick: () => verify(entry), 'data-verify': entry.analysis_id }, t.verify)),
              sql[key] !== undefined && h('pre', { style: { margin: 0, padding: 8, fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))', borderRadius: 6, maxHeight: 200, overflow: 'auto' } }, sql[key]))
          })),
        h('div', { style: css.scroll }, draft !== null && feed !== null && h(Grid, { key: stamp, spec: draft.spec, feed })))
    }

    // ── Editing tool rows in the conversation ────────────────────────────────
    const DRAFT_CHANGED = 'ours-dashboard:draft-changed'
    const parseJson = text => { try { const value = JSON.parse(text ?? ''); return value !== null && typeof value === 'object' ? value : {} } catch { return {} } }

    /** One line per editing tool call, in the reader's words. A finished call tells the draft panel to reload now. */
    function EditStep({ phase, block, toolName }) {
      const settled = phase === 'result'
      const args = parseJson(settled ? block.call?.argsRaw : block.argsRaw)
      const output = settled ? parseJson((block.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('')) : null
      const failed = settled && output?.ok !== true
      useEffect(() => { if (settled) window.dispatchEvent(new Event(DRAFT_CHANGED)) }, [settled])
      const [doing, done] = t.steps[toolName] ?? [toolName, toolName]
      const subject = toolName === 'dashboard_save_analysis' ? args.name : toolName === 'dashboard_save_widget_type' ? args.description : undefined
      return h('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: '0 8px', fontSize: 13, lineHeight: 1.5, padding: '2px 0', opacity: 0.65 },
        'data-edit-step': toolName, 'data-state': !settled ? 'running' : failed ? 'error' : 'ok',
        title: failed ? `${output?.error?.code ?? ''} ${output?.error?.message ?? ''}`.trim() : undefined,
      },
        h('span', null, !settled ? `${doing}…` : failed ? `${doing}… ${t.stepRetry}` : done),
        typeof subject === 'string' && subject !== '' && h('span', { style: { fontWeight: 600, maxWidth: '36em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, subject))
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
        for (const key of Object.keys(COPY.en.steps)) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, EditStep))
        }
        ctx.effect(() => ctx.sidebarRight.mounted.subscribe(() => { onSessionMounted(ctx.sidebarRight.mounted.getSnapshot()) }), 'ours-dashboard: edit sessions')
        ctx.layout.selectPanel(PANEL_ID)
      },
    }
  },
})

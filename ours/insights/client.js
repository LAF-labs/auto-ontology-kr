/**
 * Browser half of @ours/insights: two `main` panels in the sidebar list.
 *
 * Reports: saved reports newest first; a report shows its text with each
 * figure value from the stored run result, a numbered source note per figure
 * (analysis name, version, verification, parameters, execution time, cache),
 * and what started it (a scheduled task or a session). Text is rendered as
 * React elements from a small Markdown subset; nothing is set as HTML.
 *
 * Alerts: firings newest first with an unread count (also on the sidebar
 * icon), "원인 분석" that opens an analysis Session with the firing as context
 * (the only step that uses a model), the rules with their state, turning a
 * pending rule (proposed by an agent) on, pausing, evaluating now, deleting,
 * and a form for a person's rule on a verified saved analysis.
 */
window.__ModuleLoader__.load({
  id: '@ours/insights',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback } = React

    const REPORTS_PANEL = 'ours-reports'
    const ALERTS_PANEL = 'ours-alerts'
    const UNREAD_POLL_MS = 15000
    const LIST_POLL_MS = 15000
    let clientCtx = null

    const COPY = {
      ko: {
        reports: '보고서', alerts: '알림', noReports: '저장된 보고서가 없습니다. 분석 세션에서 보고서를 저장하거나 예약을 만드세요.',
        pick: '왼쪽에서 보고서를 고르세요.', sources: '출처', verified: '검증됨', unverified: '검증 안 됨', cached: '캐시', fresh: '새로 실행',
        executed: '실행', params: '파라미터', bySchedule: t => `예약: ${t}`, bySession: '세션에서 저장', openSession: '세션 열기',
        allVerified: '모든 수치가 검증된 분석', someUnverified: '검증 안 된 분석 포함', change: '변화', rowsShown: (s, n) => `${n}행 중 ${s}행`,
        unread: n => `읽지 않은 알림 ${n}개`, markAll: '모두 읽음', markRead: '읽음', investigate: '원인 분석', investigating: '세션을 여는 중',
        reopen: '분석 세션 열기', firings: '발생 이력', noFirings: '발생한 알림이 없습니다.', rules: '규칙', noRules: '규칙이 없습니다.',
        status: { pending: '확인 대기', active: '켜짐', paused: '꺼짐' }, byAgent: '에이전트 제안', byPerson: '사람이 만듦',
        turnOn: '켜기', pause: '끄기', evaluate: '지금 평가', remove: '삭제', confirmRemove: '이 규칙을 삭제할까요?',
        pendingHelp: '에이전트가 제안한 규칙입니다. 분석과 조건을 확인한 뒤 켜면 평가가 시작됩니다.',
        every: s => s % 3600 === 0 ? `${s / 3600}시간마다` : `${Math.round(s / 60)}분마다`, lastValue: '마지막 값', lastEval: '마지막 평가', never: '평가 전',
        previous: '직전', newRule: '새 규칙', create: '만들기', cancel: '취소', name: '이름', analysis: '분석(검증된 것만)', column: '값 열', row: '행 번호',
        kind: '조건', threshold: '임계값', changeKind: '직전 기간 대비 변화율', op: '비교', value: '값', percent: '변화율(%)', previousParams: '직전 기간 파라미터',
        interval: '평가 간격(분)', paramHint: '비우면 기본값', limits: l => `규칙 최대 ${l.max_rules}개, 평가 간격 최소 ${Math.round(l.min_interval_s / 60)}분`,
        evaluated: s => `평가 ${s.evaluated}건, 발생 ${s.fired}건, 오류 ${s.errors}건`, error: '오류', firedAt: '발생',
      },
      en: {
        reports: 'Reports', alerts: 'Alerts', noReports: 'No saved reports. Save one from an analysis session or create a schedule.',
        pick: 'Pick a report on the left.', sources: 'Sources', verified: 'verified', unverified: 'unverified', cached: 'cached', fresh: 'fresh run',
        executed: 'Ran', params: 'Parameters', bySchedule: t => `Schedule: ${t}`, bySession: 'Saved from a session', openSession: 'Open session',
        allVerified: 'Every value from a verified analysis', someUnverified: 'Includes unverified analyses', change: 'change', rowsShown: (s, n) => `${s} of ${n} rows`,
        unread: n => `${n} unread alert(s)`, markAll: 'Mark all read', markRead: 'Read', investigate: 'Investigate', investigating: 'Opening a session',
        reopen: 'Open analysis session', firings: 'Firings', noFirings: 'No alerts fired.', rules: 'Rules', noRules: 'No rules.',
        status: { pending: 'awaiting review', active: 'on', paused: 'off' }, byAgent: 'proposed by an agent', byPerson: 'made by a person',
        turnOn: 'Turn on', pause: 'Pause', evaluate: 'Evaluate now', remove: 'Delete', confirmRemove: 'Delete this rule?',
        pendingHelp: 'An agent proposed this rule. Check the analysis and condition, then turn it on to start evaluating.',
        every: s => s % 3600 === 0 ? `every ${s / 3600} h` : `every ${Math.round(s / 60)} min`, lastValue: 'Last value', lastEval: 'Last evaluated', never: 'not evaluated',
        previous: 'previous', newRule: 'New rule', create: 'Create', cancel: 'Cancel', name: 'Name', analysis: 'Analysis (verified only)', column: 'Value column', row: 'Row',
        kind: 'Condition', threshold: 'Threshold', changeKind: 'Change against the previous period', op: 'Compare', value: 'Value', percent: 'Change (%)', previousParams: 'Previous period parameters',
        interval: 'Interval (minutes)', paramHint: 'blank: default', limits: l => `At most ${l.max_rules} rules; interval at least ${Math.round(l.min_interval_s / 60)} min`,
        evaluated: s => `${s.evaluated} evaluated, ${s.fired} fired, ${s.errors} error(s)`, error: 'Error', firedAt: 'Fired',
      },
    }
    const t = String(globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ko') ? COPY.ko : COPY.en
    const locale = globalThis.navigator?.language

    async function api(path, body) {
      const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      let json
      try { json = await response.json() } catch { json = undefined }
      if (!response.ok) {
        const error = json?.error ?? {}
        return { ok: false, error: { code: error.code ?? 'http_error', message: error.message ?? `HTTP ${response.status}`, details: error.details ?? null } }
      }
      return { ok: true, body: json }
    }

    const formatTime = iso => {
      if (typeof iso !== 'string') return ''
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }
    const formatCell = (cell, unit) => {
      if (cell === null || cell === undefined) return '—'
      const number = typeof cell === 'number' ? cell : typeof cell === 'string' && /^-?\d+(\.\d+)?$/.test(cell) ? Number(cell) : null
      if (number === null) return String(cell)
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(number)}${unit ?? ''}`
    }
    const paramsText = params => Object.entries(params ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(', ')

    const css = {
      root: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' },
      bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap' },
      title: { fontWeight: 600, fontSize: 15, flex: '1 1 auto' },
      split: { flex: '1 1 auto', display: 'flex', minHeight: 0 },
      list: { width: 300, flex: '0 0 auto', borderRight: '1px solid var(--dsw-alias-border-l1)', overflow: 'auto' },
      item: active => ({ padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer', background: active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent' }),
      scroll: { flex: '1 1 auto', overflow: 'auto', padding: '16px 24px', minHeight: 0, minWidth: 0 },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '10px 12px', marginBottom: 10 },
      button: (kind = 'plain', disabled = false) => ({
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 10px', font: 'inherit', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        background: kind === 'primary' ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary))' : 'transparent',
        color: kind === 'primary' ? 'var(--dsw-alias-label-primary-inverted, #fff)' : kind === 'danger' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
      }),
      badge: tone => ({ fontSize: 11, padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)',
        background: tone === 'ok' ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)' : tone === 'warn' ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent)' : tone === 'error' ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent)' : 'var(--dsw-alias-bg-layer-2)' }),
      notice: tone => ({ margin: '8px 16px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center',
        background: tone === 'error' ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)' : 'var(--dsw-alias-bg-layer-1)' }),
      figure: verified => ({ fontWeight: 600, borderBottom: `1px dotted ${verified ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'}`, cursor: 'help' }),
      table: { borderCollapse: 'collapse', fontSize: 12, margin: '8px 0' },
      cell: { border: '1px solid var(--dsw-alias-border-l1)', padding: '4px 8px', textAlign: 'left' },
      field: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, minWidth: 140 },
      input: { font: 'inherit', fontSize: 12, padding: '4px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
    }

    function openSession(sessionId) {
      clientCtx?.uiWorkspace.openSession(sessionId)
    }

    // ── Unread count shared by the sidebar icon and the Alerts panel ─────────
    const unread = { value: 0, listeners: new Set(), timer: null }
    async function refreshUnread() {
      const result = await api('api/insights/unread')
      if (result.ok && result.body.unread !== unread.value) { unread.value = result.body.unread; for (const fn of unread.listeners) fn(unread.value) }
    }
    function useUnread() {
      const [value, setValue] = useState(unread.value)
      useEffect(() => {
        unread.listeners.add(setValue)
        if (unread.timer === null) { refreshUnread(); unread.timer = setInterval(refreshUnread, UNREAD_POLL_MS) }
        return () => { unread.listeners.delete(setValue); if (unread.listeners.size === 0) { clearInterval(unread.timer); unread.timer = null } }
      }, [])
      return value
    }

    // ── Report text: a Markdown subset with figure placeholders ──────────────
    function inline(text, ctx, keyBase) {
      const parts = []
      const re = /\{\{\s*fig:([A-Za-z][A-Za-z0-9_-]{0,39})\s*\}\}|\*\*([^*]+)\*\*|`([^`]+)`/g
      let last = 0
      let match
      let i = 0
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index))
        const key = `${keyBase}-${i++}`
        if (match[1] !== undefined) parts.push(h(FigureInline, { key, id: match[1], ctx }))
        else if (match[2] !== undefined) parts.push(h('strong', { key }, match[2]))
        else parts.push(h('code', { key, style: { fontSize: '0.92em' } }, match[3]))
        last = re.lastIndex
      }
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }

    function FigureInline({ id, ctx }) {
      const figure = ctx.report.figures[id]
      const note = ctx.order.indexOf(id) + 1
      if (figure === undefined) return h('span', null, '—')
      if (figure.kind === 'table') return h(FigureTable, { figure, note })
      const verified = figure.kind === 'change' ? figure.verified : figure.analysis.verified
      const tip = figure.kind === 'change' ? `${figure.from} → ${figure.to}` : `${figure.analysis.name ?? figure.analysis.id} v${figure.analysis.version} · ${paramsText(figure.params)} · ${formatTime(figure.executed_at)}`
      return h('span', { 'data-figure': id },
        h('span', { style: css.figure(verified), title: tip }, figure.text),
        h('sup', { style: { fontSize: 10, marginLeft: 1 } }, h('a', { href: `#src-${id}`, style: { color: 'inherit' } }, `[${note}]`)))
    }

    function FigureTable({ figure, note }) {
      return h('span', { style: { display: 'block' }, 'data-figure': figure.id },
        h('table', { style: css.table },
          h('thead', null, h('tr', null, figure.table.columns.map((c, i) => h('th', { key: i, style: css.cell }, c.label ?? c.name)))),
          h('tbody', null, figure.table.rows.map((row, r) => h('tr', { key: r }, row.map((cell, i) => h('td', { key: i, style: css.cell }, formatCell(cell, figure.table.columns[i].unit))))))),
        h('span', { style: css.meta }, `${figure.table.shown < figure.table.row_count ? `${t.rowsShown(figure.table.shown, figure.table.row_count)} · ` : ''}`, h('a', { href: `#src-${figure.id}`, style: { color: 'inherit' } }, `[${note}]`)))
    }

    function ReportBody({ report }) {
      const order = [...new Set([...report.body.matchAll(/\{\{\s*fig:([A-Za-z][A-Za-z0-9_-]{0,39})\s*\}\}/g)].map(m => m[1]))]
      const ctx = { report, order }
      const blocks = []
      let list = null
      const flush = () => { if (list !== null) { blocks.push(h(list.ordered ? 'ol' : 'ul', { key: `l${blocks.length}` }, list.items)); list = null } }
      report.body.split('\n').forEach((line, index) => {
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
        const numbered = /^\s*\d+\.\s+(.*)$/.exec(line)
        if (heading) { flush(); blocks.push(h(`h${Math.min(heading[1].length + 1, 5)}`, { key: index, style: { margin: '14px 0 6px' } }, inline(heading[2], ctx, index))); return }
        if (bullet || numbered) {
          const ordered = numbered !== null
          if (list !== null && list.ordered !== ordered) flush()
          if (list === null) list = { ordered, items: [] }
          list.items.push(h('li', { key: index }, inline((bullet ?? numbered)[1], ctx, index)))
          return
        }
        flush()
        if (line.trim() === '') return
        blocks.push(h('p', { key: index, style: { margin: '6px 0', lineHeight: 1.6 } }, inline(line, ctx, index)))
      })
      flush()
      return h('div', { style: { fontSize: 14 } }, blocks,
        order.length > 0 && h('div', { style: { marginTop: 18, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } },
          h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, t.sources),
          order.map((id, i) => h(SourceNote, { key: id, figure: report.figures[id], note: i + 1 }))))
    }

    function SourceNote({ figure, note }) {
      if (figure === undefined) return null
      if (figure.kind === 'change') {
        return h('div', { id: `src-${figure.id}`, style: { fontSize: 12, margin: '4px 0' }, 'data-source': figure.id }, `[${note}] ${t.change}: ${figure.from} → ${figure.to} = ${figure.text}`)
      }
      const a = figure.analysis
      return h('div', { id: `src-${figure.id}`, style: { fontSize: 12, margin: '4px 0', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, 'data-source': figure.id },
        h('span', null, `[${note}] ${a.name ?? a.id} v${a.version}`),
        h('span', { style: css.badge(a.verified ? 'ok' : 'warn') }, a.verified ? t.verified : `${t.unverified} (${a.status})`),
        h('span', { style: css.meta }, `${t.params}: ${paramsText(figure.params) || '—'}`),
        h('span', { style: css.meta }, `${t.executed} ${formatTime(figure.executed_at)} · ${figure.cache_hit ? t.cached : t.fresh}`),
        figure.kind === 'value' && figure.column?.name && h('span', { style: css.meta }, `${figure.column.label ?? figure.column.name}${figure.selector?.where ? ` (${paramsText(figure.selector.where)})` : figure.selector?.row ? ` (row ${figure.selector.row})` : ''}`))
    }

    function triggerBadge(report) {
      return report.trigger?.kind === 'schedule' ? h('span', { style: css.badge('ok') }, t.bySchedule(report.trigger.schedule_title)) : h('span', { style: css.badge() }, t.bySession)
    }

    function ReportsPanel() {
      const [list, setList] = useState(null)
      const [selected, setSelected] = useState(null)
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)
      const load = useCallback(async () => {
        const result = await api('api/insights/reports?limit=200')
        if (!result.ok) { setError(result.error); return }
        setError(null)
        setList(result.body.data)
        setSelected(current => current ?? result.body.data[0]?.id ?? null)
      }, [])
      useEffect(() => { load(); const timer = setInterval(load, LIST_POLL_MS); return () => clearInterval(timer) }, [load])
      useEffect(() => {
        if (selected === null) { setReport(null); return }
        let cancelled = false
        api(`api/insights/report?id=${encodeURIComponent(selected)}`).then(result => { if (!cancelled) setReport(result.ok ? result.body.data : null) })
        return () => { cancelled = true }
      }, [selected])
      return h('div', { style: css.root, 'data-panel': REPORTS_PANEL },
        h('div', { style: css.bar }, h('div', { style: css.title }, t.reports), list !== null && h('span', { style: css.meta }, `${list.length}`)),
        error !== null && h('div', { style: css.notice('error') }, `${error.code}: ${error.message}`),
        list !== null && list.length === 0 && h('div', { style: { padding: 16, fontSize: 13 } }, t.noReports),
        list !== null && list.length > 0 && h('div', { style: css.split },
          h('div', { style: css.list },
            list.map(row => h('div', { key: row.id, style: css.item(row.id === selected), onClick: () => setSelected(row.id), 'data-report': row.id },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 3 } }, row.title),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                h('span', { style: css.meta }, formatTime(row.created_at)), triggerBadge(row),
                !row.all_verified && h('span', { style: css.badge('warn') }, t.someUnverified))))),
          h('div', { style: css.scroll },
            report === null ? h('div', { style: { fontSize: 13 } }, t.pick) : h('div', { 'data-report-view': report.id },
              h('h2', { style: { margin: '0 0 6px', fontSize: 20 } }, report.title),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 } },
                h('span', { style: css.meta }, formatTime(report.created_at)), triggerBadge(report),
                h('span', { style: css.badge(Object.values(report.figures).every(f => f.kind === 'change' || f.analysis.verified) ? 'ok' : 'warn') },
                  Object.values(report.figures).every(f => f.kind === 'change' || f.analysis.verified) ? t.allVerified : t.someUnverified),
                report.session_id && h('button', { style: css.button(), onClick: () => openSession(report.session_id) }, t.openSession)),
              h(ReportBody, { report })))))
    }

    // ── Alerts ───────────────────────────────────────────────────────────────
    function conditionText(rule) {
      const c = rule.condition
      if (c.kind === 'threshold') return `${c.op} ${formatCell(c.value)}`
      return `${t.changeKind} ${c.op} ${c.percent}% (${t.previous}: ${paramsText(c.previous_params)})`
    }

    function FiringCard({ firing, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      async function investigate() {
        setBusy(true)
        try {
          const result = await api('api/insights/investigate', { firing_id: firing.id })
          if (!result.ok) { setError(result.error); return }
          openSession(result.body.data.session_id)
          await refreshUnread()
          onChanged()
        } finally { setBusy(false) }
      }
      async function markRead() {
        await api('api/insights/read', { ids: [firing.id] }); await refreshUnread(); onChanged()
      }
      const unreadNow = firing.read_at === null
      return h('div', { style: { ...css.card, borderLeft: unreadNow ? '3px solid var(--dsw-alias-state-warn-primary)' : css.card.border }, 'data-firing': firing.id, 'data-unread': unreadNow ? '1' : '0' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, fontSize: 14 } }, firing.rule_name),
          h('span', { style: css.meta }, `${t.firedAt} ${formatTime(firing.fired_at)}`),
          h('span', { style: { flex: '1 1 auto' } }),
          unreadNow && h('button', { style: css.button(), onClick: markRead }, t.markRead),
          h('button', { style: css.button('primary', busy), disabled: busy, onClick: investigate, 'data-action': 'investigate' },
            busy ? t.investigating : firing.investigation_session_id ? t.reopen : t.investigate)),
        h('div', { style: { fontSize: 14, margin: '6px 0' } },
          h('strong', null, firing.value_text), ` ${firing.column?.label ?? firing.column?.name ?? ''} · ${firing.condition_text}`,
          firing.previous_value_text !== null && ` · ${t.previous} ${firing.previous_value_text}`, firing.change_text !== null && ` (${firing.change_text})`),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h('span', { style: { fontSize: 12 } }, `${firing.analysis.name ?? firing.analysis.id} v${firing.analysis.version}`),
          h('span', { style: css.badge(firing.analysis.verified ? 'ok' : 'warn') }, firing.analysis.verified ? t.verified : t.unverified),
          h('span', { style: css.meta }, `${t.params}: ${paramsText(firing.params) || '—'} · ${t.executed} ${formatTime(firing.executed_at)}`)),
        error !== null && h('div', { style: { ...css.meta, color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } }, `${error.code}: ${error.message}`))
    }

    function RuleCard({ rule, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      async function act(path, body) {
        setBusy(true)
        try {
          const result = await api(path, body)
          if (!result.ok) setMessage({ tone: 'error', text: `${result.error.code}: ${result.error.message}` })
          else if (result.body.data?.summary) setMessage({ tone: 'info', text: t.evaluated(result.body.data.summary) })
          else setMessage(null)
          await refreshUnread()
          onChanged()
        } finally { setBusy(false) }
      }
      const s = rule.state
      return h('div', { style: css.card, 'data-rule': rule.id, 'data-status': rule.status },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, fontSize: 13 } }, rule.name),
          h('span', { style: css.badge(rule.status === 'active' ? 'ok' : rule.status === 'pending' ? 'warn' : undefined) }, t.status[rule.status]),
          h('span', { style: css.meta }, rule.created_by === 'agent' ? t.byAgent : t.byPerson),
          h('span', { style: { flex: '1 1 auto' } }),
          rule.status !== 'active' && h('button', { style: css.button('primary', busy), disabled: busy, onClick: () => act('api/insights/rule-update', { id: rule.id, status: 'active' }), 'data-action': 'turn-on' }, t.turnOn),
          rule.status === 'active' && h('button', { style: css.button('plain', busy), disabled: busy, onClick: () => act('api/insights/rule-update', { id: rule.id, status: 'paused' }) }, t.pause),
          h('button', { style: css.button('plain', busy), disabled: busy, onClick: () => act('api/insights/evaluate', { id: rule.id }), 'data-action': 'evaluate' }, t.evaluate),
          h('button', { style: css.button('danger', busy), disabled: busy, onClick: () => { if (globalThis.confirm(t.confirmRemove)) act('api/insights/rule-delete', { id: rule.id }) } }, t.remove)),
        rule.status === 'pending' && h('div', { style: { fontSize: 12, margin: '6px 0', color: 'var(--dsw-alias-label-secondary)' } }, t.pendingHelp),
        h('div', { style: { fontSize: 12, marginTop: 4 } },
          `${rule.analysis_name ?? rule.analysis_id}${rule.version ? ` v${rule.version}` : ''} · ${rule.value.column}${rule.value.where ? ` (${paramsText(rule.value.where)})` : ''}${rule.value.reduce && rule.value.reduce !== 'first' ? ` ${rule.value.reduce}` : ''} ${conditionText(rule)} · ${t.every(rule.interval_s)}`),
        h('div', { style: css.meta }, `${t.params}: ${paramsText(rule.params) || '—'}`),
        h('div', { style: css.meta }, s.last_evaluated_at === null ? t.never : `${t.lastEval} ${formatTime(s.last_evaluated_at)} · ${t.lastValue} ${formatCell(s.last_value)}${s.previous_value !== null ? ` (${t.previous} ${formatCell(s.previous_value)})` : ''}`),
        s.last_error && h('div', { style: { ...css.meta, color: 'var(--dsw-alias-state-error-primary)' } }, `${t.error}: ${s.last_error.code}: ${s.last_error.message}`),
        message !== null && h('div', { style: { ...css.meta, color: message.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : undefined } }, message.text))
    }

    function ParamInputs({ defs, values, onChange }) {
      return defs.map(def => h('label', { key: def.name, style: css.field }, `${def.name} (${def.type})`,
        h('input', { style: css.input, value: values[def.name] ?? '', placeholder: `${t.paramHint}${def.default !== undefined && def.default !== null ? `: ${Array.isArray(def.default) ? def.default.join(',') : def.default}` : ''}`, onChange: e => onChange({ ...values, [def.name]: e.target.value }) })))
    }

    const parseParam = (def, text) => {
      if (/^list</.test(def.type ?? '')) return text.split(',').map(s => s.trim()).filter(Boolean)
      if (['int', 'number'].includes(def.type) && /^-?\d+(\.\d+)?$/.test(text)) return Number(text)
      if (def.type === 'bool') return text === 'true'
      return text
    }
    const paramsFrom = (defs, values) => Object.fromEntries(defs.filter(d => (values[d.name] ?? '').trim() !== '').map(d => [d.name, parseParam(d, values[d.name].trim())]))

    function NewRule({ limits, onDone }) {
      const [analyses, setAnalyses] = useState([])
      const [form, setForm] = useState({ name: '', analysis_id: '', column: '', row: '0', kind: 'threshold', op: '>', value: '', percent: '', interval: String(Math.max(5, Math.round((limits?.min_interval_s ?? 300) / 60))) })
      const [detail, setDetail] = useState(null)
      const [params, setParams] = useState({})
      const [previous, setPrevious] = useState({})
      const [error, setError] = useState(null)
      useEffect(() => { api('api/ao/analyses?status=verified').then(r => { if (r.ok) setAnalyses(r.body.data) }) }, [])
      useEffect(() => {
        if (form.analysis_id === '') { setDetail(null); return }
        api(`api/ao/analysis?id=${encodeURIComponent(form.analysis_id)}`).then(r => {
          const version = r.ok ? r.body.data.version : null
          setDetail(version)
          const measure = version?.columns?.find(c => c.role === 'measure') ?? version?.columns?.[0]
          setForm(f => ({ ...f, column: measure?.name ?? '', name: f.name || (r.ok ? r.body.data.name : '') }))
        })
      }, [form.analysis_id])
      const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }))
      const defs = detail?.params ?? []
      async function submit() {
        const body = {
          name: form.name, analysis_id: form.analysis_id, params: paramsFrom(defs, params),
          value: { column: form.column, ...Number(form.row) > 0 ? { row: Number(form.row) } : {} },
          condition: form.kind === 'threshold' ? { kind: 'threshold', op: form.op, value: Number(form.value) } : { kind: 'change', op: form.op, percent: Number(form.percent), previous_params: paramsFrom(defs, previous) },
          interval_s: Math.round(Number(form.interval) * 60),
        }
        const result = await api('api/insights/rules', body)
        if (!result.ok) { setError(`${result.error.code}: ${result.error.message}${result.error.details?.problems ? ` (${result.error.details.problems.map(p => `${p.path} ${p.message}`).join('; ')})` : ''}`); return }
        onDone()
      }
      const ops = form.kind === 'threshold' ? ['>', '>=', '<', '<='] : ['>=', '<=', 'abs>=']
      return h('div', { style: { ...css.card, display: 'flex', flexDirection: 'column', gap: 8 }, 'data-new-rule': '1' },
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('label', { style: css.field }, t.analysis, h('select', { style: css.input, value: form.analysis_id, onChange: set('analysis_id'), 'data-field': 'analysis' },
            h('option', { value: '' }, '—'), analyses.map(a => h('option', { key: a.id, value: a.id }, a.name)))),
          h('label', { style: css.field }, t.name, h('input', { style: css.input, value: form.name, onChange: set('name') })),
          h('label', { style: css.field }, t.column, h('select', { style: css.input, value: form.column, onChange: set('column') }, (detail?.columns ?? []).map(c => h('option', { key: c.name, value: c.name }, c.label ? `${c.label} (${c.name})` : c.name)))),
          h('label', { style: { ...css.field, minWidth: 60 } }, t.row, h('input', { style: { ...css.input, width: 60 }, value: form.row, onChange: set('row') }))),
        defs.length > 0 && h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, h(ParamInputs, { defs, values: params, onChange: setParams })),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { style: css.field }, t.kind, h('select', { style: css.input, value: form.kind, onChange: e => setForm(f => ({ ...f, kind: e.target.value, op: e.target.value === 'threshold' ? '>' : '>=' })) },
            h('option', { value: 'threshold' }, t.threshold), h('option', { value: 'change' }, t.changeKind))),
          h('label', { style: { ...css.field, minWidth: 70 } }, t.op, h('select', { style: css.input, value: form.op, onChange: set('op') }, ops.map(op => h('option', { key: op, value: op }, op)))),
          form.kind === 'threshold'
            ? h('label', { style: css.field }, t.value, h('input', { style: css.input, value: form.value, onChange: set('value'), 'data-field': 'value' }))
            : h('label', { style: css.field }, t.percent, h('input', { style: css.input, value: form.percent, onChange: set('percent') })),
          h('label', { style: { ...css.field, minWidth: 90 } }, t.interval, h('input', { style: { ...css.input, width: 80 }, value: form.interval, onChange: set('interval') }))),
        form.kind === 'change' && defs.length > 0 && h('div', null, h('div', { style: { fontSize: 12, marginBottom: 4 } }, t.previousParams),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, h(ParamInputs, { defs, values: previous, onChange: setPrevious }))),
        limits && h('div', { style: css.meta }, t.limits(limits)),
        error !== null && h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: css.button('primary', form.analysis_id === ''), disabled: form.analysis_id === '', onClick: submit, 'data-action': 'create-rule' }, t.create),
          h('button', { style: css.button(), onClick: onDone }, t.cancel)))
    }

    function AlertsPanel() {
      const count = useUnread()
      const [firings, setFirings] = useState(null)
      const [rules, setRules] = useState(null)
      const [limits, setLimits] = useState(null)
      const [adding, setAdding] = useState(false)
      const load = useCallback(async () => {
        const [f, r] = await Promise.all([api('api/insights/firings?limit=100'), api('api/insights/rules')])
        if (f.ok) setFirings(f.body.data)
        if (r.ok) { setRules(r.body.data); setLimits(r.body.limits) }
      }, [])
      useEffect(() => { load(); const timer = setInterval(load, LIST_POLL_MS); return () => clearInterval(timer) }, [load])
      useEffect(() => { load() }, [count, load])
      async function markAll() { await api('api/insights/read', {}); await refreshUnread(); load() }
      return h('div', { style: css.root, 'data-panel': ALERTS_PANEL },
        h('div', { style: css.bar },
          h('div', { style: css.title }, t.alerts),
          h('span', { style: css.badge(count > 0 ? 'warn' : undefined), 'data-unread-count': count }, t.unread(count)),
          count > 0 && h('button', { style: css.button(), onClick: markAll }, t.markAll)),
        h('div', { style: css.scroll },
          h('div', { style: { fontWeight: 600, fontSize: 13, margin: '0 0 8px' } }, t.firings),
          firings !== null && firings.length === 0 && h('div', { style: { fontSize: 13, marginBottom: 12 } }, t.noFirings),
          (firings ?? []).map(firing => h(FiringCard, { key: firing.id, firing, onChanged: load })),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 8px' } },
            h('div', { style: { fontWeight: 600, fontSize: 13, flex: '1 1 auto' } }, t.rules),
            !adding && h('button', { style: css.button(), onClick: () => setAdding(true), 'data-action': 'new-rule' }, t.newRule)),
          adding && h(NewRule, { limits, onDone: () => { setAdding(false); load() } }),
          rules !== null && rules.length === 0 && !adding && h('div', { style: { fontSize: 13 } }, t.noRules),
          (rules ?? []).map(rule => h(RuleCard, { key: `${rule.id}:${rule.updated_at}`, rule, onChanged: load }))))
    }

    function ReportsIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('rect', { x: 3, y: 1.5, width: 10, height: 13, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M5.5 5h5M5.5 8h5M5.5 11h3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    function AlertsIcon() {
      const count = useUnread()
      return h('span', { style: { position: 'relative', display: 'inline-flex' }, 'data-unread-icon': count },
        h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
          h('path', { d: 'M8 1.8a4 4 0 0 0-4 4v2.6L2.6 11h10.8L12 8.4V5.8a4 4 0 0 0-4-4ZM6.3 12.6a1.8 1.8 0 0 0 3.4 0', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' })),
        count > 0 && h('span', { style: { position: 'absolute', top: -6, left: -10, minWidth: 14, height: 14, padding: '0 3px', borderRadius: 7, fontSize: 9, lineHeight: '14px', textAlign: 'center', fontWeight: 700, color: '#fff', background: 'var(--dsw-alias-state-error-primary, #dc2626)' } }, count > 99 ? '99+' : String(count)))
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        clientCtx = ctx
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: REPORTS_PANEL }, ReportsPanel))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ALERTS_PANEL }, AlertsPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: REPORTS_PANEL, order: -90, label: () => t.reports }, ReportsIcon))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: ALERTS_PANEL, order: -80, label: () => t.alerts }, AlertsIcon))
      },
    }
  },
})

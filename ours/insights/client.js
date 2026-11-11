/**
 * Browser half of @ours/insights: the 보고서 and 알림 panels in the sidebar list.
 *
 * 보고서: scheduled reports (repeat, next run, pause and resume) and saved
 * reports newest first. A report shows its text with each figure value from
 * the stored run result and a numbered source line per figure in the product
 * wording: analysis name, 확인됨 or 확인 전, 조건 (period and other
 * parameters in words), and `11월 11일 12:06 기준`. Text is rendered as React
 * elements from a small Markdown subset; nothing is set as HTML.
 *
 * 알림: alerts that went off with an unread count (also on the sidebar icon),
 * 원인 분석 that opens an analysis conversation for the alert (the only step
 * that uses a model), the watched numbers with their state, turning one
 * proposed in a conversation on, pausing, checking now, deleting, and a form
 * for a person's alert on a confirmed analysis.
 *
 * Wording follows planning/ux-audit.md P0-10 and its glossary (확인된 분석,
 * 확인됨/확인 전, 조건, … 기준). Analysis ids, version numbers and column
 * names stay off the screen.
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
    const SCHEDULE_EXAMPLE = '매주 월요일 9시에 지난주 실적 보고서 만들어 줘'
    let clientCtx = null

    const t = {
      reports: '보고서', alerts: '알림', loading: '불러오는 중…',
      noReports: `아직 보고서가 없습니다. 새 질문에서 "${SCHEDULE_EXAMPLE}"라고 말하면 여기에 쌓입니다.`, scheduleReport: '보고서 예약하기',
      reportsFailed: '보고서를 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.', pick: '왼쪽에서 보고서를 고르세요.',
      scheduled: '예약된 보고서', next: when => `다음 ${when}`, paused: '꺼짐', pause: '끄기', resume: '켜기',
      sources: '근거', confirmed: '확인됨', unconfirmed: '확인 전', calc: '계산', allConfirmed: '모든 숫자가 확인된 분석에서 나왔습니다', someUnconfirmed: '확인 전 분석이 들어 있습니다',
      bySchedule: title => `예약: ${title}`, bySession: '대화에서 저장', askAbout: '이 보고서에 대해 묻기', rowsShown: (s, n) => `${n}줄 중 ${s}줄`,
      alertsFailed: '알림을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.',
      unread: n => `읽지 않은 알림 ${n}개`, markAll: '모두 읽음', markRead: '읽음', investigate: '원인 분석', investigating: '여는 중…', reopen: '분석 대화 열기',
      firings: '울린 알림', noFirings: '아직 울린 알림이 없습니다.', firedAt: when => `${when} 울림`, previous: '직전',
      rules: '지켜보는 숫자', noRules: "숫자가 기준을 넘으면 알려 드립니다. '새 알림'으로 기준을 정하세요.", newRule: '새 알림',
      status: { pending: '켜기 전', active: '켜짐', paused: '꺼짐' }, byAgent: '대화에서 제안됨', byPerson: '직접 만듦',
      turnOn: '켜기', pauseRule: '끄기', checkNow: '지금 확인', remove: '삭제', confirmRemove: '이 알림을 삭제할까요? 울린 기록은 남습니다.',
      pendingHelp: '대화에서 제안한 알림입니다. 조건을 보고 켜면 지켜보기 시작합니다.', every: s => s % 3600 === 0 ? `${s / 3600}시간마다 확인` : `${Math.round(s / 60)}분마다 확인`,
      never: '아직 확인한 적 없음', lastCheck: (when, value) => `마지막 확인 ${when} · ${value}`, checkFailed: '확인하지 못했습니다', checked: s => s.fired > 0 ? '확인했습니다. 기준을 넘어 알림이 울렸습니다.' : s.errors > 0 ? '확인하지 못했습니다.' : '확인했습니다. 기준을 넘지 않았습니다.',
      form: {
        analysis: '지켜볼 숫자 (확인된 분석)', name: '알림 이름', column: '항목', row: '몇 번째 줄', kind: '기준', threshold: '기준값과 비교', change: '직전 기간보다 변한 비율(%)',
        op: '비교', value: '기준값', percent: '변한 비율(%)', previous: '직전 기간의 조건', interval: '확인 주기(분)', paramHint: '비우면 기본값',
        limits: l => `알림은 ${l.max_rules}개까지 만들 수 있고, ${Math.round(l.min_interval_s / 60)}분보다 자주 확인할 수 없습니다.`,
        create: '알림 만들기', cancel: '취소', byChat: '새 질문에서 "승인 건수가 2,000건을 넘으면 알려 줘"라고 말해도 됩니다.', failed: '알림을 만들지 못했습니다',
      },
      ops: { '>': '초과', '>=': '이상', '<': '미만', '<=': '이하', 'abs>=': '변화 이상' },
    }

    async function api(path, body) {
      let response
      try {
        response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      } catch (error) {
        return { ok: false, error: { code: 'network', message: String(error?.message ?? error), details: null } }
      }
      let json
      try { json = await response.json() } catch { json = undefined }
      if (!response.ok) {
        const error = json?.error ?? {}
        return { ok: false, error: { code: error.code ?? 'http_error', message: error.message ?? `HTTP ${response.status}`, details: error.details ?? null } }
      }
      return { ok: true, body: json }
    }

    // ── Wording helpers ──────────────────────────────────────────────────────
    const pad = n => String(n).padStart(2, '0')
    const when = iso => {
      if (typeof iso !== 'string') return ''
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const asOf = iso => `${when(iso)} 기준`
    const number = (value, unit) => {
      if (value === null || value === undefined) return '—'
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null
      if (n === null) return String(value)
      return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(n)}${unit ?? ''}`
    }
    const relativeMonth = k => k === 0 ? '이번 달' : k === -1 ? '지난달' : k === 1 ? '다음 달' : k < 0 ? `${-k}달 전` : `${k}달 뒤`
    const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
    const MONTH_START = /^month_start\((-?\d+)\)$/

    /** Period in words from a start/end parameter pair: `2026년 10월`, `지난달`, or `2026-10-01 ~ 2026-11-01`. */
    function periodText(start, end) {
      const ms = [MONTH_START.exec(String(start)), MONTH_START.exec(String(end))]
      if (ms[0] && ms[1]) {
        const a = Number(ms[0][1]); const b = Number(ms[1][1])
        return b - a === 1 ? relativeMonth(a) : `${relativeMonth(a)}부터 ${relativeMonth(b - 1)}까지`
      }
      const ds = [DATE.exec(String(start)), DATE.exec(String(end))]
      if (ds[0] && ds[1] && ds[0][3] === '01' && ds[1][3] === '01') {
        const months = (Number(ds[1][1]) - Number(ds[0][1])) * 12 + Number(ds[1][2]) - Number(ds[0][2])
        const first = `${ds[0][1]}년 ${Number(ds[0][2])}월`
        if (months === 1) return first
        if (months > 1) { const last = new Date(Number(ds[1][1]), Number(ds[1][2]) - 2, 1); return `${first}~${last.getFullYear()}년 ${last.getMonth() + 1}월` }
      }
      return `${start} ~ ${end}`
    }

    /** `기간 2026년 10월 · statuses APPROVED` from analysis parameters (no JSON). */
    function conditionText(params) {
      const entries = Object.entries(params ?? {})
      if (entries.length === 0) return ''
      const startKey = entries.find(([k]) => /start/i.test(k))?.[0]
      const endKey = entries.find(([k]) => /end/i.test(k))?.[0]
      const parts = []
      if (startKey !== undefined && endKey !== undefined) parts.push(`기간 ${periodText(params[startKey], params[endKey])}`)
      for (const [k, v] of entries) {
        if (k === startKey && endKey !== undefined) continue
        if (k === endKey && startKey !== undefined) continue
        parts.push(`${k} ${Array.isArray(v) ? v.join(', ') : MONTH_START.test(String(v)) ? relativeMonth(Number(MONTH_START.exec(String(v))[1])) : v}`)
      }
      return parts.join(' · ')
    }

    const figureName = figure => figure.label ?? (conditionText(figure.params) || figure.analysis?.name || '')

    function ruleConditionText(rule) {
      if (rule.condition_text) return rule.condition_text
      const c = rule.condition
      if (c.kind === 'threshold') return `${number(c.value, rule.value_unit)} ${t.ops[c.op]}`
      return `직전 기간 대비 ${c.percent}% ${t.ops[c.op]}`
    }

    const css = {
      root: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' },
      bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap', minHeight: 44 },
      title: { fontWeight: 600, fontSize: 15, flex: '1 1 auto' },
      split: { flex: '1 1 auto', display: 'flex', minHeight: 0 },
      list: { width: 300, flex: '0 0 auto', borderRight: '1px solid var(--dsw-alias-border-l1)', overflow: 'auto' },
      item: active => ({ padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer', background: active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent' }),
      section: { padding: '10px 14px 4px', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      scroll: { flex: '1 1 auto', overflow: 'auto', padding: '16px 24px', minHeight: 0, minWidth: 0 },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '10px 12px', marginBottom: 10 },
      button: (kind = 'plain', disabled = false) => ({
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 10px', font: 'inherit', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        background: kind === 'primary' ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary))' : 'transparent',
        color: kind === 'primary' ? 'var(--dsw-alias-label-primary-inverted, #fff)' : kind === 'danger' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
      }),
      badge: tone => ({ fontSize: 11, padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)',
        background: tone === 'ok' ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)' : tone === 'warn' ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent)' : 'var(--dsw-alias-bg-layer-2)' }),
      notice: tone => ({ margin: '12px 16px 0', padding: '10px 12px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        background: tone === 'error' ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)' : 'var(--dsw-alias-bg-layer-1)' }),
      empty: { padding: '48px 24px', fontSize: 14, lineHeight: 1.6, textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 },
      figure: confirmed => ({ fontWeight: 600, borderBottom: `1px dotted ${confirmed ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'}`, cursor: 'help' }),
      table: { borderCollapse: 'collapse', fontSize: 12, margin: '8px 0' },
      cell: { border: '1px solid var(--dsw-alias-border-l1)', padding: '4px 8px', textAlign: 'left' },
      field: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, minWidth: 140 },
      input: { font: 'inherit', fontSize: 12, padding: '4px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
    }

    const openSession = sessionId => clientCtx?.uiWorkspace.openSession(sessionId)
    const startConversation = prompt => clientCtx?.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
    const Loading = () => h('div', { style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t.loading)
    const Failure = ({ text, error }) => h('div', { style: css.notice('error'), 'data-notice': 'error' }, h('span', null, text), error && h('span', { style: css.meta }, `(${error.code})`))

    // ── Unread count shared by the sidebar icon and the 알림 panel ──────────
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

    const figureConfirmed = figure => figure.kind === 'change' ? figure.verified : figure.analysis.verified

    function FigureInline({ id, ctx }) {
      const figure = ctx.report.figures[id]
      const note = ctx.order.indexOf(id) + 1
      if (figure === undefined) return h('span', null, '—')
      if (figure.kind === 'table') return h(FigureTable, { figure, note })
      return h('span', { 'data-figure': id },
        h('span', { style: css.figure(figureConfirmed(figure)), title: sourceText(ctx.report, figure) }, figure.text),
        h('sup', { style: { fontSize: 10, marginLeft: 1 } }, h('a', { href: `#src-${id}`, style: { color: 'inherit' } }, `[${note}]`)))
    }

    function FigureTable({ figure, note }) {
      return h('span', { style: { display: 'block' }, 'data-figure': figure.id },
        h('table', { style: css.table },
          h('thead', null, h('tr', null, figure.table.columns.map((c, i) => h('th', { key: i, style: css.cell }, c.label ?? c.name)))),
          h('tbody', null, figure.table.rows.map((row, r) => h('tr', { key: r }, row.map((cell, i) => h('td', { key: i, style: css.cell }, number(cell, typeof cell === 'number' ? figure.table.columns[i].unit : null))))))),
        h('span', { style: css.meta }, `${figure.table.shown < figure.table.row_count ? `${t.rowsShown(figure.table.shown, figure.table.row_count)} · ` : ''}`, h('a', { href: `#src-${figure.id}`, style: { color: 'inherit' } }, `[${note}]`)))
    }

    /** `기간별 승인된 리뷰 증빙 수 · 확인됨 · 조건: 기간 2026년 10월 · 11월 11일 12:12 기준`, or the calculation of a change. */
    function sourceText(report, figure) {
      if (figure.kind === 'change') {
        const from = report.figures[figure.from]
        const to = report.figures[figure.to]
        const end = f => `${figureName(f)} ${f.text}`
        return figure.format === 'change'
          ? `${t.calc}: (${end(to)} − ${end(from)}) ÷ ${from.text} = ${figure.text}`
          : `${t.calc}: ${end(to)} − ${end(from)} = ${figure.text}`
      }
      const condition = conditionText(figure.params)
      return [figure.analysis.name, figure.analysis.verified ? t.confirmed : t.unconfirmed, condition && `조건: ${condition}`, asOf(figure.executed_at)].filter(Boolean).join(' · ')
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
          order.map((id, i) => report.figures[id] === undefined ? null : h('div', { key: id, id: `src-${id}`, style: { fontSize: 12, margin: '4px 0', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }, 'data-source': id },
            h('span', null, `[${i + 1}]`),
            report.figures[id].kind !== 'change' && h('span', { style: css.badge(report.figures[id].analysis.verified ? 'ok' : 'warn') }, report.figures[id].analysis.verified ? t.confirmed : t.unconfirmed),
            h('span', null, report.figures[id].kind === 'change' ? sourceText(report, report.figures[id]) : sourceText(report, report.figures[id]).split(' · ').filter(p => p !== t.confirmed && p !== t.unconfirmed).join(' · '))))))
    }

    function triggerBadge(report) {
      return report.trigger?.kind === 'schedule' ? h('span', { style: css.badge('ok') }, t.bySchedule(report.trigger.schedule_title)) : h('span', { style: css.badge() }, t.bySession)
    }

    function ScheduleRow({ row, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      async function toggle() {
        setBusy(true)
        const result = await api('api/insights/schedule-update', { id: row.id, active: row.status !== 'active' })
        setBusy(false)
        setError(result.ok ? null : result.error)
        onChanged()
      }
      return h('div', { style: { padding: '8px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }, 'data-schedule': row.id },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 3 } }, row.title),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: css.meta }, row.repeat),
          row.status === 'active' ? h('span', { style: css.meta }, t.next(when(row.next_at))) : h('span', { style: css.badge() }, t.paused),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { style: css.button('plain', busy), disabled: busy, onClick: toggle }, row.status === 'active' ? t.pause : t.resume)),
        error !== null && h('div', { style: { ...css.meta, color: 'var(--dsw-alias-state-error-primary)' } }, `${error.message}`))
    }

    function ReportsPanel() {
      const [list, setList] = useState(null)
      const [schedules, setSchedules] = useState([])
      const [selected, setSelected] = useState(null)
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)
      const load = useCallback(async () => {
        const [result, sched] = await Promise.all([api('api/insights/reports?limit=200'), api('api/insights/schedules')])
        if (sched.ok) setSchedules(sched.body.data)
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
      const empty = list !== null && list.length === 0 && schedules.length === 0
      const allConfirmed = report !== null && Object.values(report.figures).every(figureConfirmed)
      return h('div', { style: css.root, 'data-panel': REPORTS_PANEL },
        h('div', { style: css.bar }, h('div', { style: css.title }, t.reports), !empty && h('button', { style: css.button(), onClick: () => startConversation(SCHEDULE_EXAMPLE) }, t.scheduleReport)),
        error !== null && list === null && h(Failure, { text: t.reportsFailed, error }),
        list === null && error === null && h(Loading),
        empty && h('div', { style: css.empty, 'data-empty': 'reports' },
          h('div', null, t.noReports),
          h('button', { style: css.button('primary'), onClick: () => startConversation(SCHEDULE_EXAMPLE), 'data-action': 'schedule-report' }, t.scheduleReport)),
        list !== null && !empty && h('div', { style: css.split },
          h('div', { style: css.list },
            schedules.length > 0 && h('div', { 'data-schedules': schedules.length },
              h('div', { style: css.section }, t.scheduled),
              schedules.map(row => h(ScheduleRow, { key: `${row.id}:${row.status}`, row, onChanged: load })),
              h('div', { style: css.section }, t.reports)),
            list.map(row => h('div', { key: row.id, style: css.item(row.id === selected), onClick: () => setSelected(row.id), 'data-report': row.id },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 3 } }, row.title),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                h('span', { style: css.meta }, when(row.created_at)), triggerBadge(row),
                !row.all_verified && h('span', { style: css.badge('warn') }, t.unconfirmed))))),
          h('div', { style: css.scroll },
            report === null ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, list.length === 0 ? '' : t.pick) : h('div', { 'data-report-view': report.id },
              h('h2', { style: { margin: '0 0 6px', fontSize: 20 } }, report.title),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 } },
                h('span', { style: css.meta }, when(report.created_at)), triggerBadge(report),
                h('span', { style: css.badge(allConfirmed ? 'ok' : 'warn') }, allConfirmed ? t.allConfirmed : t.someUnconfirmed),
                report.session_id && h('button', { style: css.button(), onClick: () => openSession(report.session_id) }, t.askAbout)),
              h(ReportBody, { report })))))
    }

    // ── 알림 ─────────────────────────────────────────────────────────────────
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
      async function markRead() { await api('api/insights/read', { ids: [firing.id] }); await refreshUnread(); onChanged() }
      const isUnread = firing.read_at === null
      const label = firing.column?.label ?? firing.analysis.name
      const condition = conditionText(firing.params)
      return h('div', { style: { ...css.card, borderLeft: isUnread ? '3px solid var(--dsw-alias-state-warn-primary)' : css.card.border }, 'data-firing': firing.id, 'data-unread': isUnread ? '1' : '0' },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, fontSize: 14 } }, firing.rule_name),
          h('span', { style: css.meta }, t.firedAt(when(firing.fired_at))),
          h('span', { style: { flex: '1 1 auto' } }),
          isUnread && h('button', { style: css.button(), onClick: markRead }, t.markRead),
          h('button', { style: css.button('primary', busy), disabled: busy, onClick: investigate, 'data-action': 'investigate' },
            busy ? t.investigating : firing.investigation_session_id ? t.reopen : t.investigate)),
        h('div', { style: { fontSize: 14, margin: '6px 0' } },
          `${label} `, h('strong', null, firing.value_text), ` · 기준 ${firing.condition_text}`,
          firing.previous_value_text !== null && ` · ${t.previous} ${firing.previous_value_text}`, firing.change_text !== null && ` (${firing.change_text})`),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 } },
          h('span', null, firing.analysis.name),
          h('span', { style: css.badge(firing.analysis.verified ? 'ok' : 'warn') }, firing.analysis.verified ? t.confirmed : t.unconfirmed),
          h('span', { style: css.meta }, [condition && `조건: ${condition}`, asOf(firing.executed_at)].filter(Boolean).join(' · '))),
        error !== null && h('div', { style: { ...css.meta, color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } }, error.message))
    }

    function RuleCard({ rule, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      async function act(path, body) {
        setBusy(true)
        try {
          const result = await api(path, body)
          if (!result.ok) setMessage({ tone: 'error', text: result.error.message })
          else if (result.body.data?.summary) setMessage({ tone: 'info', text: t.checked(result.body.data.summary) })
          else setMessage(null)
          await refreshUnread()
          onChanged()
        } finally { setBusy(false) }
      }
      const s = rule.state
      const condition = conditionText(rule.params)
      return h('div', { style: css.card, 'data-rule': rule.id, 'data-status': rule.status },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, fontSize: 13 } }, rule.name),
          h('span', { style: css.badge(rule.status === 'active' ? 'ok' : rule.status === 'pending' ? 'warn' : undefined) }, t.status[rule.status]),
          h('span', { style: css.meta }, rule.created_by === 'agent' ? t.byAgent : t.byPerson),
          h('span', { style: { flex: '1 1 auto' } }),
          rule.status !== 'active' && h('button', { style: css.button('primary', busy), disabled: busy, onClick: () => act('api/insights/rule-update', { id: rule.id, status: 'active' }), 'data-action': 'turn-on' }, t.turnOn),
          rule.status === 'active' && h('button', { style: css.button('plain', busy), disabled: busy, onClick: () => act('api/insights/rule-update', { id: rule.id, status: 'paused' }) }, t.pauseRule),
          h('button', { style: css.button('plain', busy), disabled: busy, onClick: () => act('api/insights/evaluate', { id: rule.id }), 'data-action': 'evaluate' }, t.checkNow),
          h('button', { style: css.button('danger', busy), disabled: busy, onClick: () => { if (globalThis.confirm(t.confirmRemove)) act('api/insights/rule-delete', { id: rule.id }) } }, t.remove)),
        rule.status === 'pending' && h('div', { style: { fontSize: 12, margin: '6px 0', color: 'var(--dsw-alias-label-secondary)' } }, t.pendingHelp),
        h('div', { style: { fontSize: 13, marginTop: 4 } }, `${rule.value_label ?? rule.analysis_name ?? ''} · 기준 ${ruleConditionText(rule)} · ${t.every(rule.interval_s)}`),
        h('div', { style: css.meta }, [rule.analysis_name, condition && `조건: ${condition}`].filter(Boolean).join(' · ')),
        h('div', { style: css.meta }, s.last_evaluated_at === null ? t.never : t.lastCheck(when(s.last_evaluated_at), number(s.last_value, rule.value_unit))),
        s.last_error && h('div', { style: { ...css.meta, color: 'var(--dsw-alias-state-error-primary)' } }, `${t.checkFailed}: ${s.last_error.message}`),
        message !== null && h('div', { style: { ...css.meta, color: message.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : undefined } }, message.text))
    }

    function ParamInputs({ defs, values, onChange }) {
      return defs.map(def => h('label', { key: def.name, style: css.field }, `조건: ${def.label ?? def.name}`,
        h('input', { style: css.input, value: values[def.name] ?? '', placeholder: `${t.form.paramHint}${def.default !== undefined && def.default !== null ? ` (${Array.isArray(def.default) ? def.default.join(',') : def.default})` : ''}`, onChange: e => onChange({ ...values, [def.name]: e.target.value }) })))
    }

    const parseParam = (def, text) => {
      if (/^list</.test(def.type ?? '')) return text.split(',').map(s => s.trim()).filter(Boolean)
      if (['int', 'number'].includes(def.type) && /^-?\d+(\.\d+)?$/.test(text)) return Number(text)
      if (def.type === 'bool') return text === 'true'
      return text
    }
    const paramsFrom = (defs, values) => Object.fromEntries(defs.filter(d => (values[d.name] ?? '').trim() !== '').map(d => [d.name, parseParam(d, values[d.name].trim())]))

    function NewRule({ limits, onDone }) {
      const [analyses, setAnalyses] = useState(null)
      const [form, setForm] = useState({ name: '', analysis_id: '', column: '', row: '1', kind: 'threshold', op: '>', value: '', percent: '', interval: String(Math.max(60, Math.round((limits?.min_interval_s ?? 300) / 60))) })
      const [detail, setDetail] = useState(null)
      const [params, setParams] = useState({})
      const [previous, setPrevious] = useState({})
      const [error, setError] = useState(null)
      useEffect(() => { api('api/ao/analyses?status=verified').then(r => setAnalyses(r.ok ? r.body.data : [])) }, [])
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
      const manyRows = (detail?.columns ?? []).some(c => c.role === 'dimension' || c.role === 'time')
      async function submit() {
        const row = Math.max(1, Math.round(Number(form.row) || 1)) - 1
        const body = {
          name: form.name, analysis_id: form.analysis_id, params: paramsFrom(defs, params),
          value: { column: form.column, ...manyRows && row > 0 ? { row } : {} },
          condition: form.kind === 'threshold' ? { kind: 'threshold', op: form.op, value: Number(String(form.value).replace(/,/g, '')) } : { kind: 'change', op: form.op, percent: Number(form.percent), previous_params: paramsFrom(defs, previous) },
          interval_s: Math.round(Number(form.interval) * 60),
        }
        const result = await api('api/insights/rules', body)
        if (!result.ok) { setError(`${t.form.failed}: ${result.error.message}`); return }
        onDone()
      }
      const ops = form.kind === 'threshold' ? ['>', '>=', '<', '<='] : ['>=', '<=', 'abs>=']
      return h('div', { style: { ...css.card, display: 'flex', flexDirection: 'column', gap: 10 }, 'data-new-rule': '1' },
        h('div', { style: css.meta }, t.form.byChat),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('label', { style: css.field }, t.form.analysis, h('select', { style: css.input, value: form.analysis_id, onChange: set('analysis_id'), 'data-field': 'analysis' },
            h('option', { value: '' }, analyses === null ? t.loading : '—'), (analyses ?? []).map(a => h('option', { key: a.id, value: a.id }, a.name)))),
          h('label', { style: css.field }, t.form.name, h('input', { style: css.input, value: form.name, onChange: set('name') })),
          h('label', { style: css.field }, t.form.column, h('select', { style: css.input, value: form.column, onChange: set('column'), 'data-field': 'column' }, (detail?.columns ?? []).map(c => h('option', { key: c.name, value: c.name }, c.label ?? c.name)))),
          manyRows && h('label', { style: { ...css.field, minWidth: 80 } }, t.form.row, h('input', { style: { ...css.input, width: 70 }, value: form.row, onChange: set('row') }))),
        defs.length > 0 && h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, h(ParamInputs, { defs, values: params, onChange: setParams })),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { style: css.field }, t.form.kind, h('select', { style: css.input, value: form.kind, onChange: e => setForm(f => ({ ...f, kind: e.target.value, op: e.target.value === 'threshold' ? '>' : '>=' })), 'data-field': 'kind' },
            h('option', { value: 'threshold' }, t.form.threshold), h('option', { value: 'change' }, t.form.change))),
          form.kind === 'threshold'
            ? h('label', { style: css.field }, t.form.value, h('input', { style: css.input, value: form.value, onChange: set('value'), 'data-field': 'value' }))
            : h('label', { style: css.field }, t.form.percent, h('input', { style: css.input, value: form.percent, onChange: set('percent') })),
          h('label', { style: { ...css.field, minWidth: 90 } }, t.form.op, h('select', { style: css.input, value: form.op, onChange: set('op'), 'data-field': 'op' }, ops.map(op => h('option', { key: op, value: op }, t.ops[op])))),
          h('label', { style: { ...css.field, minWidth: 100 } }, t.form.interval, h('input', { style: { ...css.input, width: 80 }, value: form.interval, onChange: set('interval') }))),
        form.kind === 'change' && defs.length > 0 && h('div', null, h('div', { style: { fontSize: 12, marginBottom: 4 } }, t.form.previous),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } }, h(ParamInputs, { defs, values: previous, onChange: setPrevious }))),
        limits && h('div', { style: css.meta }, t.form.limits(limits)),
        error !== null && h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: css.button('primary', form.analysis_id === ''), disabled: form.analysis_id === '', onClick: submit, 'data-action': 'create-rule' }, t.form.create),
          h('button', { style: css.button(), onClick: onDone }, t.form.cancel)))
    }

    function AlertsPanel() {
      const count = useUnread()
      const [firings, setFirings] = useState(null)
      const [rules, setRules] = useState(null)
      const [limits, setLimits] = useState(null)
      const [error, setError] = useState(null)
      const [adding, setAdding] = useState(false)
      const load = useCallback(async () => {
        const [f, r] = await Promise.all([api('api/insights/firings?limit=100'), api('api/insights/rules')])
        if (f.ok) setFirings(f.body.data)
        if (r.ok) { setRules(r.body.data); setLimits(r.body.limits) }
        setError(f.ok && r.ok ? null : (f.ok ? r : f).error)
      }, [])
      useEffect(() => { load(); const timer = setInterval(load, LIST_POLL_MS); return () => clearInterval(timer) }, [load])
      useEffect(() => { load() }, [count, load])
      async function markAll() { await api('api/insights/read', {}); await refreshUnread(); load() }
      return h('div', { style: css.root, 'data-panel': ALERTS_PANEL },
        h('div', { style: css.bar },
          h('div', { style: css.title }, t.alerts),
          count > 0 && h('span', { style: css.badge('warn'), 'data-unread-count': count }, t.unread(count)),
          count > 0 && h('button', { style: css.button(), onClick: markAll }, t.markAll)),
        error !== null && h(Failure, { text: t.alertsFailed, error }),
        firings === null && rules === null && error === null ? h(Loading) : h('div', { style: css.scroll },
          h('div', { style: { fontWeight: 600, fontSize: 13, margin: '0 0 8px' } }, t.firings),
          firings !== null && firings.length === 0 && h('div', { style: { fontSize: 13, marginBottom: 12, color: 'var(--dsw-alias-label-secondary)' } }, t.noFirings),
          (firings ?? []).map(firing => h(FiringCard, { key: firing.id, firing, onChanged: load })),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 8px' } },
            h('div', { style: { fontWeight: 600, fontSize: 13, flex: '1 1 auto' } }, t.rules),
            !adding && h('button', { style: css.button(), onClick: () => setAdding(true), 'data-action': 'new-rule' }, t.newRule)),
          adding && h(NewRule, { limits, onDone: () => { setAdding(false); load() } }),
          rules !== null && rules.length === 0 && !adding && h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t.noRules),
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
        count > 0 && h('span', { style: { position: 'absolute', top: -4, right: -4, width: 7, height: 7, borderRadius: 4, background: 'var(--dsw-alias-state-error-primary, #dc2626)' }, title: t.unread(count) }))
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

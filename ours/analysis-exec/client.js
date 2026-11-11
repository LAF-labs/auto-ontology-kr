/**
 * Browser half of @ours/analysis-exec.
 *
 * Tool rows (keyed `tool.call.toolview` registrations) for the three analysis
 * tools, and the result card. Chat folds a finished turn's tool rows into its
 * work details, so the result card is not a tool row: a turn-data definition
 * collects the turn's successful `analysis_present_result` results and a
 * `conversation.chat.turnTail` entry renders one card per result below the
 * closing reply, where it stays visible.
 *
 * Everything derives from the logged call arguments and tool result text (the
 * JSON the model saw), so a replayed session renders the same cards; figures
 * are fetched from the host's artifact route by the path in the result.
 *
 * The card shows numbers, figures and tables from the run's output, then the
 * evidence the host recorded (input analyses with version, parameters, read
 * time and verified state; the code; the run's isolation) and the model's
 * method, assumptions and uncertainty.
 */
window.__ModuleLoader__.load({
  id: '@ours/analysis-exec',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const TURN_DATA_KEY = 'oursAnalysisResults'

    const COPY = {
      ko: {
        result: '분석 결과', run: 'Python 실행', input: '분석 입력',
        forecast: '예측', segments: '세그먼트', other: '분석',
        running: '실행 중', preparing: '가져오는 중', presenting: '정리하는 중', failed: '실패', stopped: '중단됨', ok: '완료',
        verified: '검증됨', notVerified: '검증 안 됨',
        evidence: '근거', inputs: '입력 데이터', method: '방법', assumptions: '가정', uncertainty: '불확실성',
        interval: '구간', level: '수준', execution: '실행 환경', code: '코드 보기', stdout: '표준 출력', stderr: '오류 출력',
        params: '파라미터', readAt: '읽은 시각', rows: '행', cache: '캐시', fresh: '새로 읽음', shown: '표시',
        noNetwork: '네트워크 없음', readOnly: '읽기 전용 파일시스템', took: '소요', artifacts: '산출물', download: 'CSV 내려받기',
        source: '출처', verifiedAt: '검증 시각', numbers: '수치', noParams: '기본값', figureMissing: '그림을 불러오지 못했습니다',
        shownBelow: '답변 아래에 표시',
      },
      en: {
        result: 'Analysis result', run: 'Python run', input: 'Analysis input',
        forecast: 'Forecast', segments: 'Segments', other: 'Analysis',
        running: 'Running', preparing: 'Fetching', presenting: 'Preparing', failed: 'Failed', stopped: 'Stopped', ok: 'Done',
        verified: 'Verified', notVerified: 'Not verified',
        evidence: 'Evidence', inputs: 'Input data', method: 'Method', assumptions: 'Assumptions', uncertainty: 'Uncertainty',
        interval: 'Interval', level: 'level', execution: 'Execution', code: 'Show code', stdout: 'Standard output', stderr: 'Error output',
        params: 'Parameters', readAt: 'Read at', rows: 'rows', cache: 'cache', fresh: 'fresh read', shown: 'shown',
        noNetwork: 'no network', readOnly: 'read-only filesystem', took: 'took', artifacts: 'Outputs', download: 'Download CSV',
        source: 'Source', verifiedAt: 'verified at', numbers: 'Numbers', noParams: 'defaults', figureMissing: 'The figure could not be loaded',
        shownBelow: 'shown below the reply',
      },
    }
    const copy = String(globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ko') ? COPY.ko : COPY.en

    const muted = { opacity: 0.65 }
    const border = '1px solid color-mix(in srgb, currentColor 14%, transparent)'
    const styles = {
      card: { border, borderRadius: 8, padding: '10px 12px', margin: '4px 0', fontSize: 13, lineHeight: 1.45 },
      head: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
      title: { fontWeight: 600 },
      badge: (tone) => ({
        fontSize: 11, padding: '1px 6px', borderRadius: 999, border, whiteSpace: 'nowrap',
        background: tone === 'good' ? 'color-mix(in srgb, #2e9e5b 18%, transparent)'
          : tone === 'warn' ? 'color-mix(in srgb, #d08a1a 20%, transparent)'
            : tone === 'bad' ? 'color-mix(in srgb, #d04040 20%, transparent)' : 'transparent',
      }),
      meta: { display: 'flex', flexWrap: 'wrap', gap: '2px 14px', marginTop: 4, fontSize: 12, ...muted },
      numbers: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginTop: 8 },
      number: { display: 'flex', flexDirection: 'column' },
      numberValue: { fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      numberName: { fontSize: 11, ...muted },
      figure: { display: 'block', maxWidth: '100%', maxHeight: 360, marginTop: 8, borderRadius: 6, border, background: '#fff' },
      tableWrap: { overflowX: 'auto', marginTop: 8, maxHeight: 280, overflowY: 'auto' },
      table: { borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' },
      th: { textAlign: 'left', padding: '3px 10px 3px 0', borderBottom: border, whiteSpace: 'nowrap', fontWeight: 600 },
      td: { padding: '3px 10px 3px 0', borderBottom: border, whiteSpace: 'nowrap' },
      num: { textAlign: 'right' },
      caption: { marginTop: 8, fontSize: 12, ...muted },
      section: { marginTop: 10, paddingTop: 8, borderTop: border },
      sectionTitle: { fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', ...muted },
      label: { fontWeight: 600, marginTop: 6 },
      list: { margin: '2px 0 0', paddingLeft: 18 },
      pre: { margin: '6px 0 0', padding: 8, borderRadius: 6, border, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre', maxHeight: 320, overflowY: 'auto' },
      summary: { cursor: 'pointer', marginTop: 8, fontSize: 12, ...muted },
      link: { color: 'inherit', textDecoration: 'underline' },
    }

    function parseArgs(raw) {
      try { const value = JSON.parse(raw ?? ''); return value !== null && typeof value === 'object' ? value : {} } catch { return {} }
    }

    function parseResult(block) {
      const text = (block.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('')
      try { const value = JSON.parse(text); return value !== null && typeof value === 'object' ? value : null } catch { return null }
    }

    function formatTime(iso) {
      if (typeof iso !== 'string') return null
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
    }

    function formatValue(value) {
      if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 4 })
      return value === null ? '—' : String(value)
    }

    const isNumeric = text => text !== '' && Number.isFinite(Number(text))

    function Meta({ items }) {
      const shown = items.filter(Boolean)
      return shown.length === 0 ? null : h('div', { style: styles.meta }, shown.map((text, index) => h('span', { key: index }, text)))
    }

    function Fold({ label, text }) {
      if (typeof text !== 'string' || text.trim() === '') return null
      return h('details', null, h('summary', { style: styles.summary }, label), h('pre', { style: styles.pre }, text))
    }

    function Table({ table }) {
      const columns = Array.isArray(table.columns) ? table.columns : []
      const rows = Array.isArray(table.rows) ? table.rows : []
      const numeric = columns.map((_name, index) => rows.length > 0 && rows.every(row => row[index] === '' || isNumeric(row[index])))
      const count = typeof table.row_count === 'number' ? table.row_count : null
      return h('div', null,
        h('div', { style: styles.caption },
          table.name,
          count !== null && ` · ${count} ${copy.rows}${rows.length < count ? ` (${rows.length} ${copy.shown})` : ''}`,
          table.path && ' · ', table.path && h('a', { href: table.path, style: styles.link }, copy.download)),
        h('div', { style: styles.tableWrap },
          h('table', { style: styles.table },
            h('thead', null, h('tr', null, columns.map((name, index) => h('th', { key: index, style: numeric[index] ? { ...styles.th, ...styles.num } : styles.th }, name)))),
            h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: rowIndex }, columns.map((_name, index) =>
              h('td', { key: index, style: numeric[index] ? { ...styles.td, ...styles.num } : styles.td }, row[index] === '' || row[index] === undefined ? '—' : numeric[index] ? formatValue(Number(row[index])) : String(row[index])))))))))
    }

    function Figure({ figure }) {
      const [failed, setFailed] = React.useState(false)
      if (failed) return h('div', { style: styles.caption }, `${figure.name}: ${copy.figureMissing}`)
      return h('img', { src: figure.path, alt: figure.name, style: styles.figure, loading: 'lazy', onError: () => setFailed(true) })
    }

    function verifiedBadge(analysis, key) {
      const verified = analysis?.status === 'verified'
      return h('span', { key, style: styles.badge(verified ? 'good' : 'bad') }, `${verified ? copy.verified : copy.notVerified}${typeof analysis?.version === 'number' ? ` v${analysis.version}` : ''}`)
    }

    function inputFacts(input) {
      const params = input.params && Object.keys(input.params).length > 0 ? JSON.stringify(input.params) : copy.noParams
      return [
        `${copy.params} ${params}`,
        input.executed_at && `${copy.readAt} ${formatTime(input.executed_at)}${input.cache_hit ? ` (${copy.cache})` : ''}`,
        typeof input.row_count === 'number' && `${input.row_count.toLocaleString()} ${copy.rows}`,
      ]
    }

    /** Inputs grouped by analysis version: the analysis once, then one line per file. */
    function Inputs({ inputs }) {
      const groups = new Map()
      for (const input of inputs) {
        const key = `${input.analysis?.id}@${input.analysis?.version}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(input)
      }
      return [...groups.entries()].map(([key, members]) => {
        const first = members[0]
        const source = first.source ? [first.source.database_name, ...(Array.isArray(first.source.tables) ? first.source.tables : [])].filter(Boolean).join(' · ') : null
        return h('div', { key, style: { marginTop: 4 }, 'data-analysis-input': key },
          h('div', { style: styles.head },
            h('span', { style: styles.title }, first.analysis?.name ?? first.analysis?.id ?? first.input),
            verifiedBadge(first.analysis, 'v')),
          h(Meta, { items: [
            source && `${copy.source} ${source}`,
            first.analysis?.verified_at && `${copy.verifiedAt} ${formatTime(first.analysis.verified_at)}`,
          ] }),
          members.map(input => h('div', { key: input.input, style: styles.meta },
            h('code', null, input.file), ...inputFacts(input).filter(Boolean).map((text, index) => h('span', { key: index }, text)))))
      })
    }

    function ErrorLine({ error }) {
      return h('div', { style: { marginTop: 6 } }, h('code', null, String(error.code ?? 'error')), ' ', String(error.message ?? ''))
    }

    function stateBadge(state, runningLabel) {
      if (state === 'running') return h('span', { key: 's', style: styles.badge() }, runningLabel)
      if (state === 'error') return h('span', { key: 's', style: styles.badge('bad') }, copy.failed)
      if (state === 'stopped') return h('span', { key: 's', style: styles.badge('warn') }, copy.stopped)
      return null
    }

    function settle({ phase, block }) {
      const settled = phase === 'result'
      const args = parseArgs(settled ? block.call?.argsRaw : block.argsRaw)
      if (!settled) return { state: 'running', args, output: null, error: null }
      if (block.error?.code === 'interrupted') return { state: 'stopped', args, output: null, error: null }
      const output = parseResult(block)
      if (output?.ok === true) return { state: 'ok', args, output, error: null }
      return { state: 'error', args, output, error: output?.error ?? { code: block.error?.code ?? 'error', message: block.error?.name ?? '' } }
    }

    /** The full result card: output first, then the evidence. */
    function ResultCard({ shown }) {
      const interval = shown.interval
      const isolation = shown.run?.isolation ?? {}
      return h('div', { style: styles.card, 'data-analysis-card': 'result', 'data-state': 'ok' },
        h('div', { style: styles.head },
          h('span', { style: muted }, copy.result),
          h('span', { style: styles.title }, shown.title),
          h('span', { style: styles.badge() }, copy[shown.kind] ?? copy.other)),
        Array.isArray(shown.numbers) && shown.numbers.length > 0 && h('div', { style: styles.numbers, 'data-analysis-numbers': '' }, shown.numbers.map((item, index) =>
          h('div', { key: index, style: styles.number }, h('span', { style: styles.numberValue }, formatValue(item.value)), h('span', { style: styles.numberName }, item.name)))),
        (shown.figures ?? []).map(figure => h(Figure, { key: figure.name, figure })),
        (shown.tables ?? []).map(table => h(Table, { key: table.name, table })),
        h('div', { style: styles.section, 'data-analysis-evidence': '' },
          h('div', { style: styles.sectionTitle }, copy.evidence),
          h('div', { style: styles.label }, copy.inputs),
          h(Inputs, { inputs: shown.inputs ?? [] }),
          h('div', { style: styles.label }, copy.method),
          h('div', null, shown.method),
          h('div', { style: styles.label }, copy.assumptions),
          h('ul', { style: styles.list }, (shown.assumptions ?? []).map((item, index) => h('li', { key: index }, item))),
          h('div', { style: styles.label }, copy.uncertainty),
          h('div', null, shown.uncertainty),
          interval && h(Meta, { items: [`${copy.interval} ${interval.table}: ${interval.lower} – ${interval.upper}`, typeof interval.level === 'number' && `${copy.level} ${Math.round(interval.level * 1000) / 10}%`] }),
          h('div', { style: styles.label }, copy.execution),
          h(Meta, { items: [
            shown.run?.started_at && formatTime(shown.run.started_at),
            typeof shown.run?.duration_ms === 'number' && `${copy.took} ${(shown.run.duration_ms / 1000).toFixed(1)}s`,
            isolation.network === 'none' && copy.noNetwork,
            isolation.root_filesystem === 'read-only' && copy.readOnly,
            shown.run?.image,
            `run ${shown.run_id}`,
          ] }),
          h(Fold, { label: copy.code, text: shown.code })))
    }

    /**
     * Tool row of analysis_present_result. Work details fold when a turn ends,
     * so the row stays short and the full card is rendered at the turn tail.
     */
    function PresentRow(props) {
      const { state, args, output, error } = settle(props)
      const shown = output?.presentation
      return h('div', { style: styles.card, 'data-analysis-card': 'present', 'data-state': state },
        h('div', { style: styles.head },
          h('span', { style: muted }, copy.result),
          h('span', { style: styles.title }, String(shown?.title ?? args.title ?? '')),
          stateBadge(state, copy.presenting),
          state === 'ok' && h('span', { style: styles.badge('good') }, copy.shownBelow)),
        shown && h(Meta, { items: [
          copy[shown.kind] ?? copy.other,
          `run ${shown.run_id}`,
          (shown.tables ?? []).concat(shown.figures ?? []).map(item => item.name).join(', '),
        ] }),
        error && h(ErrorLine, { error }))
    }

    /** Result cards of a finished turn, below its closing reply. */
    function ResultsTail(props) {
      const presentations = props.turn?.data?.get(TURN_DATA_KEY)
      if (!Array.isArray(presentations) || presentations.length === 0) return null
      return h('div', { 'data-analysis-results': '' }, presentations.map(item => h(ResultCard, { key: item.callId, shown: item.presentation })))
    }

    /**
     * Turn-local accumulator of successful analysis_present_result calls; it
     * publishes no view node, only the turn data the tail reads.
     */
    const resultsDefinition = {
      // Turn data is keyed by the definition's kind.
      kind: TURN_DATA_KEY,
      match(event) {
        if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
        if (event.type === 'tool/call' && event.data?.name === 'analysis_present_result') return { id: String(event.data.turn), role: 'update' }
        // A replacement copy of a result would repeat the card.
        if (event.type === 'tool/result' && (event.surfaceOp === undefined || event.surfaceOp === 'append')) return { id: String(event.data.turn), role: 'update' }
        return null
      },
      start(_context, match) {
        return { turn: match.event.data.turn, calls: new Set(), presentations: [] }
      },
      update(context, match) {
        const { state } = context
        const event = match.event
        if (state === undefined) return state
        if (event.type === 'tool/call') return { ...state, calls: new Set([...state.calls, String(event.data.callId)]) }
        if (event.type !== 'tool/result' || event.data.message?.isError === true) return state
        const callId = String(event.data.message?.source?.callId)
        if (!state.calls.has(callId) || state.presentations.some(item => item.callId === callId)) return state
        const output = parseResult(event.data.message)
        if (output?.ok !== true || output.presentation === null || typeof output.presentation !== 'object') return state
        return { ...state, presentations: [...state.presentations, { callId, presentation: output.presentation }] }
      },
      buildLocationData(context, scope, previous) {
        if (scope !== 'turn' || context.state === undefined) return null
        if (previous?.kind === 'turn' && previous.turn === context.state.turn && previous.key === TURN_DATA_KEY && previous.value === context.state.presentations) return previous
        return { kind: 'turn', turn: context.state.turn, key: TURN_DATA_KEY, value: context.state.presentations }
      },
    }

    function RunCard(props) {
      const { state, args, output, error } = settle(props)
      const run = output?.run
      const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : []
      return h('div', { style: styles.card, 'data-analysis-card': 'run', 'data-state': state },
        h('div', { style: styles.head },
          h('span', { style: muted }, copy.run),
          Array.isArray(args.inputs) && h('code', null, args.inputs.join(', ')),
          stateBadge(state, copy.running),
          state === 'ok' && h('span', { style: styles.badge('good') }, copy.ok)),
        error && h(ErrorLine, { error }),
        run && h(Meta, { items: [
          typeof run.duration_ms === 'number' && `${copy.took} ${(run.duration_ms / 1000).toFixed(1)}s`,
          artifacts.length > 0 && `${copy.artifacts} ${artifacts.map(item => item.name).join(', ')}`,
          copy.noNetwork,
        ] }),
        h(Fold, { label: copy.code, text: args.code }),
        h(Fold, { label: copy.stdout, text: run?.stdout }),
        h(Fold, { label: copy.stderr, text: run?.stderr }))
    }

    function InputCard(props) {
      const { state, args, output, error } = settle(props)
      const input = output?.input
      return h('div', { style: styles.card, 'data-analysis-card': 'input', 'data-state': state },
        h('div', { style: styles.head },
          h('span', { style: muted }, copy.input),
          !input && h('span', { style: styles.title }, String(args.analysis_id ?? '')),
          stateBadge(state, copy.preparing)),
        input && h(Inputs, { inputs: [input] }),
        error && h(ErrorLine, { error }))
    }

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        const rows = { analysis_present_result: PresentRow, analysis_run_python: RunCard, analysis_prepare_input: InputCard }
        for (const [key, component] of Object.entries(rows)) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, component))
        }
        ctx.uiConversation.events.register(resultsDefinition)
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: '@ours/analysis-exec' }, ResultsTail))
      },
    }
  },
})

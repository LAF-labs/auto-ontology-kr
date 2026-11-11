/**
 * Browser half of @ours/analysis-exec.
 *
 * One-line step rows (keyed `tool.call.toolview` registrations) for the three
 * analysis tools, and the result card. Chat folds a finished turn's tool rows
 * into its work details, so the result card is not a tool row: a turn-data
 * definition collects the turn's successful `analysis_present_result` results
 * and a `conversation.chat.turnTail` entry renders one card per result below
 * the closing reply, where it stays visible.
 *
 * Everything derives from the logged call arguments and tool result text (the
 * JSON the model saw), so a replayed session renders the same views; figures
 * are fetched from the host's artifact route by the path in the result.
 *
 * The card is written for a person who does not read code or statistics. Its
 * first screen holds the answer (a forecast with its range, or the headline
 * numbers), one plain sentence on how it was worked out, how far to trust it,
 * and which confirmed analyses it was computed from. Method, assumptions,
 * every number, the tables of a forecast and the code are one click further.
 * Analysis ids, file names of inputs, image names and run ids are not shown.
 */
window.__ModuleLoader__.load({
  id: '@ours/analysis-exec',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const TURN_DATA_KEY = 'oursAnalysisResults'

    /** 은 after a final consonant, 는 otherwise; 은 for text that does not end in a Hangul syllable. */
    function topicParticle(text) {
      const code = text.charCodeAt(text.length - 1)
      return code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 === 0 ? '는' : '은'
    }

    const COPY = {
      ko: {
        badge: { forecast: '예측', other: '확인 전' },
        estimate: '확인된 숫자를 바탕으로 한 추정이며, 보장이 아닙니다.',
        unreviewed: '확인된 숫자로 방금 새로 계산했습니다. 중요한 결정에 쓰기 전에 확인해 주세요.',
        about: '약',
        range: (level, lower, upper, unit) => `${level}% 확률로 ${lower}~${upper}${unit} 사이`,
        periods: n => `이후 ${n - 1}개 기간의 예측은 '자세히'에 있습니다.`,
        basis: '계산에 쓴 숫자', confirmed: '확인됨', unconfirmed: '확인 전',
        values: n => `값 ${n}개`, asOf: time => `${time} 기준`, conditions: '조건',
        details: '자세히', numbers: '자세한 수치', method: '통계 방법', assumptions: '가정', sourcesDetail: '계산에 쓴 숫자 자세히',
        version: v => `분석 버전 ${v}`, rows: n => `${n}행`, shownOf: (shown, n) => `${n}행 중 ${shown}행 표시`, download: 'CSV 내려받기',
        process: '계산 과정 보기', computedAt: time => `${time}에 계산`, isolated: '외부와 끊긴 환경에서 실행', code: '계산 코드', figureMissing: '그림을 불러오지 못했습니다',
        steps: {
          analysis_prepare_input: ['확인된 분석에서 숫자를 가져오는 중', '확인된 분석에서 숫자를 가져옴'],
          analysis_run_python: ['계산하는 중', '계산을 마침'],
          analysis_present_result: ['결과를 정리하는 중', '결과를 정리함 · 답변 아래에 표시'],
        },
        elapsed: seconds => `${seconds}초 경과`, took: seconds => `${seconds}초`,
        notUsable: '쓸 수 없음', failed: '마치지 못함', retrying: '다시 계산합니다', stopped: '중단됨', output: '출력 보기', errorDetail: '자세히',
        errors: {
          not_verified: name => `${name ? `「${name}」${topicParticle(name)} ` : ''}아직 확인 전이라 분석에 쓸 수 없습니다. 확인된 분석만 쓸 수 있습니다.`,
          input_truncated: () => '결과가 너무 커서 전부 가져오지 못했습니다. 기간을 줄이거나 더 요약된 분석을 써야 합니다.',
          not_found: () => '해당 분석을 찾을 수 없습니다.',
          invalid_params: () => '분석 조건이 올바르지 않습니다.',
          unreachable: () => '데이터 서버에 연결하지 못했습니다. 잠시 뒤 다시 물어봐 주세요.',
          timeout: () => '제한 시간 안에 계산을 마치지 못했습니다.',
          busy: () => '지금 다른 계산이 진행 중입니다. 잠시 뒤 다시 시도해 주세요.',
          failed: () => '계산 중 오류가 났습니다.',
          killed: () => '계산에 메모리가 너무 많이 필요해 중단했습니다.',
          output_limit: () => '계산 결과가 허용 크기를 넘어 중단했습니다.',
          unavailable: () => '지금 이 환경에서는 분석 계산을 실행할 수 없습니다. 관리자에게 문의해 주세요.',
          fallback: () => '이 단계를 마치지 못했습니다.',
        },
      },
      en: {
        badge: { forecast: 'Forecast', other: 'Unreviewed' },
        estimate: 'An estimate from confirmed numbers, not a guarantee.',
        unreviewed: 'Newly calculated from confirmed numbers. Check it before an important decision.',
        about: 'about',
        range: (level, lower, upper, unit) => `${level}% likely between ${lower} and ${upper}${unit}`,
        periods: n => `Forecasts for the ${n - 1} later periods are under Details.`,
        basis: 'Computed from', confirmed: 'Confirmed', unconfirmed: 'Unreviewed',
        values: n => `${n} values`, asOf: time => `as of ${time}`, conditions: 'Conditions',
        details: 'Details', numbers: 'All numbers', method: 'Statistical method', assumptions: 'Assumptions', sourcesDetail: 'Inputs in detail',
        version: v => `analysis version ${v}`, rows: n => `${n} rows`, shownOf: (shown, n) => `${shown} of ${n} rows shown`, download: 'Download CSV',
        process: 'Show the calculation', computedAt: time => `computed ${time}`, isolated: 'run in an environment cut off from outside', code: 'Calculation code', figureMissing: 'The figure could not be loaded',
        steps: {
          analysis_prepare_input: ['Fetching numbers from a confirmed analysis', 'Fetched numbers from a confirmed analysis'],
          analysis_run_python: ['Calculating', 'Calculation finished'],
          analysis_present_result: ['Preparing the result', 'Result prepared · shown below the reply'],
        },
        elapsed: seconds => `${seconds}s`, took: seconds => `${seconds}s`,
        notUsable: 'Not usable', failed: 'Not finished', retrying: 'calculating again', stopped: 'Stopped', output: 'Show output', errorDetail: 'Details',
        errors: {
          not_verified: name => `${name ? `"${name}" is ` : 'This analysis is '}not confirmed yet and cannot be used. Only confirmed analyses can.`,
          input_truncated: () => 'The result is too large to fetch whole. Narrow the period or use a more aggregated analysis.',
          not_found: () => 'That analysis was not found.',
          invalid_params: () => 'The analysis conditions are not valid.',
          unreachable: () => 'The data server could not be reached. Ask again shortly.',
          timeout: () => 'The calculation did not finish in time.',
          busy: () => 'Another calculation is running. Try again shortly.',
          failed: () => 'The calculation hit an error.',
          killed: () => 'The calculation needed too much memory and was stopped.',
          output_limit: () => 'The calculation wrote more than allowed and was stopped.',
          unavailable: () => 'Analysis calculations cannot run in this environment right now. Contact the administrator.',
          fallback: () => 'This step did not finish.',
        },
      },
    }
    const copy = String(globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ko') ? COPY.ko : COPY.en
    const locale = globalThis.navigator?.language
    const ERROR_KIND = {
      not_verified: 'not_verified', retired: 'not_verified', input_truncated: 'input_truncated', export_too_large: 'input_truncated',
      not_found: 'not_found', invalid_params: 'invalid_params', invalid_request: 'fallback',
      unreachable: 'unreachable', gateway_error: 'unreachable', bad_response: 'unreachable', connector_timeout: 'unreachable', db_error: 'unreachable',
      missing_token: 'unreachable', unauthorized: 'unreachable', forbidden: 'unreachable',
      timeout: 'timeout', busy: 'busy', export_quota_exceeded: 'busy', failed: 'failed', killed: 'killed', output_limit: 'output_limit',
      runtime_unavailable: 'unavailable', image_missing: 'unavailable', runtime_error: 'unavailable',
    }

    const muted = { opacity: 0.65 }
    const border = '1px solid color-mix(in srgb, currentColor 14%, transparent)'
    const styles = {
      card: { border, borderRadius: 8, padding: '14px 16px', margin: '8px 0 4px', fontSize: 13, lineHeight: 1.5 },
      head: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
      title: { fontWeight: 600, fontSize: 14 },
      badge: (tone) => ({
        fontSize: 11, padding: '1px 7px', borderRadius: 999, border, whiteSpace: 'nowrap',
        background: tone === 'good' ? 'color-mix(in srgb, #2e9e5b 18%, transparent)'
          : tone === 'warn' ? 'color-mix(in srgb, #d08a1a 20%, transparent)'
            : tone === 'info' ? 'color-mix(in srgb, #4c6ef5 22%, transparent)'
              : tone === 'bad' ? 'color-mix(in srgb, #d04040 20%, transparent)' : 'transparent',
      }),
      headline: { marginTop: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 10px' },
      headlineLabel: { fontSize: 14, ...muted },
      headlineValue: { fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' },
      range: { fontSize: 14, marginTop: 2, fontVariantNumeric: 'tabular-nums' },
      highlights: { display: 'flex', flexWrap: 'wrap', gap: '8px 28px', marginTop: 10 },
      highlight: { display: 'flex', flexDirection: 'column' },
      highlightValue: { fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
      highlightLabel: { fontSize: 12, ...muted },
      text: { marginTop: 8 },
      note: { marginTop: 6, fontSize: 12, ...muted },
      basis: { marginTop: 10, paddingTop: 8, borderTop: border, fontSize: 12 },
      basisLine: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 8px', marginTop: 3 },
      figure: { display: 'block', maxWidth: '100%', maxHeight: 380, marginTop: 12 },
      caption: { marginTop: 10, fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '0 10px', alignItems: 'baseline' },
      tableWrap: { overflowX: 'auto', marginTop: 4, maxHeight: 280, overflowY: 'auto' },
      table: { borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' },
      th: { textAlign: 'left', padding: '3px 12px 3px 0', borderBottom: border, whiteSpace: 'nowrap', fontWeight: 600 },
      td: { padding: '3px 12px 3px 0', borderBottom: border, whiteSpace: 'nowrap' },
      num: { textAlign: 'right' },
      label: { fontWeight: 600, marginTop: 10, fontSize: 12 },
      list: { margin: '2px 0 0', paddingLeft: 18 },
      numbers: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '4px 16px', marginTop: 4, fontSize: 12 },
      numberRow: { display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: border, padding: '2px 0', fontVariantNumeric: 'tabular-nums' },
      pre: { margin: '6px 0 0', padding: 8, borderRadius: 6, border, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre', maxHeight: 320, overflowY: 'auto' },
      summary: { cursor: 'pointer', marginTop: 10, fontSize: 12, ...muted },
      link: { color: 'inherit', textDecoration: 'underline', ...muted },
      step: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 8px', fontSize: 13, lineHeight: 1.5, padding: '2px 0', ...muted },
      stepSubject: { maxWidth: '36em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 },
      stepBody: { fontSize: 13, lineHeight: 1.5, padding: '0 0 2px' },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', alignSelf: 'center', background: 'currentColor', animation: 'ours-analysis-pulse 1.2s ease-in-out infinite' },
    }
    if (document.getElementById('ours-analysis-keyframes') === null) {
      const style = document.createElement('style')
      style.id = 'ours-analysis-keyframes'
      style.textContent = '@keyframes ours-analysis-pulse{0%,100%{opacity:.25}50%{opacity:1}}'
      document.head.append(style)
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
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
    }

    /** A number as people write it: grouped digits, at most two decimals. */
    function formatNumber(value) {
      return value.toLocaleString(locale, { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 })
    }

    function formatValue(value) {
      if (typeof value === 'number') return formatNumber(value)
      return value === null || value === undefined ? '—' : String(value)
    }

    /**
     * Rounds a forecast and its bounds for reading, all to the same step: two
     * leading digits of the point (8,392.6 → 8,400 with 6,096.8 → 6,100).
     */
    function readable(point, values) {
      const size = Math.abs(point)
      const step = size >= 10 ? 10 ** (Math.floor(Math.log10(size)) - 1) : size >= 1 ? 0.1 : 0.01
      const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
      return values.map(value => (Math.round(value / step) * step).toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: digits }))
    }

    const isNumeric = text => typeof text === 'string' && text.trim() !== '' && Number.isFinite(Number(text))

    function Fold({ label, children, open = false }) {
      return h('details', open ? { open: true } : null, h('summary', { style: styles.summary }, label), children)
    }

    function Table({ table }) {
      const columns = Array.isArray(table.columns) ? table.columns : []
      const rows = Array.isArray(table.rows) ? table.rows : []
      const numeric = columns.map((_name, index) => rows.length > 0 && rows.every(row => row[index] === '' || row[index] === undefined || isNumeric(row[index])))
      const count = typeof table.row_count === 'number' ? table.row_count : null
      return h('div', { 'data-analysis-table': '' },
        h('div', { style: styles.caption },
          table.title && h('span', { style: { fontWeight: 600 } }, table.title),
          count !== null && rows.length < count && h('span', { style: muted }, copy.shownOf(rows.length, count)),
          table.path && h('a', { href: table.path, style: styles.link }, copy.download)),
        h('div', { style: styles.tableWrap },
          h('table', { style: styles.table },
            h('thead', null, h('tr', null, columns.map((name, index) => h('th', { key: index, style: numeric[index] ? { ...styles.th, ...styles.num } : styles.th }, name)))),
            h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: rowIndex }, columns.map((_name, index) =>
              h('td', { key: index, style: numeric[index] ? { ...styles.td, ...styles.num } : styles.td },
                row[index] === '' || row[index] === undefined ? '—' : numeric[index] ? formatNumber(Number(row[index])) : String(row[index])))))))))
    }

    function Figure({ figure }) {
      const [failed, setFailed] = React.useState(false)
      if (failed) return h('div', { style: styles.note }, copy.figureMissing)
      return h('img', { src: figure.path, alt: figure.title ?? '', style: styles.figure, loading: 'lazy', onError: () => setFailed(true) })
    }

    /** Conditions of one input as `label value · label value`, without JSON punctuation. */
    function conditionsText(conditions) {
      return (conditions ?? []).map(item => `${item.label} ${Array.isArray(item.value) ? item.value.join(', ') : typeof item.value === 'object' && item.value !== null ? JSON.stringify(item.value) : item.value}`).join(' · ')
    }

    /**
     * One source in one line: several inputs read from the same analysis show
     * the span of each condition that changed between them.
     */
    function sourceSummary(source) {
      const files = source.files ?? []
      if (files.length <= 1) return conditionsText(files[0]?.conditions)
      const labels = (files[0]?.conditions ?? []).map(item => item.label)
      const parts = []
      for (const label of labels) {
        const values = files.map(file => file.conditions?.find(item => item.label === label)?.value).filter(value => value !== undefined).map(String)
        const distinct = [...new Set(values)]
        if (distinct.length === 1) parts.push(`${label} ${distinct[0]}`)
        else { const sorted = [...distinct].sort(); parts.push(`${label} ${sorted[0]} ~ ${sorted[sorted.length - 1]}`) }
      }
      return [copy.values(files.length), ...parts].join(' · ')
    }

    function latest(files) {
      const times = (files ?? []).map(file => file.as_of).filter(value => typeof value === 'string').sort()
      return times.length > 0 ? times[times.length - 1] : null
    }

    function confirmedBadge(source, key) {
      const confirmed = source.status === 'verified'
      return h('span', { key, style: styles.badge(confirmed ? 'good' : 'warn') }, confirmed ? copy.confirmed : copy.unconfirmed)
    }

    function Sources({ sources }) {
      return h('div', { style: styles.basis, 'data-analysis-basis': '' },
        h('div', { style: muted }, copy.basis),
        sources.map((source, index) => {
          const asOf = latest(source.files)
          const summary = sourceSummary(source)
          return h('div', { key: index, style: styles.basisLine },
            confirmedBadge(source, 'b'),
            h('span', { style: { fontWeight: 600 } }, `「${source.name}」`),
            summary && h('span', { style: muted }, (source.files ?? []).length <= 1 ? `${copy.conditions}: ${summary}` : summary),
            asOf && h('span', { style: muted }, copy.asOf(formatTime(asOf))))
        }))
    }

    function SourcesDetail({ sources }) {
      return h('div', null,
        h('div', { style: styles.label }, copy.sourcesDetail),
        sources.map((source, index) => h('div', { key: index, style: { marginTop: 2, fontSize: 12 } },
          h('div', null, `「${source.name}」 · ${source.status === 'verified' ? copy.confirmed : copy.unconfirmed} · ${copy.version(source.version)}`),
          h('ul', { style: { ...styles.list, ...muted } }, (source.files ?? []).map((file, fileIndex) =>
            h('li', { key: fileIndex }, [conditionsText(file.conditions), file.as_of && copy.asOf(formatTime(file.as_of)), typeof file.rows === 'number' && copy.rows(file.rows)].filter(Boolean).join(' · ')))))))
    }

    /** The result card: the answer and how far to trust it first; details and the calculation one click further. */
    function ResultCard({ shown }) {
      const forecast = shown.kind === 'forecast'
      const headline = shown.headline
      const unit = headline?.unit ?? ''
      const [point, lower, upper] = headline ? readable(headline.point, [headline.point, headline.lower, headline.upper]) : []
      const tables = shown.tables ?? []
      const numbers = Array.isArray(shown.numbers) ? shown.numbers : []
      return h('div', { style: styles.card, 'data-analysis-card': 'result', 'data-state': 'ok' },
        h('div', { style: styles.head },
          h('span', { style: styles.badge(forecast ? 'info' : 'warn') }, forecast ? copy.badge.forecast : copy.badge.other),
          h('span', { style: styles.title }, shown.title)),
        headline && h('div', { 'data-analysis-headline': '' },
          h('div', { style: styles.headline },
            h('span', { style: styles.headlineLabel }, headline.label),
            h('span', { style: styles.headlineValue }, `${copy.about} ${point}${unit}`)),
          h('div', { style: styles.range }, copy.range(Math.round(headline.level * 1000) / 10, lower, upper, unit)),
          headline.periods > 1 && h('div', { style: styles.note }, copy.periods(headline.periods))),
        !headline && (shown.highlights ?? []).length > 0 && h('div', { style: styles.highlights, 'data-analysis-highlights': '' }, shown.highlights.map((item, index) =>
          h('div', { key: index, style: styles.highlight },
            h('span', { style: styles.highlightValue }, `${formatValue(item.value)}${item.unit ?? ''}`),
            h('span', { style: styles.highlightLabel }, item.label)))),
        h('div', { style: styles.text }, shown.summary),
        h('div', { style: styles.text }, shown.uncertainty),
        h('div', { style: styles.note }, forecast ? copy.estimate : copy.unreviewed),
        (shown.figures ?? []).map(figure => h(Figure, { key: figure.name, figure })),
        !forecast && tables.map(table => h(Table, { key: table.name, table })),
        h(Sources, { sources: shown.sources ?? [] }),
        h(Fold, { label: copy.details },
          forecast && tables.map(table => h(Table, { key: table.name, table })),
          numbers.length > 0 && h('div', null,
            h('div', { style: styles.label }, copy.numbers),
            h('div', { style: styles.numbers }, numbers.map((item, index) => h('div', { key: index, style: styles.numberRow }, h('span', { style: muted }, item.name), h('span', null, formatValue(item.value)))))),
          h('div', { style: styles.label }, copy.method),
          h('div', null, shown.method),
          h('div', { style: styles.label }, copy.assumptions),
          h('ul', { style: styles.list }, (shown.assumptions ?? []).map((item, index) => h('li', { key: index }, item))),
          h(SourcesDetail, { sources: shown.sources ?? [] })),
        h(Fold, { label: copy.process },
          h('div', { style: styles.note }, [shown.run?.started_at && copy.computedAt(formatTime(shown.run.started_at)), shown.run?.isolated && copy.isolated].filter(Boolean).join(' · ')),
          h('div', { style: styles.label }, copy.code),
          h('pre', { style: styles.pre }, shown.code)))
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

    /** Seconds since this view first saw the step running; the log holds no start time for a running call. */
    function useElapsed(running) {
      const [seconds, setSeconds] = React.useState(0)
      React.useEffect(() => {
        if (!running) return undefined
        const started = Date.now()
        const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
        return () => clearInterval(timer)
      }, [running])
      return seconds
    }

    function errorSentence(error) {
      const kind = ERROR_KIND[error?.code] ?? 'fallback'
      const quoted = /"([^"]+)"/.exec(String(error?.message ?? ''))
      return copy.errors[kind](quoted ? quoted[1] : null)
    }

    function ErrorBody({ error, children }) {
      return h('div', { style: styles.stepBody },
        h('div', null, errorSentence(error)),
        h(Fold, { label: copy.errorDetail },
          h('div', { style: styles.note }, h('code', null, String(error.code ?? 'error')), ' ', String(error.message ?? '')),
          children))
    }

    /** One step row: what is happening in a person's words, then what it concerned. */
    function Step({ toolName, state, subject, trailing, tone }) {
      const [running, done] = copy.steps[toolName]
      return h('div', { style: styles.step, 'data-analysis-step': toolName, 'data-state': state },
        state === 'running' && h('span', { style: styles.dot }),
        h('span', null, state === 'running' ? running : state === 'ok' ? done : state === 'stopped' ? copy.stopped : running.replace(/ 중$/, '')),
        state === 'error' && h('span', { style: styles.badge(tone ?? 'bad') }, tone === 'warn' ? copy.notUsable : copy.failed),
        subject && h('span', { style: styles.stepSubject }, subject),
        trailing && h('span', null, trailing))
    }

    function InputStep(props) {
      const { state, output, error } = settle(props)
      const input = output?.input
      const unusable = ['not_verified', 'retired', 'input_truncated'].includes(error?.code)
      return h('div', { 'data-analysis-card': 'input', 'data-state': state },
        h(Step, {
          toolName: 'analysis_prepare_input', state, tone: unusable ? 'warn' : 'bad',
          subject: input?.analysis?.name ? `「${input.analysis.name}」` : null,
          trailing: input ? [conditionsText(input.conditions), input.executed_at && copy.asOf(formatTime(input.executed_at))].filter(Boolean).join(' · ') : null,
        }),
        error && h(ErrorBody, { error }))
    }

    function RunStep(props) {
      const { state, args, output, error } = settle(props)
      const run = output?.run
      const seconds = useElapsed(state === 'running')
      const outputText = [run?.stdout, run?.stderr].filter(text => typeof text === 'string' && text.trim() !== '').join('\n')
      return h('div', { 'data-analysis-card': 'run', 'data-state': state },
        h(Step, {
          toolName: 'analysis_run_python', state,
          trailing: state === 'running' ? (seconds >= 3 ? copy.elapsed(seconds) : null)
            : state === 'ok' && typeof run?.duration_ms === 'number' ? copy.took(Math.max(1, Math.round(run.duration_ms / 1000)))
              : state === 'error' && error?.code === 'failed' ? copy.retrying : null,
        }),
        error && error.code !== 'failed' && h('div', { style: styles.stepBody }, errorSentence(error)),
        state !== 'running' && h(Fold, { label: copy.process },
          h('pre', { style: styles.pre }, String(args.code ?? '')),
          outputText !== '' && h(Fold, { label: copy.output }, h('pre', { style: styles.pre }, outputText))))
    }

    function PresentStep(props) {
      const { state, error } = settle(props)
      return h('div', { 'data-analysis-card': 'present', 'data-state': state },
        h(Step, { toolName: 'analysis_present_result', state }),
        error && h(ErrorBody, { error }))
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

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        const rows = { analysis_present_result: PresentStep, analysis_run_python: RunStep, analysis_prepare_input: InputStep }
        for (const [key, component] of Object.entries(rows)) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, component))
        }
        ctx.uiConversation.events.register(resultsDefinition)
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: '@ours/analysis-exec' }, ResultsTail))
      },
    }
  },
})

/**
 * Browser half of @ours/ao-connector: result cards for the Auto-ontology
 * agent tools `ao_run_analysis` and `ao_ask_question`, and one-line step rows
 * for the lookup tools (keyed `tool.call.toolview` registrations). Each view
 * derives only from the logged call arguments and the tool result text (the
 * JSON the model saw), so a replayed session renders the same view. A new
 * question shows how long it has been running while this page watches it.
 */
window.__ModuleLoader__.load({
  id: '@ours/ao-connector',
  factory(require) {
    const React = require('react')
    const { parseArgs, parseToolResult, cardModel } = createModelHelpers()
    const h = React.createElement

    const COPY = {
      ko: {
        running: '확인된 분석을 실행하는 중', asking: '새로 계산하는 중', saved: '확인된 분석', generated: '새로 계산',
        verified: '확인됨', draft: '확인 전', unreviewed: '확인 전',
        asOf: time => `${time} 기준`, executedAt: '계산 시각', cached: '저장된 결과 사용', duration: '계산에 걸린 시간', version: '분석 버전',
        rows: n => `${n}행`, shownOf: (shown, n) => `${n}행 중 ${shown}행 표시`, truncated: '일부만 가져옴', source: '데이터:', params: '조건:',
        sql: '계산식 보기 (SQL)', failed: '실패', lastSuccess: time => time ? `지금 새로 계산하지 못했습니다. ${time}의 값을 보여 드립니다.` : '지금 새로 계산하지 못했습니다. 이전에 성공한 값을 보여 드립니다.', noRows: '해당하는 데이터가 없습니다', analysesUsed: '참고한 분석', stopped: '중단됨',
        askingHelp: '확인된 분석에 없는 질문이라 데이터에서 새로 계산하고 있습니다. 보통 1~3분 걸립니다.',
        askingLong: '평소보다 오래 걸리고 있습니다. 계속 기다리거나, 중지한 뒤 질문을 더 구체적으로 바꿔 보세요.',
        elapsed: seconds => seconds < 60 ? `${seconds}초 경과` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초 경과`,
        unreviewedHelp: '방금 새로 계산한 숫자라 아직 사람이 확인하지 않았습니다. 결정에 쓰기 전에 알고 있는 숫자와 맞는지 담당자가 대조해 주세요.',
        versionLabel: n => `분석 버전 v${n}`,
        paramNames: { start_date: '시작일', end_date: '종료일', month_start: '기준 월', top_n: '상위 개수', limit: '개수', statuses: '상태', status: '상태' },
        errors: {
          unreachable: '데이터 서버에 연결하지 못했습니다. 잠시 뒤 다시 물어봐 주세요.', timeout: '제한 시간 안에 계산을 마치지 못했습니다.',
          ask_deadline: '시간 안에 끝나지 않아 이 계산을 멈췄습니다. 원하시면 다시 계산해 보겠습니다.',
          busy: '지금 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.', not_found: '해당 분석을 찾을 수 없습니다.', not_verified: '아직 확인 전인 분석입니다.',
          invalid_params: '분석 조건이 올바르지 않습니다.', db_error: '데이터베이스에서 값을 읽지 못했습니다.', ask_failed: '이 질문의 계산식을 만들지 못했습니다. 질문을 더 구체적으로 바꿔 보세요.',
          unauthorized: '데이터 서버 접근 권한을 확인해 주세요.', fallback: '이 단계를 마치지 못했습니다.',
        },
        steps: {
          ao_list_analyses: ['확인된 분석을 찾는 중', '확인된 분석을 찾아봄'], ao_get_analysis: ['분석 정의를 읽는 중', '분석 정의를 읽음'],
          ao_search_terms: ['용어를 확인하는 중', '용어를 확인함'], ao_question_coverage: ['답할 수 있는 질문인지 확인하는 중', '답할 수 있는 질문인지 확인함'],
        },
        found: n => `${n}건`, stepFailed: '확인하지 못함',
      },
      en: {
        running: 'Calculating', asking: 'Analyzing', saved: 'Confirmed analysis', generated: 'New calculation',
        verified: 'Confirmed', draft: 'Not confirmed yet', unreviewed: 'Not confirmed yet',
        asOf: time => `as of ${time}`, executedAt: 'Computed', cached: 'stored result', duration: 'calculation time', version: 'analysis version',
        rows: n => `${n} rows`, shownOf: (shown, n) => `${shown} of ${n} rows shown`, truncated: 'partial', source: 'Data:', params: 'Conditions:',
        sql: 'Show the formula (SQL)', failed: 'Failed', lastSuccess: time => time ? `Could not calculate it now. Showing the value from ${time}.` : 'Could not calculate it now. Showing the last successful value.', noRows: 'No matching data', analysesUsed: 'Analyses used', stopped: 'Stopped',
        askingHelp: 'No saved analysis answers this, so a query is being written against the data. This usually takes 1 to 3 minutes.',
        askingLong: 'This is taking longer than usual. Keep waiting, or stop and ask a more specific question.',
        elapsed: seconds => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
        unreviewedHelp: 'This number was just calculated and no person has confirmed it yet. Before deciding on it, compare it with a number you know.',
        versionLabel: n => `analysis version v${n}`,
        paramNames: { start_date: 'Start', end_date: 'End', month_start: 'Month', top_n: 'Top', limit: 'Count', statuses: 'Status', status: 'Status' },
        errors: {
          unreachable: 'The data server could not be reached. Try again shortly.', timeout: 'The calculation did not finish in time.',
          busy: 'Too many requests right now. Try again shortly.', ask_deadline: 'This calculation was stopped because it did not finish in time. It can be tried again.', not_found: 'That analysis was not found.', not_verified: 'This analysis is not verified yet.',
          invalid_params: 'The analysis conditions are not valid.', db_error: 'The database could not be read.', ask_failed: 'No query could be written for this question. Try a more specific question.',
          unauthorized: 'Check the access to the data server.', fallback: 'This step did not finish.',
        },
        steps: {
          ao_list_analyses: ['Looking for saved analyses', 'Looked for saved analyses'], ao_get_analysis: ['Reading the analysis', 'Read the analysis'],
          ao_search_terms: ['Searching the data for terms', 'Searched the data for terms'], ao_question_coverage: ['Checking whether this can be answered', 'Checked whether this can be answered'],
        },
        found: n => `${n} found`, stepFailed: 'not confirmed',
      },
    }
    const copy = String(globalThis.navigator?.language ?? 'en').toLowerCase().startsWith('ko') ? COPY.ko : COPY.en
    const locale = globalThis.navigator?.language
    const ERROR_KIND = {
      unreachable: 'unreachable', gateway_error: 'unreachable', bad_response: 'unreachable', timeout: 'timeout', connector_timeout: 'timeout',
      busy: 'busy', not_found: 'not_found', not_verified: 'not_verified', retired: 'not_verified', invalid_params: 'invalid_params', db_error: 'db_error',
      ask_failed: 'ask_failed', ask_deadline: 'ask_deadline', missing_token: 'unauthorized', unauthorized: 'unauthorized', forbidden: 'unauthorized',
    }
    const errorText = code => copy.errors[ERROR_KIND[code] ?? 'fallback']

    const muted = { opacity: 0.65 }
    const border = '1px solid color-mix(in srgb, currentColor 14%, transparent)'
    const styles = {
      card: { border, borderRadius: 8, padding: '10px 12px', margin: '4px 0', fontSize: 13, lineHeight: 1.45 },
      head: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
      title: { fontWeight: 600 },
      badge: (tone) => ({
        fontSize: 11, padding: '1px 6px', borderRadius: 999, border,
        background: tone === 'good' ? 'color-mix(in srgb, #2e9e5b 18%, transparent)'
          : tone === 'warn' ? 'color-mix(in srgb, #d08a1a 20%, transparent)'
            : tone === 'bad' ? 'color-mix(in srgb, #d04040 20%, transparent)' : 'transparent',
      }),
      meta: { display: 'flex', flexWrap: 'wrap', gap: '2px 14px', marginTop: 6, fontSize: 12, ...muted },
      tableWrap: { overflowX: 'auto', marginTop: 8, maxHeight: 320, overflowY: 'auto' },
      table: { borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' },
      th: { textAlign: 'left', padding: '3px 10px 3px 0', borderBottom: border, whiteSpace: 'nowrap', fontWeight: 600 },
      td: { padding: '3px 10px 3px 0', borderBottom: border, whiteSpace: 'nowrap' },
      num: { textAlign: 'right' },
      pre: { margin: '6px 0 0', padding: 8, borderRadius: 6, border, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre' },
      summary: { cursor: 'pointer', marginTop: 8, fontSize: 12, ...muted },
      error: { marginTop: 6 },
      sub: { marginTop: 10, paddingTop: 8, borderTop: border },
      step: { display: 'flex', flexWrap: 'wrap', gap: '0 8px', fontSize: 13, lineHeight: 1.5, padding: '2px 0', ...muted },
      stepSubject: { maxWidth: '36em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 },
      wait: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12, ...muted },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', background: 'currentColor', animation: 'ours-ao-pulse 1.2s ease-in-out infinite' },
    }
    if (document.getElementById('ours-ao-keyframes') === null) {
      const style = document.createElement('style')
      style.id = 'ours-ao-keyframes'
      style.textContent = '@keyframes ours-ao-pulse{0%,100%{opacity:.25}50%{opacity:1}}'
      document.head.append(style)
    }

    function formatTime(iso, seconds = false) {
      if (typeof iso !== 'string') return null
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', ...seconds ? { second: '2-digit' } : {} })
    }

    /** A measure cell as people write numbers: grouped digits, at most two decimals. Identifiers and text stay as they are. */
    function formatCell(cell, column) {
      if (cell === null || cell === undefined) return '—'
      if (typeof cell === 'object') return JSON.stringify(cell)
      if (column?.numeric !== true) return String(cell)
      const number = typeof cell === 'number' ? cell : (typeof cell === 'string' && cell.trim() !== '' ? Number(cell) : NaN)
      return Number.isFinite(number) ? number.toLocaleString(locale, { maximumFractionDigits: 2 }) : String(cell)
    }

    function Table({ table }) {
      if (table.rows.length === 0) return h('div', { style: { ...muted, marginTop: 8 } }, copy.noRows)
      return h('div', { style: styles.tableWrap },
        h('table', { style: styles.table },
          h('thead', null, h('tr', null, table.columns.map((column, index) =>
            h('th', { key: index, style: column.numeric ? { ...styles.th, ...styles.num } : styles.th, title: column.name },
              column.unit ? `${column.label} (${column.unit})` : column.label)))),
          h('tbody', null, table.rows.map((row, rowIndex) => h('tr', { key: rowIndex }, row.map((cell, index) =>
            h('td', { key: index, style: table.columns[index]?.numeric ? { ...styles.td, ...styles.num } : styles.td },
              formatCell(cell, table.columns[index]))))))))
    }

    function Meta({ items }) {
      const shown = items.filter(item => item !== null && item !== undefined && item !== false)
      return shown.length === 0 ? null : h('div', { style: styles.meta }, shown.map((text, index) => h('span', { key: index }, text)))
    }

    function Sql({ sql }) {
      if (typeof sql !== 'string' || sql === '') return null
      return h('details', null, h('summary', { style: styles.summary }, copy.sql), h('pre', { style: styles.pre }, sql))
    }

    function ResultBody({ result }) {
      return h(React.Fragment, null,
        h(Meta, { items: [
          result.executedAt && h('span', {
            title: [`${copy.executedAt} ${formatTime(result.executedAt, true)}`, result.durationMs !== null && `${copy.duration} ${result.durationMs}ms`, result.cache?.hit && copy.cached].filter(Boolean).join(' · '),
          }, copy.asOf(formatTime(result.executedAt))),
          // The row count shows only when the card holds fewer rows than the result.
          result.rowCount !== null && ((result.rowsShown !== null && result.rowsShown < result.rowCount) || result.truncated)
            && `${result.rowsShown !== null && result.rowsShown < result.rowCount ? copy.shownOf(result.rowsShown, result.rowCount) : copy.rows(result.rowCount)}${result.truncated ? ` · ${copy.truncated}` : ''}`,
          result.params && `${copy.params} ${result.params}`,
          result.source && `${copy.source} ${result.source}`,
          result.analysesUsed && `${copy.analysesUsed} ${result.analysesUsed}`,
        ] }),
        result.table && h(Table, { table: result.table }),
        h(Sql, { sql: result.sql }))
    }

    /** Seconds since this card first showed a call as running; it restarts when the page reloads. */
    function useElapsed(active) {
      const [seconds, setSeconds] = React.useState(0)
      React.useEffect(() => {
        if (!active) return undefined
        const started = Date.now()
        const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
        return () => clearInterval(timer)
      }, [active])
      return seconds
    }

    /** One muted line for a lookup step: what was looked up, and how many were found. */
    function StepRow(props) {
      const { phase, block, toolName } = props
      const settled = phase === 'result'
      const args = parseArgs(settled ? block.call?.argsRaw : block.argsRaw)
      const output = settled ? parseToolResult(block) : null
      const [doing, done] = copy.steps[toolName] ?? [toolName, toolName]
      const subject = toolName === 'ao_get_analysis' ? output?.analysis?.name : args.query ?? args.search_term ?? args.question
      const count = toolName === 'ao_list_analyses' ? output?.total : toolName === 'ao_search_terms' ? output?.count : undefined
      const failed = settled && output?.ok !== true
      return h('div', { style: styles.step, 'data-ao-step': toolName, 'data-state': !settled ? 'running' : failed ? 'error' : 'ok', title: failed ? `${output?.error?.code ?? ''} ${output?.error?.message ?? ''}`.trim() : undefined },
        h('span', null, settled ? done : `${doing}…`),
        typeof subject === 'string' && subject !== '' && h('span', { style: styles.stepSubject }, subject),
        typeof count === 'number' && h('span', null, copy.found(count)),
        failed && h('span', null, copy.stepFailed))
    }

    function AoCard(props) {
      const model = cardModel(props)
      const elapsed = useElapsed(model.state === 'running')
      const kindLabel = model.kind === 'ask' ? copy.generated : copy.saved
      const badges = []
      if (model.state === 'running') badges.push(h('span', { key: 's', style: styles.badge() }, model.kind === 'ask' ? copy.asking : copy.running))
      if (model.state === 'error') badges.push(h('span', { key: 's', style: styles.badge('bad') }, copy.failed))
      if (model.state === 'stopped') badges.push(h('span', { key: 's', style: styles.badge('warn') }, copy.stopped))
      if (model.kind === 'ask' && model.state === 'ok') badges.push(h('span', { key: 'r', style: styles.badge('warn') }, copy.unreviewed))
      const versionTitle = model.version !== null ? copy.versionLabel(model.version) : undefined
      if (model.status === 'verified') badges.push(h('span', { key: 'v', style: styles.badge('good'), title: versionTitle }, copy.verified))
      if (model.status === 'draft') badges.push(h('span', { key: 'v', style: styles.badge('warn'), title: versionTitle }, copy.draft))
      return h('div', { style: styles.card, 'data-ao-card': model.kind, 'data-state': model.state },
        h('div', { style: styles.head },
          h('span', { style: muted }, kindLabel),
          // An analysis id alone says nothing to a reader; the name replaces it once the result is in.
          h('span', { style: styles.title }, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(model.title) ? '' : model.title),
          ...badges),
        model.kind === 'ask' && model.state === 'running' && h('div', { style: styles.wait, role: 'status' },
          h('span', { style: styles.dot }), h('span', null, `${copy.elapsed(elapsed)} · ${elapsed >= 240 ? copy.askingLong : copy.askingHelp}`)),
        model.kind === 'ask' && model.state === 'ok' && h('div', { style: { ...styles.meta, marginTop: 4 } }, copy.unreviewedHelp),
        model.result && h(ResultBody, { result: model.result }),
        model.error && h('div', { style: styles.error },
          h('div', { title: `${model.error.code}: ${model.error.message}` }, errorText(model.error.code)),
          model.error.lastSuccess && h('div', { style: styles.sub },
            h('div', { style: styles.title }, copy.lastSuccess(formatTime(model.error.lastSuccess.executedAt))),
            h(ResultBody, { result: model.error.lastSuccess }))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const key of ['ao_run_analysis', 'ao_ask_question']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, AoCard))
        }
        for (const key of Object.keys(COPY.en.steps)) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, StepRow))
        }
      },
    }

    /** View-model helpers kept free of React so the shape logic stays testable by eye. */
    function createModelHelpers() {
      const NUMERIC = new Set(['integer', 'number', 'decimal', 'float', 'double'])

      function parseArgs(raw) {
        try { const value = JSON.parse(raw ?? ''); return value !== null && typeof value === 'object' ? value : {} } catch { return {} }
      }

      function parseToolResult(block) {
        const text = (block.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('')
        try { const value = JSON.parse(text); return value !== null && typeof value === 'object' ? value : null } catch { return null }
      }

      function savedTable(data) {
        if (!Array.isArray(data?.rows) || !Array.isArray(data?.columns)) return null
        return {
          columns: data.columns.map(column => ({
            name: column.name, label: column.label ?? column.name, unit: column.unit ?? null,
            numeric: NUMERIC.has(String(column.type ?? '').toLowerCase()) || column.role === 'measure',
          })),
          rows: data.rows,
        }
      }

      function recordsTable(data) {
        if (!Array.isArray(data?.rows)) return null
        const names = Array.isArray(data.columns) && data.columns.length > 0 ? data.columns : [...new Set(data.rows.flatMap(row => Object.keys(row ?? {})))]
        return {
          columns: names.map(name => ({ name, label: name, unit: null, numeric: data.rows.some(row => typeof row?.[name] === 'number') })),
          rows: data.rows.map(row => names.map(name => row?.[name] ?? null)),
        }
      }

      function savedResult(data) {
        if (data === null || typeof data !== 'object') return null
        const source = data.source
        return {
          executedAt: data.executed_at ?? null,
          durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : null,
          cache: data.cache ? { hit: data.cache.hit === true, expiresAt: data.cache.expires_at ?? null } : null,
          rowCount: typeof data.row_count === 'number' ? data.row_count : Array.isArray(data.rows) ? data.rows.length : null,
          rowsShown: typeof data.rows_shown === 'number' ? data.rows_shown : null,
          truncated: data.truncated === true,
          steps: null,
          // Conditions as words: a known parameter name becomes its display name, a list its items joined by commas.
          params: data.params && Object.keys(data.params).length > 0 ? Object.entries(data.params).map(([name, value]) => `${copy.paramNames[name] ?? name} ${Array.isArray(value) ? value.join(', ') : typeof value === 'object' && value !== null ? JSON.stringify(value) : value}`).join(' · ') : null,
          // Table names without the schema prefix.
          source: source && Array.isArray(source.tables) && source.tables.length > 0 ? source.tables.map(table => String(table).split('.').pop()).join(', ') : null,
          analysesUsed: null,
          table: savedTable(data),
          sql: data.sql ?? null,
        }
      }

      function askResult(data) {
        if (data === null || typeof data !== 'object') return null
        const used = Array.isArray(data.custom_analyses_used) && data.custom_analyses_used.length > 0
          ? data.custom_analyses_used.map(item => typeof item === 'string' ? item : item?.name ?? item?.id ?? JSON.stringify(item)).join(', ')
          : null
        return {
          executedAt: null, durationMs: null, cache: null,
          rowCount: Array.isArray(data.rows) ? data.rows.length : null,
          rowsShown: typeof data.rows_shown === 'number' ? data.rows_shown : null,
          truncated: false,
          steps: typeof data.steps === 'number' ? data.steps : null,
          params: null, source: null, analysesUsed: used,
          table: recordsTable(data),
          sql: data.sql_code ?? null,
        }
      }

      function cardModel({ phase, block, toolName }) {
        const kind = toolName === 'ao_ask_question' ? 'ask' : 'run'
        const settled = phase === 'result'
        const args = parseArgs(settled ? block.call?.argsRaw : block.argsRaw)
        const model = {
          kind, state: 'running', title: kind === 'ask' ? String(args.question ?? '') : String(args.analysis_id ?? ''),
          status: null, version: null, result: null, error: null,
        }
        if (!settled) return model
        if (block.error?.code === 'interrupted') return { ...model, state: 'stopped' }
        const output = parseToolResult(block)
        if (output?.ok === true) {
          const data = kind === 'ask' ? output.answer : output.result
          return {
            ...model, state: 'ok',
            title: kind === 'run' && typeof data?.name === 'string' ? data.name : model.title,
            status: kind === 'run' ? data?.status ?? null : null,
            version: kind === 'run' && typeof data?.version === 'number' ? data.version : null,
            result: kind === 'ask' ? askResult(data) : savedResult(data),
          }
        }
        const error = output?.error ?? { code: block.error?.code ?? 'error', message: block.error?.name ?? '' }
        const last = error.last_success ?? null
        return {
          ...model, state: 'error',
          title: typeof last?.name === 'string' ? last.name : model.title,
          status: last?.status ?? null, version: typeof last?.version === 'number' ? last.version : null,
          error: { code: String(error.code ?? 'error'), message: String(error.message ?? ''), lastSuccess: last ? savedResult(last) : null },
        }
      }

      return { parseArgs, parseToolResult, cardModel }
    }
  },
})

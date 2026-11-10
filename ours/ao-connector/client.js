/**
 * Browser half of @ours/ao-connector: result cards for the Auto-ontology
 * agent tools `ao_run_analysis` and `ao_ask_question` (keyed
 * `tool.call.toolview` registrations). Each card derives only from the logged
 * call arguments and the tool result text (the JSON the model saw), so a
 * replayed session renders the same card. Other ao_* tools keep the generic row.
 */
window.__ModuleLoader__.load({
  id: '@ours/ao-connector',
  factory(require) {
    const React = require('react')
    const { parseToolResult, cardModel } = createModelHelpers()
    const h = React.createElement

    const COPY = {
      ko: {
        running: '실행 중', asking: '질문하는 중', saved: '저장된 분석', generated: '새 질문',
        verified: '검증됨', draft: '초안', unreviewed: '생성된 SQL · 검토 안 됨',
        executedAt: '실행 시각', cached: '캐시', cacheHit: '적중', cacheMiss: '새로 실행', expires: '만료',
        duration: '소요', rows: '행', truncated: '잘림', shown: '표시', source: '출처', params: '파라미터',
        sql: 'SQL 보기', failed: '실패', lastSuccess: '마지막 성공 결과', noRows: '행 없음', steps: '단계',
        analysesUsed: '참고한 분석', stopped: '중단됨',
      },
      en: {
        running: 'Running', asking: 'Asking', saved: 'Saved analysis', generated: 'New question',
        verified: 'Verified', draft: 'Draft', unreviewed: 'Generated SQL · not reviewed',
        executedAt: 'Executed', cached: 'Cache', cacheHit: 'hit', cacheMiss: 'fresh run', expires: 'expires',
        duration: 'took', rows: 'rows', truncated: 'truncated', shown: 'shown', source: 'Source', params: 'Parameters',
        sql: 'Show SQL', failed: 'Failed', lastSuccess: 'Last successful result', noRows: 'No rows', steps: 'steps',
        analysesUsed: 'Analyses used', stopped: 'Stopped',
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
    }

    function formatTime(iso) {
      if (typeof iso !== 'string') return null
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
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
              cell === null ? '—' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell))))))))
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
          result.executedAt && `${copy.executedAt} ${formatTime(result.executedAt)}`,
          result.durationMs !== null && `${copy.duration} ${result.durationMs}ms`,
          result.cache && `${copy.cached} ${result.cache.hit ? copy.cacheHit : copy.cacheMiss}${result.cache.expiresAt ? ` · ${copy.expires} ${formatTime(result.cache.expiresAt)}` : ''}`,
          result.rowCount !== null && `${result.rowCount} ${copy.rows}${result.rowsShown !== null ? ` (${result.rowsShown} ${copy.shown})` : ''}${result.truncated ? ` · ${copy.truncated}` : ''}`,
          result.steps !== null && `${result.steps} ${copy.steps}`,
          result.params && `${copy.params} ${result.params}`,
          result.source && `${copy.source} ${result.source}`,
          result.analysesUsed && `${copy.analysesUsed} ${result.analysesUsed}`,
        ] }),
        result.table && h(Table, { table: result.table }),
        h(Sql, { sql: result.sql }))
    }

    function AoCard(props) {
      const model = cardModel(props)
      const kindLabel = model.kind === 'ask' ? copy.generated : copy.saved
      const badges = []
      if (model.state === 'running') badges.push(h('span', { key: 's', style: styles.badge() }, model.kind === 'ask' ? copy.asking : copy.running))
      if (model.state === 'error') badges.push(h('span', { key: 's', style: styles.badge('bad') }, copy.failed))
      if (model.state === 'stopped') badges.push(h('span', { key: 's', style: styles.badge('warn') }, copy.stopped))
      if (model.kind === 'ask' && model.state === 'ok') badges.push(h('span', { key: 'r', style: styles.badge('warn') }, copy.unreviewed))
      if (model.status === 'verified') badges.push(h('span', { key: 'v', style: styles.badge('good') }, `${copy.verified}${model.version !== null ? ` v${model.version}` : ''}`))
      if (model.status === 'draft') badges.push(h('span', { key: 'v', style: styles.badge('warn') }, `${copy.draft}${model.version !== null ? ` v${model.version}` : ''}`))
      return h('div', { style: styles.card, 'data-ao-card': model.kind, 'data-state': model.state },
        h('div', { style: styles.head },
          h('span', { style: muted }, kindLabel),
          h('span', { style: styles.title }, model.title),
          ...badges),
        model.result && h(ResultBody, { result: model.result }),
        model.error && h('div', { style: styles.error },
          h('div', null, h('code', null, model.error.code), ' ', model.error.message),
          model.error.lastSuccess && h('div', { style: styles.sub },
            h('div', { style: styles.title }, copy.lastSuccess),
            h(ResultBody, { result: model.error.lastSuccess }))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const key of ['ao_run_analysis', 'ao_ask_question']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, AoCard))
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
          params: data.params && Object.keys(data.params).length > 0 ? JSON.stringify(data.params) : null,
          source: source ? [source.database_name, ...(Array.isArray(source.tables) ? source.tables : [])].filter(Boolean).join(' · ') : null,
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
          status: last?.status ?? null, version: typeof last?.version === 'number' ? last.version : null,
          error: { code: String(error.code ?? 'error'), message: String(error.message ?? ''), lastSuccess: last ? savedResult(last) : null },
        }
      }

      return { parseToolResult, cardModel }
    }
  },
})

/**
 * table@1 — rows as a table with column labels and units.
 * Props: { rows, columns, options, theme, locale }. No network access.
 * options: columns (names to show, in order; default all), max_rows (default 200),
 *          decimals (fixed digits for numeric cells).
 */
const NUMERIC = new Set(['integer', 'number', 'decimal', 'float', 'double', 'bigint'])

function isNumericColumn(column, rows, index) {
  if (NUMERIC.has(String(column.type ?? '').toLowerCase()) || column.role === 'measure') return true
  return rows.length > 0 && rows.every(row => typeof row[index] === 'number' || row[index] === null)
}

function cellText(value, numeric, options, locale) {
  if (value === null || value === undefined) return '—'
  if (numeric) {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isNaN(number)) {
      const digits = Number.isInteger(options.decimals) ? options.decimals : undefined
      return number.toLocaleString(locale, digits === undefined ? { maximumFractionDigits: 4 } : { minimumFractionDigits: digits, maximumFractionDigits: digits })
    }
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function render(el, props) {
  const { rows = [], columns = [], options = {}, theme = {}, locale } = props
  const wanted = Array.isArray(options.columns) ? options.columns : columns.map(column => column.name)
  const shown = wanted.map(name => ({ index: columns.findIndex(column => column.name === name), column: columns.find(column => column.name === name) })).filter(entry => entry.index >= 0)
  const numeric = shown.map(entry => isNumericColumn(entry.column, rows, entry.index))
  const maxRows = Number.isInteger(options.max_rows) ? options.max_rows : 200
  const border = `1px solid ${theme.border ?? 'rgba(127,127,127,.25)'}`
  el.replaceChildren()
  const wrap = document.createElement('div')
  wrap.style.cssText = `height:100%;overflow:auto;font-family:${theme.font ?? 'inherit'};color:${theme.text ?? 'inherit'}`
  const table = document.createElement('table')
  table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums'
  const head = table.createTHead().insertRow()
  shown.forEach((entry, i) => {
    const th = document.createElement('th')
    th.style.cssText = `position:sticky;top:0;background:${theme.surface ?? 'inherit'};text-align:${numeric[i] ? 'right' : 'left'};padding:4px 8px;border-bottom:${border};font-weight:600;white-space:nowrap;color:${theme.textSecondary ?? 'inherit'}`
    th.textContent = entry.column.unit ? `${entry.column.label ?? entry.column.name} (${entry.column.unit})` : entry.column.label ?? entry.column.name
    th.title = entry.column.name
    head.append(th)
  })
  const body = table.createTBody()
  for (const row of rows.slice(0, maxRows)) {
    const tr = body.insertRow()
    shown.forEach((entry, i) => {
      const td = tr.insertCell()
      td.style.cssText = `padding:4px 8px;border-bottom:${border};text-align:${numeric[i] ? 'right' : 'left'};white-space:nowrap`
      td.textContent = cellText(row[entry.index], numeric[i], options, locale)
    })
  }
  wrap.append(table)
  if (rows.length > maxRows) {
    const more = document.createElement('div')
    more.style.cssText = `padding:4px 8px;font-size:11px;color:${theme.textTertiary ?? 'inherit'}`
    more.textContent = `${maxRows} / ${rows.length}`
    wrap.append(more)
  }
  el.append(wrap)
}

export default {
  mount(el, props) {
    render(el, props)
    return { update: next => render(el, next), destroy: () => el.replaceChildren() }
  },
}

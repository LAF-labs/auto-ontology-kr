/**
 * number-tile@1 — one value, large, with its column label and unit.
 * Props: { rows, columns, options, theme, locale }. No network access.
 * options: column (name; default first measure, else last column), row (index, default 0),
 *          label (overrides the column label), decimals (fixed digits), suffix, prefix,
 *          compare_row (index of a second row shown as the change from it).
 */
function toNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value)
  return null
}

function pickColumn(columns, name) {
  if (name !== undefined) return columns.findIndex(column => column.name === name)
  const measure = columns.findIndex(column => column.role === 'measure')
  return measure >= 0 ? measure : columns.length - 1
}

function format(value, options, locale) {
  const number = toNumber(value)
  if (number === null) return value === null || value === undefined ? '—' : String(value)
  const digits = Number.isInteger(options.decimals) ? options.decimals : (Number.isInteger(number) ? 0 : Math.min(2, String(value).split('.')[1]?.replace(/0+$/, '').length ?? 2))
  return number.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function render(el, props) {
  const { rows = [], columns = [], options = {}, theme = {}, locale } = props
  const index = pickColumn(columns, options.column)
  const column = columns[index] ?? { name: '', label: '' }
  const row = rows[options.row ?? 0]
  el.replaceChildren()
  const box = document.createElement('div')
  box.style.cssText = `display:flex;flex-direction:column;justify-content:center;height:100%;gap:4px;font-family:${theme.font ?? 'inherit'};color:${theme.text ?? 'inherit'}`
  if (row === undefined || index < 0) {
    box.textContent = '—'
    el.append(box)
    return
  }
  const value = document.createElement('div')
  const text = `${options.prefix ?? ''}${format(row[index], options, locale)}${options.suffix ?? ''}`
  // Fit the whole number to the tile width instead of cutting digits off.
  const width = el.clientWidth || 240
  const size = Math.max(14, Math.min(40, Math.floor(width / Math.max(4, (text.length + (column.unit ? 1 : 0)) * 0.62))))
  value.style.cssText = `font-size:${size}px;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums;white-space:nowrap`
  value.textContent = text
  const unit = document.createElement('span')
  unit.style.cssText = `font-size:0.45em;font-weight:500;margin-left:4px;color:${theme.textSecondary ?? 'inherit'}`
  unit.textContent = column.unit ?? ''
  value.append(unit)
  const label = document.createElement('div')
  label.style.cssText = `font-size:12px;color:${theme.textSecondary ?? 'inherit'}`
  label.textContent = options.label ?? column.label ?? column.name
  box.append(value, label)
  if (Number.isInteger(options.compare_row) && rows[options.compare_row] !== undefined) {
    const now = toNumber(row[index])
    const before = toNumber(rows[options.compare_row][index])
    if (now !== null && before !== null && before !== 0) {
      const change = (now - before) / Math.abs(before)
      const delta = document.createElement('div')
      delta.style.cssText = `font-size:12px;color:${change >= 0 ? theme.positive ?? 'inherit' : theme.negative ?? 'inherit'}`
      delta.textContent = `${change >= 0 ? '▲' : '▼'} ${(Math.abs(change) * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`
      box.append(delta)
    }
  }
  el.append(box)
}

export default {
  mount(el, props) {
    let current = props
    render(el, current)
    const observer = new ResizeObserver(() => render(el, current))
    observer.observe(el)
    return {
      update(next) { current = next; render(el, current) },
      destroy() { observer.disconnect(); el.replaceChildren() },
    }
  },
}

/**
 * bar-chart@1 — one bar per row: a category column and a measure column, in SVG.
 * Props: { rows, columns, options, theme, locale }. No network access.
 * options: x (category column; default first non-measure text column), y (measure column; default first
 *          measure), orientation ('horizontal' default, or 'vertical'), sort ('desc' default,
 *          'asc', or 'none'), limit (bars shown, default 20).
 */
const SVG = 'http://www.w3.org/2000/svg'
const node = (name, attrs = {}, text) => {
  const el = document.createElementNS(SVG, name)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  if (text !== undefined) el.textContent = text
  return el
}
const toNumber = value => typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : null)

/** Default category column: a non-measure text column, else the first non-measure column. */
function categoryColumn(columns) {
  const text = columns.findIndex(c => c.role !== 'measure' && /char|text|string|date|time/i.test(String(c.type ?? '')))
  return text >= 0 ? text : columns.findIndex(c => c.role !== 'measure')
}

function truncate(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function render(el, props) {
  const { rows = [], columns = [], options = {}, theme = {}, locale } = props
  el.replaceChildren()
  const width = Math.max(120, el.clientWidth || 300)
  const height = Math.max(80, el.clientHeight || 160)
  const xi = options.x !== undefined ? columns.findIndex(c => c.name === options.x) : categoryColumn(columns)
  let yi = options.y !== undefined ? columns.findIndex(c => c.name === options.y) : columns.findIndex(c => c.role === 'measure')
  if (yi < 0) yi = columns.length - 1
  let bars = rows.map(row => ({ label: xi >= 0 ? row[xi] : '', value: toNumber(row[yi]) })).filter(bar => bar.value !== null)
  if (options.sort !== 'none') bars.sort((a, b) => options.sort === 'asc' ? a.value - b.value : b.value - a.value)
  bars = bars.slice(0, Number.isInteger(options.limit) ? options.limit : 20)
  const svg = node('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'font-family': theme.font ?? 'inherit', 'font-size': 11 })
  if (bars.length === 0) {
    svg.append(node('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: theme.textTertiary ?? 'currentColor' }, '—'))
    el.append(svg)
    return
  }
  const max = Math.max(0, ...bars.map(b => b.value))
  const min = Math.min(0, ...bars.map(b => b.value))
  const span = max - min || 1
  const unit = columns[yi]?.unit ? ` ${columns[yi].unit}` : ''
  const color = theme.series?.[0] ?? theme.accent ?? 'currentColor'
  const fmt = v => v.toLocaleString(locale, { notation: Math.abs(max) >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: 2 })
  if (options.orientation === 'vertical') {
    const pad = { left: 8, right: 8, top: 16, bottom: 22 }
    const slot = (width - pad.left - pad.right) / bars.length
    const plotH = height - pad.top - pad.bottom
    const zero = pad.top + plotH * (max / span)
    bars.forEach((bar, i) => {
      const h = Math.abs(bar.value) / span * plotH
      const x = pad.left + i * slot + slot * 0.15
      const rect = node('rect', { x, y: bar.value >= 0 ? zero - h : zero, width: slot * 0.7, height: Math.max(1, h), rx: 2, fill: color })
      rect.append(node('title', {}, `${bar.label}: ${bar.value.toLocaleString(locale)}${unit}`))
      svg.append(rect)
      svg.append(node('text', { x: x + slot * 0.35, y: (bar.value >= 0 ? zero - h : zero + h) - 3, 'text-anchor': 'middle', fill: theme.textSecondary ?? 'currentColor' }, fmt(bar.value)))
      svg.append(node('text', { x: x + slot * 0.35, y: height - 6, 'text-anchor': 'middle', fill: theme.textTertiary ?? 'currentColor' }, truncate(bar.label, Math.max(3, Math.floor(slot / 7)))))
    })
  } else {
    const labelW = Math.min(width * 0.35, 140)
    const pad = { left: labelW + 8, right: 56, top: 4, bottom: 4 }
    const slot = (height - pad.top - pad.bottom) / bars.length
    const plotW = width - pad.left - pad.right
    const zero = pad.left + plotW * (-min / span)
    bars.forEach((bar, i) => {
      const w = Math.abs(bar.value) / span * plotW
      const y = pad.top + i * slot + slot * 0.15
      const rect = node('rect', { x: bar.value >= 0 ? zero : zero - w, y, width: Math.max(1, w), height: Math.max(2, slot * 0.7), rx: 2, fill: color })
      rect.append(node('title', {}, `${bar.label}: ${bar.value.toLocaleString(locale)}${unit}`))
      svg.append(rect)
      const mid = y + slot * 0.35 + 4
      svg.append(node('text', { x: pad.left - 6, y: mid, 'text-anchor': 'end', fill: theme.textSecondary ?? 'currentColor' }, truncate(bar.label, Math.floor(labelW / 7))))
      svg.append(node('text', { x: (bar.value >= 0 ? zero + w : zero) + 4, y: mid, fill: theme.text ?? 'currentColor' }, fmt(bar.value)))
    })
  }
  el.append(svg)
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

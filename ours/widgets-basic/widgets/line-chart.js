/**
 * line-chart@1 — one line per measure column over an x column, in SVG.
 * Props: { rows, columns, options, theme, locale }. No network access.
 * options: x (column name; default first non-measure text column), y (name or names; default all
 *          measures), sort_x (default true: sort points by x), y_zero (default true: y axis from 0).
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

function niceTicks(min, max, count) {
  if (min === max) { max = min + 1 }
  const step0 = (max - min) / Math.max(1, count)
  const power = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= step0) ?? step0
  const ticks = []
  // From the step at or below min to the first step at or above max, so every value is inside the axis.
  for (let v = Math.floor(min / step) * step; ; v += step) {
    ticks.push(Number(v.toPrecision(12)))
    if (v >= max - step * 1e-9 || ticks.length > 50) break
  }
  return ticks
}

export function selectSeries(columns, options) {
  const x = options.x !== undefined ? columns.findIndex(c => c.name === options.x) : categoryColumn(columns)
  const wanted = options.y === undefined ? columns.filter(c => c.role === 'measure').map(c => c.name) : [].concat(options.y)
  let y = wanted.map(name => columns.findIndex(c => c.name === name)).filter(i => i >= 0 && i !== x)
  if (y.length === 0) y = columns.map((_, i) => i).filter(i => i !== x).slice(0, 1)
  return { x: x >= 0 ? x : 0, y }
}

function render(el, props) {
  const { rows = [], columns = [], options = {}, theme = {}, locale } = props
  el.replaceChildren()
  const width = Math.max(120, el.clientWidth || 300)
  const height = Math.max(80, el.clientHeight || 160)
  const { x, y } = selectSeries(columns, options)
  let points = rows.map(row => ({ label: row[x], values: y.map(i => toNumber(row[i])) }))
  if (options.sort_x !== false) points = [...points].sort((a, b) => String(a.label).localeCompare(String(b.label), 'und', { numeric: true }))
  const all = points.flatMap(p => p.values).filter(v => v !== null)
  const svg = node('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'font-family': theme.font ?? 'inherit', 'font-size': 11 })
  if (points.length === 0 || all.length === 0) {
    svg.append(node('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: theme.textTertiary ?? 'currentColor' }, '—'))
    el.append(svg)
    return
  }
  const legendH = y.length > 1 ? 18 : 0
  const pad = { left: 52, right: 28, top: 8 + legendH, bottom: 24 }
  const lo = options.y_zero === false ? Math.min(...all) : Math.min(0, ...all)
  const hi = Math.max(...all)
  const ticks = niceTicks(lo, hi, Math.max(2, Math.floor((height - pad.top - pad.bottom) / 36)))
  const yMin = ticks[0]
  const yMax = ticks.at(-1)
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const sx = i => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
  const sy = v => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH
  for (const tick of ticks) {
    svg.append(node('line', { x1: pad.left, x2: width - pad.right, y1: sy(tick), y2: sy(tick), stroke: theme.border ?? 'rgba(127,127,127,.25)', 'stroke-width': 1 }))
    svg.append(node('text', { x: pad.left - 6, y: sy(tick) + 4, 'text-anchor': 'end', fill: theme.textTertiary ?? 'currentColor' }, tick.toLocaleString(locale, { notation: Math.abs(yMax) >= 1e6 ? 'compact' : 'standard' })))
  }
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 70))))
  points.forEach((point, i) => {
    if (i % every !== 0 && i !== points.length - 1) return
    const anchor = points.length > 1 && i === points.length - 1 ? 'end' : points.length > 1 && i === 0 ? 'start' : 'middle'
    svg.append(node('text', { x: sx(i), y: height - 6, 'text-anchor': anchor, fill: theme.textTertiary ?? 'currentColor' }, String(point.label ?? '')))
  })
  const palette = theme.series ?? ['currentColor']
  y.forEach((columnIndex, s) => {
    const color = palette[s % palette.length]
    const path = points.map((p, i) => p.values[s] === null ? null : `${sx(i)},${sy(p.values[s])}`).filter(Boolean)
    svg.append(node('polyline', { points: path.join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }))
    points.forEach((p, i) => {
      if (p.values[s] === null) return
      const dot = node('circle', { cx: sx(i), cy: sy(p.values[s]), r: points.length > 40 ? 1.5 : 3, fill: color })
      dot.append(node('title', {}, `${p.label}: ${p.values[s].toLocaleString(locale)}${columns[columnIndex].unit ? ` ${columns[columnIndex].unit}` : ''}`))
      svg.append(dot)
    })
    if (legendH > 0) {
      const lx = pad.left + s * 120
      svg.append(node('rect', { x: lx, y: 4, width: 10, height: 10, rx: 2, fill: color }))
      svg.append(node('text', { x: lx + 14, y: 13, fill: theme.textSecondary ?? 'currentColor' }, columns[columnIndex].label ?? columns[columnIndex].name))
    }
  })
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

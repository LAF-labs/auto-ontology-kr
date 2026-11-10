# Writing a dashboard widget type

Write a new type only when no listed type (`dashboard_read_draft` → `widget_types`) can show the data, even with options. A new type is a single ES module saved with `dashboard_save_widget_type`; each save is a new immutable version.

## Module contract

```js
export default {
  mount(el, props) {
    // draw into el; keep what update() needs
    return {
      update(nextProps) { /* redraw from nextProps */ },
      destroy() { /* remove listeners and observers, empty el */ },
    }
  },
}
```

- `mount` draws synchronously into `el` and returns the handle. `update` is called with new props whenever the data, options or theme change; redraw completely from the props it receives.
- `el` fills the widget card body. Size from `el.clientWidth` and `el.clientHeight`, and redraw on resize with a `ResizeObserver` on `el` (disconnect it in `destroy`).
- Use only the DOM and SVG (`document.createElement`, `document.createElementNS('http://www.w3.org/2000/svg', …)`). Set text with `textContent`, never `innerHTML` with data values.

## Props

| Prop | Meaning |
| --- | --- |
| `rows` | Array of rows; each row is an array in column order. Numbers may arrive as strings (decimals): convert with `Number()` and skip non-finite values. |
| `columns` | `[{ name, type, role, unit, label }]`. `role` is `dimension`, `measure` or `time`. Show `label` (else `name`) and `unit`. |
| `options` | The widget's `options` object from the spec, as you defined them. Give every option a default. |
| `theme` | Colors and font of the current light or dark theme (below). |
| `locale` | BCP 47 locale; format numbers with `value.toLocaleString(locale)`. |

Theme values: `text`, `textSecondary`, `textTertiary`, `border`, `background`, `surface`, `accent`, `positive`, `warning`, `negative`, `series` (array of colors for several series), `font`. Use them for every color; do not hard-code colors, so the widget follows light and dark mode. The card already draws the title, the run time and errors: draw only the data.

## Forbidden

The module runs in a sandboxed frame with no network, storage or cookies. Saving refuses code that uses `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `import`/`import()`, `importScripts`, `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `parent`/`top`/`opener`, `eval`, `new Function`, `Worker`, or markup that loads resources (`<script>`, `<iframe>`, `<img>`, `<link>`). Everything a widget shows comes from its props.

Never invent values: with no rows, or no usable number, draw a dash (`—`) and nothing else.

## Before saving, check in this order

1. The data: run the analysis (`ao_run_analysis`, or the preview of `dashboard_save_analysis`) and note the column names, roles and units the widget will read.
2. Options: decide which column each part reads (default: the first measure, the first dimension), and the option names and defaults.
3. Write the module; read it once more for the contract (`export default`, `mount` returning `update` and `destroy`), theme colors, units, empty data, and resize.
4. Save it, then add or update the widget in the draft with the returned `type_version`, and ask the person to look at the preview. If they report it broken, fix the module and save it again (the next version).

## Example: progress bars against a target

One bar per row: the first dimension as the label, the first measure as the value, filled against `options.target`.

```js
function draw(el, { rows = [], columns = [], options = {}, theme = {}, locale }) {
  el.replaceChildren()
  const label = columns.findIndex(c => c.role !== 'measure')
  const value = options.column !== undefined ? columns.findIndex(c => c.name === options.column) : columns.findIndex(c => c.role === 'measure')
  const items = rows.map(row => ({ name: String(row[label] ?? ''), value: Number(row[value]) })).filter(item => Number.isFinite(item.value))
  if (value < 0 || items.length === 0) {
    const dash = document.createElement('div')
    dash.textContent = '—'
    Object.assign(dash.style, { color: theme.textTertiary, font: `14px ${theme.font}`, textAlign: 'center', paddingTop: '20px' })
    el.append(dash)
    return
  }
  const target = Number(options.target ?? Math.max(...items.map(item => item.value)))
  const unit = columns[value].unit ?? ''
  const list = document.createElement('div')
  Object.assign(list.style, { display: 'grid', gap: '6px', font: `12px ${theme.font}`, color: theme.text, height: '100%', overflow: 'auto' })
  for (const item of items) {
    const row = document.createElement('div')
    const head = document.createElement('div')
    head.textContent = `${item.name} · ${item.value.toLocaleString(locale)}${unit ? ` ${unit}` : ''}`
    const track = document.createElement('div')
    Object.assign(track.style, { height: '6px', background: theme.border, borderRadius: '3px' })
    const fill = document.createElement('div')
    Object.assign(fill.style, { height: '100%', width: `${Math.min(100, (item.value / target) * 100)}%`, background: item.value >= target ? theme.positive : theme.accent, borderRadius: '3px' })
    track.append(fill)
    row.append(head, track)
    list.append(row)
  }
  el.append(list)
}

export default {
  mount(el, props) {
    let current = props
    draw(el, current)
    const observer = new ResizeObserver(() => draw(el, current))
    observer.observe(el)
    return { update(next) { current = next; draw(el, current) }, destroy() { observer.disconnect(); el.replaceChildren() } }
  },
}
```

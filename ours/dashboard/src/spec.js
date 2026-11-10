/**
 * Dashboard spec format 1 (see ../SPEC.md): validation and derived facts.
 * Dependency-free so the host store, tests and seed scripts share it.
 */

export const SPEC_FORMAT = 1
export const DASHBOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const WIDGET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/
export const WIDGET_TYPE_RE = /^[a-z][a-z0-9-]{0,62}$/
export const LIMITS = Object.freeze({
  widgets: 50,
  gridColumns: 24,
  rowHeightMin: 40,
  rowHeightMax: 400,
  refreshMinS: 30,
  refreshMaxS: 86400,
  rowLimitMax: 50000,
  titleMax: 120,
  descriptionMax: 2000,
  optionStringMax: 2000,
  optionDepth: 6,
})
export const DEFAULTS = Object.freeze({ gridColumns: 12, rowHeight: 90, refreshS: 300 })

const TOP_KEYS = ['format', 'title', 'description', 'grid', 'refresh_s', 'max_age_s', 'widgets']
const GRID_KEYS = ['columns', 'row_height']
const WIDGET_KEYS = ['id', 'type', 'type_version', 'title', 'layout', 'source', 'refresh_s', 'options']
const LAYOUT_KEYS = ['x', 'y', 'w', 'h']
const SOURCE_KEYS = ['analysis_id', 'version', 'params', 'row_limit']

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isInt = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && value >= min && value <= max
const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value)

/**
 * Validate a spec.
 * @param {unknown} spec - candidate spec (parsed JSON).
 * @param {object} [context]
 * @param {(type: string, version: number) => boolean} [context.hasWidget] - whether a widget module version exists.
 * @returns {{ ok: true, spec: object } | { ok: false, problems: Array<{ path: string, message: string }> }}
 *   `spec` is the input unchanged (defaults are applied by readers, not written into the record).
 */
export function validateSpec(spec, { hasWidget } = {}) {
  const problems = []
  const add = (path, message) => { if (problems.length < 50) problems.push({ path, message }) }
  const keysOnly = (value, allowed, path) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(`${path}.${key}`, 'unknown field')
  }

  if (!isObject(spec)) return { ok: false, problems: [{ path: '$', message: 'spec must be an object' }] }
  keysOnly(spec, TOP_KEYS, '$')
  if (spec.format !== SPEC_FORMAT) add('$.format', `must be ${SPEC_FORMAT}`)
  if (typeof spec.title !== 'string' || spec.title.trim() === '' || spec.title.length > LIMITS.titleMax) add('$.title', `non-empty string up to ${LIMITS.titleMax} characters`)
  if (spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > LIMITS.descriptionMax)) add('$.description', `string up to ${LIMITS.descriptionMax} characters`)

  let columns = DEFAULTS.gridColumns
  if (spec.grid !== undefined) {
    if (!isObject(spec.grid)) add('$.grid', 'must be an object')
    else {
      keysOnly(spec.grid, GRID_KEYS, '$.grid')
      if (spec.grid.columns !== undefined) {
        if (!isInt(spec.grid.columns, 1, LIMITS.gridColumns)) add('$.grid.columns', `integer 1..${LIMITS.gridColumns}`)
        else columns = spec.grid.columns
      }
      if (spec.grid.row_height !== undefined && !isInt(spec.grid.row_height, LIMITS.rowHeightMin, LIMITS.rowHeightMax)) add('$.grid.row_height', `integer ${LIMITS.rowHeightMin}..${LIMITS.rowHeightMax}`)
    }
  }
  if (spec.refresh_s !== undefined && !isInt(spec.refresh_s, LIMITS.refreshMinS, LIMITS.refreshMaxS)) add('$.refresh_s', `integer ${LIMITS.refreshMinS}..${LIMITS.refreshMaxS}`)
  if (spec.max_age_s !== undefined && !isInt(spec.max_age_s, 0, LIMITS.refreshMaxS)) add('$.max_age_s', `integer 0..${LIMITS.refreshMaxS}`)

  if (!Array.isArray(spec.widgets) || spec.widgets.length === 0 || spec.widgets.length > LIMITS.widgets) {
    add('$.widgets', `array of 1..${LIMITS.widgets} widgets`)
  } else {
    const ids = new Set()
    const cells = new Map()
    spec.widgets.forEach((widget, index) => {
      const path = `$.widgets[${index}]`
      if (!isObject(widget)) { add(path, 'must be an object'); return }
      keysOnly(widget, WIDGET_KEYS, path)
      if (typeof widget.id !== 'string' || !WIDGET_ID_RE.test(widget.id)) add(`${path}.id`, `must match ${WIDGET_ID_RE}`)
      else if (ids.has(widget.id)) add(`${path}.id`, `duplicate id ${JSON.stringify(widget.id)}`)
      else ids.add(widget.id)
      const typeOk = typeof widget.type === 'string' && WIDGET_TYPE_RE.test(widget.type)
      if (!typeOk) add(`${path}.type`, `must match ${WIDGET_TYPE_RE}`)
      if (!isInt(widget.type_version, 1)) add(`${path}.type_version`, 'positive integer')
      else if (typeOk && hasWidget !== undefined && !hasWidget(widget.type, widget.type_version)) {
        add(`${path}.type`, `widget module ${widget.type}@${widget.type_version} is not in the store`)
      }
      if (widget.title !== undefined && (typeof widget.title !== 'string' || widget.title.length > LIMITS.titleMax)) add(`${path}.title`, `string up to ${LIMITS.titleMax} characters`)
      if (widget.refresh_s !== undefined && !isInt(widget.refresh_s, LIMITS.refreshMinS, LIMITS.refreshMaxS)) add(`${path}.refresh_s`, `integer ${LIMITS.refreshMinS}..${LIMITS.refreshMaxS}`)

      const layout = widget.layout
      if (!isObject(layout)) add(`${path}.layout`, 'must be an object with x, y, w, h')
      else {
        keysOnly(layout, LAYOUT_KEYS, `${path}.layout`)
        const valid = isInt(layout.x, 0) && isInt(layout.y, 0, 1000) && isInt(layout.w, 1) && isInt(layout.h, 1, 50)
        if (!valid) add(`${path}.layout`, 'x, y non-negative integers; w, h positive integers')
        else if (layout.x + layout.w > columns) add(`${path}.layout`, `x + w exceeds ${columns} columns`)
        else {
          for (let y = layout.y; y < layout.y + layout.h; y += 1) {
            for (let x = layout.x; x < layout.x + layout.w; x += 1) {
              const other = cells.get(`${x},${y}`)
              if (other !== undefined) { add(`${path}.layout`, `overlaps widget ${JSON.stringify(other)}`); y = Infinity; break }
              cells.set(`${x},${y}`, widget.id)
            }
          }
        }
      }

      const source = widget.source
      if (!isObject(source)) add(`${path}.source`, 'must be an object with analysis_id')
      else {
        keysOnly(source, SOURCE_KEYS, `${path}.source`)
        if (typeof source.analysis_id !== 'string' || source.analysis_id.trim() === '' || source.analysis_id.length > 200) add(`${path}.source.analysis_id`, 'non-empty string')
        if (source.version !== undefined && !isInt(source.version, 1)) add(`${path}.source.version`, 'positive integer')
        if (source.row_limit !== undefined && !isInt(source.row_limit, 1, LIMITS.rowLimitMax)) add(`${path}.source.row_limit`, `integer 1..${LIMITS.rowLimitMax}`)
        if (source.params !== undefined) {
          if (!isObject(source.params)) add(`${path}.source.params`, 'must be an object')
          else {
            for (const [name, value] of Object.entries(source.params)) {
              const ok = isScalar(value) || (Array.isArray(value) && value.every(isScalar))
              if (!ok) add(`${path}.source.params.${name}`, 'scalar or array of scalars')
            }
          }
        }
      }

      if (widget.options !== undefined) {
        if (!isObject(widget.options)) add(`${path}.options`, 'must be an object')
        else checkOptions(widget.options, `${path}.options`, 0, add)
      }
    })
  }
  return problems.length === 0 ? { ok: true, spec } : { ok: false, problems }
}

/** Options are free-form display settings: JSON values, bounded, and never SQL. */
function checkOptions(value, path, depth, add) {
  if (depth > LIMITS.optionDepth) { add(path, `nested deeper than ${LIMITS.optionDepth}`); return }
  if (typeof value === 'string') { if (value.length > LIMITS.optionStringMax) add(path, `string longer than ${LIMITS.optionStringMax}`); return }
  if (isScalar(value)) return
  if (Array.isArray(value)) { value.forEach((item, index) => checkOptions(item, `${path}[${index}]`, depth + 1, add)); return }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/^(sql|query|statement)$/i.test(key)) add(`${path}.${key}`, 'a spec holds no SQL; point the widget at a saved analysis')
      checkOptions(item, `${path}.${key}`, depth + 1, add)
    }
    return
  }
  add(path, 'must be JSON')
}

/**
 * Saved-analysis ids a spec reads, sorted and unique. The basis for scoping a
 * dashboard's data access to exactly these analyses.
 * @param {object} spec - a valid spec.
 * @returns {string[]}
 */
export function analysisIds(spec) {
  return [...new Set((spec.widgets ?? []).map(widget => widget.source?.analysis_id).filter(id => typeof id === 'string'))].sort()
}

/**
 * Widget module versions a spec needs, as `type@version`, sorted and unique.
 * @param {object} spec - a valid spec.
 * @returns {string[]}
 */
export function widgetRefs(spec) {
  return [...new Set((spec.widgets ?? []).map(widget => `${widget.type}@${widget.type_version}`))].sort()
}

/**
 * Effective timing for one widget.
 * @returns {{ refreshS: number, maxAgeS: number }}
 */
export function widgetTiming(spec, widget) {
  const refreshS = widget.refresh_s ?? spec.refresh_s ?? DEFAULTS.refreshS
  const maxAgeS = spec.max_age_s ?? refreshS
  return { refreshS, maxAgeS: Math.min(maxAgeS, refreshS) }
}

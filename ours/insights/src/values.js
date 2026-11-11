/**
 * Reading one number or one table out of a saved-analysis run result
 * (auto-ontology/docs/saved-analyses.md §8: `columns` and row arrays) and
 * formatting it. Shared by report figures and alert rules. No harness imports.
 */

/** Value selector: which column, which row (`row` index or `where` equality on other columns), and how to fold rows. */
export const REDUCERS = Object.freeze(['first', 'sum', 'min', 'max', 'count'])

/**
 * Number from a run cell. `integer` beyond 2^53 and `decimal` arrive as strings (§8).
 * @param {unknown} cell
 * @returns {number|null} null when the cell is not numeric.
 */
export function toNumber(cell) {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell === 'string' && /^-?\d+(\.\d+)?$/.test(cell.trim())) return Number(cell.trim())
  return null
}

const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value)

/**
 * Problems of a selector `{column, row?, where?, reduce?}`; empty when valid.
 * @param {unknown} selector
 * @param {string} path - prefix for problem paths.
 * @returns {Array<{path: string, message: string}>}
 */
export function selectorProblems(selector, path) {
  const problems = []
  const add = (p, message) => problems.push({ path: p, message })
  if (selector === null || typeof selector !== 'object' || Array.isArray(selector)) { add(path, 'must be an object'); return problems }
  const allowed = ['column', 'row', 'where', 'reduce']
  for (const key of Object.keys(selector)) if (!allowed.includes(key)) add(`${path}.${key}`, 'unknown field')
  if (typeof selector.column !== 'string' || selector.column === '') add(`${path}.column`, 'must name a result column')
  if (selector.row !== undefined && !(Number.isInteger(selector.row) && selector.row >= 0)) add(`${path}.row`, 'must be a row index (0 is the first row)')
  if (selector.where !== undefined) {
    if (selector.where === null || typeof selector.where !== 'object' || Array.isArray(selector.where) || Object.keys(selector.where).length === 0) add(`${path}.where`, 'must be an object of column: value')
    else for (const [key, value] of Object.entries(selector.where)) if (!isScalar(value)) add(`${path}.where.${key}`, 'must be a string, number, boolean or null')
  }
  if (selector.row !== undefined && selector.where !== undefined) add(`${path}.row`, 'use row or where, not both')
  if (selector.reduce !== undefined && !REDUCERS.includes(selector.reduce)) add(`${path}.reduce`, `must be one of ${REDUCERS.join(', ')}`)
  if (selector.reduce !== undefined && selector.reduce !== 'first' && selector.row !== undefined) add(`${path}.reduce`, 'a row index picks one row; reduce applies to all (or the where-matched) rows')
  return problems
}

const sameCell = (cell, wanted) => cell === wanted || (cell !== null && wanted !== null && String(cell) === String(wanted))

/**
 * Read one value from run data.
 * @param {{columns: Array<{name: string, unit?: string|null, label?: string|null}>, rows: unknown[][]}} data
 * @param {{column: string, row?: number, where?: object, reduce?: string}} selector
 * @returns {{ok: true, value: number|string|boolean|null, number: number|null, column: object, row_index: number|null, rows_used: number}
 *   | {ok: false, code: string, message: string}}
 */
export function pickValue(data, selector) {
  const columns = Array.isArray(data?.columns) ? data.columns : []
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const index = columns.findIndex(column => column?.name === selector.column)
  if (index < 0) return { ok: false, code: 'unknown_column', message: `the result has no column ${JSON.stringify(selector.column)}; columns: ${columns.map(c => c?.name).join(', ')}` }
  let candidates = rows.map((row, rowIndex) => ({ row, rowIndex }))
  if (selector.where !== undefined) {
    for (const [name, wanted] of Object.entries(selector.where)) {
      const whereIndex = columns.findIndex(column => column?.name === name)
      if (whereIndex < 0) return { ok: false, code: 'unknown_column', message: `where names no result column ${JSON.stringify(name)}` }
      candidates = candidates.filter(({ row }) => sameCell(row?.[whereIndex], wanted))
    }
  }
  const reduce = selector.reduce ?? 'first'
  if (reduce === 'count') return { ok: true, value: candidates.length, number: candidates.length, column: columns[index], row_index: null, rows_used: candidates.length }
  if (reduce === 'first') {
    const position = selector.row ?? 0
    const chosen = selector.where === undefined ? candidates[position] : candidates[0]
    if (chosen === undefined) return { ok: false, code: 'no_row', message: selector.where === undefined ? `the result has ${rows.length} row(s); row ${position} does not exist` : `no row matches where ${JSON.stringify(selector.where)}` }
    const value = chosen.row?.[index] ?? null
    return { ok: true, value, number: toNumber(value), column: columns[index], row_index: chosen.rowIndex, rows_used: 1 }
  }
  if (candidates.length === 0) return { ok: false, code: 'no_row', message: 'no rows to reduce' }
  const numbers = candidates.map(({ row }) => toNumber(row?.[index]))
  if (numbers.some(number => number === null)) return { ok: false, code: 'not_numeric', message: `column ${selector.column} has non-numeric values; ${reduce} needs numbers` }
  const value = reduce === 'sum' ? numbers.reduce((a, b) => a + b, 0) : reduce === 'min' ? Math.min(...numbers) : Math.max(...numbers)
  return { ok: true, value, number: value, column: columns[index], row_index: null, rows_used: numbers.length }
}

/**
 * Percent change from `from` to `to`; null when `from` is zero.
 * @param {number} from
 * @param {number} to
 * @returns {number|null}
 */
export function percentChange(from, to) {
  if (from === 0) return null
  return ((to - from) / Math.abs(from)) * 100
}

/**
 * Display text of a value. `number`: grouped digits with the column unit;
 * `percent`: a ratio shown ×100 with %; `change`: signed percent; `difference`: signed with unit; `raw`: as stored.
 * @param {number|string|boolean|null} value
 * @param {{format?: string, decimals?: number, unit?: string|null, locale?: string}} [options]
 * @returns {string}
 */
export function formatValue(value, { format = 'number', decimals, unit = null, locale = 'ko-KR' } = {}) {
  if (value === null || value === undefined) return '—'
  const number = toNumber(value)
  if (format === 'raw' || number === null) return String(value)
  const fixed = (n, d) => new Intl.NumberFormat(locale, { minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 2 }).format(n)
  if (format === 'percent') return `${fixed(number * 100, decimals ?? 1)}%`
  if (format === 'change') return `${number > 0 ? '+' : ''}${fixed(number, decimals ?? 1)}%`
  const text = fixed(number, decimals)
  const signed = format === 'difference' && number > 0 ? `+${text}` : text
  return unit ? `${signed}${unit}` : signed
}

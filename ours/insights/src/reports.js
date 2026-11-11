/**
 * Reports: text plus figures bound to saved-analysis runs. The agent writes
 * the text with `{{fig:<id>}}` placeholders and declares each figure as an
 * analysis id, parameters and a value selector; the host runs the analyses
 * itself (`ctx.aoConnector`, cache allowed) and stores the value with its
 * provenance: analysis name, version, verification status, resolved
 * parameters and execution time. Numbers typed into the text by hand are
 * refused (`hand_written_numbers`), so every number a reader sees came from a
 * run. Reports are append-only: no versions, no edits. No harness imports.
 */
import { randomBytes } from 'node:crypto'
import { formatValue, percentChange, pickValue, selectorProblems } from './values.js'

export const FIGURE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
export const PLACEHOLDER_RE = /\{\{\s*fig:([A-Za-z][A-Za-z0-9_-]{0,39})\s*\}\}/g
export const FIGURE_KINDS = Object.freeze(['value', 'table', 'change'])
const VALUE_FORMATS = ['number', 'percent', 'raw']
const CHANGE_FORMATS = ['change', 'difference']
const TITLE_MAX = 200
const BODY_MAX = 20000
const FIGURES_MAX = 30
const TABLE_ROWS_MAX = 50

export class InsightsError extends Error {
  /**
   * @param {number} status - HTTP status for browser routes.
   * @param {string} code - stable error code, also returned to the model.
   * @param {string} message
   * @param {object|null} [details]
   */
  constructor(status, code, message, details = null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value)

/**
 * Problems of `params` (scalar or scalar-array values, as dashboard specs allow).
 * @returns {Array<{path: string, message: string}>}
 */
export function paramsProblems(params, path) {
  if (params === undefined) return []
  if (!isObject(params)) return [{ path, message: 'must be an object of parameter: value' }]
  const problems = []
  for (const [key, value] of Object.entries(params)) {
    if (!(isScalar(value) || (Array.isArray(value) && value.every(isScalar)))) problems.push({ path: `${path}.${key}`, message: 'must be a scalar or an array of scalars' })
  }
  return problems
}

/**
 * Problems of a report input `{title, body, figures}`; empty when valid.
 * @returns {Array<{path: string, message: string}>}
 */
export function reportProblems(input) {
  const problems = []
  const add = (path, message) => problems.push({ path, message })
  if (!isObject(input)) return [{ path: '$', message: 'must be an object' }]
  for (const key of Object.keys(input)) if (!['title', 'body', 'figures'].includes(key)) add(`$.${key}`, 'unknown field')
  if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > TITLE_MAX) add('$.title', `must be 1–${TITLE_MAX} characters`)
  if (typeof input.body !== 'string' || input.body.trim() === '' || input.body.length > BODY_MAX) add('$.body', `must be 1–${BODY_MAX} characters`)
  const figures = input.figures ?? []
  if (!Array.isArray(figures) || figures.length > FIGURES_MAX) { add('$.figures', `must be an array of at most ${FIGURES_MAX} figures`); return problems }
  const ids = new Map()
  figures.forEach((figure, index) => {
    const path = `$.figures[${index}]`
    if (!isObject(figure)) { add(path, 'must be an object'); return }
    if (typeof figure.id !== 'string' || !FIGURE_ID_RE.test(figure.id)) add(`${path}.id`, 'must start with a letter; letters, digits, _ and -, at most 40')
    else if (ids.has(figure.id)) add(`${path}.id`, `duplicates figures[${ids.get(figure.id)}]`)
    else ids.set(figure.id, index)
    if (!FIGURE_KINDS.includes(figure.kind)) { add(`${path}.kind`, `must be one of ${FIGURE_KINDS.join(', ')}`); return }
    if (figure.label !== undefined && (typeof figure.label !== 'string' || figure.label.length > 120)) add(`${path}.label`, 'must be a string of at most 120 characters')
    if (figure.decimals !== undefined && !(Number.isInteger(figure.decimals) && figure.decimals >= 0 && figure.decimals <= 4)) add(`${path}.decimals`, 'must be 0–4')
    const allowed = { value: ['column', 'row', 'where', 'reduce', 'format'], table: ['columns', 'max_rows'], change: ['from', 'to', 'format'] }[figure.kind]
    const common = figure.kind === 'change' ? ['id', 'kind', 'label', 'decimals'] : ['id', 'kind', 'label', 'decimals', 'analysis_id', 'version', 'params']
    for (const key of Object.keys(figure)) if (![...common, ...allowed].includes(key)) add(`${path}.${key}`, `unknown field for a ${figure.kind} figure`)
    if (figure.kind !== 'change') {
      if (typeof figure.analysis_id !== 'string' || figure.analysis_id === '') add(`${path}.analysis_id`, 'must be a saved analysis id')
      if (figure.version !== undefined && !(Number.isInteger(figure.version) && figure.version >= 1)) add(`${path}.version`, 'must be a version number; omit it for the latest verified version')
      problems.push(...paramsProblems(figure.params, `${path}.params`))
    }
    if (figure.kind === 'value') {
      const { format, ...selector } = Object.fromEntries(Object.entries(figure).filter(([key]) => allowed.includes(key)))
      problems.push(...selectorProblems(selector, path))
      if (format !== undefined && !VALUE_FORMATS.includes(format)) add(`${path}.format`, `must be one of ${VALUE_FORMATS.join(', ')}`)
    }
    if (figure.kind === 'table') {
      if (figure.columns !== undefined && !(Array.isArray(figure.columns) && figure.columns.length > 0 && figure.columns.every(c => typeof c === 'string' && c !== ''))) add(`${path}.columns`, 'must be a non-empty array of column names')
      if (figure.max_rows !== undefined && !(Number.isInteger(figure.max_rows) && figure.max_rows >= 1 && figure.max_rows <= TABLE_ROWS_MAX)) add(`${path}.max_rows`, `must be 1–${TABLE_ROWS_MAX}`)
    }
    if (figure.kind === 'change') {
      for (const end of ['from', 'to']) if (typeof figure[end] !== 'string' || figure[end] === '') add(`${path}.${end}`, 'must name a value figure of this report')
      if (figure.format !== undefined && !CHANGE_FORMATS.includes(figure.format)) add(`${path}.format`, `must be one of ${CHANGE_FORMATS.join(', ')}`)
    }
  })
  figures.forEach((figure, index) => {
    if (figure?.kind !== 'change') return
    for (const end of ['from', 'to']) {
      if (typeof figure[end] !== 'string') continue
      const target = figures[ids.get(figure[end])]
      if (target === undefined) add(`$.figures[${index}].${end}`, `names no figure of this report: ${figure[end]}`)
      else if (target.kind !== 'value') add(`$.figures[${index}].${end}`, `must name a value figure; ${figure[end]} is a ${target.kind}`)
    }
  })
  if (typeof input.body === 'string') {
    const used = placeholders(input.body)
    for (const id of used) if (!ids.has(id)) add('$.body', `{{fig:${id}}} names no figure`)
  }
  return problems
}

/** Figure ids referenced by `{{fig:…}}` in `text`, in order of first use. */
export function placeholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map(match => match[1]))]
}

const DATE_RUN_RE = /^(\d{4}[-./]\d{1,2}([-./]\d{1,2})?(T\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}:\d{2}(:\d{2})?|\d{1,2}[./]\d{1,2})$/
const CALENDAR_SUFFIX_RE = /^\s?(년도?|월|일|시|분|초|주차?|개월|분기|번째|위|등|차|월분|일간|주간|개년)/
const CALENDAR_PREFIX_RE = /(제|Q|H|W|FY)\s?$/

/**
 * Numbers in `text` that are not calendar words, small counts (0–10), parts of
 * identifiers (a run of letters, digits, `_` and `-` with an ASCII letter, such as a UUID), or parameter values the figures use. A report must show every
 * other number through a figure placeholder.
 * @param {string} text
 * @param {Set<string>} allowed - parameter values (as strings) the report's figures use.
 * @returns {string[]} offending number tokens, each once.
 */
export function handWrittenNumbers(text, allowed = new Set()) {
  const stripped = text.replace(PLACEHOLDER_RE, ' ')
  const found = []
  for (const match of stripped.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const token = match[0].replace(/,+$/, '')
    const start = match.index
    const end = start + token.length
    const before = stripped.slice(Math.max(0, start - 3), start)
    const after = stripped.slice(end, end + 6)
    if (/[A-Za-z_]$/.test(before)) continue
    let idStart = start
    let idEnd = end
    while (idStart > 0 && /[A-Za-z0-9_-]/.test(stripped[idStart - 1])) idStart -= 1
    while (idEnd < stripped.length && /[A-Za-z0-9_-]/.test(stripped[idEnd])) idEnd += 1
    if (/[A-Za-z]/.test(stripped.slice(idStart, idEnd))) continue // part of an id such as a UUID or v2
    let runStart = start
    let runEnd = end
    while (runStart > 0 && /[\d\-./:T]/.test(stripped[runStart - 1])) runStart -= 1
    while (runEnd < stripped.length && /[\d\-./:T]/.test(stripped[runEnd])) runEnd += 1
    const run = stripped.slice(runStart, runEnd).replace(/[.:\-/T]+$/, '')
    if (DATE_RUN_RE.test(run) && !/^\d{1,2}[./]\d{1,2}$/.test(run)) continue
    if (/^\d{1,2}[./]\d{1,2}$/.test(run) && CALENDAR_SUFFIX_RE.test(stripped.slice(runEnd, runEnd + 6))) continue
    if (CALENDAR_SUFFIX_RE.test(after) && !token.includes(',') && !token.includes('.')) continue
    if (CALENDAR_PREFIX_RE.test(before) && /^\d{1,4}$/.test(token)) continue
    const plain = token.replace(/,/g, '')
    if (allowed.has(plain) || allowed.has(token)) continue
    const signed = /[+\-−±]\s?$/.test(before)
    if (/^\d+$/.test(plain) && Number(plain) <= 10 && !signed && !/^\s?%/.test(after) && !/^\.\d/.test(stripped.slice(end, end + 2))) continue
    if (!found.includes(token)) found.push(token)
  }
  return found
}

const runKey = (analysisId, version, params) => JSON.stringify([analysisId, version ?? null, params ?? {}])

/** Parameter values (and their parts) used by figures, as strings, for {@link handWrittenNumbers}. */
export function figureParamValues(figures) {
  const values = new Set()
  const addValue = value => {
    if (value === null || typeof value === 'boolean') return
    const text = String(value)
    values.add(text)
    for (const part of text.match(/\d+/g) ?? []) values.add(String(Number(part)))
  }
  for (const figure of figures ?? []) {
    for (const value of Object.values(figure.params ?? {})) (Array.isArray(value) ? value : [value]).forEach(addValue)
    if (figure.where !== undefined) Object.values(figure.where).forEach(addValue)
  }
  return values
}

function provenance(data) {
  return {
    analysis: { id: data.analysis_id, name: data.name ?? null, version: data.version ?? null, status: data.status ?? null, verified: data.status === 'verified' },
    params: data.params ?? {},
    executed_at: data.executed_at ?? null,
    cache_hit: data.cache?.hit === true,
    source: data.source ?? null,
  }
}

const columnInfo = column => ({ name: column?.name ?? null, label: column?.label ?? null, unit: column?.unit ?? null })

/**
 * Run the figures' analyses (one run per distinct analysis, version and
 * parameters) and build stored figures. Any failure refuses the whole report.
 * @param {object[]} figures - validated figure inputs.
 * @param {{runAnalysis: (id: string, request: object, signal?: AbortSignal) => Promise<object>}} connector
 * @param {{maxAgeS?: number, locale?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, object>>} stored figures by id.
 */
export async function resolveFigures(figures, connector, { maxAgeS, locale = 'ko-KR', signal } = {}) {
  const runs = new Map()
  for (const figure of figures) {
    if (figure.kind === 'change') continue
    const key = runKey(figure.analysis_id, figure.version, figure.params)
    if (!runs.has(key)) {
      const request = {
        ...figure.version === undefined ? {} : { version: figure.version },
        ...figure.params === undefined ? {} : { params: figure.params },
        ...maxAgeS === undefined ? {} : { max_age_s: maxAgeS },
      }
      runs.set(key, connector.runAnalysis(figure.analysis_id, request, signal))
    }
  }
  const results = new Map()
  for (const [key, promise] of runs) results.set(key, await promise)
  const failures = []
  const out = {}
  for (const figure of figures) {
    if (figure.kind === 'change') continue
    const result = results.get(runKey(figure.analysis_id, figure.version, figure.params))
    if (!result.ok) { failures.push({ figure: figure.id, analysis_id: figure.analysis_id, code: result.error.code, message: result.error.message }); continue }
    const data = result.data
    const base = { id: figure.id, kind: figure.kind, label: figure.label ?? null, ...provenance(data) }
    if (figure.kind === 'value') {
      const picked = pickValue(data, figure)
      if (!picked.ok) { failures.push({ figure: figure.id, analysis_id: figure.analysis_id, code: picked.code, message: picked.message }); continue }
      const format = figure.format ?? (picked.number === null ? 'raw' : 'number')
      const unit = format === 'number' ? picked.column?.unit ?? null : null
      out[figure.id] = {
        ...base,
        selector: { column: figure.column, ...figure.row === undefined ? {} : { row: figure.row }, ...figure.where === undefined ? {} : { where: figure.where }, ...figure.reduce === undefined ? {} : { reduce: figure.reduce } },
        column: columnInfo(picked.column), value: picked.value, number: picked.number, format, decimals: figure.decimals ?? null,
        text: formatValue(picked.value, { format, decimals: figure.decimals, unit, locale }),
      }
    } else {
      const columns = Array.isArray(data.columns) ? data.columns : []
      const wanted = figure.columns ?? columns.map(column => column.name)
      const indexes = wanted.map(name => columns.findIndex(column => column.name === name))
      const missing = wanted.filter((_, i) => indexes[i] < 0)
      if (missing.length > 0) { failures.push({ figure: figure.id, analysis_id: figure.analysis_id, code: 'unknown_column', message: `the result has no column(s) ${missing.join(', ')}` }); continue }
      const limit = figure.max_rows ?? 20
      const rows = (data.rows ?? []).slice(0, limit).map(row => indexes.map(i => row[i] ?? null))
      out[figure.id] = {
        ...base,
        table: { columns: indexes.map(i => columnInfo(columns[i])), rows, row_count: data.row_count ?? (data.rows ?? []).length, shown: rows.length, truncated: data.truncated === true },
      }
    }
  }
  for (const figure of figures) {
    if (figure.kind !== 'change' || out[figure.from] === undefined || out[figure.to] === undefined) continue
    const from = out[figure.from].number
    const to = out[figure.to].number
    if (from === null || to === null) { failures.push({ figure: figure.id, code: 'not_numeric', message: 'a change needs two numeric value figures' }); continue }
    const format = figure.format ?? 'change'
    const value = format === 'change' ? percentChange(from, to) : to - from
    if (value === null) { failures.push({ figure: figure.id, code: 'zero_base', message: `${figure.from} is zero; a percent change is undefined` }); continue }
    const unit = format === 'difference' ? out[figure.to].column?.unit ?? null : null
    out[figure.id] = {
      id: figure.id, kind: 'change', label: figure.label ?? null, from: figure.from, to: figure.to, format, decimals: figure.decimals ?? null,
      value, number: value, text: formatValue(value, { format, decimals: figure.decimals, unit, locale }),
      verified: out[figure.from].analysis.verified && out[figure.to].analysis.verified,
    }
  }
  if (failures.length > 0) throw new InsightsError(422, 'figure_failed', 'one or more figures could not be read; nothing was saved', { failures })
  return out
}

/**
 * Plain-text rendering (placeholders replaced, tables as Markdown, numbered
 * source notes). Used for the model's confirmation and for later delivery.
 * @param {{title: string, body: string, figures: Record<string, object>}} report
 * @returns {string}
 */
export function renderPlain(report) {
  const order = placeholders(report.body)
  const note = id => order.indexOf(id) + 1
  const table = figure => {
    const head = figure.table.columns.map(c => c.label ?? c.name)
    const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
    for (const row of figure.table.rows) lines.push(`| ${row.map((cell, i) => formatValue(cell, { format: typeof cell === 'number' ? 'number' : 'raw', unit: figure.table.columns[i].unit })).join(' | ')} |`)
    return lines.join('\n')
  }
  const body = report.body.replace(PLACEHOLDER_RE, (_, id) => {
    const figure = report.figures[id]
    if (figure === undefined) return '—'
    return figure.kind === 'table' ? `\n${table(figure)}\n[${note(id)}]` : `${figure.text}[${note(id)}]`
  })
  const sources = order.map(id => {
    const figure = report.figures[id]
    if (figure === undefined) return null
    if (figure.kind === 'change') return `[${note(id)}] ${figure.from} → ${figure.to} (${figure.format === 'change' ? '변화율' : '차이'})`
    const a = figure.analysis
    return `[${note(id)}] ${a.name ?? a.id} v${a.version}${a.verified ? ' (확인됨)' : ' (확인 전)'} · ${JSON.stringify(figure.params)} · ${figure.executed_at}`
  }).filter(Boolean)
  return `# ${report.title}\n\n${body}\n\n${sources.join('\n')}`
}

/** Summary row of a stored report for lists. */
export function reportSummary(report) {
  const figures = Object.values(report.figures)
  const analysed = figures.filter(figure => figure.analysis !== undefined)
  return {
    id: report.id, title: report.title, created_at: report.created_at, trigger: report.trigger, session_id: report.session_id,
    figure_count: figures.length, all_verified: analysed.every(figure => figure.analysis.verified),
    analyses: [...new Map(analysed.map(f => [`${f.analysis.id}@${f.analysis.version}`, { id: f.analysis.id, name: f.analysis.name, version: f.analysis.version, verified: f.analysis.verified }])).values()],
  }
}

const newId = now => `r-${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${randomBytes(3).toString('hex')}`

export class ReportStore {
  /**
   * @param {object} domain - opened storage domain with a `reports` table.
   * @param {object} options
   * @param {{runAnalysis: Function}} options.connector
   * @param {number} [options.maxReports] - newest kept; older ones are removed on save.
   * @param {number} [options.maxAgeS] - cache age accepted when the host reads figure values.
   * @param {string} [options.locale]
   * @param {() => Date} [options.now]
   */
  constructor(domain, { connector, maxReports = 5000, maxAgeS = 3600, locale = 'ko-KR', now = () => new Date() }) {
    this.domain = domain
    this.connector = connector
    this.maxReports = maxReports
    this.maxAgeS = maxAgeS
    this.locale = locale
    this.now = now
  }

  get reports() { return this.domain.table('reports') }

  /**
   * Validate, run the figures, store. `trigger` says what started the Session
   * (`{kind: 'schedule', schedule_id, schedule_title}` or `{kind: 'session'}`).
   * @returns {Promise<object>} the stored report.
   */
  async save(input, { sessionId = null, trigger = { kind: 'session' }, signal } = {}) {
    const problems = reportProblems(input)
    if (problems.length > 0) throw new InsightsError(422, 'invalid_report', 'the report is not valid; nothing was saved', { problems })
    const figures = input.figures ?? []
    const allowed = figureParamValues(figures)
    const typed = [...handWrittenNumbers(input.title, allowed), ...handWrittenNumbers(input.body, allowed)]
    if (typed.length > 0) {
      throw new InsightsError(422, 'hand_written_numbers', 'the text contains numbers typed by hand; put every number in a figure and reference it as {{fig:<id>}}', { numbers: [...new Set(typed)] })
    }
    const resolved = await resolveFigures(figures, this.connector, { maxAgeS: this.maxAgeS, locale: this.locale, signal })
    const now = this.now()
    const report = {
      id: newId(now), title: input.title.trim(), body: input.body, figures: resolved,
      created_at: now.toISOString(), session_id: sessionId, trigger,
      unused_figures: figures.map(f => f.id).filter(id => !placeholders(input.body).includes(id)),
    }
    await this.reports.put(report.id, report)
    await this.prune()
    return report
  }

  async prune() {
    if (this.reports.size <= this.maxReports) return
    const ordered = [...this.reports.entries()].map(([, r]) => r).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    for (const report of ordered.slice(0, ordered.length - this.maxReports)) await this.reports.delete(report.id)
  }

  /**
   * Newest first.
   * @param {{schedule_id?: string, limit?: number, offset?: number}} [query]
   */
  list({ schedule_id, limit = 50, offset = 0 } = {}) {
    let rows = [...this.reports.entries()].map(([, r]) => r)
    if (schedule_id !== undefined) rows = rows.filter(r => r.trigger?.schedule_id === schedule_id)
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    return { data: rows.slice(offset, offset + limit).map(reportSummary), total: rows.length }
  }

  get(id) {
    const report = typeof id === 'string' ? this.reports.get(id) : undefined
    if (report === undefined) throw new InsightsError(404, 'not_found', `no report ${id}`)
    return report
  }
}

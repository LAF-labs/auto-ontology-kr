/**
 * Data map assembly from Auto-ontology gateway responses, with no harness
 * dependencies. Read-only and model-free: every call is a GET with the
 * connector's read token.
 *
 * Gateway paths (Next.js gateway, `catalog:read` or `analysis:read`, both in the viewer role):
 *   GET /api/exploration/semantic-graph?limit=   business terms and the links between them
 *   GET /api/saved-analyses, GET /api/saved-analyses/{id}?version=   confirmed analyses and their tables
 *   GET /api/exploration/tables/{id}/details?limit=   the term a table REPRESENTS
 *   GET /api/terms/{id}, GET /api/terms/{id}/column-attributes?limit=   one term's description, tables and fields
 *
 * Sample values from the catalog never leave this module: field meanings drop
 * the `— samples: …` and `— format: …` suffixes the catalog appends, and
 * `sample_values` is not read.
 */
import { forceLayout } from './layout.js'

/** A failure the routes answer with `{error: {code, status, message}}`. */
export class MapError extends Error {
  /**
   * @param {number} status - HTTP status for the browser.
   * @param {string} code - connector or local error code.
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Catalog bookkeeping fields (who and when a row was created, changed or deleted), listed after the others. */
const AUDIT_COLUMN = /^(created|updated|modified|deleted|inserted)_?(at|by|on|date|time|dt|user|id)$/i

/** Key columns (`id`, `store_id`, `fileIds`); kept but listed after the descriptive fields. */
const IDENTIFIER_COLUMN = /(^|_)ids?$|[a-z]Ids?$/

/** True for a well-formed entity (term) id. */
export const isEntityId = value => typeof value === 'string' && UUID.test(value)

function fail(result, what) {
  const error = result?.error ?? {}
  return new MapError(error.status === 404 ? 404 : 502, error.code ?? 'gateway_error', `${what}: ${error.message ?? 'gateway request failed'}`)
}

/** `text — samples: a, b` → `text`; empty → null. */
export function cleanText(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s*[—–]\s*(samples?|format):[\s\S]*$/i, '').trim()
  return text === '' ? null : text
}

/** First sentence of a description, at most `max` characters. */
export function summaryOf(description, max = 60) {
  const text = cleanText(description)
  if (text === null) return null
  const match = /^(.+?(?:다|요|함|임|음)\.|.+?[.!?])(\s|$)/.exec(text)
  const first = (match ? match[1] : text).trim()
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Confirmed analyses by entity id. An analysis belongs to every entity that a
 * table of its verified version REPRESENTS; tables only linked by a foreign
 * key do not count.
 * @returns {Promise<{byEntity: Map<string, Array<{id: string, name: string}>>, problem: string | null}>}
 */
async function confirmedAnalyses(connector, signal, concurrency) {
  const byEntity = new Map()
  const listed = await connector.listAnalyses({}, signal)
  if (!listed.ok) return { byEntity, problem: listed.error.code }
  const verified = listed.data.filter(a => Number.isInteger(a.latest_verified_version))
  const details = await mapLimit(verified, concurrency, a => connector.getAnalysis(a.id, { version: a.latest_verified_version }, signal))
  const tableUsers = new Map()
  let problem = null
  details.forEach((result, i) => {
    if (!result.ok) { problem ??= result.error.code; return }
    for (const table of result.data?.version?.tables ?? []) {
      if (!isEntityId(table.table_id)) continue
      if (!tableUsers.has(table.table_id)) tableUsers.set(table.table_id, [])
      tableUsers.get(table.table_id).push({ id: verified[i].id, name: verified[i].name })
    }
  })
  const tableIds = [...tableUsers.keys()]
  const tableDetails = await mapLimit(tableIds, concurrency, id =>
    connector.client.request('GET', `/api/exploration/tables/${encodeURIComponent(id)}/details`, { query: { limit: 100 }, signal }))
  tableDetails.forEach((result, i) => {
    if (!result.ok) { problem ??= result.error.code; return }
    for (const term of result.body.data?.terms ?? []) {
      if (!(term.relationship_types ?? []).includes('REPRESENTS')) continue
      const list = byEntity.get(term.id) ?? []
      for (const analysis of tableUsers.get(tableIds[i])) if (!list.some(a => a.id === analysis.id)) list.push(analysis)
      byEntity.set(term.id, list)
    }
  })
  for (const list of byEntity.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  return { byEntity, problem }
}

/**
 * Read the whole map.
 * @param {object} connector - `ctx.aoConnector` (uses `client.request`, `listAnalyses`, `getAnalysis`).
 * @param {object} options
 * @param {number} options.maxEntities - semantic-graph `limit` (the gateway caps it at 500).
 * @param {number} options.mainCount - entities shown before 모두 보기.
 * @param {number} [options.concurrency]
 * @param {AbortSignal} [options.signal]
 * @param {() => Date} [options.now]
 * @returns {Promise<object>} `{entities, links, layouts: {main, all}, counts, read_at, notices}`.
 * @throws {MapError} when the graph itself cannot be read.
 */
export async function loadMap(connector, { maxEntities, mainCount, concurrency = 6, signal, now = () => new Date() }) {
  const graph = await connector.client.request('GET', '/api/exploration/semantic-graph', { query: { limit: maxEntities }, signal })
  if (!graph.ok) throw fail(graph, 'semantic graph')
  const data = graph.body.data
  if (!Array.isArray(data?.nodes) || !Array.isArray(data?.links)) throw new MapError(502, 'bad_response', 'semantic graph: response has no nodes and links')
  const analyses = await confirmedAnalyses(connector, signal, concurrency)

  const ids = new Set(data.nodes.filter(node => isEntityId(node.id)).map(node => node.id))
  const seen = new Set()
  const links = []
  for (const link of data.links) {
    if (!ids.has(link.source) || !ids.has(link.target) || link.source === link.target) continue
    const key = link.source < link.target ? `${link.source}|${link.target}` : `${link.target}|${link.source}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ source: link.source, target: link.target })
  }
  const degree = new Map()
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1)
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1)
  }
  const entities = data.nodes.filter(node => ids.has(node.id)).map(node => {
    const confirmed = analyses.byEntity.get(node.id) ?? []
    const links_count = degree.get(node.id) ?? 0
    return {
      id: node.id,
      name: typeof node.name === 'string' && node.name.trim() !== '' ? node.name.trim() : null,
      summary: summaryOf(node.description),
      aliases: Array.isArray(node.synonyms) ? node.synonyms.filter(s => typeof s === 'string') : [],
      fields_count: Number.isInteger(node.column_attributes_count) ? node.column_attributes_count : null,
      links_count,
      analyses: confirmed,
      score: links_count + 3 * confirmed.length,
    }
  })
  entities.sort((a, b) => b.score - a.score || (a.name ?? '').localeCompare(b.name ?? '', 'ko'))
  // 주요 데이터: entities that confirmed analyses use come first, then the most linked.
  const main = new Set([...new Set([...entities.filter(e => e.analyses.length > 0), ...entities])].slice(0, mainCount).map(e => e.id))
  for (const entity of entities) entity.main = main.has(entity.id)
  const mainLinks = links.filter(l => main.has(l.source) && main.has(l.target))
  return {
    entities,
    links,
    layouts: {
      main: forceLayout(entities.filter(e => e.main), mainLinks, { spacing: 150 }),
      all: forceLayout(entities, links, { spacing: 120 }),
    },
    counts: { entities: entities.length, links: links.length, main: main.size, analyses: new Set([...analyses.byEntity.values()].flat().map(a => a.id)).size },
    read_at: now().toISOString(),
    notices: analyses.problem === null ? [] : [{ code: 'analyses_unavailable', cause: analyses.problem }],
  }
}

/**
 * One entity's side panel: description, fields with their meaning, linked
 * entities and confirmed analyses (both from `map`), and source table names.
 * @param {object} connector - `ctx.aoConnector`.
 * @param {string} id - entity (term) id.
 * @param {object} map - result of `loadMap`.
 * @param {{signal?: AbortSignal, maxFields?: number}} [options]
 * @throws {MapError}
 */
export async function loadEntity(connector, id, map, { signal } = {}) {
  if (!isEntityId(id)) throw new MapError(400, 'invalid_request', 'id must be an entity id')
  const [term, fields] = await Promise.all([
    connector.client.request('GET', `/api/terms/${encodeURIComponent(id)}`, { signal }),
    connector.client.request('GET', `/api/terms/${encodeURIComponent(id)}/column-attributes`, { query: { limit: 100 }, signal }),
  ])
  if (!term.ok) throw fail(term, 'term')
  const detail = term.body.data ?? {}
  const entity = map?.entities.find(e => e.id === id)
  const names = new Map((map?.entities ?? []).map(e => [e.id, e]))
  const neighbours = []
  for (const link of map?.links ?? []) {
    const other = link.source === id ? link.target : link.target === id ? link.source : null
    if (other !== null && names.has(other)) neighbours.push(names.get(other))
  }
  if (neighbours.length === 0) {
    for (const related of detail.related_terms ?? []) {
      if (isEntityId(related.id)) neighbours.push({ id: related.id, name: related.name ?? null, summary: summaryOf(related.description), main: false })
    }
  }
  neighbours.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.name ?? '').localeCompare(b.name ?? '', 'ko'))

  const fieldRows = fields.ok && Array.isArray(fields.body.data) ? fields.body.data : []
  const list = fieldRows.map(row => {
    const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : null
    const meaning = cleanText(row.description)
    const column = typeof row.source_column === 'string' ? row.source_column : row.primary_column?.column_name ?? null
    return {
      name,
      meaning: meaning === null || meaning === name ? null : meaning,
      column,
      table: row.primary_column?.table_name ?? null,
      bookkeeping: column !== null && AUDIT_COLUMN.test(column),
    }
  })
  // Catalog order, with identifiers and then bookkeeping fields moved to the end.
  const rank = f => f.bookkeeping ? 2 : f.column !== null && IDENTIFIER_COLUMN.test(f.column) ? 1 : 0
  const ordered = list.map((f, i) => [f, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([f]) => f)

  return {
    id,
    name: typeof detail.name === 'string' && detail.name.trim() !== '' ? detail.name.trim() : entity?.name ?? null,
    description: cleanText(detail.description),
    fields: ordered,
    fields_total: fields.ok && Number.isInteger(fields.body.total) ? fields.body.total : ordered.length,
    fields_problem: fields.ok ? null : fields.error.code,
    connected: neighbours.map(n => ({ id: n.id, name: n.name, summary: n.summary ?? null, main: n.main === true })),
    analyses: entity?.analyses ?? [],
    // The ontology has no example questions; this stays empty rather than inventing any.
    questions: [],
    source: {
      tables: (detail.tables ?? []).map(t => t.name).filter(name => typeof name === 'string'),
      schemas: Array.isArray(detail.schema_names) ? detail.schema_names : [],
    },
  }
}

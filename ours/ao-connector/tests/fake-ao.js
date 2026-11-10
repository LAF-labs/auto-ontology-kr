/**
 * Fake Auto-ontology gateway answering as auto-ontology/docs/saved-analyses.md
 * (and the OpenAPI search, coverage and chat routes) describe. Scenarios are
 * chosen by analysis id:
 *
 *   a-ok       verified v1, one row; per-params cache (second call hits)
 *   a-rows     verified v1, three rows
 *   a-draft    only a draft: 409 not_verified unless version is given
 *   a-guard    422 forbidden_statement
 *   a-busy     429 busy
 *   a-timeout  504 timeout with last_success
 *   a-slow     answers after 2 s
 *   a-series   verified v1, a month column and a count (six rows)
 *   a-flaky    like a-rows until switched to failing (POST /__fake/fail?id=a-flaky&on=1,
 *              no auth); then 504 timeout with the last real result as last_success
 *
 * Run standalone: node tests/fake-ao.js --port 3299   (token from FAKE_AO_TOKEN)
 */
import { createServer } from 'node:http'

const COLUMNS = [{ name: 'approved_count', type: 'integer', role: 'measure', unit: '건', label: '승인 건수', description: null }]
const ANALYSES = {
  'a-ok': { name: 'Approved per month', latest_version: 1, latest_verified_version: 1, rows: [[1234]] },
  'a-rows': { name: 'Approved by status', latest_version: 1, latest_verified_version: 1, rows: [[1], [2], [3]] },
  'a-draft': { name: 'Draft only', latest_version: 1, latest_verified_version: null, rows: [[7]] },
  'a-guard': { name: 'Guard rejects', latest_version: 1, latest_verified_version: 1 },
  'a-busy': { name: 'Busy database', latest_version: 1, latest_verified_version: 1 },
  'a-timeout': { name: 'Times out', latest_version: 1, latest_verified_version: 1 },
  'a-slow': { name: 'Slow', latest_version: 1, latest_verified_version: 1, rows: [[5]] },
  'a-flaky': { name: 'Flaky', latest_version: 1, latest_verified_version: 1, rows: [[10], [20], [30]] },
  'a-series': { name: 'Approved by month', latest_version: 1, latest_verified_version: 1,
    columns: [{ name: 'month', type: 'string', role: 'dimension', unit: null, label: '월', description: null }, ...[{ name: 'approved_count', type: 'integer', role: 'measure', unit: '건', label: '승인 건수', description: null }]],
    rows: [['2026-05', 6900], ['2026-06', 7300], ['2026-07', 7100], ['2026-08', 7800], ['2026-09', 7500], ['2026-10', 8753]] },
}
const MAX_DEADLINE_S = 280
const PARAMS = ['start_date', 'end_date', 'statuses']
const RUN_KEYS = ['version', 'params', 'max_age_s', 'row_limit']

function summary(id) {
  const a = ANALYSES[id]
  return { id, name: a.name, description: null, database_name: 'example_db', latest_version: a.latest_version,
    latest_verified_version: a.latest_verified_version, created: '2026-11-10T07:00:00Z', created_by: 'u1', updated: '2026-11-10T07:00:00Z' }
}

function contractError(status, code, message, details = null, lastSuccess = null) {
  return { status, body: { error: { code, status, message, details, last_success: lastSuccess } } }
}

function normalizedParams(params = {}) {
  return { start_date: params.start_date ?? '2026-10-01', end_date: params.end_date ?? '2026-11-01', statuses: params.statuses ?? ['APPROVED'] }
}

/** `legacyErrors`: answer like a backend from before `error.status` existed (batch items carry no status). */
export async function startFakeAo({ token = 'fake-token', forbiddenToken = 'viewer-without-read', port = 0, legacyErrors = false } = {}) {
  const requests = []
  const cache = new Map()
  const failing = new Set()
  const lastGood = new Map()
  let runs = 0

  async function run(id, body) {
    const analysis = ANALYSES[id]
    if (analysis === undefined) return contractError(404, 'not_found', 'analysis not found')
    const extra = Object.keys(body.params ?? {}).filter(name => !PARAMS.includes(name))
    if (extra.length > 0) return contractError(422, 'invalid_params', 'invalid parameter values', { params: Object.fromEntries(extra.map(name => [name, 'is not a parameter of this analysis'])) })
    if (body.version === undefined && analysis.latest_verified_version === null) return contractError(409, 'not_verified', 'no verified version', { latest_version: analysis.latest_version })
    const version = body.version ?? analysis.latest_verified_version
    const params = normalizedParams(body.params)
    if (id === 'a-guard') return contractError(422, 'forbidden_statement', 'statement is not allowed', { statement: 'DELETE' })
    if (id === 'a-busy') return contractError(429, 'busy', 'database is busy', { database_name: 'example_db', waited_s: 10 })
    if (id === 'a-timeout') {
      return contractError(504, 'timeout', 'query exceeded timeout', { timeout_s: 30 }, {
        analysis_id: id, name: analysis.name, version, status: 'verified', params, columns: COLUMNS, rows: [[1200]],
        row_count: 1, truncated: false, executed_at: '2026-11-10T06:12:03Z', duration_ms: 812,
        cache: { hit: true, shared: false, expires_at: '2026-11-10T07:12:03Z' },
        source: { database_name: 'example_db', tables: ['example_db.review_proofs'] },
        sql: 'SELECT COUNT(review_proof_id) AS approved_count FROM review_proofs\nLIMIT 5001',
      })
    }
    if (failing.has(id)) {
      const last = lastGood.get(id)
      return contractError(504, 'timeout', 'query exceeded timeout', { timeout_s: 30 }, last === undefined ? null : { ...last, cache: { ...last.cache, hit: true } })
    }
    if (id === 'a-slow') await new Promise(resolve => setTimeout(resolve, 2000))
    const key = JSON.stringify([id, version, params])
    const cached = cache.get(key)
    const rowLimit = body.row_limit ?? 5000
    if (cached !== undefined && body.max_age_s !== 0) {
      return { status: 200, body: { data: { ...cached, cache: { ...cached.cache, hit: true } } } }
    }
    runs += 1
    const rows = analysis.rows.slice(0, rowLimit)
    const data = {
      analysis_id: id, name: analysis.name, version, status: body.version === undefined ? 'verified' : (analysis.latest_verified_version === version ? 'verified' : 'draft'),
      params, columns: analysis.columns ?? COLUMNS, rows, row_count: rows.length, truncated: analysis.rows.length > rowLimit,
      executed_at: new Date().toISOString(), duration_ms: 41,
      cache: { hit: false, shared: false, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      source: { database_name: 'example_db', tables: ['example_db.review_proofs'] },
      sql: 'SELECT COUNT(review_proof_id) AS approved_count FROM review_proofs\nLIMIT 5001',
    }
    cache.set(key, data)
    lastGood.set(id, data)
    return { status: 200, body: { data } }
  }

  async function route(method, url, body) {
    const path = url.pathname
    if (method === 'GET' && path === '/api/saved-analyses') {
      const query = url.searchParams.get('query')
      // Reverse insertion order: the connector must not rely on the server's order.
      const ids = Object.keys(ANALYSES).reverse().filter(id => query === null || ANALYSES[id].name.toLowerCase().includes(query.toLowerCase()))
      return { status: 200, body: { data: ids.map(summary), count: ids.length, total: ids.length } }
    }
    if (method === 'POST' && path === '/api/saved-analyses/run-batch') {
      const items = body.items
      if (!Array.isArray(items) || items.length > 50 || new Set(items.map(item => item.key)).size !== items.length) {
        return contractError(422, 'invalid_params', 'invalid batch', { params: { items: 'invalid' } })
      }
      if (body.deadline_s !== undefined && !(Number.isInteger(body.deadline_s) && body.deadline_s >= 1 && body.deadline_s <= MAX_DEADLINE_S)) {
        return contractError(422, 'invalid_params', `deadline_s must be 1..${MAX_DEADLINE_S}`, { deadline_s: MAX_DEADLINE_S })
      }
      const data = {}
      for (const item of items) {
        const { key, analysis_id: id, ...rest } = item
        const result = await run(id, { max_age_s: body.max_age_s, ...rest })
        data[key] = legacyErrors && result.body.error !== undefined
          ? { error: Object.fromEntries(Object.entries(result.body.error).filter(([name]) => name !== 'status')) }
          : result.body
      }
      return { status: 200, body: { data } }
    }
    let match = path.match(/^\/api\/saved-analyses\/([^/]+)\/run$/)
    if (method === 'POST' && match) {
      const extra = Object.keys(body).filter(key => !RUN_KEYS.includes(key))
      if (extra.length > 0) return { status: 422, body: { detail: extra.map(key => ({ type: 'extra_forbidden', loc: ['body', key], msg: 'Extra inputs are not permitted' })) } }
      return run(decodeURIComponent(match[1]), body)
    }
    match = path.match(/^\/api\/saved-analyses\/([^/]+)$/)
    if (method === 'GET' && match) {
      const id = decodeURIComponent(match[1])
      if (ANALYSES[id] === undefined) return contractError(404, 'not_found', 'analysis not found')
      return { status: 200, body: { data: { ...summary(id), versions: [{ version: 1, status: 'verified' }], version: { version: Number(url.searchParams.get('version') ?? 1), status: 'verified', columns: COLUMNS } } } }
    }
    if (method === 'POST' && path === '/api/search/global-search') {
      if (typeof body.search_term !== 'string') return { status: 422, body: { detail: [{ type: 'missing', loc: ['body', 'search_term'] }] } }
      return { status: 200, body: { data: [{ id: 't1', type: 'Term', name: body.search_term, synonyms: [], breadcrumbs: [] }], count: 1 } }
    }
    if (method === 'POST' && path === '/api/question-entity-coverage') {
      return { status: 200, body: { data: { coverage: 0.8, candidates: [{ id: 't1', term: 'approved review', label: 'Term' }] } } }
    }
    return { status: 404, body: { error: 'Not found' } }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake')
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw === '' ? {} : JSON.parse(raw)
    const presented = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '')
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, hasKey: presented !== undefined })
    if (req.method === 'POST' && url.pathname === '/__fake/fail') {
      const id = url.searchParams.get('id')
      if (url.searchParams.get('on') === '1') failing.add(id)
      else failing.delete(id)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ failing: [...failing] })); return
    }
    if (presented === forbiddenToken) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Forbidden' })); return }
    if (presented !== token) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return }
    if (req.method === 'POST' && url.pathname === '/api/chat/completions') {
      if (body.question === 'busy') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: 'Conversation in progress' })); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
      send({ type: 'step', node: 'plan', phase: 'start' })
      send({ type: 'step', node: 'plan', phase: 'end', thought: '…' })
      if (body.question === 'fail') send({ type: 'error', message: 'semantic layer missing' })
      else {
        send({ type: 'sql', sql: 'SELECT 1' })
        send({ type: 'result', answer: { response: '1,234건', sql_code: 'SELECT COUNT(*) FROM review_proofs', sql_response_from_db: [JSON.stringify([{ count: 1234 }, { count: 1 }, { count: 2 }])], custom_analyses_used: [], thoughts: '' } })
      }
      res.end('data: [DONE]\n\n')
      return
    }
    const result = await route(req.method, url, body)
    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body))
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get runs() { return runs },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portIndex = process.argv.indexOf('--port')
  const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : 3299
  const token = process.env.FAKE_AO_TOKEN
  if (!token) throw new Error('set FAKE_AO_TOKEN')
  const fake = await startFakeAo({ token, port })
  console.log(`fake auto-ontology on ${fake.url}`)
  process.on('SIGTERM', () => fake.close().then(() => process.exit(0)))
}

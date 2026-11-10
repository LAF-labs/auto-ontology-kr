/**
 * Auto-ontology REST gateway client with no harness dependencies.
 *
 * Contract: auto-ontology/docs/saved-analyses.md (saved analyses) and
 * docs/openapi/auto-ontology-api.json (search, coverage, chat).
 * Every method resolves to `{ ok: true, ... }` or `{ ok: false, error }` and
 * never rejects for a remote or transport failure. `error` always has
 * `{ status, code, message, details, last_success }`; `status` is the gateway
 * HTTP status, or 0 for a failure that produced no response.
 */

/** Codes the connector itself produces (never sent by Auto-ontology). */
export const LOCAL_ERROR_CODES = Object.freeze({
  missingToken: 'missing_token',
  unreachable: 'unreachable',
  connectorTimeout: 'connector_timeout',
  cancelled: 'cancelled',
  badResponse: 'bad_response',
  invalidRequest: 'invalid_request',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  requestInvalid: 'request_invalid',
  gatewayError: 'gateway_error',
  askFailed: 'ask_failed',
})

/** HTTP status of each contract error code (saved-analyses.md §10), used for batch items, which carry no status. */
export const CONTRACT_ERROR_STATUS = Object.freeze({
  not_found: 404, name_conflict: 409, not_verified: 409, retired: 409, invalid_status_transition: 409, schema_mismatch: 409,
  unknown_database: 422, invalid_definition: 422, invalid_params: 422, parse_error: 422, forbidden_statement: 422,
  unsupported_placeholder: 422, duplicate_columns: 422, busy: 429, db_error: 502, timeout: 504,
})

const ANALYSIS_RUN_KEYS = ['version', 'params', 'max_age_s', 'row_limit']
const BATCH_ITEM_KEYS = ['key', 'analysis_id', ...ANALYSIS_RUN_KEYS]

function localError(code, message, status = 0, details = null) {
  return { ok: false, error: { status, code, message, details, last_success: null } }
}

/**
 * Turn one non-2xx gateway response body into the connector error.
 * FastAPI contract errors pass through unchanged; the other three gateway
 * formats (`{"error": "<string>"}`, `{"detail": [...]}`, `{"detail": "<string>"}`)
 * get a connector code.
 * @param {number} status - HTTP status.
 * @param {unknown} body - parsed JSON body, or undefined when not JSON.
 * @param {string} [text] - raw body text; a short plain-text body becomes the error message.
 * @returns {{ ok: false, error: object }}
 */
export function normalizeError(status, body, text) {
  const record = body !== null && typeof body === 'object' ? body : undefined
  const inner = record?.error
  if (inner !== null && typeof inner === 'object' && typeof inner.code === 'string') {
    return {
      ok: false,
      error: {
        status,
        code: inner.code,
        message: typeof inner.message === 'string' ? inner.message : '',
        details: inner.details ?? null,
        last_success: inner.last_success ?? null,
      },
    }
  }
  if (typeof inner === 'string') {
    const code = status === 401 ? LOCAL_ERROR_CODES.unauthorized
      : status === 403 ? LOCAL_ERROR_CODES.forbidden : LOCAL_ERROR_CODES.gatewayError
    return localError(code, inner, status)
  }
  if (Array.isArray(record?.detail)) {
    return localError(LOCAL_ERROR_CODES.requestInvalid, 'request body rejected by the gateway', status, { detail: record.detail })
  }
  if (typeof record?.detail === 'string') {
    return localError(LOCAL_ERROR_CODES.gatewayError, record.detail, status)
  }
  // Some gateway paths answer in plain text (`Forbidden`, `Backend connection failed`).
  if (body === undefined && typeof text === 'string' && text.trim() !== '' && text.length <= 1000) {
    const code = status === 401 ? LOCAL_ERROR_CODES.unauthorized
      : status === 403 ? LOCAL_ERROR_CODES.forbidden : LOCAL_ERROR_CODES.gatewayError
    return localError(code, text.trim(), status)
  }
  return localError(LOCAL_ERROR_CODES.badResponse, `unexpected HTTP ${status} response`, status)
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

function unknownKeys(source, keys) {
  return Object.keys(source).filter(key => !keys.includes(key))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the fields of one run request before any network I/O.
 * @returns {string | undefined} a reason, or undefined when valid.
 */
function runRequestProblem(request, allowed) {
  if (!isPlainObject(request)) return 'request must be an object'
  const extra = unknownKeys(request, allowed)
  if (extra.length > 0) return `unknown field(s): ${extra.join(', ')}`
  if (request.version !== undefined && !(Number.isInteger(request.version) && request.version >= 1)) return 'version must be a positive integer'
  if (request.params !== undefined && !isPlainObject(request.params)) return 'params must be an object'
  if (request.max_age_s !== undefined && !(Number.isInteger(request.max_age_s) && request.max_age_s >= 0)) return 'max_age_s must be a non-negative integer'
  if (request.row_limit !== undefined && !(Number.isInteger(request.row_limit) && request.row_limit >= 1)) return 'row_limit must be a positive integer'
  return undefined
}

/**
 * Parse an SSE body from /api/chat/completions into its JSON events.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<object>} events in order; ends at `[DONE]` or end of stream.
 */
async function* sseEvents(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + (buffer[index] === '\r' ? 2 : 1))
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      if (payload === '') continue
      yield JSON.parse(payload)
    }
  }
}

const NAME_COLLATOR = new Intl.Collator('und', { numeric: true })

/** Name in root-locale collation, then id, so equal names keep a fixed order. */
function compareAnalyses(a, b) {
  return NAME_COLLATOR.compare(String(a?.name ?? ''), String(b?.name ?? ''))
    || String(a?.id ?? '').localeCompare(String(b?.id ?? ''), 'und')
}

/**
 * Chat `sql_response_from_db` to records. Observed on the gateway as a
 * one-item list holding a JSON-records string (`["[{\"n\":1}]"]`); a plain
 * string or an array of records is accepted too. Unparseable input comes back
 * as `rows: null` with the text in `rows_text`.
 */
export function normalizeChatRows(value) {
  const parse = (text) => { try { return JSON.parse(text) } catch { return undefined } }
  let records
  if (value === null || value === undefined) return { columns: [], rows: null }
  if (typeof value === 'string') records = parse(value)
  else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const parts = value.map(parse)
    records = parts.some((part) => part === undefined) ? undefined : parts.flatMap((part) => Array.isArray(part) ? part : [part])
  } else records = value
  if (!Array.isArray(records) || !records.every(isPlainObject)) {
    return { columns: [], rows: null, rows_text: typeof value === 'string' ? value : JSON.stringify(value) }
  }
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))]
  return { columns, rows: records }
}

export class AoClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl - gateway origin, e.g. http://127.0.0.1:3000 (no /api).
   * @param {() => Promise<string | undefined>} options.token - current API token, resolved per request.
   * @param {number} [options.requestTimeoutMs] - deadline for JSON requests.
   * @param {number} [options.askTimeoutMs] - deadline for one streamed question.
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ baseUrl, token, requestTimeoutMs = 330_000, askTimeoutMs = 900_000, fetch: fetchImpl = globalThis.fetch }) {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`ao-connector: baseUrl must be http(s), got ${url.protocol}`)
    this.baseUrl = url.href.replace(/\/+$/, '')
    this.token = token
    this.requestTimeoutMs = requestTimeoutMs
    this.askTimeoutMs = askTimeoutMs
    this.fetch = fetchImpl
  }

  /**
   * One gateway call. Resolves to `{ ok, status, body | error, response? }`.
   * @param {string} method
   * @param {string} path - absolute path starting with /api/.
   * @param {object} [options]
   */
  async request(method, path, { body, query, signal, timeoutMs = this.requestTimeoutMs, stream = false } = {}) {
    const token = await this.token()
    if (token === undefined || token === '') {
      return localError(LOCAL_ERROR_CODES.missingToken, 'no Auto-ontology API token is configured')
    }
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const deadline = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    let response
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          'x-api-key': token,
          accept: stream ? 'text/event-stream' : 'application/json',
          ...body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: combined,
        redirect: 'error',
      })
    } catch (error) {
      if (signal?.aborted) return localError(LOCAL_ERROR_CODES.cancelled, 'request cancelled')
      if (deadline.aborted) return localError(LOCAL_ERROR_CODES.connectorTimeout, `no response within ${timeoutMs} ms`, 0, { timeout_ms: timeoutMs })
      return localError(LOCAL_ERROR_CODES.unreachable, `gateway unreachable: ${error?.cause?.code ?? error?.message ?? String(error)}`)
    }
    if (stream && response.ok) return { ok: true, status: response.status, response, signal: combined, deadline }
    let parsed
    let text
    try {
      text = await response.text()
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch (error) {
      if (signal?.aborted) return localError(LOCAL_ERROR_CODES.cancelled, 'request cancelled')
      if (deadline.aborted) return localError(LOCAL_ERROR_CODES.connectorTimeout, `no response within ${timeoutMs} ms`, 0, { timeout_ms: timeoutMs })
      parsed = undefined
    }
    if (!response.ok) return normalizeError(response.status, parsed, text)
    if (!isPlainObject(parsed)) return localError(LOCAL_ERROR_CODES.badResponse, 'gateway answered without a JSON object', response.status)
    return { ok: true, status: response.status, body: parsed }
  }

  /** GET /api/saved-analyses — `{ ok, data, count, total }`. */
  async listAnalyses({ query, status, skip, limit } = {}, signal) {
    // The gateway's "by name" order follows the store's collation, so the
    // whole list is fetched (no limit = all) and ordered and paged here.
    const result = await this.request('GET', '/api/saved-analyses', { query: { query, status }, signal })
    if (!result.ok) return result
    const { data } = result.body
    if (!Array.isArray(data)) return localError(LOCAL_ERROR_CODES.badResponse, 'list response has no data array', result.status)
    const sorted = [...data].sort(compareAnalyses)
    const start = Number.isInteger(skip) && skip > 0 ? skip : 0
    const page = Number.isInteger(limit) && limit >= 0 ? sorted.slice(start, start + limit) : sorted.slice(start)
    return { ok: true, data: page, count: page.length, total: sorted.length }
  }

  /** GET /api/saved-analyses/{id}?version= — `{ ok, data }`. */
  async getAnalysis(analysisId, { version } = {}, signal) {
    if (typeof analysisId !== 'string' || analysisId === '') return localError(LOCAL_ERROR_CODES.invalidRequest, 'analysis_id must be a non-empty string')
    const result = await this.request('GET', `/api/saved-analyses/${encodeURIComponent(analysisId)}`, { query: { version }, signal })
    return result.ok ? { ok: true, data: result.body.data } : result
  }

  /** POST /api/saved-analyses/{id}/run — `{ ok, data }`; errors carry `last_success`. */
  async runAnalysis(analysisId, request = {}, signal) {
    if (typeof analysisId !== 'string' || analysisId === '') return localError(LOCAL_ERROR_CODES.invalidRequest, 'analysis_id must be a non-empty string')
    const problem = runRequestProblem(request, ANALYSIS_RUN_KEYS)
    if (problem !== undefined) return localError(LOCAL_ERROR_CODES.invalidRequest, problem)
    const result = await this.request('POST', `/api/saved-analyses/${encodeURIComponent(analysisId)}/run`, { body: pick(request, ANALYSIS_RUN_KEYS), signal })
    return result.ok ? { ok: true, data: result.body.data } : result
  }

  /**
   * POST /api/saved-analyses/run-batch — `{ ok, data: { [key]: { ok, data } | { ok: false, error } } }`.
   * A whole-request failure is `{ ok: false, error }`; item failures stay per item.
   */
  async runBatch({ items, max_age_s, deadline_s } = {}, signal) {
    if (!Array.isArray(items) || items.length === 0) return localError(LOCAL_ERROR_CODES.invalidRequest, 'items must be a non-empty array')
    const keys = new Set()
    for (const [index, item] of items.entries()) {
      const problem = runRequestProblem(item, BATCH_ITEM_KEYS)
      if (problem !== undefined) return localError(LOCAL_ERROR_CODES.invalidRequest, `items[${index}]: ${problem}`)
      if (typeof item.key !== 'string' || item.key === '') return localError(LOCAL_ERROR_CODES.invalidRequest, `items[${index}].key must be a non-empty string`)
      if (typeof item.analysis_id !== 'string' || item.analysis_id === '') return localError(LOCAL_ERROR_CODES.invalidRequest, `items[${index}].analysis_id must be a non-empty string`)
      if (keys.has(item.key)) return localError(LOCAL_ERROR_CODES.invalidRequest, `duplicate key ${JSON.stringify(item.key)}`)
      keys.add(item.key)
    }
    if (max_age_s !== undefined && !(Number.isInteger(max_age_s) && max_age_s >= 0)) return localError(LOCAL_ERROR_CODES.invalidRequest, 'max_age_s must be a non-negative integer')
    if (deadline_s !== undefined && !(Number.isInteger(deadline_s) && deadline_s >= 1)) return localError(LOCAL_ERROR_CODES.invalidRequest, 'deadline_s must be a positive integer')
    if (deadline_s !== undefined && deadline_s * 1000 >= this.requestTimeoutMs) {
      return localError(LOCAL_ERROR_CODES.invalidRequest, `deadline_s must be shorter than the connector timeout (${Math.floor(this.requestTimeoutMs / 1000)} s)`)
    }
    const body = {
      items: items.map(item => pick(item, BATCH_ITEM_KEYS)),
      ...max_age_s === undefined ? {} : { max_age_s },
      ...deadline_s === undefined ? {} : { deadline_s },
    }
    const result = await this.request('POST', '/api/saved-analyses/run-batch', { body, signal })
    if (!result.ok) return result
    const data = result.body.data
    if (!isPlainObject(data)) return localError(LOCAL_ERROR_CODES.badResponse, 'batch response has no data object', result.status)
    const out = {}
    for (const key of keys) {
      const entry = data[key]
      if (isPlainObject(entry) && 'data' in entry) out[key] = { ok: true, data: entry.data }
      else if (isPlainObject(entry) && isPlainObject(entry.error)) {
        // Current backends state `error.status`; older ones need the §10 table.
        const status = Number.isInteger(entry.error.status) ? entry.error.status : CONTRACT_ERROR_STATUS[entry.error.code] ?? 0
        out[key] = normalizeError(status, entry)
      }
      else out[key] = localError(LOCAL_ERROR_CODES.badResponse, `batch response has no entry for ${JSON.stringify(key)}`)
    }
    return { ok: true, data: out }
  }

  /** POST /api/search/global-search — `{ ok, data, count }`. */
  async searchTerms(searchTerm, { filters } = {}, signal) {
    if (typeof searchTerm !== 'string' || searchTerm.trim().length < 2) return localError(LOCAL_ERROR_CODES.invalidRequest, 'search_term needs at least two characters')
    const result = await this.request('POST', '/api/search/global-search', {
      body: { search_term: searchTerm, ...filters === undefined ? {} : { filters } }, signal,
    })
    if (!result.ok) return result
    return { ok: true, data: result.body.data, count: result.body.count }
  }

  /** POST /api/question-entity-coverage — `{ ok, data: { coverage, candidates, uncovered_entities? } }`. */
  async questionCoverage(question, { max_distance } = {}, signal) {
    if (typeof question !== 'string' || question.trim() === '') return localError(LOCAL_ERROR_CODES.invalidRequest, 'question must be a non-empty string')
    const result = await this.request('POST', '/api/question-entity-coverage', {
      body: { question, ...max_distance === undefined ? {} : { max_distance } }, signal,
    })
    return result.ok ? { ok: true, data: result.body.data } : result
  }

  /**
   * POST /api/chat/completions (SSE), stateless (no conversation_id).
   * @returns `{ ok, data: { response, sql_code, columns, rows, rows_text?, custom_analyses_used, steps } }`, or `ask_failed` for an `error` event.
   */
  async askQuestion(question, { target_db, evidence } = {}, signal) {
    if (typeof question !== 'string' || question.trim() === '') return localError(LOCAL_ERROR_CODES.invalidRequest, 'question must be a non-empty string')
    const result = await this.request('POST', '/api/chat/completions', {
      body: { question, ...target_db === undefined ? {} : { target_db }, ...evidence === undefined ? {} : { evidence } },
      signal, timeoutMs: this.askTimeoutMs, stream: true,
    })
    if (!result.ok) return result
    let steps = 0
    try {
      for await (const event of sseEvents(result.response.body)) {
        if (event.type === 'step' && event.phase !== 'end') steps += 1
        else if (event.type === 'error') return localError(LOCAL_ERROR_CODES.askFailed, String(event.message ?? 'question failed'), result.status)
        else if (event.type === 'result') {
          const answer = event.answer ?? {}
          return {
            ok: true,
            data: {
              response: answer.response ?? null,
              sql_code: answer.sql_code ?? null,
              ...normalizeChatRows(answer.sql_response_from_db),
              custom_analyses_used: Array.isArray(answer.custom_analyses_used) ? answer.custom_analyses_used : [],
              steps,
            },
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) return localError(LOCAL_ERROR_CODES.cancelled, 'request cancelled')
      if (result.deadline.aborted) return localError(LOCAL_ERROR_CODES.connectorTimeout, `no answer within ${this.askTimeoutMs} ms`, 0, { timeout_ms: this.askTimeoutMs })
      return localError(LOCAL_ERROR_CODES.badResponse, `malformed event stream: ${error?.message ?? String(error)}`, result.status)
    }
    return localError(LOCAL_ERROR_CODES.badResponse, 'event stream ended without a result', result.status)
  }
}

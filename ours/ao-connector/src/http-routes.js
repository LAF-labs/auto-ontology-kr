/**
 * Browser routes on the shared API channel. Connection admits only the owner
 * cookie before a route runs; these handlers translate between browser JSON
 * and the connector.
 *
 *   GET  /api/ao/analyses?query=&status=&skip=&limit=
 *   GET  /api/ao/analysis?id=&version=
 *   POST /api/ao/run         {"analysis_id", "version"?, "params"?, "max_age_s"?, "row_limit"?}
 *   POST /api/ao/run-batch   {"items": [...], "max_age_s"?, "deadline_s"?}   (contract body)
 *   POST /api/ao/verify      {"analysis_id", "version", "note"?}   (a person verifies a draft version; reviewer token)
 *
 * Success: 200 with the contract `data` (list adds `count`, `total`).
 * Failure: `{"error": {code, message, details, last_success}}` with the
 * contract status. Auto-ontology 401/403 become 502 (`upstream_unauthorized`,
 * `upstream_forbidden`) so the browser never confuses them with its own
 * missing cookie; connector-local failures map as in LOCAL_STATUS.
 */

const LOCAL_STATUS = {
  missing_token: 503,
  unreachable: 502,
  connector_timeout: 504,
  cancelled: 499,
  bad_response: 502,
  invalid_request: 400,
  request_invalid: 502,
  gateway_error: 502,
  ask_failed: 502,
}

function errorResponse(error) {
  let status = error.status
  let code = error.code
  if (code === 'unauthorized') { status = 502; code = 'upstream_unauthorized' }
  else if (code === 'forbidden') { status = 502; code = 'upstream_forbidden' }
  else if (code in LOCAL_STATUS) status = LOCAL_STATUS[code]
  if (!Number.isInteger(status) || status < 400) status = 502
  return Response.json({ error: { code, status, message: error.message, details: error.details ?? null, last_success: error.last_success ?? null } }, { status })
}

function badRequest(message) {
  return Response.json({ error: { code: 'invalid_request', message, details: null, last_success: null } }, { status: 400 })
}

async function readJson(request) {
  const text = await request.text()
  if (text === '') return {}
  try { return JSON.parse(text) } catch { return undefined }
}

function intParam(url, name) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return undefined
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN
}

/**
 * @param {object} connector - object with the AoConnector methods.
 * @returns {Array<{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }>}
 */
export function aoRoutes(connector) {
  return [
    {
      path: '/api/ao/analyses',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        const skip = intParam(url, 'skip')
        const limit = intParam(url, 'limit')
        if (Number.isNaN(skip) || Number.isNaN(limit)) return badRequest('skip and limit must be non-negative integers')
        const result = await connector.listAnalyses({
          query: url.searchParams.get('query') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          skip, limit,
        }, request.signal)
        return result.ok ? Response.json({ data: result.data, count: result.count, total: result.total }) : errorResponse(result.error)
      },
    },
    {
      path: '/api/ao/analysis',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        const id = url.searchParams.get('id')
        const version = intParam(url, 'version')
        if (id === null || id === '') return badRequest('id is required')
        if (Number.isNaN(version)) return badRequest('version must be a positive integer')
        const result = await connector.getAnalysis(id, { version }, request.signal)
        return result.ok ? Response.json({ data: result.data }) : errorResponse(result.error)
      },
    },
    {
      path: '/api/ao/run',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readJson(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return badRequest('body must be a JSON object')
        const { analysis_id: analysisId, ...rest } = body
        if (typeof analysisId !== 'string' || analysisId === '') return badRequest('analysis_id is required')
        const result = await connector.runAnalysis(analysisId, rest, request.signal)
        return result.ok ? Response.json({ data: result.data }) : errorResponse(result.error)
      },
    },
    {
      path: '/api/ao/run-batch',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readJson(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return badRequest('body must be a JSON object')
        const extra = Object.keys(body).filter(key => key !== 'items' && key !== 'max_age_s' && key !== 'deadline_s')
        if (extra.length > 0) return badRequest(`unknown field(s): ${extra.join(', ')}`)
        const result = await connector.runBatch(body, request.signal)
        if (!result.ok) return errorResponse(result.error)
        const data = {}
        for (const [key, entry] of Object.entries(result.data)) {
          data[key] = entry.ok ? { data: entry.data } : { error: { code: entry.error.code, status: entry.error.status, message: entry.error.message, details: entry.error.details, last_success: entry.error.last_success } }
        }
        return Response.json({ data })
      },
    },
    {
      // The edit panel's button. No agent tool verifies, and generated widget
      // code runs in an opaque-origin frame that cannot send the owner cookie here.
      path: '/api/ao/verify',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readJson(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return badRequest('body must be a JSON object')
        const extra = Object.keys(body).filter(key => !['analysis_id', 'version', 'note'].includes(key))
        if (extra.length > 0) return badRequest(`unknown field(s): ${extra.join(', ')}`)
        if (typeof body.analysis_id !== 'string' || body.analysis_id === '') return badRequest('analysis_id is required')
        const result = await connector.verifyVersion(body.analysis_id, body.version, { note: body.note }, request.signal)
        return result.ok ? Response.json({ data: result.data }) : errorResponse(result.error)
      },
    },
  ]
}

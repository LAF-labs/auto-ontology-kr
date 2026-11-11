/**
 * Browser routes for reports and alerts, exact paths on the shared API
 * channel (owner cookie required). Errors: `{"error": {code, status, message, details}}`.
 *
 *   GET  /api/insights/reports?schedule_id=&limit=&offset=   report summaries, newest first
 *   GET  /api/insights/report?id=                           one report with its figures
 *   GET  /api/insights/rules                                rules and the server's limits
 *   POST /api/insights/rules        {name, analysis_id, …}  a person's rule (starts active)
 *   POST /api/insights/rule-update  {id, status?, …fields}  turn on (pending → active), pause, change
 *   POST /api/insights/rule-delete  {id}
 *   POST /api/insights/evaluate     {id}                    evaluate one rule now (no model)
 *   GET  /api/insights/firings?limit=&offset=&unread_only=1&rule_id=
 *   GET  /api/insights/unread                               {unread}
 *   POST /api/insights/read         {ids?}                  mark firings read (all when ids is absent)
 *   POST /api/insights/investigate  {firing_id}             open (or reopen) the analysis Session for a firing
 *   GET  /api/insights/schedules                            scheduled tasks (not ended): title, repeat in words, next run
 *   POST /api/insights/schedule-update {id, active}         pause or resume one
 */
import { InsightsError } from './reports.js'

function errorResponse(error) {
  if (error instanceof InsightsError) {
    return Response.json({ error: { code: error.code, status: error.status, message: error.message, details: error.details } }, { status: error.status })
  }
  return Response.json({ error: { code: 'internal', status: 500, message: String(error?.message ?? error), details: null } }, { status: 500 })
}

async function readBody(request) {
  const text = await request.text()
  if (text === '') return {}
  let value
  try { value = JSON.parse(text) } catch { throw new InsightsError(400, 'invalid_request', 'body must be JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InsightsError(400, 'invalid_request', 'body must be a JSON object')
  return value
}

const intParam = (url, name, fallback, max) => {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new InsightsError(400, 'invalid_request', `${name} must be a non-negative integer`)
  return Math.min(value, max)
}

/**
 * @param {object} deps
 * @param {import('./reports.js').ReportStore} deps.reports
 * @param {import('./alerts.js').AlertStore} deps.alerts
 * @param {(firingId: string) => Promise<{session_id: string, reused: boolean}>} deps.investigate
 * @param {object} deps.limits - shown with the rules (max_rules, min_interval_s, max_interval_s).
 * @param {{list: () => Promise<object[]>, setActive: (id: string, active: boolean) => Promise<object>}} [deps.schedules]
 */
export function insightsRoutes({ reports, alerts, investigate, limits, schedules = { list: async () => [], setActive: async () => { throw new InsightsError(503, 'schedule_unavailable', 'no Schedule service') } } }) {
  const route = (path, methods, handler) => ({
    path, methods, requestBody: 'buffered',
    async fetch(request) {
      try {
        const result = await handler(request, new URL(request.url))
        return Response.json(result)
      } catch (error) {
        return errorResponse(error)
      }
    },
  })
  return [
    route('/api/insights/reports', ['GET'], (_request, url) => {
      const scheduleId = url.searchParams.get('schedule_id')
      return reports.list({ ...scheduleId === null ? {} : { schedule_id: scheduleId }, limit: intParam(url, 'limit', 50, 200), offset: intParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER) })
    }),
    route('/api/insights/report', ['GET'], (_request, url) => ({ data: reports.get(url.searchParams.get('id')) })),
    route('/api/insights/rules', ['GET', 'POST'], async request => {
      if (request.method === 'GET') return { data: alerts.listRules(), limits }
      const body = await readBody(request)
      return { data: await alerts.createRule(body, { createdBy: 'person', signal: request.signal }) }
    }),
    route('/api/insights/rule-update', ['POST'], async request => {
      const { id, ...changes } = await readBody(request)
      return { data: await alerts.updateRule(id, changes, request.signal) }
    }),
    route('/api/insights/rule-delete', ['POST'], async request => {
      const body = await readBody(request)
      return { data: await alerts.deleteRule(body.id) }
    }),
    route('/api/insights/evaluate', ['POST'], async request => {
      const body = await readBody(request)
      const summary = await alerts.evaluateRule(body.id, request.signal)
      return { data: { summary, rule: alerts.getRule(body.id) } }
    }),
    route('/api/insights/firings', ['GET'], (_request, url) => {
      const ruleId = url.searchParams.get('rule_id')
      return alerts.listFirings({
        limit: intParam(url, 'limit', 50, 200), offset: intParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER),
        unread_only: url.searchParams.get('unread_only') === '1', ...ruleId === null ? {} : { rule_id: ruleId },
      })
    }),
    route('/api/insights/unread', ['GET'], () => ({ unread: alerts.unreadCount() })),
    route('/api/insights/read', ['POST'], async request => {
      const body = await readBody(request)
      if (body.ids !== undefined && !(Array.isArray(body.ids) && body.ids.every(id => typeof id === 'string'))) throw new InsightsError(400, 'invalid_request', 'ids must be an array of firing ids')
      return { data: await alerts.markRead(body.ids) }
    }),
    route('/api/insights/investigate', ['POST'], async request => {
      const body = await readBody(request)
      return { data: await investigate(body.firing_id) }
    }),
    route('/api/insights/schedules', ['GET'], async () => ({ data: await schedules.list() })),
    route('/api/insights/schedule-update', ['POST'], async request => {
      const body = await readBody(request)
      return { data: await schedules.setActive(body.id, body.active) }
    }),
  ]
}

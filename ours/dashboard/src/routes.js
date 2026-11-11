/**
 * Browser routes for the dashboard store, exact paths on the shared API
 * channel (owner cookie required). Errors: `{"error": {code, status, message, details}}`.
 * Draft calls carry the browser's owner id in `x-ours-draft-owner`.
 *
 *   GET  /api/dashboard/list                       visible dashboards, home, runtime settings
 *   GET  /api/dashboard/get?id=&view=published|draft
 *   GET  /api/dashboard/versions?id=
 *   POST /api/dashboard/draft     {id, spec?}      create or replace this browser's draft
 *   POST /api/dashboard/discard   {id}
 *   POST /api/dashboard/publish   {id, force?}     409 base_changed when someone published first
 *   POST /api/dashboard/revert    {id, version, expected?}
 *   POST /api/dashboard/home      {id}
 *   GET  /api/dashboard/widgets                    module versions in the store
 *   POST /api/dashboard/widgets   {type, version, source, description?}
 *   GET  /api/dashboard/widget-module?type=&version=   the ES module source
 *   POST /api/dashboard/edit      {id}             open the edit Session on this browser's draft (the draft is created from the published version when absent; the Session already editing it is reused)
 *   GET  /api/dashboard/editor?session=&fresh=1    the draft an edit Session edits (this browser's only), its unverified analyses and saved analyses; `fresh=1` rechecks the analyses now
 */
import { StoreError } from './store.js'

export const OWNER_HEADER = 'x-ours-draft-owner'

function errorResponse(error) {
  if (error instanceof StoreError) {
    return Response.json({ error: { code: error.code, status: error.status, message: error.message, details: error.details } }, { status: error.status })
  }
  return Response.json({ error: { code: 'internal', status: 500, message: String(error?.message ?? error), details: null } }, { status: 500 })
}

async function readBody(request) {
  const text = await request.text()
  if (text === '') return {}
  let value
  try { value = JSON.parse(text) } catch { throw new StoreError(400, 'invalid_request', 'body must be JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StoreError(400, 'invalid_request', 'body must be a JSON object')
  return value
}

function onlyKeys(body, allowed) {
  const extra = Object.keys(body).filter(key => !allowed.includes(key))
  if (extra.length > 0) throw new StoreError(400, 'invalid_request', `unknown field(s): ${extra.join(', ')}`)
}

const owner = request => request.headers.get(OWNER_HEADER) ?? undefined

const GATE_KEEP_MS = 15_000

/**
 * @param {import('./store.js').DashboardStore} store
 * @param {object} runtime - settings the browser runtime reads from /list (e.g. `{ deadline_s }`).
 * @param {object} [editing] - edit Sessions; absent leaves /edit and /editor answering 503.
 * @param {(id: string, owner: string) => Promise<object>} editing.openEditor
 * @param {(spec: object, signal?: AbortSignal) => Promise<object[]>} editing.gate - unverified analyses of a spec.
 */
export function dashboardRoutes(store, runtime = {}, editing = undefined) {
  const needEditing = () => {
    if (editing === undefined) throw new StoreError(503, 'editing_unavailable', 'dashboard editing is not configured on this server')
    return editing
  }
  const route = (path, methods, handler) => ({
    path, methods, requestBody: 'buffered',
    async fetch(request) {
      try {
        const result = await handler(request, new URL(request.url))
        return result instanceof Response ? result : Response.json(result)
      } catch (error) {
        return errorResponse(error)
      }
    },
  })
  // The edit panel polls this route about once a second while it is on screen; the gate asks
  // Auto-ontology once per analysis, so its answer for one draft revision is kept for a short
  // time. `fresh=1` (sent after the person verifies an analysis) and publishing bypass it.
  const gateResults = new Map()
  const cachedGate = async (sessionId, draft, fresh, signal) => {
    const kept = gateResults.get(sessionId)
    if (!fresh && kept !== undefined && kept.stamp === draft.updated_at && Date.now() - kept.at < GATE_KEEP_MS) return kept.value
    const value = await needEditing().gate(draft.spec, signal)
    gateResults.set(sessionId, { stamp: draft.updated_at, at: Date.now(), value })
    if (gateResults.size > 200) gateResults.delete(gateResults.keys().next().value)
    return value
  }
  return [
    route('/api/dashboard/list', ['GET'], request => ({ ...store.list(owner(request)), runtime })),
    route('/api/dashboard/get', ['GET'], (request, url) => ({ data: store.get(url.searchParams.get('id'), { view: url.searchParams.get('view') ?? 'published', owner: owner(request) }) })),
    route('/api/dashboard/versions', ['GET'], (request, url) => ({ data: store.versionsOf(url.searchParams.get('id')) })),
    route('/api/dashboard/draft', ['POST'], async request => {
      const body = await readBody(request)
      onlyKeys(body, ['id', 'spec'])
      return { data: await store.saveDraft(body.id, owner(request), body.spec) }
    }),
    route('/api/dashboard/discard', ['POST'], async request => {
      const body = await readBody(request)
      onlyKeys(body, ['id'])
      return { data: await store.discardDraft(body.id, owner(request)) }
    }),
    route('/api/dashboard/publish', ['POST'], async request => {
      const body = await readBody(request)
      onlyKeys(body, ['id', 'force'])
      if (body.force !== undefined && typeof body.force !== 'boolean') throw new StoreError(400, 'invalid_request', 'force must be a boolean')
      return { data: await store.publish(body.id, owner(request), { force: body.force === true }) }
    }),
    route('/api/dashboard/revert', ['POST'], async request => {
      const body = await readBody(request)
      onlyKeys(body, ['id', 'version', 'expected'])
      return { data: await store.revert(body.id, body.version, { expected: body.expected }) }
    }),
    route('/api/dashboard/home', ['POST'], async request => {
      const body = await readBody(request)
      onlyKeys(body, ['id'])
      return { data: await store.setHome(body.id) }
    }),
    route('/api/dashboard/widgets', ['GET', 'POST'], async request => {
      if (request.method === 'GET') return { data: store.listWidgets() }
      const body = await readBody(request)
      onlyKeys(body, ['type', 'version', 'source', 'description'])
      // Modules added over HTTP are never trusted to run in the page.
      return { data: await store.putWidget({ ...body, origin: 'generated' }) }
    }),
    route('/api/dashboard/widget-module', ['GET'], (request, url) => {
      const version = Number(url.searchParams.get('version'))
      const entry = store.widget(url.searchParams.get('type') ?? '', version)
      if (entry === undefined) throw new StoreError(404, 'not_found', 'no such widget module version')
      return new Response(entry.source, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          // Versions are immutable; the digest pins the content.
          'cache-control': 'private, max-age=31536000, immutable',
          etag: `"${entry.sha256}"`,
          'x-content-type-options': 'nosniff',
          'x-ours-widget-origin': entry.origin ?? 'generated',
        },
      })
    }),
    route('/api/dashboard/edit', ['POST'], async request => {
      const body = await readBody(request)
      onlyKeys(body, ['id'])
      return { data: await needEditing().openEditor(body.id, owner(request)) }
    }),
    route('/api/dashboard/editor', ['GET'], async (request, url) => {
      const binding = store.editor(url.searchParams.get('session') ?? '')
      // Another browser's edit Session reads as absent: its draft is not visible here.
      if (binding === undefined || binding.owner !== owner(request)) throw new StoreError(404, 'not_found', 'not an edit session of this browser')
      let draft = null
      try { draft = store.get(binding.dashboard_id, { view: 'draft', owner: binding.owner }) } catch (error) {
        if (!(error instanceof StoreError && error.status === 404)) throw error
      }
      const unverified = draft === null ? [] : await cachedGate(binding.session_id, draft, url.searchParams.get('fresh') === '1', request.signal)
      return { data: { session_id: binding.session_id, dashboard_id: binding.dashboard_id, created_at: binding.created_at, saved_analyses: binding.analyses, draft, unverified_analyses: unverified } }
    }),
  ]
}

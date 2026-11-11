/**
 * Browser routes of the data map, exact paths on the shared API channel
 * (owner cookie required). Errors: `{"error": {code, status, message}}`.
 *
 *   GET /api/ontology-map/graph?refresh=1   the map (cached `cacheTtlS`; refresh=1 reads again)
 *   GET /api/ontology-map/entity?id=        one entity's side panel
 *
 * When reading the map again fails and an earlier map is cached, the graph
 * route answers that map with `stale: {code, failed_at}` instead of an error.
 */
import { MapError, loadEntity, loadMap } from './map.js'

function errorResponse(error) {
  if (error instanceof MapError) {
    return Response.json({ error: { code: error.code, status: error.status, message: error.message } }, { status: error.status })
  }
  return Response.json({ error: { code: 'internal', status: 500, message: String(error?.message ?? error) } }, { status: 500 })
}

/**
 * @param {object} deps
 * @param {object} deps.connector - `ctx.aoConnector`.
 * @param {number} deps.cacheTtlS - seconds a read map is reused.
 * @param {number} deps.maxEntities
 * @param {number} deps.mainCount
 * @param {() => number} [deps.clock] - milliseconds.
 * @returns {Array<object>} route objects for `ctx.connection.fetch.register`.
 */
export function ontologyMapRoutes({ connector, cacheTtlS, maxEntities, mainCount, clock = Date.now }) {
  let cached = null
  let cachedAt = 0
  let inflight = null

  async function readMap(refresh) {
    if (!refresh && cached !== null && clock() - cachedAt < cacheTtlS * 1000) return cached
    // One read at a time; concurrent requests share it.
    inflight ??= loadMap(connector, { maxEntities, mainCount, now: () => new Date(clock()) })
      .then(map => { cached = map; cachedAt = clock(); return map })
      .finally(() => { inflight = null })
    try {
      return await inflight
    } catch (error) {
      if (cached === null || !(error instanceof MapError)) throw error
      return { ...cached, stale: { code: error.code, failed_at: new Date(clock()).toISOString() } }
    }
  }

  const route = (path, handler) => ({
    path, methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try {
        return Response.json(await handler(new URL(request.url), request))
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  return [
    route('/api/ontology-map/graph', async url => ({ data: await readMap(url.searchParams.get('refresh') === '1') })),
    route('/api/ontology-map/entity', async (url, request) => {
      const map = await readMap(false)
      return { data: await loadEntity(connector, url.searchParams.get('id'), map, { signal: request.signal }) }
    }),
  ]
}

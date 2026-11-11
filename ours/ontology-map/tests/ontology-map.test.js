import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { forceLayout } from '../src/layout.js'
import { cleanText, loadEntity, loadMap, MapError, summaryOf } from '../src/map.js'
import { ontologyMapRoutes } from '../src/routes.js'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORDER = id(1); const CUSTOMER = id(2); const STORE = id(3); const TOKEN = id(4)
const T_ORDERS = id(101); const T_CUSTOMERS = id(102)

/** Fake `ctx.aoConnector` answering the gateway paths the map reads. */
function fakeConnector({ graphFails = false, analysesFail = false, calls = [] } = {}) {
  const ok = body => ({ ok: true, status: 200, body })
  const routes = {
    '/api/exploration/semantic-graph': () => graphFails
      ? { ok: false, error: { status: 0, code: 'unreachable', message: 'gateway unreachable: ECONNREFUSED' } }
      : ok({ data: {
        nodes: [
          { id: ORDER, name: '주문', description: '고객이 넣은 주문입니다. 결제와 배송 상태를 담습니다.', synonyms: ['Order', 'orders'], column_attributes_count: 4 },
          { id: CUSTOMER, name: '고객', description: '가입한 고객', synonyms: ['Customer'], column_attributes_count: 2 },
          { id: STORE, name: '매장', description: null, synonyms: [], column_attributes_count: 0 },
          { id: TOKEN, name: '로그인 토큰', description: '로그인 토큰 — samples: abc, def', synonyms: [], column_attributes_count: 1 },
          { id: 'not-a-uuid', name: 'x' },
        ],
        links: [
          { source: ORDER, target: CUSTOMER, relationship_types: ['SEMANTIC_FK'] },
          { source: CUSTOMER, target: ORDER, relationship_types: ['SEMANTIC_FK'] },
          { source: ORDER, target: STORE, relationship_types: ['HAS_ATTRIBUTE'] },
          { source: ORDER, target: 'not-a-uuid', relationship_types: [] },
        ],
      } }),
    [`/api/exploration/tables/${T_ORDERS}/details`]: () => ok({ data: { terms: [
      { id: ORDER, relationship_types: ['HAS_ATTRIBUTE', 'REPRESENTS'] },
      { id: CUSTOMER, relationship_types: ['SEMANTIC_FK'] },
    ] } }),
    [`/api/exploration/tables/${T_CUSTOMERS}/details`]: () => ok({ data: { terms: [{ id: CUSTOMER, relationship_types: ['REPRESENTS'] }] } }),
    [`/api/terms/${ORDER}`]: () => ok({ data: { id: ORDER, name: '주문', description: '고객이 넣은 주문입니다. 결제와 배송 상태를 담습니다.', tables: [{ id: T_ORDERS, name: 'orders' }], schema_names: ['shop'], related_terms: [] } }),
    [`/api/terms/${ORDER}/column-attributes`]: () => ok({ data: [
      { name: '생성일', description: '생성일', source_column: 'created_at', primary_column: { table_name: 'orders' } },
      { name: '주문 상태', description: '주문의 진행 상태 — samples: PAID, SHIPPED', source_column: 'status', sample_values: ['PAID'], primary_column: { table_name: 'orders' } },
      { name: '금액', description: '결제 금액(원)', source_column: 'amount', primary_column: { table_name: 'orders' } },
      { name: '메모', description: '메모', source_column: 'memo', primary_column: { table_name: 'orders' } },
    ], total: 4 }),
  }
  return {
    client: {
      async request(method, path, options) {
        calls.push({ method, path, query: options?.query })
        assert.equal(method, 'GET')
        const handler = routes[path]
        return handler ? handler() : { ok: false, error: { status: 404, code: 'not_found', message: path } }
      },
    },
    async listAnalyses() {
      calls.push({ method: 'GET', path: '/api/saved-analyses' })
      if (analysesFail) return { ok: false, error: { status: 403, code: 'forbidden', message: 'no' } }
      return { ok: true, data: [
        { id: 'a1', name: '월별 주문 수', latest_verified_version: 2 },
        { id: 'a2', name: '고객별 주문 금액', latest_verified_version: 1 },
        { id: 'a3', name: '초안 분석', latest_verified_version: null },
      ] }
    },
    async getAnalysis(analysisId, { version }) {
      calls.push({ method: 'GET', path: `/api/saved-analyses/${analysisId}`, query: { version } })
      const tables = analysisId === 'a1' ? [{ table_id: T_ORDERS }] : [{ table_id: T_ORDERS }, { table_id: T_CUSTOMERS }]
      return { ok: true, data: { version: { version, tables } } }
    },
  }
}

describe('layout', () => {
  test('is deterministic and keeps nodes apart', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` }))
    const links = nodes.slice(1).map((n, i) => ({ source: `n${i % 4}`, target: n.id }))
    const a = forceLayout(nodes, links)
    assert.deepEqual(a, forceLayout(nodes, links))
    const points = Object.values(a)
    let closest = Infinity
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) closest = Math.min(closest, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]))
    assert.ok(closest > 30, `closest pair ${closest}`)
    assert.deepEqual(forceLayout([], []), {})
  })
})

describe('wording', () => {
  test('drops catalog sample values and keeps the first sentence', () => {
    assert.equal(cleanText('주문 상태 — samples: PAID, SHIPPED'), '주문 상태')
    assert.equal(cleanText('  '), null)
    assert.equal(summaryOf('고객이 넣은 주문입니다. 결제와 배송 상태를 담습니다.'), '고객이 넣은 주문입니다.')
    assert.equal(summaryOf('가'.repeat(80), 10).length, 10)
  })
})

describe('loadMap', () => {
  test('reads terms, links and confirmed analyses with GET only', async () => {
    const calls = []
    const map = await loadMap(fakeConnector({ calls }), { maxEntities: 500, mainCount: 2, now: () => new Date('2026-11-11T08:00:00Z') })
    assert.ok(calls.every(c => c.method === 'GET'))
    assert.deepEqual(calls[0], { method: 'GET', path: '/api/exploration/semantic-graph', query: { limit: 500 } })
    assert.deepEqual(map.entities.map(e => e.name), ['주문', '고객', '매장', '로그인 토큰'])
    assert.equal(map.links.length, 2, 'duplicate and dangling links dropped')
    const order = map.entities[0]
    assert.deepEqual(order.analyses.map(a => a.name), ['고객별 주문 금액', '월별 주문 수'])
    // 고객 is linked to a2 through customers (REPRESENTS), not to a1 through the orders foreign key.
    assert.deepEqual(map.entities[1].analyses.map(a => a.id), ['a2'])
    assert.equal(order.summary, '고객이 넣은 주문입니다.')
    assert.equal(map.entities.find(e => e.id === TOKEN).summary, '로그인 토큰')
    assert.deepEqual(map.entities.filter(e => e.main).map(e => e.name), ['주문', '고객'])
    assert.deepEqual(Object.keys(map.layouts.main).sort(), [ORDER, CUSTOMER].sort())
    assert.equal(Object.keys(map.layouts.all).length, 4)
    assert.deepEqual(map.counts, { entities: 4, links: 2, main: 2, analyses: 2 })
    assert.equal(map.read_at, '2026-11-11T08:00:00.000Z')
    assert.deepEqual(map.notices, [])
    assert.ok(!calls.some(c => c.path.includes('a3')), 'unverified analyses are not read')
  })

  test('still draws the map when analyses cannot be read', async () => {
    const map = await loadMap(fakeConnector({ analysesFail: true }), { maxEntities: 500, mainCount: 12 })
    assert.equal(map.entities.length, 4)
    assert.deepEqual(map.notices, [{ code: 'analyses_unavailable', cause: 'forbidden' }])
  })

  test('fails with the connector code when the graph cannot be read', async () => {
    await assert.rejects(loadMap(fakeConnector({ graphFails: true }), { maxEntities: 500, mainCount: 12 }), e => e instanceof MapError && e.code === 'unreachable' && e.status === 502)
  })
})

describe('loadEntity', () => {
  test('orders fields, hides sample values and lists links and analyses from the map', async () => {
    const connector = fakeConnector()
    const map = await loadMap(connector, { maxEntities: 500, mainCount: 12 })
    const entity = await loadEntity(connector, ORDER, map)
    assert.equal(entity.name, '주문')
    assert.deepEqual(entity.fields.map(f => f.name), ['주문 상태', '금액', '메모', '생성일'])
    assert.equal(entity.fields[0].meaning, '주문의 진행 상태')
    assert.equal(entity.fields[2].meaning, null, 'a meaning equal to the name is dropped')
    assert.equal(entity.fields[3].bookkeeping, true)
    assert.ok(!JSON.stringify(entity).includes('PAID'))
    assert.deepEqual(entity.connected.map(c => c.name), ['고객', '매장'])
    assert.deepEqual(entity.analyses.map(a => a.name), ['고객별 주문 금액', '월별 주문 수'])
    assert.deepEqual(entity.questions, [])
    assert.deepEqual(entity.source, { tables: ['orders'], schemas: ['shop'] })
  })

  test('rejects an id that is not an entity id', async () => {
    await assert.rejects(loadEntity(fakeConnector(), '../x', null), e => e.status === 400)
  })
})

describe('routes', () => {
  const get = (route, query = '') => route.fetch(new Request(`http://h${route.path}${query}`)).then(async r => ({ status: r.status, body: await r.json() }))

  test('caches the map, reads again on refresh, and serves the last map when the gateway is down', async () => {
    let now = 0
    const calls = []
    const connector = fakeConnector({ calls })
    const [graph, entity] = ontologyMapRoutes({ connector, cacheTtlS: 300, maxEntities: 500, mainCount: 12, clock: () => now })
    assert.equal((await get(graph)).body.data.entities.length, 4)
    const reads = () => calls.filter(c => c.path === '/api/exploration/semantic-graph').length
    await get(graph)
    assert.equal(reads(), 1)
    now = 301_000
    await get(graph)
    assert.equal(reads(), 2)
    connector.client.request = async () => ({ ok: false, error: { status: 0, code: 'unreachable', message: 'down' } })
    const stale = await get(graph, '?refresh=1')
    assert.equal(stale.status, 200)
    assert.equal(stale.body.data.stale.code, 'unreachable')
    const failed = await get(entity, `?id=${ORDER}`)
    assert.equal(failed.status, 502)
    assert.equal(failed.body.error.code, 'unreachable')
  })

  test('answers a human-readable error code without a cached map', async () => {
    const [graph] = ontologyMapRoutes({ connector: fakeConnector({ graphFails: true }), cacheTtlS: 300, maxEntities: 500, mainCount: 12 })
    const result = await get(graph)
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'unreachable')
  })
})

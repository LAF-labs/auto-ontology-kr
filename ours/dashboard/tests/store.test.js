import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisIds, validateSpec, widgetRefs, widgetTiming } from '../src/spec.js'
import { DashboardStore, memoryDomain } from '../src/store.js'
import { dashboardRoutes, OWNER_HEADER } from '../src/routes.js'

const A = 'owner-aaaaaaaa'
const B = 'owner-bbbbbbbb'

function spec(overrides = {}) {
  return {
    format: 1,
    title: 'Sales',
    widgets: [
      { id: 'total', type: 'number-tile', type_version: 1, layout: { x: 0, y: 0, w: 3, h: 2 }, source: { analysis_id: 'an-2' } },
      { id: 'trend', type: 'line-chart', type_version: 1, layout: { x: 3, y: 0, w: 9, h: 3 }, source: { analysis_id: 'an-1', params: { top_n: 3, statuses: ['A', 'B'] } }, options: { x: 'month' } },
      { id: 'again', type: 'table', type_version: 1, layout: { x: 0, y: 3, w: 12, h: 3 }, source: { analysis_id: 'an-2' }, refresh_s: 60 },
    ],
    ...overrides,
  }
}

async function storeWithWidgets() {
  const store = new DashboardStore(memoryDomain())
  for (const type of ['number-tile', 'line-chart', 'table']) await store.putWidget({ type, version: 1, source: `export default {}//${type}` })
  return store
}

describe('spec', () => {
  test('valid spec and derived facts', () => {
    assert.equal(validateSpec(spec()).ok, true)
    assert.deepEqual(analysisIds(spec()), ['an-1', 'an-2'])
    assert.deepEqual(widgetRefs(spec()), ['line-chart@1', 'number-tile@1', 'table@1'])
    assert.deepEqual(widgetTiming(spec(), spec().widgets[2]), { refreshS: 60, maxAgeS: 60 })
    assert.deepEqual(widgetTiming({ ...spec(), refresh_s: 600, max_age_s: 120 }, spec().widgets[0]), { refreshS: 600, maxAgeS: 120 })
  })

  test('rejections', () => {
    const problems = s => validateSpec(s).problems?.map(p => p.path) ?? []
    assert.deepEqual(problems({ ...spec(), format: 2 }), ['$.format'])
    assert.deepEqual(problems({ ...spec(), extra: 1 }), ['$.extra'])
    assert.deepEqual(problems({ ...spec(), widgets: [] }), ['$.widgets'])
    const overlap = spec(); overlap.widgets[1].layout = { x: 2, y: 1, w: 3, h: 1 }
    assert.deepEqual(problems(overlap), ['$.widgets[1].layout'])
    const wide = spec(); wide.widgets[0].layout = { x: 10, y: 0, w: 3, h: 1 }
    assert.deepEqual(problems(wide), ['$.widgets[0].layout'])
    const dup = spec(); dup.widgets[1].id = 'total'
    assert.deepEqual(problems(dup), ['$.widgets[1].id'])
    const sql = spec(); sql.widgets[0].options = { nested: { SQL: 'SELECT 1' } }
    assert.deepEqual(problems(sql), ['$.widgets[0].options.nested.SQL'])
    const sourceSql = spec(); sourceSql.widgets[0].source.sql = 'SELECT 1'
    assert.deepEqual(problems(sourceSql), ['$.widgets[0].source.sql'])
    const params = spec(); params.widgets[0].source.params = { x: { y: 1 } }
    assert.deepEqual(problems(params), ['$.widgets[0].source.params.x'])
    assert.deepEqual(validateSpec(spec(), { hasWidget: type => type !== 'table' }).problems.map(p => p.path), ['$.widgets[2].type'])
  })
})

describe('store', () => {
  test('drafts are per owner; publish makes a shared version', async () => {
    const store = await storeWithWidgets()
    await store.saveDraft('sales', A, spec())
    assert.deepEqual(store.list(A).data.map(d => [d.id, d.has_draft, d.published_version]), [['sales', true, null]])
    assert.deepEqual(store.list(B).data, [])
    assert.throws(() => store.get('sales', { view: 'draft', owner: B }), { code: 'not_found' })
    assert.throws(() => store.get('sales'), { code: 'not_found' })
    const published = await store.publish('sales', A)
    assert.equal(published.version, 1)
    assert.equal(store.get('sales').spec.title, 'Sales')
    assert.deepEqual(store.list(B).data.map(d => [d.id, d.has_draft, d.published_version]), [['sales', false, 1]])
    assert.throws(() => store.get('sales', { view: 'draft', owner: A }), { code: 'not_found' })
  })

  test('second publisher from the same base gets base_changed; force overrides', async () => {
    const store = await storeWithWidgets()
    await store.saveDraft('sales', A, spec())
    await store.publish('sales', A)
    await store.saveDraft('sales', A)
    await store.saveDraft('sales', B)
    await store.saveDraft('sales', A, spec({ title: 'A edit' }))
    await store.saveDraft('sales', B, spec({ title: 'B edit' }))
    const [first, second] = await Promise.allSettled([store.publish('sales', A), store.publish('sales', B)])
    assert.equal(first.value.version, 2)
    assert.equal(second.reason.code, 'base_changed')
    assert.deepEqual(second.reason.details, { base_version: 1, published_version: 2, published_at: first.value.published_at })
    assert.equal(store.get('sales').spec.title, 'A edit')
    const forced = await store.publish('sales', B, { force: true })
    assert.equal(forced.version, 3)
    assert.equal(store.versionsOf('sales').history.at(-1).forced, true)
  })

  test('revert moves the pointer and guards with expected', async () => {
    const store = await storeWithWidgets()
    await store.saveDraft('sales', A, spec())
    await store.publish('sales', A)
    await store.saveDraft('sales', A, spec({ title: 'v2' }))
    await store.publish('sales', A)
    await assert.rejects(store.revert('sales', 1, { expected: 1 }), { code: 'base_changed' })
    await store.revert('sales', 1, { expected: 2 })
    assert.equal(store.get('sales').spec.title, 'Sales')
    assert.equal(store.get('sales').version, 1)
    assert.deepEqual(store.versionsOf('sales').versions.map(v => v.version), [2, 1])
    await assert.rejects(store.revert('sales', 9), { code: 'not_found' })
    await store.saveDraft('sales', A)
    assert.equal(store.get('sales', { view: 'draft', owner: A }).base_version, 1)
  })

  test('invalid specs and unknown widget modules are refused at save', async () => {
    const store = await storeWithWidgets()
    await assert.rejects(store.saveDraft('sales', A, { format: 1 }), { code: 'invalid_spec' })
    await assert.rejects(store.saveDraft('sales', A, spec({ widgets: [{ ...spec().widgets[0], type_version: 2 }] })), { code: 'invalid_spec' })
    await assert.rejects(store.saveDraft('Bad Id', A, spec()), { code: 'invalid_request' })
    await assert.rejects(store.saveDraft('sales', 'short', spec()), { code: 'invalid_request' })
    assert.equal(store.list(A).data.length, 0)
  })

  test('widget modules are immutable', async () => {
    const store = await storeWithWidgets()
    assert.equal((await store.putWidget({ type: 'table', version: 1, source: 'export default {}//table' })).created, false)
    await assert.rejects(store.putWidget({ type: 'table', version: 1, source: 'changed' }), { code: 'widget_exists' })
    assert.equal((await store.putWidget({ type: 'table', version: 2, source: 'changed' })).created, true)
  })

  test('home must be published', async () => {
    const store = await storeWithWidgets()
    await store.saveDraft('sales', A, spec())
    await assert.rejects(store.setHome('sales'), { code: 'not_found' })
    await store.publish('sales', A)
    await store.setHome('sales')
    assert.equal(store.list(B).home, 'sales')
  })
})

describe('routes', () => {
  test('owner header, errors and module serving', async () => {
    const store = await storeWithWidgets()
    const routes = Object.fromEntries(dashboardRoutes(store, { deadline_s: 90 }).map(r => [r.path, r]))
    const call = (path, { method = 'GET', body, owner } = {}) => routes[path.split('?')[0]].fetch(new Request(`http://h${path}`, {
      method, headers: { ...owner === undefined ? {} : { [OWNER_HEADER]: owner }, 'content-type': 'application/json' }, ...body === undefined ? {} : { body: JSON.stringify(body) },
    }))
    let response = await call('/api/dashboard/draft', { method: 'POST', body: { id: 'sales', spec: spec() } })
    assert.equal(response.status, 400)
    response = await call('/api/dashboard/draft', { method: 'POST', body: { id: 'sales', spec: { format: 1 } }, owner: A })
    assert.equal(response.status, 422)
    assert.equal((await response.json()).error.code, 'invalid_spec')
    assert.equal((await call('/api/dashboard/draft', { method: 'POST', body: { id: 'sales', spec: spec() }, owner: A })).status, 200)
    assert.equal((await call('/api/dashboard/publish', { method: 'POST', body: { id: 'sales', bogus: 1 }, owner: A })).status, 400)
    assert.equal((await call('/api/dashboard/publish', { method: 'POST', body: { id: 'sales' }, owner: A })).status, 200)
    const list = await (await call('/api/dashboard/list', { owner: B })).json()
    assert.deepEqual(list.runtime, { deadline_s: 90 })
    assert.equal(list.data[0].published_version, 1)
    const module = await call('/api/dashboard/widget-module?type=table&version=1')
    assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(await module.text(), 'export default {}//table')
    assert.equal((await call('/api/dashboard/widget-module?type=table&version=7')).status, 404)
  })
})

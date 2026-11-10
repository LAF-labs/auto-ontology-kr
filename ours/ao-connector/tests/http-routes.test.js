import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { AoClient } from '../src/client.js'
import { aoRoutes } from '../src/http-routes.js'
import { startFakeAo } from './fake-ao.js'

let fake
let routes
let tokenValue = 'route-token'
before(async () => {
  fake = await startFakeAo({ token: 'route-token' })
  routes = Object.fromEntries(aoRoutes(new AoClient({ baseUrl: fake.url, token: async () => tokenValue })).map(route => [route.path, route]))
})
after(() => fake.close())

async function call(path, init = {}) {
  const response = await routes[path.split('?')[0]].fetch(new Request(`http://127.0.0.1:3180${path}`, init))
  return { status: response.status, body: await response.json() }
}
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('routes are exact /api/ao paths', () => {
  assert.deepEqual(Object.keys(routes).sort(), ['/api/ao/analyses', '/api/ao/analysis', '/api/ao/run', '/api/ao/run-batch', '/api/ao/verify'])
})

test('list, get, run, batch', async () => {
  const list = await call('/api/ao/analyses?status=verified&limit=2')
  assert.equal(list.status, 200)
  assert.equal(list.body.count, 2)
  assert.equal(list.body.total, 8)
  assert.deepEqual(fake.requests.at(-1).query, { status: 'verified' })
  const one = await call('/api/ao/analysis?id=a-ok&version=1')
  assert.equal(one.body.data.id, 'a-ok')
  const run = await call('/api/ao/run', post({ analysis_id: 'a-ok', params: { start_date: '2026-01-01' } }))
  assert.equal(run.status, 200)
  assert.deepEqual(run.body.data.rows, [[1234]])
  const batch = await call('/api/ao/run-batch', post({ items: [{ key: 'w1', analysis_id: 'a-ok' }, { key: 'w2', analysis_id: 'a-timeout' }] }))
  assert.equal(batch.status, 200)
  assert.deepEqual(batch.body.data.w1.data.rows, [[1234]])
  assert.equal(batch.body.data.w2.error.code, 'timeout')
  assert.deepEqual(batch.body.data.w2.error.last_success.rows, [[1200]])
})

test('contract errors keep status and body', async () => {
  const guard = await call('/api/ao/run', post({ analysis_id: 'a-guard' }))
  assert.equal(guard.status, 422)
  assert.deepEqual(guard.body.error, { code: 'forbidden_statement', status: 422, message: 'statement is not allowed', details: { statement: 'DELETE' }, last_success: null })
  const busy = await call('/api/ao/run', post({ analysis_id: 'a-busy' }))
  assert.equal(busy.status, 429)
  const timeout = await call('/api/ao/run', post({ analysis_id: 'a-timeout' }))
  assert.equal(timeout.status, 504)
  assert.equal(timeout.body.error.last_success.executed_at, '2026-11-10T06:12:03Z')
})

test('upstream auth failures are 502, not the browser 401', async () => {
  tokenValue = 'wrong'
  const wrong = await call('/api/ao/analyses')
  assert.equal(wrong.status, 502)
  assert.equal(wrong.body.error.code, 'upstream_unauthorized')
  tokenValue = undefined
  const missing = await call('/api/ao/analyses')
  assert.equal(missing.status, 503)
  assert.equal(missing.body.error.code, 'missing_token')
  tokenValue = 'route-token'
})

test('malformed browser requests are 400', async () => {
  assert.equal((await call('/api/ao/run', post({}))).status, 400)
  assert.equal((await call('/api/ao/run', { method: 'POST', body: '{not json' })).status, 400)
  assert.equal((await call('/api/ao/run', post({ analysis_id: 'a-ok', typo: 1 }))).body.error.code, 'invalid_request')
  assert.equal((await call('/api/ao/run-batch', post({ items: [], extra: 1 }))).status, 400)
  assert.equal((await call('/api/ao/analysis')).status, 400)
  assert.equal((await call('/api/ao/analyses?limit=-1')).status, 400)
})

test('verify uses the reviewer token and refuses unknown fields', async () => {
  const noEditor = await call('/api/ao/verify', post({ analysis_id: 'a-draft', version: 1 }))
  assert.equal(noEditor.status, 503)
  assert.equal(noEditor.body.error.code, 'missing_token')
  const editorRoutes = Object.fromEntries(aoRoutes(new AoClient({ baseUrl: fake.url, token: async () => tokenValue, reviewerToken: async () => 'fake-reviewer-token' })).map(route => [route.path, route]))
  const verify = body => editorRoutes['/api/ao/verify'].fetch(new Request('http://127.0.0.1:3180/api/ao/verify', post(body)))
  assert.equal((await verify({ analysis_id: 'a-draft', version: 1, publish: true })).status, 400)
  const ok = await verify({ analysis_id: 'a-draft', version: 1, note: 'checked' })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).data.latest_verified_version, 1)
  const again = await verify({ analysis_id: 'a-draft', version: 1 })
  assert.equal(again.status, 409)
  assert.equal((await again.json()).error.code, 'invalid_status_transition')
})

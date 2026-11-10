import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { AoClient } from '../src/client.js'
import { startFakeAo } from './fake-ao.js'

const TOKEN = 'test-token'
let fake
let client
before(async () => {
  fake = await startFakeAo({ token: TOKEN })
  client = new AoClient({ baseUrl: fake.url, token: async () => TOKEN })
})
after(() => fake.close())

function clientWith(token, extra = {}) {
  return new AoClient({ baseUrl: fake.url, token: async () => token, ...extra })
}

describe('saved analyses', () => {
  test('list and get', async () => {
    const list = await client.listAnalyses({ query: 'approved' })
    assert.equal(list.ok, true)
    assert.deepEqual(list.data.map(a => a.id), ['a-ok', 'a-rows'])
    assert.equal(fake.requests.at(-1).query.query, 'approved')
    const one = await client.getAnalysis('a-ok', { version: 1 })
    assert.equal(one.ok, true)
    assert.equal(one.data.id, 'a-ok')
    assert.equal(fake.requests.at(-1).query.version, '1')
  })

  test('run returns contract data and cache fields', async () => {
    const params = { start_date: '2026-09-01' }
    const first = await client.runAnalysis('a-ok', { params })
    assert.equal(first.ok, true)
    assert.deepEqual(first.data.rows, [[1234]])
    assert.equal(first.data.cache.hit, false)
    assert.equal(first.data.columns[0].name, 'approved_count')
    const second = await client.runAnalysis('a-ok', { params })
    assert.equal(second.data.cache.hit, true)
    assert.equal(second.data.executed_at, first.data.executed_at)
    const fresh = await client.runAnalysis('a-ok', { params, max_age_s: 0 })
    assert.equal(fresh.data.cache.hit, false)
    assert.deepEqual(fake.requests.at(-1).body, { params, max_age_s: 0 })
    assert.equal(fake.requests.at(-1).hasKey, true)
  })

  test('contract errors pass through with details and last_success', async () => {
    const guard = await client.runAnalysis('a-guard')
    assert.deepEqual(guard.error, { status: 422, code: 'forbidden_statement', message: 'statement is not allowed', details: { statement: 'DELETE' }, last_success: null })
    const busy = await client.runAnalysis('a-busy')
    assert.equal(busy.error.status, 429)
    assert.equal(busy.error.code, 'busy')
    assert.deepEqual(busy.error.details, { database_name: 'example_db', waited_s: 10 })
    const timeout = await client.runAnalysis('a-timeout')
    assert.equal(timeout.error.status, 504)
    assert.equal(timeout.error.code, 'timeout')
    assert.deepEqual(timeout.error.last_success.rows, [[1200]])
    const draft = await client.runAnalysis('a-draft')
    assert.equal(draft.error.code, 'not_verified')
    assert.deepEqual(draft.error.details, { latest_version: 1 })
    const draftPinned = await client.runAnalysis('a-draft', { version: 1 })
    assert.equal(draftPinned.ok, true)
    const missing = await client.runAnalysis('nope')
    assert.equal(missing.error.code, 'not_found')
    const badParam = await client.runAnalysis('a-ok', { params: { extra: 1 } })
    assert.equal(badParam.error.code, 'invalid_params')
    assert.deepEqual(badParam.error.details, { params: { extra: 'is not a parameter of this analysis' } })
  })

  test('FastAPI body validation errors become request_invalid', async () => {
    const result = await client.request('POST', '/api/saved-analyses/a-ok/run', { body: { typo: 1 } })
    assert.equal(result.error.code, 'request_invalid')
    assert.equal(result.error.status, 422)
    assert.equal(result.error.details.detail[0].type, 'extra_forbidden')
  })

  test('invalid requests are refused before any network call', async () => {
    const before = fake.requests.length
    assert.equal((await client.runAnalysis('a-ok', { typo: 1 })).error.code, 'invalid_request')
    assert.equal((await client.runAnalysis('a-ok', { version: 0 })).error.code, 'invalid_request')
    assert.equal((await client.runAnalysis('')).error.code, 'invalid_request')
    assert.equal((await client.runBatch({ items: [] })).error.code, 'invalid_request')
    assert.equal((await client.runBatch({ items: [{ key: 'k', analysis_id: 'a-ok' }, { key: 'k', analysis_id: 'a-ok' }] })).error.code, 'invalid_request')
    assert.equal((await client.searchTerms('x')).error.code, 'invalid_request')
    assert.equal(fake.requests.length, before)
  })
})

describe('run-batch', () => {
  test('per-item data and errors, isolation, status by code', async () => {
    const result = await client.runBatch({
      items: [
        { key: 'w1', analysis_id: 'a-rows', params: { start_date: 'month_start(-1)' } },
        { key: 'w2', analysis_id: 'a-timeout' },
        { key: 'w3', analysis_id: 'a-guard' },
        { key: 'w4', analysis_id: 'a-busy', max_age_s: 0 },
      ],
      max_age_s: 3600,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.data.w1.data.rows, [[1], [2], [3]])
    assert.equal(result.data.w2.ok, false)
    assert.equal(result.data.w2.error.code, 'timeout')
    assert.equal(result.data.w2.error.status, 504)
    assert.deepEqual(result.data.w2.error.last_success.rows, [[1200]])
    assert.equal(result.data.w3.error.code, 'forbidden_statement')
    assert.equal(result.data.w3.error.status, 422)
    assert.equal(result.data.w4.error.code, 'busy')
    assert.equal(result.data.w4.error.status, 429)
    assert.deepEqual(fake.requests.at(-1).body.max_age_s, 3600)
  })
})

describe('agent endpoints', () => {
  test('search, coverage, ask', async () => {
    const search = await client.searchTerms('승인')
    assert.equal(search.ok, true)
    assert.equal(search.data[0].type, 'Term')
    assert.deepEqual(fake.requests.at(-1).body, { search_term: '승인' })
    const coverage = await client.questionCoverage('지난달 승인 건수')
    assert.equal(coverage.data.coverage, 0.8)
    const answer = await client.askQuestion('지난달 승인 건수', { target_db: 'example_db' })
    assert.equal(answer.ok, true)
    assert.equal(answer.data.response, '1,234건')
    assert.equal(answer.data.steps, 2)
    assert.equal(answer.data.rows.length, 3)
    assert.deepEqual(fake.requests.at(-1).body, { question: '지난달 승인 건수', target_db: 'example_db' })
    const failed = await client.askQuestion('fail')
    assert.equal(failed.error.code, 'ask_failed')
    assert.equal(failed.error.message, 'semantic layer missing')
    const busy = await client.askQuestion('busy')
    assert.equal(busy.error.code, 'gateway_error')
    assert.equal(busy.error.status, 409)
    assert.equal(busy.error.message, 'Conversation in progress')
  })
})

describe('authentication and transport', () => {
  test('missing token sends nothing', async () => {
    const before = fake.requests.length
    const result = await clientWith(undefined).listAnalyses()
    assert.equal(result.error.code, 'missing_token')
    assert.equal(result.error.status, 0)
    assert.equal((await clientWith('').runAnalysis('a-ok')).error.code, 'missing_token')
    assert.equal(fake.requests.length, before)
  })

  test('gateway 401 and 403 string errors', async () => {
    const wrong = await clientWith('wrong').listAnalyses()
    assert.deepEqual(wrong.error, { status: 401, code: 'unauthorized', message: 'Unauthorized', details: null, last_success: null })
    const forbidden = await clientWith('viewer-without-read').runAnalysis('a-ok')
    assert.equal(forbidden.error.status, 403)
    assert.equal(forbidden.error.code, 'forbidden')
  })

  test('unreachable gateway', async () => {
    const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
    const result = await new AoClient({ baseUrl: `http://127.0.0.1:${port}`, token: async () => TOKEN }).listAnalyses()
    assert.equal(result.error.code, 'unreachable')
  })

  test('connector deadline and caller cancellation', async () => {
    const timed = await clientWith(TOKEN, { requestTimeoutMs: 200 }).runAnalysis('a-slow')
    assert.equal(timed.error.code, 'connector_timeout')
    assert.deepEqual(timed.error.details, { timeout_ms: 200 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const cancelled = await client.runAnalysis('a-slow', {}, controller.signal)
    assert.equal(cancelled.error.code, 'cancelled')
  })

  test('baseUrl must be http(s)', () => {
    assert.throws(() => new AoClient({ baseUrl: 'file:///etc', token: async () => TOKEN }), /http\(s\)/)
  })
})

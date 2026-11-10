import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { AoClient } from '../src/client.js'
import { aoToolSpecs, TOOL_NAMES } from '../src/tool-specs.js'
import { startFakeAo } from './fake-ao.js'

let fake
let tools
before(async () => {
  fake = await startFakeAo({ token: 't' })
  tools = Object.fromEntries(aoToolSpecs(new AoClient({ baseUrl: fake.url, token: async () => 't' }), { maxRows: 2 }).map(spec => [spec.name, spec]))
})
after(() => fake.close())

const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])

test('every tool has a name in TOOL_NAMES and a DSL parameter schema', () => {
  assert.deepEqual(Object.keys(tools), [...TOOL_NAMES])
  for (const spec of Object.values(tools)) {
    assert.ok(spec.description.length > 20)
    for (const [key, property] of Object.entries(spec.parameters)) {
      assert.ok(VALUE_TYPES.has(property.type), `${spec.name}.${key}`)
      if (property.type === 'object') assert.equal(typeof property.additionalProperties, 'boolean')
      if ('required' in property) assert.equal(property.required, true)
    }
  }
})

test('rows beyond maxRows are cut and reported', async () => {
  const value = await tools.ao_run_analysis.execute({ analysis_id: 'a-rows' }, undefined)
  assert.equal(value.ok, true)
  assert.deepEqual(value.result.rows, [[1], [2]])
  assert.equal(value.result.rows_shown, 2)
  assert.equal(value.result.row_count, 3)
  const answer = await tools.ao_ask_question.execute({ question: 'q' }, undefined)
  assert.equal(answer.answer.rows.length, 2)
  assert.equal(answer.answer.rows_shown, 2)
})

test('refusals are results with last_success, not throws', async () => {
  const value = await tools.ao_run_analysis.execute({ analysis_id: 'a-timeout' }, undefined)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'timeout')
  assert.deepEqual(value.error.last_success.rows, [[1200]])
  const guard = await tools.ao_run_analysis.execute({ analysis_id: 'a-guard' }, undefined)
  assert.equal('last_success' in guard.error, false)
})

test('list, get, search, coverage', async () => {
  assert.equal((await tools.ao_list_analyses.execute({ status: 'verified' })).total, 8)
  assert.equal((await tools.ao_get_analysis.execute({ analysis_id: 'a-ok' })).analysis.id, 'a-ok')
  assert.equal((await tools.ao_search_terms.execute({ search_term: '승인' })).count, 1)
  assert.equal((await tools.ao_question_coverage.execute({ question: 'q' })).coverage.coverage, 0.8)
})

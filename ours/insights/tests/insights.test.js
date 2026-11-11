import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { formatValue, pickValue, toNumber } from '../src/values.js'
import { ReportStore, handWrittenNumbers, placeholders, renderPlain, reportProblems } from '../src/reports.js'
import { AlertStore, conditionHolds, describeCondition, ruleProblems } from '../src/alerts.js'
import { insightsToolSpecs } from '../src/tool-specs.js'
import { insightsRoutes } from '../src/routes.js'
import { reportTrigger } from '../src/trigger.js'
import { AoClient } from '../../ao-connector/src/client.js'
import { startFakeAo } from '../../ao-connector/tests/fake-ao.js'

function memoryDomain() {
  const tables = new Map()
  const table = name => {
    if (!tables.has(name)) {
      const map = new Map()
      tables.set(name, {
        get: key => map.get(key), entries: () => map.entries(), keys: () => map.keys(), get size() { return map.size },
        put: async (key, value) => { map.set(key, structuredClone(value)) }, delete: async key => map.delete(key),
      })
    }
    return tables.get(name)
  }
  return { table }
}

const SERIES = {
  columns: [{ name: 'month', type: 'string', label: '월', unit: null }, { name: 'approved_count', type: 'integer', label: '승인 건수', unit: '건' }],
  rows: [['2026-09', 7500], ['2026-10', 8753], ['2026-11', '12000']],
}

describe('values', () => {
  test('pick by row, where and reduce', () => {
    assert.equal(pickValue(SERIES, { column: 'approved_count' }).value, 7500)
    assert.equal(pickValue(SERIES, { column: 'approved_count', row: 1 }).value, 8753)
    assert.equal(pickValue(SERIES, { column: 'approved_count', where: { month: '2026-10' } }).value, 8753)
    assert.equal(pickValue(SERIES, { column: 'approved_count', reduce: 'sum' }).number, 28253)
    assert.equal(pickValue(SERIES, { column: 'approved_count', reduce: 'max' }).number, 12000)
    assert.equal(pickValue(SERIES, { column: 'month', reduce: 'count' }).number, 3)
    assert.equal(pickValue(SERIES, { column: 'nope' }).code, 'unknown_column')
    assert.equal(pickValue(SERIES, { column: 'approved_count', row: 9 }).code, 'no_row')
    assert.equal(pickValue(SERIES, { column: 'month', reduce: 'sum' }).code, 'not_numeric')
    assert.equal(toNumber('260.26'), 260.26)
    assert.equal(toNumber('abc'), null)
  })

  test('formatting', () => {
    assert.equal(formatValue(8753, { unit: '건' }), '8,753건')
    assert.equal(formatValue(0.584, { format: 'percent' }), '58.4%')
    assert.equal(formatValue(16.7, { format: 'change' }), '+16.7%')
    assert.equal(formatValue(-3, { format: 'difference', unit: '건' }), '-3건')
    assert.equal(formatValue(null), '—')
  })
})

describe('hand-written numbers', () => {
  test('calendar words, small counts, identifiers and parameter values pass', () => {
    const text = '2026년 10월 보고. 2026-10-01부터 3가지를 봤다. v2 분석, Q3, 상위 20곳, 10:30 기준, 1. 첫째 {{fig:a}}'
    assert.deepEqual(handWrittenNumbers(text, new Set(['20'])), [])
  })
  test('counts, percents and decimals are flagged', () => {
    assert.deepEqual(handWrittenNumbers('승인 8,753건으로 16.7% 늘었고 +3건, 12건, 5% 차이', new Set()), ['8,753', '16.7', '3', '12', '5'])
  })
  test('ids are not numbers; a signed count still is', () => {
    assert.deepEqual(handWrittenNumbers("분석 88eb2bc0-4d1c-47cd-9d13-a1309a67fdad 기준, run_2026 결과", new Set()), [])
    assert.deepEqual(handWrittenNumbers('증감 -1253건', new Set()), ['1253'])
  })
  test('placeholders are not numbers', () => {
    assert.deepEqual(handWrittenNumbers('{{fig:m10}} 대비 {{ fig:m9 }}', new Set()), [])
    assert.deepEqual(placeholders('{{fig:a}} {{fig:b}} {{fig:a}}'), ['a', 'b'])
  })
})

const sept = { id: 'sep', kind: 'value', analysis_id: 'a-series', column: 'approved_count', where: { month: '2026-09' } }
const oct = { id: 'oct', kind: 'value', analysis_id: 'a-series', column: 'approved_count', where: { month: '2026-10' } }

describe('reports with the fake gateway', () => {
  let fake
  let client
  before(async () => {
    fake = await startFakeAo({ token: 't-read' })
    client = new AoClient({ baseUrl: fake.url, requestTimeoutMs: 5000, askTimeoutMs: 5000, token: async () => 't-read' })
  })
  after(() => fake.close())

  test('input problems', () => {
    const paths = input => reportProblems(input).map(p => p.path)
    assert.deepEqual(paths({ title: 'x', body: '{{fig:zz}}', figures: [] }), ['$.body'])
    assert.deepEqual(paths({ title: 'x', body: 'y', figures: [{ id: 'a', kind: 'value', analysis_id: 'q', column: 'c', sql: 'SELECT 1' }] }), ['$.figures[0].sql'])
    assert.deepEqual(paths({ title: 'x', body: 'y', figures: [{ id: 'c', kind: 'change', from: 'a', to: 'b' }] }), ['$.figures[0].from', '$.figures[0].to'])
    assert.deepEqual(paths({ title: 'x', body: 'y', figures: [sept, { ...oct, id: 'sep' }] }), ['$.figures[1].id'])
  })

  test('save runs the analyses, stores values with their sources and renders them', async () => {
    const store = new ReportStore(memoryDomain(), { connector: client })
    const report = await store.save({
      title: '2026년 10월 승인 현황',
      body: '10월 승인은 {{fig:oct}}로 9월 {{fig:sep}} 대비 {{fig:mom}} 변했다.\n\n{{fig:recent}}',
      figures: [sept, oct, { id: 'mom', kind: 'change', from: 'sep', to: 'oct' }, { id: 'recent', kind: 'table', analysis_id: 'a-series', max_rows: 2 }],
    }, { sessionId: 's-1' })
    assert.equal(report.figures.oct.value, 8753)
    assert.equal(report.figures.oct.text, '8,753건')
    assert.equal(report.figures.mom.text, '+16.7%')
    assert.deepEqual(report.figures.oct.analysis, { id: 'a-series', name: 'Approved by month', version: 1, status: 'verified', verified: true })
    assert.match(report.figures.oct.executed_at, /^\d{4}-/)
    assert.equal(report.figures.recent.table.shown, 2)
    assert.equal(fake.runs, 1, 'one run for three figures of the same analysis and parameters')
    const text = renderPlain(report)
    assert.match(text, /8,753건\[1\]/)
    assert.match(text, /\[1\] Approved by month v1 \(확인됨\)/)
    assert.equal(store.list().data[0].all_verified, true)
  })

  test('hand-written numbers and failed figures save nothing', async () => {
    const store = new ReportStore(memoryDomain(), { connector: client })
    await assert.rejects(store.save({ title: 't', body: '승인 8753건 {{fig:oct}}', figures: [oct] }), { code: 'hand_written_numbers', details: { numbers: ['8753'] } })
    await assert.rejects(store.save({ title: 't', body: '{{fig:g}}', figures: [{ id: 'g', kind: 'value', analysis_id: 'a-guard', column: 'approved_count' }] }), { code: 'figure_failed' })
    await assert.rejects(store.save({ title: 't', body: '{{fig:g}}', figures: [{ id: 'g', kind: 'value', analysis_id: 'a-ok', column: 'nope' }] }), { code: 'figure_failed' })
    assert.equal(store.list().total, 0)
  })

  test('an unverified version is saved and marked', async () => {
    const store = new ReportStore(memoryDomain(), { connector: client })
    const report = await store.save({ title: '초안 확인', body: '{{fig:d}}', figures: [{ id: 'd', kind: 'value', analysis_id: 'a-draft', version: 1, column: 'approved_count' }] })
    assert.equal(report.figures.d.analysis.verified, false)
    assert.equal(store.list().data[0].all_verified, false)
  })

  test('report tool links a scheduled session and decodes JSON-text figures', async () => {
    const reports = new ReportStore(memoryDomain(), { connector: client })
    const schedule = {
      catalog: async () => [{ id: 'sch-1', title: '주간 보고', target: { kind: 'new', create: {} }, lastDelivery: { scheduledAt: '2026-11-11T00:00:00.000Z', targetSessionId: 's-sched' } }],
      history: async () => ({ records: [] }),
    }
    const saved = []
    const [save] = insightsToolSpecs({ reports, alerts: undefined, triggerOf: (sid, hint) => reportTrigger(schedule, sid, hint), onReport: r => saved.push(r.id) })
    const result = await save.execute({ title: '주간 보고', body: '{{fig:oct}}', figures: JSON.stringify([oct]) }, { sessionId: 's-sched' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.trigger, { kind: 'schedule', schedule_id: 'sch-1', schedule_title: '주간 보고', occurrence_at: '2026-11-11T00:00:00.000Z' })
    assert.deepEqual(saved, [result.report_id])
    assert.equal(reports.list({ schedule_id: 'sch-1' }).total, 1)
    const manual = await save.execute({ title: '수동', body: '{{fig:oct}}', figures: [oct] }, { sessionId: 's-other' })
    assert.deepEqual(manual.trigger, { kind: 'session' })
    const refused = await save.execute({ title: '수동', body: '12,000건 {{fig:oct}}', figures: [oct] }, { sessionId: 's-other' })
    assert.equal(refused.error.code, 'hand_written_numbers')
  })
})

const LIMITS = { maxRules: 3, minIntervalS: 300, maxIntervalS: 86400 }
const threshold = (overrides = {}) => ({ name: '승인 급증', analysis_id: 'a-ok', value: { column: 'approved_count' }, condition: { kind: 'threshold', op: '>', value: 2000 }, interval_s: 300, ...overrides })

describe('alert rules', () => {
  test('rule problems', () => {
    const paths = input => ruleProblems(input, LIMITS).map(p => p.path)
    assert.deepEqual(paths(threshold()), [])
    assert.deepEqual(paths(threshold({ interval_s: 60 })), ['$.interval_s'])
    assert.deepEqual(paths(threshold({ condition: { kind: 'change', op: '>=', percent: 20 } })), ['$.condition.previous_params'])
    assert.deepEqual(paths(threshold({ value: { column: 'x', sql: 'SELECT 1' } })), ['$.value.sql'])
  })

  test('conditions', () => {
    assert.equal(conditionHolds({ kind: 'threshold', op: '>', value: 10 }, 11).matched, true)
    assert.equal(conditionHolds({ kind: 'threshold', op: '<=', value: 10 }, 11).matched, false)
    assert.equal(conditionHolds({ kind: 'change', op: '>=', percent: 10 }, 120, 100).matched, true)
    assert.equal(conditionHolds({ kind: 'change', op: '<=', percent: -10 }, 85, 100).matched, true)
    assert.equal(conditionHolds({ kind: 'change', op: 'abs>=', percent: 30 }, 85, 100).matched, false)
    assert.equal(conditionHolds({ kind: 'change', op: '>=', percent: 10 }, 5, 0).matched, false)
    assert.equal(describeCondition({ kind: 'threshold', op: '>', value: 2000 }, 'ko-KR', '건'), '2,000건 초과')
    assert.equal(describeCondition({ kind: 'threshold', op: '<=', value: 50 }), '50 이하')
    assert.equal(describeCondition({ kind: 'change', op: '<=', percent: -20, previous_params: {} }), '직전 기간보다 20% 이상 감소')
    assert.equal(describeCondition({ kind: 'change', op: '>=', percent: 15, previous_params: {} }), '직전 기간보다 15% 이상 증가')
  })

  describe('with the fake gateway', () => {
    let fake
    let client
    let clock
    const setRows = (id, rows) => fetch(`${fake.url}/__fake/rows?id=${id}`, { method: 'POST', body: JSON.stringify({ rows }) })
    before(async () => {
      fake = await startFakeAo({ token: 't-read' })
      client = new AoClient({ baseUrl: fake.url, requestTimeoutMs: 5000, askTimeoutMs: 5000, token: async () => 't-read' })
    })
    after(() => fake.close())
    const alertStore = () => {
      clock = new Date('2026-11-11T00:00:00Z')
      const fired = []
      const store = new AlertStore(memoryDomain(), { connector: client, ...LIMITS, now: () => clock, onFire: f => fired.push(f) })
      return { store, fired }
    }

    test('verified analyses only; unknown columns and parameters refused; limit', async () => {
      const { store } = alertStore()
      await assert.rejects(store.createRule(threshold({ analysis_id: 'a-draft' }), { createdBy: 'person' }), { code: 'not_verified' })
      await assert.rejects(store.createRule(threshold({ value: { column: 'nope' } }), { createdBy: 'person' }), { code: 'invalid_rule' })
      await assert.rejects(store.createRule(threshold({ params: { top_n: 3 } }), { createdBy: 'person' }), { code: 'invalid_rule' })
      await assert.rejects(store.createRule(threshold({ analysis_id: 'missing' }), { createdBy: 'person' }), { code: 'analysis_not_found' })
      for (let i = 0; i < 3; i += 1) await store.createRule(threshold({ params: { start_date: 'month_start(0)' } }), { createdBy: 'person' })
      await assert.rejects(store.createRule(threshold(), { createdBy: 'person' }), { code: 'rule_limit' })
    })

    test('agent rules wait for a person; a crossing fires once; errors never fire', async () => {
      const { store, fired } = alertStore()
      await setRows('a-ok', [[1234]])
      const rule = await store.createRule(threshold(), { createdBy: 'agent', sessionId: 's-1' })
      assert.equal(rule.status, 'pending')
      assert.deepEqual(await store.evaluateDue(), { evaluated: 0, fired: 0, errors: 0, requests: 0 })
      await store.updateRule(rule.id, { status: 'active' })
      assert.equal((await store.evaluateDue()).evaluated, 1)
      assert.equal(store.getRule(rule.id).state.matched, false)
      assert.equal((await store.evaluateDue()).evaluated, 0, 'not due again before interval_s')
      await setRows('a-ok', [[2500]])
      clock = new Date(clock.getTime() + 300_000)
      const second = await store.evaluateDue()
      assert.deepEqual(second, { evaluated: 1, fired: 1, errors: 0, requests: 1 })
      assert.equal(fired[0].value, 2500)
      assert.equal(fired[0].value_text, '2,500건')
      assert.equal(fired[0].condition_text, '2,000건 초과')
      assert.equal(fired[0].analysis.verified, true)
      assert.equal(store.unreadCount(), 1)
      clock = new Date(clock.getTime() + 300_000)
      await store.evaluateDue()
      assert.equal(fired.length, 1, 'still above: no second firing')
      await setRows('a-ok', [[1000]])
      clock = new Date(clock.getTime() + 300_000)
      await store.evaluateDue()
      await setRows('a-ok', [[3000]])
      clock = new Date(clock.getTime() + 300_000)
      await store.evaluateDue()
      assert.equal(fired.length, 2, 'fires again after dropping below')
      const guard = await store.createRule(threshold({ analysis_id: 'a-guard' }), { createdBy: 'person' })
      clock = new Date(clock.getTime() + 300_000)
      const withError = await store.evaluateDue()
      assert.equal(withError.errors, 1)
      assert.equal(store.getRule(guard.id).state.last_error.code, 'forbidden_statement')
      assert.equal(fired.length, 2)
      await store.markRead()
      assert.equal(store.unreadCount(), 0)
      await setRows('a-ok', [[1234]])
    })

    test('routes: create, turn on, evaluate now, firings, read', async () => {
      const { store } = alertStore()
      const reports = new ReportStore(memoryDomain(), { connector: client })
      const routes = Object.fromEntries(insightsRoutes({ reports, alerts: store, investigate: async id => ({ session_id: `s-for-${id}`, reused: false }), limits: { max_rules: 3 } }).map(r => [r.path, r]))
      const call = async (path, body) => {
        const response = await routes[path].fetch(new Request(`http://h${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }))
        return { status: response.status, body: await response.json() }
      }
      const created = await call('/api/insights/rules', threshold({ condition: { kind: 'threshold', op: '>', value: 1000 } }))
      assert.equal(created.body.data.status, 'active')
      const evaluated = await call('/api/insights/evaluate', { id: created.body.data.id })
      assert.equal(evaluated.body.data.summary.fired, 1)
      assert.equal((await call('/api/insights/unread')).body.unread, 1)
      const firings = await call('/api/insights/firings')
      assert.equal(firings.body.data[0].rule_name, '승인 급증')
      assert.equal((await call('/api/insights/investigate', { firing_id: firings.body.data[0].id })).body.data.session_id, `s-for-${firings.body.data[0].id}`)
      assert.equal((await call('/api/insights/read', {})).body.data.unread, 0)
      assert.equal((await call('/api/insights/rules', { ...threshold(), analysis_id: 'a-draft' })).status, 409)
      assert.equal((await call('/api/insights/rule-delete', { id: created.body.data.id })).body.data.deleted, true)
    })
  })

  test('change rules read the previous period with merged parameters', async () => {
    const calls = []
    const connector = {
      getAnalysis: async () => ({ ok: true, data: { name: 'Orders', latest_verified_version: 2, version: { version: 2, status: 'verified', columns: [{ name: 'n', unit: '건' }], params: [{ name: 'start_date' }, { name: 'end_date' }] } } }),
      runBatch: async ({ items }) => {
        calls.push(items)
        const data = {}
        for (const item of items) {
          const n = item.params.start_date === 'month_start(-1)' ? 100 : 75
          data[item.key] = { ok: true, data: { analysis_id: 'o', name: 'Orders', version: 2, status: 'verified', params: item.params, columns: [{ name: 'n', unit: '건' }], rows: [[n]], executed_at: '2026-11-11T00:00:00Z' } }
        }
        return { ok: true, data }
      },
    }
    const fired = []
    const store = new AlertStore(memoryDomain(), { connector, ...LIMITS, onFire: f => fired.push(f) })
    await store.createRule({
      name: '주문 급감', analysis_id: 'o', params: { start_date: 'month_start(0)', end_date: 'today' }, value: { column: 'n' },
      condition: { kind: 'change', op: '<=', percent: -20, previous_params: { start_date: 'month_start(-1)', end_date: 'month_start(0)' } }, interval_s: 300,
    }, { createdBy: 'person' })
    const summary = await store.evaluateDue()
    assert.equal(summary.fired, 1)
    assert.deepEqual(calls[0].map(i => [i.key.split(':')[0], i.params.start_date, i.max_age_s]), [['cur', 'month_start(0)', 300], ['prev', 'month_start(-1)', 300]])
    assert.equal(fired[0].change_text, '-25.0%')
    assert.equal(fired[0].previous_value_text, '100건')
  })
})

import { repeatText, scheduleRow } from '../src/schedules.js'

describe('schedules', () => {
  test('repeat in words', () => {
    assert.equal(repeatText({ kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Seoul:20261201T090000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1' }), '매달 1일 09:00')
    assert.equal(repeatText({ kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Seoul:20261116T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO' }), '매주 월요일 09:00')
    assert.equal(repeatText({ kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Seoul:20261111T121200\nRRULE:FREQ=DAILY;COUNT=1' }), '한 번')
    assert.equal(repeatText({ kind: 'weekly', time: '09:00:00.000', weekdays: [1, 5] }), '매주 월·금요일 09:00')
    assert.equal(repeatText({ kind: 'cron', expression: '0 9 * * 1' }), '사용자 지정')
  })
  test('rows: next run only while active', () => {
    const entry = { id: 's1', title: '주간 보고', kind: 'at', status: 'active', scheduledAt: '2026-11-16T00:00:00.000Z', target: { kind: 'new' } }
    assert.equal(scheduleRow(entry).next_at, '2026-11-16T00:00:00.000Z')
    assert.equal(scheduleRow({ ...entry, status: 'paused' }).next_at, null)
  })
})

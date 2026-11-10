import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AoClient } from '../../ao-connector/src/client.js'
import { startFakeAo } from '../../ao-connector/tests/fake-ao.js'
import { DashboardStore, memoryDomain } from '../src/store.js'
import { dashboardRoutes, OWNER_HEADER } from '../src/routes.js'
import { EDITOR_TOOL_NAMES, analysisRefs, applyOperations, editorToolSpecs, makeAnalysisGate, widgetSourceProblems } from '../src/editor.js'

const A = 'owner-aaaaaaaa'
const B = 'owner-bbbbbbbb'
const SESSION = 'session-editor-1'

function spec() {
  return {
    format: 1,
    title: 'Ops',
    widgets: [
      { id: 'total', type: 'number-tile', type_version: 1, layout: { x: 0, y: 0, w: 4, h: 2 }, source: { analysis_id: 'a-ok' } },
      { id: 'bars', type: 'bar-chart', type_version: 1, layout: { x: 4, y: 0, w: 8, h: 3 }, source: { analysis_id: 'a-rows' } },
    ],
  }
}

let fake
let connector
before(async () => {
  fake = await startFakeAo({ token: 'read', editorToken: 'edit', reviewerToken: 'review' })
  connector = new AoClient({ baseUrl: fake.url, token: async () => 'read', editorToken: async () => 'edit', reviewerToken: async () => 'review' })
})
after(() => fake.close())

async function setup() {
  const gate = makeAnalysisGate(connector)
  const store = new DashboardStore(memoryDomain(), { checkAnalyses: gate })
  for (const type of ['number-tile', 'bar-chart', 'table']) await store.putWidget({ type, version: 1, source: `export default {}//${type}`, origin: 'basic' })
  await store.saveDraft('ops', A, spec())
  await store.publish('ops', A)
  await store.saveDraft('ops', A)
  await store.bindEditor(SESSION, 'ops', A)
  const tools = Object.fromEntries(editorToolSpecs({ store, connector, gate, maxRows: 5 }).map(t => [t.name, t]))
  const call = (name, args = {}, sessionId = SESSION) => tools[name].execute(args, { sessionId })
  return { store, gate, tools, call }
}

describe('editing tools', () => {
  test('every tool refuses a Session without a binding', async () => {
    const { tools, call } = await setup()
    assert.deepEqual(Object.keys(tools), [...EDITOR_TOOL_NAMES])
    for (const name of EDITOR_TOOL_NAMES) {
      const result = await call(name, { operations: [{ op: 'remove_widget', id: 'total' }], sql: 'SELECT 1', type: 'x', source: 'export default {}', description: 'x' }, 'analyst-session')
      assert.equal(result.ok, false, name)
      assert.equal(result.error.code, 'not_bound', name)
    }
    const undefinedSession = await tools.dashboard_read_draft.execute({}, { sessionId: undefined })
    assert.equal(undefinedSession.error.code, 'not_bound')
  })

  test('read, edit, and refuse an invalid result without changing the draft', async () => {
    const { store, call } = await setup()
    const read = await call('dashboard_read_draft')
    assert.equal(read.ok, true)
    assert.equal(read.draft.dashboard_id, 'ops')
    assert.equal(read.draft.base_version, 1)
    assert.deepEqual(read.widget_types.map(w => `${w.type}@${w.version}`), ['bar-chart@1', 'number-tile@1', 'table@1'])
    assert.deepEqual(read.unverified_analyses, [])

    const edited = await call('dashboard_edit_draft', { operations: [{ op: 'update_widget', id: 'bars', changes: { type: 'table', title: 'Rows' } }] })
    assert.equal(edited.ok, true)
    assert.equal(store.get('ops', { view: 'draft', owner: A }).spec.widgets[1].type, 'table')
    assert.equal(store.get('ops').spec.widgets[1].type, 'bar-chart', 'the published version is untouched')

    const overlap = await call('dashboard_edit_draft', { operations: [{ op: 'add_widget', widget: { id: 'x', type: 'table', type_version: 1, layout: { x: 0, y: 0, w: 2, h: 2 }, source: { analysis_id: 'a-ok' } } }] })
    assert.equal(overlap.error.code, 'invalid_spec')
    const sql = await call('dashboard_edit_draft', { operations: [{ op: 'update_widget', id: 'total', changes: { options: { sql: 'SELECT 1' } } }] })
    assert.equal(sql.error.code, 'invalid_spec')
    const unknown = await call('dashboard_edit_draft', { operations: [{ op: 'remove_widget', id: 'nope' }, { op: 'set_dashboard', changes: { owner: 'x' } }] })
    assert.equal(unknown.error.code, 'invalid_operations')
    assert.equal(unknown.error.details.problems.length, 2)
    assert.equal(store.get('ops', { view: 'draft', owner: A }).spec.widgets.length, 2)
  })

  test('a saved draft analysis previews, blocks publishing until verified, then publishes', async () => {
    const { store, call } = await setup()
    const saved = await call('dashboard_save_analysis', { name: 'Share approved', database_name: 'example_db', sql: 'SELECT 0.4 AS share', column_hints: { share: { role: 'measure', unit: '%' } } })
    assert.equal(saved.ok, true)
    assert.equal(saved.status, 'draft')
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.columns.map(c => c.name), ['share'])
    assert.equal(store.editor(SESSION).analyses[0].analysis_id, saved.analysis_id)

    const bound = await call('dashboard_edit_draft', { operations: [{ op: 'add_widget', widget: { id: 'share', type: 'number-tile', type_version: 1, layout: { x: 0, y: 3, w: 4, h: 2 }, source: { analysis_id: saved.analysis_id, version: 1 } } }] })
    assert.equal(bound.ok, true)
    assert.deepEqual(bound.unverified_analyses.map(u => [u.analysis_id, u.version, u.reason]), [[saved.analysis_id, 1, 'draft']])

    await assert.rejects(store.publish('ops', A), error => error.code === 'unverified_analyses' && error.details.analyses.length === 1)
    await assert.rejects(store.publish('ops', A, { force: true }), error => error.code === 'unverified_analyses', 'force does not skip the gate')
    assert.equal(store.get('ops').version, 1)

    assert.equal((await connector.verifyVersion(saved.analysis_id, 1)).ok, true)
    const published = await store.publish('ops', A)
    assert.equal(published.version, 2)
    const gone = await call('dashboard_read_draft')
    assert.equal(gone.error.code, 'draft_gone')
  })

  test('an unpinned widget needs a verified version; lookup failures block', async () => {
    const { gate } = await setup()
    const withDraft = { ...spec(), widgets: [{ ...spec().widgets[0], source: { analysis_id: 'a-draft' } }, { ...spec().widgets[1], source: { analysis_id: 'missing' } }] }
    const result = await gate(withDraft)
    assert.deepEqual(result.map(r => [r.analysis_id, r.reason]), [['a-draft', 'no_verified_version'], ['missing', 'not_found']])
    const down = makeAnalysisGate({ getAnalysis: async () => ({ ok: false, error: { code: 'unreachable' } }) })
    assert.equal((await down(spec()))[0].reason, 'unchecked:unreachable')
    assert.deepEqual(analysisRefs({ widgets: [{ source: { analysis_id: 'b' } }, { source: { analysis_id: 'a', version: 2 } }, { source: { analysis_id: 'b' } }] }), [{ analysis_id: 'a', version: 2 }, { analysis_id: 'b', version: null }])
  })

  test('widget types: forbidden code refused, new versions are generated and immutable', async () => {
    const { store, call } = await setup()
    const bad = await call('dashboard_save_widget_type', { type: 'gauge', description: 'g', source: 'export default { mount(el) { fetch("/api/dashboard/list"); return { update() {}, destroy() {} } } }' })
    assert.equal(bad.error.code, 'invalid_widget')
    const ok = await call('dashboard_save_widget_type', { type: 'gauge', description: 'g', source: 'export default { mount(el, p) { return { update() {}, destroy() {} } } }' })
    assert.deepEqual([ok.type, ok.type_version], ['gauge', 1])
    const again = await call('dashboard_save_widget_type', { type: 'gauge', description: 'g2', source: 'export default { mount(el, p) { el.textContent = "2"; return { update() {}, destroy() {} } } }' })
    assert.equal(again.type_version, 2)
    const over = await call('dashboard_save_widget_type', { type: 'table', description: 't', source: 'export default { mount() { return { update() {}, destroy() {} } } }' })
    assert.equal(over.type_version, 2)
    const origins = Object.fromEntries(store.listWidgets().map(w => [`${w.type}@${w.version}`, w.origin]))
    assert.deepEqual([origins['gauge@1'], origins['table@1'], origins['table@2']], ['generated', 'basic', 'generated'])
    assert.deepEqual(widgetSourceProblems('const top = 1; export default { mount(el) { return { update() {}, destroy() {} } } }'), [])
    assert.deepEqual(widgetSourceProblems('export function mount(el) { return { update() {}, destroy() {} } }'), [])
    assert.equal(widgetSourceProblems('function render() {} export default render').length, 1, 'a module without mount is refused')
  })

  test('operations apply in order on a copy', () => {
    const base = spec()
    const { spec: next, problems } = applyOperations(base, [
      { op: 'update_widget', id: 'total', changes: { layout: { x: 0, y: 0, w: 6, h: 2 }, title: null } },
      { op: 'remove_widget', id: 'bars' },
      { op: 'set_dashboard', changes: { title: 'Renamed', refresh_s: 600 } },
    ])
    assert.deepEqual(problems, [])
    assert.equal(next.title, 'Renamed')
    assert.equal(next.widgets.length, 1)
    assert.equal(base.widgets.length, 2)
  })
})

describe('edit routes', () => {
  test('edit opens through the service; editor answers only the owning browser', async () => {
    const { store, gate } = await setup()
    const opened = []
    const routes = Object.fromEntries(dashboardRoutes(store, {}, {
      openEditor: async (id, owner) => { opened.push([id, owner]); return { session_id: 's-2' } },
      gate,
    }).map(r => [r.path, r]))
    const call = (path, { method = 'GET', body, owner } = {}) => routes[path.split('?')[0]].fetch(new Request(`http://h${path}`, {
      method, headers: { ...owner === undefined ? {} : { [OWNER_HEADER]: owner }, 'content-type': 'application/json' }, ...body === undefined ? {} : { body: JSON.stringify(body) },
    }))
    assert.equal((await call('/api/dashboard/edit', { method: 'POST', body: { id: 'ops' }, owner: A })).status, 200)
    assert.deepEqual(opened, [['ops', A]])
    const mine = await call(`/api/dashboard/editor?session=${SESSION}`, { owner: A })
    assert.equal(mine.status, 200)
    const body = (await mine.json()).data
    assert.equal(body.dashboard_id, 'ops')
    assert.equal(body.draft.view, 'draft')
    assert.equal((await call(`/api/dashboard/editor?session=${SESSION}`, { owner: B })).status, 404)
    const posted = await call('/api/dashboard/widgets', { method: 'POST', body: { type: 'number-tile', version: 2, source: 'export default {}' }, owner: A })
    assert.equal((await posted.json()).data.origin, 'generated')
    const noEditing = Object.fromEntries(dashboardRoutes(store).map(r => [r.path, r]))
    const refused = await noEditing['/api/dashboard/edit'].fetch(new Request('http://h/api/dashboard/edit', { method: 'POST', headers: { [OWNER_HEADER]: A }, body: '{"id":"ops"}' }))
    assert.equal(refused.status, 503)
  })
})

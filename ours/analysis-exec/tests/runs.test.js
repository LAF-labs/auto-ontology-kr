import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { InputStore, autoSource, exportApiSource, runApiSource } from '../src/inputs.js'
import { resolveLimits } from '../src/limits.js'
import { AnalysisRuns, sessionKey } from '../src/runs.js'
import { analysisToolSpecs, TOOL_NAMES } from '../src/tool-specs.js'
import { fakeConnector, fakeRunner, writeOutput } from './fakes.js'

let root
let dataDir
let counter = 0
before(async () => { root = await mkdtemp(join(tmpdir(), 'analysis-exec-unit-')) })
after(async () => { await rm(root, { recursive: true, force: true }) })
beforeEach(() => { counter += 1; dataDir = join(root, `data${counter}`) })

function setup({ script, limits, source, maxRows = 50 } = {}) {
  const connector = fakeConnector()
  const runner = fakeRunner(script)
  const resolved = resolveLimits(limits)
  const runs = new AnalysisRuns({
    dataDir, runner, limits: resolved, maxRows,
    inputs: new InputStore({ connector, source: source ?? runApiSource(connector), maxInputs: resolved.maxInputsPerSession, now: () => new Date('2026-11-11T03:00:00Z') }),
    now: () => new Date('2026-11-11T03:00:01Z'),
  })
  const tools = Object.fromEntries(analysisToolSpecs(runs).map(spec => [spec.name, (args, sessionId = 's1') => spec.execute(args, { sessionId })]))
  return { connector, runner, runs, tools }
}

const FORECAST_CSV = 'month,forecast,lo80,hi80\n2026-11-01,140,128,152\n2026-12-01,146,129,163\n'
const INTERVAL = { table: 'forecast.csv', point: 'forecast', lower: 'lo80', upper: 'hi80', level: 0.8, label: 'November forecast' }

async function forecastRun(context) {
  await context.tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })
  return context.tools.analysis_run_python({ code: 'print("fit")', inputs: ['orders'] })
}

describe('prepare input', () => {
  test('writes the verified result as CSV with its column description and a manifest', async () => {
    const { tools, connector } = setup()
    const result = await tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok', params: { start: '2026-07-01' }, max_age_s: 0 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.input.analysis, { id: 'a-ok', name: 'Monthly orders', version: 1, status: 'verified', verified_at: '2026-11-01T00:00:00Z' })
    assert.equal(result.input.path, '/input/orders.csv')
    assert.equal(result.input.row_count, 4)
    assert.equal(result.input.executed_at, '2026-11-11T02:00:00.000000Z')
    assert.equal(result.input.prepared_at, '2026-11-11T03:00:00.000Z')
    assert.equal(result.input.sql, undefined)
    assert.deepEqual(result.input.conditions, [{ name: 'start', label: 'Start (inclusive)', value: '2026-07-01' }])
    // The version is read first, then pinned in the run request.
    assert.deepEqual(connector.calls, [['get', 'a-ok', undefined], ['run', 'a-ok', { version: 1, params: { start: '2026-07-01' }, max_age_s: 0 }]])
    const inputs = join(dataDir, 'sessions', 's1', 'inputs')
    assert.equal(await readFile(join(inputs, 'orders.csv'), 'utf8'), 'month,orders\n2026-07-01,100\n2026-08-01,110\n2026-09-01,\n2026-10-01,135\n')
    assert.deepEqual(JSON.parse(await readFile(join(inputs, 'orders.columns.json'), 'utf8')).columns[1], { name: 'orders', type: 'integer', role: 'measure', unit: 'count', label: 'Orders' })
    const manifest = JSON.parse(await readFile(join(dataDir, 'sessions', 's1', 'manifests', 'orders.json'), 'utf8'))
    assert.equal(manifest.sql, 'SELECT month, orders FROM monthly')
    assert.equal(manifest.analysis.verified_by, 'reviewer')
    assert.equal(manifest.sha256, createHash('sha256').update(await readFile(join(inputs, 'orders.csv'))).digest('hex'))
    assert.deepEqual((await readdir(inputs)).sort(), ['orders.columns.json', 'orders.csv'])
  })

  test('refuses a draft version before running it', async () => {
    const { tools, connector } = setup()
    for (const args of [{ name: 'x', analysis_id: 'a-draft' }, { name: 'x', analysis_id: 'a-ok', version: 2 }]) {
      const result = await tools.analysis_prepare_input(args)
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'not_verified')
    }
    assert.ok(connector.calls.every(call => call[0] === 'get'), 'no run request was sent')
    await assert.rejects(stat(join(dataDir, 'sessions', 's1', 'inputs', 'x.csv')), { code: 'ENOENT' })
  })

  test('refuses a result that the run reports as not verified, and leaves no file', async () => {
    const { tools } = setup()
    const result = await tools.analysis_prepare_input({ name: 'x', analysis_id: 'a-flip' })
    assert.equal(result.error.code, 'not_verified')
    assert.deepEqual(await readdir(join(dataDir, 'sessions', 's1', 'inputs')), [])
  })

  test('refuses a result cut by the row limit', async () => {
    const { tools } = setup()
    const result = await tools.analysis_prepare_input({ name: 'x', analysis_id: 'a-big' })
    assert.equal(result.error.code, 'input_truncated')
    assert.deepEqual(await readdir(join(dataDir, 'sessions', 's1', 'inputs')), [])
  })

  test('refuses names that are not plain file stems, unknown analyses and calls without a session', async () => {
    const { tools } = setup()
    for (const name of ['../x', 'a/b', 'A', '1a', '', 'a'.repeat(41), 'x.csv']) {
      assert.equal((await tools.analysis_prepare_input({ name, analysis_id: 'a-ok' })).error.code, 'invalid_request', name)
    }
    assert.equal((await tools.analysis_prepare_input({ name: 'x', analysis_id: 'nope' })).error.code, 'not_found')
    assert.equal((await tools.analysis_prepare_input({ name: 'x', analysis_id: 'a-ok' }, undefined)).ok, true)
    assert.equal((await tools.analysis_prepare_input({ name: 'x', analysis_id: 'a-ok' }, '')).error.code, 'no_session')
  })

  test('caps the inputs of one session; replacing a name is allowed', async () => {
    const { tools } = setup({ limits: { maxInputsPerSession: 2 } })
    assert.equal((await tools.analysis_prepare_input({ name: 'a', analysis_id: 'a-ok' })).ok, true)
    assert.equal((await tools.analysis_prepare_input({ name: 'b', analysis_id: 'a-ok' })).ok, true)
    assert.equal((await tools.analysis_prepare_input({ name: 'c', analysis_id: 'a-ok' })).error.code, 'too_many_inputs')
    assert.equal((await tools.analysis_prepare_input({ name: 'a', analysis_id: 'a-ok' })).ok, true)
  })

  test('the tool takes no SQL and no file path', () => {
    const spec = analysisToolSpecs(setup().runs).find(item => item.name === 'analysis_prepare_input')
    assert.deepEqual(Object.keys(spec.parameters).sort(), ['analysis_id', 'max_age_s', 'name', 'params', 'version'])
    assert.deepEqual([...TOOL_NAMES], ['analysis_prepare_input', 'analysis_run_python', 'analysis_present_result'])
  })
})

describe('export source', () => {
  let server
  let origin
  let requests
  const body = 'month,orders\n2026-07-01,100\n'
  const digest = createHash('sha256').update(body).digest('hex')
  let exportAnswer
  before(async () => {
    server = createServer((request, response) => {
      let text = ''
      request.on('data', chunk => { text += chunk })
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, key: request.headers['x-api-key'], body: text })
        if (request.method === 'POST' && request.url === '/api/saved-analyses/a-ok/export') {
          response.writeHead(exportAnswer.status, { 'content-type': 'application/json' }).end(JSON.stringify(exportAnswer.body))
        } else if (request.method === 'GET' && request.url === '/api/saved-analysis-exports/e1/file') {
          response.writeHead(200, { 'content-type': 'text/csv' }).end(body)
        } else response.writeHead(404).end('{}')
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })
  after(() => new Promise(resolve => server.close(resolve)))
  beforeEach(() => {
    requests = []
    exportAnswer = {
      status: 201,
      body: { data: {
        export_id: 'e1', analysis_id: 'a-ok', name: 'Monthly orders', version: 1, params: { start: '2026-07-01' }, format: 'csv', state: 'ready',
        columns: [{ name: 'month', type: 'date' }, { name: 'orders', type: 'integer' }], row_count: 1, byte_size: body.length, sha256: digest,
        created_at: '2026-11-11T02:00:00Z', finished_at: '2026-11-11T02:00:02Z', file: { name: 'e1.csv', download_path: '/api/saved-analysis-exports/e1/file' },
        source: { database_name: 'shop' }, sql: 'SELECT 1',
      } },
    }
  })

  test('requests a CSV export of the pinned version and stores the checked file', async () => {
    const { tools } = setup({ source: exportApiSource({ baseUrl: origin, token: async () => 'export-token' }) })
    const result = await tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.input.via, 'export')
    assert.equal(result.input.export_id, 'e1')
    assert.equal(result.input.row_count, 1)
    assert.deepEqual(requests.map(item => [item.method, item.url, item.key]), [
      ['POST', '/api/saved-analyses/a-ok/export', 'export-token'],
      ['GET', '/api/saved-analysis-exports/e1/file', 'export-token'],
    ])
    assert.deepEqual(JSON.parse(requests[0].body), { version: 1, params: {}, format: 'csv' })
    assert.equal(await readFile(join(dataDir, 'sessions', 's1', 'inputs', 'orders.csv'), 'utf8'), body)
  })

  test('passes export refusals through and rejects a file that fails its checksum', async () => {
    const { tools } = setup({ source: exportApiSource({ baseUrl: origin, token: async () => 'export-token' }) })
    exportAnswer = { status: 413, body: { error: { code: 'export_too_large', status: 413, message: 'too many rows', details: { max_rows: 10 } } } }
    assert.deepEqual((await tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })).error, { code: 'export_too_large', message: 'too many rows', details: { max_rows: 10 } })
    exportAnswer = { status: 201, body: { data: { export_id: 'e1', version: 1, state: 'ready', sha256: '0'.repeat(64), file: { download_path: '/api/saved-analysis-exports/e1/file' } } } }
    assert.equal((await tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })).error.code, 'bad_response')
    assert.deepEqual(await readdir(join(dataDir, 'sessions', 's1', 'inputs')), [])
  })

  test('stores Parquet under its own extension and replaces an earlier CSV of the same name', async () => {
    const context = setup()
    await context.tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })
    exportAnswer.body.data.format = 'parquet'
    const parquet = setup({ source: exportApiSource({ baseUrl: origin, format: 'parquet', token: async () => 'export-token' }) })
    const result = await parquet.tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })
    assert.equal(result.input.path, '/input/orders.parquet')
    assert.equal(result.input.format, 'parquet')
    assert.equal(JSON.parse(requests[0].body).format, 'parquet')
    assert.deepEqual((await readdir(join(dataDir, 'sessions', 's1', 'inputs'))).sort(), ['orders.columns.json', 'orders.parquet'])
    assert.throws(() => exportApiSource({ baseUrl: origin, format: 'xlsx', token: async () => 'x' }), /csv or parquet/)
  })

  test('auto reads small results through the run API and exports only a cut result', async () => {
    const connector = fakeConnector()
    const context = setup({ source: autoSource(runApiSource(connector), exportApiSource({ baseUrl: origin, token: async () => 'export-token' })) })
    const small = await context.tools.analysis_prepare_input({ name: 'small', analysis_id: 'a-ok' })
    assert.equal(small.input.via, 'run')
    assert.deepEqual(requests, [])
    // a-big is cut by the run API; the fake gateway only exports a-ok, so the export answers 404.
    const big = await context.tools.analysis_prepare_input({ name: 'big', analysis_id: 'a-big' })
    assert.equal(big.error.code, 'gateway_error')
    assert.deepEqual(requests.map(item => item.url), ['/api/saved-analyses/a-big/export'])
  })

  test('sends nothing without a token', async () => {
    const { tools } = setup({ source: exportApiSource({ baseUrl: origin, token: async () => undefined }) })
    assert.equal((await tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })).error.code, 'missing_token')
    assert.deepEqual(requests, [])
  })
})

describe('run', () => {
  test('gives the run only the inputs it names and returns stdout and described artifacts', async () => {
    const context = setup({
      maxRows: 1,
      script: async ({ outputDir }) => {
        await writeOutput(outputDir, { 'forecast.csv': FORECAST_CSV, 'result.json': '{"mape": 0.07, "next": {"month": "2026-11-01", "value": 140}}', 'plots/trend.png': 'png-bytes', 'notes.bin': 'x' })
        return { stdout: { text: 'fit ok\n', bytes: 7, truncated: false } }
      },
    })
    await context.tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })
    await context.tools.analysis_prepare_input({ name: 'other', analysis_id: 'a-ok' })
    const result = await context.tools.analysis_run_python({ code: 'print("fit ok")', inputs: ['orders'] })
    assert.equal(result.ok, true)
    assert.match(result.run.run_id, /^r[0-9a-f]{16}$/)
    assert.equal(result.run.stdout, 'fit ok\n')
    assert.deepEqual(result.run.inputs, ['orders'])
    assert.deepEqual(result.run.artifacts, [
      { name: 'forecast.csv', kind: 'table', bytes: FORECAST_CSV.length, columns: ['month', 'forecast', 'lo80', 'hi80'], rows: [['2026-11-01', '140', '128', '152']], row_count: 2, rows_shown: 1 },
      { name: 'notes.bin', kind: 'other', bytes: 1 },
      { name: 'plots/trend.png', kind: 'figure', bytes: 9 },
      { name: 'result.json', kind: 'data', bytes: 61, content: { mape: 0.07, next: { month: '2026-11-01', value: 140 } } },
    ])
    const request = context.runner.runs[0]
    assert.equal(request.name, `ae-${result.run.run_id}`)
    assert.deepEqual((await readdir(request.inputDir)).sort(), ['orders.columns.json', 'orders.csv'])
    assert.equal(await readFile(join(request.codeDir, 'main.py'), 'utf8'), 'print("fit ok")')
    const record = JSON.parse(await readFile(join(request.outputDir, '..', 'record.json'), 'utf8'))
    assert.equal(record.inputs[0].analysis.version, 1)
    assert.equal(record.inputs[0].sql, 'SELECT month, orders FROM monthly')
    assert.equal(record.code_sha256, createHash('sha256').update('print("fit ok")').digest('hex'))
    assert.deepEqual(record.isolation, { network: 'none', root_filesystem: 'read-only', user: '10001:10001', writable: ['/output', '/tmp'] })
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700)
    assert.equal((await stat(request.outputDir)).mode & 0o777, 0o755)
  })

  test('refuses unknown inputs, no inputs, empty or oversized code, and a missing runtime', async () => {
    const context = setup({ limits: { maxCodeBytes: 10 } })
    await context.tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })
    const unknown = await context.tools.analysis_run_python({ code: 'x', inputs: ['nope'] })
    assert.equal(unknown.error.code, 'unknown_input')
    assert.deepEqual(unknown.error.details, { available: ['orders'] })
    assert.equal((await context.tools.analysis_run_python({ code: 'x', inputs: ['../../manifests/orders'] })).error.code, 'unknown_input')
    assert.equal((await context.tools.analysis_run_python({ code: 'x', inputs: [] })).error.code, 'invalid_request')
    assert.equal((await context.tools.analysis_run_python({ code: '  ', inputs: ['orders'] })).error.code, 'invalid_request')
    assert.equal((await context.tools.analysis_run_python({ code: 'x'.repeat(11), inputs: ['orders'] })).error.code, 'invalid_request')
    // Another session does not see this session's inputs.
    assert.equal((await context.tools.analysis_run_python({ code: 'x', inputs: ['orders'] }, 's2')).error.code, 'unknown_input')
    context.runner.available = { ok: false, code: 'image_missing', message: 'image is not built' }
    assert.equal((await context.tools.analysis_run_python({ code: 'x', inputs: ['orders'] })).error.code, 'image_missing')
    assert.equal(context.runner.runs.length, 0)
  })

  test('a failed run returns its streams and cannot be presented', async () => {
    const context = setup({ script: async () => ({ status: 'failed', exitCode: 1, message: 'the script exited with code 1', stderr: { text: 'Traceback…\nValueError: bad', bytes: 26, truncated: false } }) })
    const result = await forecastRun(context)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'failed')
    assert.equal(result.run.stderr, 'Traceback…\nValueError: bad')
    const presented = await context.tools.analysis_present_result({ run_id: result.run.run_id, title: 't', kind: 'other', summary: 'a plain summary', method: 'a method here', assumptions: ['a'], uncertainty: 'not sure at all' })
    assert.equal(presented.error.code, 'run_not_ok')
  })

  test('links and special files a run leaves are not artifacts', async () => {
    const context = setup({ script: async ({ outputDir }) => { await writeFile(join(outputDir, 'a.csv'), 'x\n1\n'); await symlink('/etc/passwd', join(outputDir, 'leak.csv')) } })
    const result = await forecastRun(context)
    assert.deepEqual(result.run.artifacts.map(item => item.name), ['a.csv'])
    assert.deepEqual(result.run.skipped_outputs, ['leak.csv'])
    assert.equal(await context.runs.artifactFile('s1', result.run.run_id, 'leak.csv'), undefined)
  })
})

describe('present', () => {
  const claims = { title: 'Orders next month', kind: 'forecast', summary: 'The trend of the last four months was continued one month.', method: 'Holt linear trend on monthly orders.', assumptions: ['The trend of the last months continues.'], uncertainty: 'Only four months were available, so the range is wide.' }
  const script = async ({ outputDir }) => { await writeOutput(outputDir, { 'forecast.csv': FORECAST_CSV, 'result.json': '{"mape": 0.07, "months used": 4}', 'trend.png': 'png', 'bad.csv': 'p,lo,hi\n3,5,1\n', 'outside.csv': 'p,lo,hi\n9,1,5\n' }) }

  test('builds the card from the host record: sources, headline read from the table, numbers, code', async () => {
    const context = setup({ script })
    await context.tools.analysis_prepare_input({ name: 'orders', analysis_id: 'a-ok' })
    await context.tools.analysis_prepare_input({ name: 'orders_b', analysis_id: 'a-ok', params: { start: '2026-08-01' } })
    const run = await context.tools.analysis_run_python({ code: 'print("fit")', inputs: ['orders', 'orders_b'] })
    const result = await context.tools.analysis_present_result({ ...claims, run_id: run.run.run_id, interval: INTERVAL, unit: ' orders', tables: [{ file: 'forecast.csv', title: 'Forecast by month' }], figures: ['trend.png'] })
    assert.equal(result.ok, true, JSON.stringify(result))
    const shown = result.presentation
    assert.deepEqual(shown.headline, { label: 'November forecast', point: 140, lower: 128, upper: 152, level: 0.8, unit: 'orders', periods: 2 })
    assert.deepEqual(shown.sources, [{
      name: 'Monthly orders', status: 'verified', version: 1, data: ['shop.orders'],
      files: [
        { file: 'orders.csv', conditions: [{ label: 'Start (inclusive)', value: '2026-07-01' }], as_of: '2026-11-11T02:00:00.000000Z', rows: 4 },
        { file: 'orders_b.csv', conditions: [{ label: 'Start (inclusive)', value: '2026-08-01' }], as_of: '2026-11-11T02:00:00.000000Z', rows: 4 },
      ],
    }])
    assert.equal(shown.code, 'print("fit")')
    assert.deepEqual(shown.run, { started_at: '2026-11-11T03:00:01.000Z', duration_ms: 5, isolated: true })
    assert.deepEqual(shown.numbers, [{ name: 'mape', value: 0.07 }, { name: 'months used', value: 4 }])
    assert.deepEqual(shown.tables.map(table => [table.name, table.title, table.row_count]), [['forecast.csv', 'Forecast by month', 2]])
    assert.deepEqual(shown.figures, [{ name: 'trend.png', title: null, path: `api/analysis-exec/artifact?session=s1&run=${run.run.run_id}&name=trend.png` }])
    assert.equal(shown.summary, claims.summary)
    // Ids and image names stay in the host record, not in what the person sees.
    assert.equal(JSON.stringify(shown).includes('a-ok'), false)
    assert.equal(JSON.stringify(shown).includes('test-image'), false)
    const saved = JSON.parse(await readFile(join(dataDir, 'sessions', 's1', 'runs', run.run.run_id, 'presentation.json'), 'utf8'))
    assert.equal(saved.presented_at, '2026-11-11T03:00:01.000Z')
    assert.equal(saved.image.name, 'test-image:1')
  })

  test('a forecast needs an interval that exists in the output', async () => {
    const context = setup({ script })
    const run = await forecastRun(context)
    const present = extra => context.tools.analysis_present_result({ ...claims, run_id: run.run.run_id, ...extra })
    assert.equal((await present({})).error.code, 'interval_required')
    assert.equal((await present({ interval: { ...INTERVAL, point: undefined } })).error.code, 'interval_required')
    assert.equal((await present({ interval: { ...INTERVAL, label: ' ' } })).error.code, 'interval_required')
    assert.equal((await present({ interval: { ...INTERVAL, table: 'nope.csv' } })).error.code, 'interval_invalid')
    assert.equal((await present({ interval: { ...INTERVAL, lower: 'lo' } })).error.code, 'interval_invalid')
    assert.equal((await present({ interval: { ...INTERVAL, lower: 'month' } })).error.code, 'interval_invalid')
    assert.equal((await present({ interval: { ...INTERVAL, table: 'bad.csv', point: 'p', lower: 'lo', upper: 'hi' } })).error.code, 'interval_invalid')
    assert.equal((await present({ interval: { ...INTERVAL, table: 'outside.csv', point: 'p', lower: 'lo', upper: 'hi' } })).error.code, 'interval_invalid')
    assert.equal((await present({ interval: { ...INTERVAL, level: 80 } })).error.code, 'interval_invalid')
    assert.equal((await present({ kind: 'segments' })).ok, true)
  })

  test('highlights are read from result.json by name', async () => {
    const context = setup({ script })
    const run = await forecastRun(context)
    const present = extra => context.tools.analysis_present_result({ ...claims, kind: 'segments', run_id: run.run.run_id, ...extra })
    assert.deepEqual((await present({ highlights: ['months used', { key: 'mape', unit: '%' }] })).presentation.highlights, [{ label: 'months used', value: 4, unit: null }, { label: 'mape', value: 0.07, unit: '%' }])
    const unknown = await present({ highlights: ['revenue'] })
    assert.equal(unknown.error.code, 'unknown_highlight')
    assert.deepEqual(unknown.error.details, { names: ['mape', 'months used'] })
  })

  test('refuses missing summary, method, assumptions or uncertainty, other sessions, and unknown artifacts', async () => {
    const context = setup({ script })
    const run = await forecastRun(context)
    const base = { ...claims, kind: 'other', run_id: run.run.run_id }
    for (const patch of [{ method: 'short' }, { summary: undefined }, { uncertainty: '' }, { assumptions: [] }, { assumptions: 'none' }, { title: ' ' }, { kind: 'chart' }, { unit: 3 }]) {
      assert.equal((await context.tools.analysis_present_result({ ...base, ...patch })).error.code, 'invalid_request', JSON.stringify(patch))
    }
    assert.equal((await context.tools.analysis_present_result(base, 's2')).error.code, 'unknown_run')
    assert.equal((await context.tools.analysis_present_result({ ...base, run_id: '../x' })).error.code, 'unknown_run')
    assert.equal((await context.tools.analysis_present_result({ ...base, tables: ['trend.png'] })).error.code, 'unknown_artifact')
    assert.equal((await context.tools.analysis_present_result({ ...base, figures: ['../record.json'] })).error.code, 'unknown_artifact')
  })
})

describe('artifact files', () => {
  test('only figures and tables listed in the record resolve', async () => {
    const context = setup({ script: async ({ outputDir }) => { await writeOutput(outputDir, { 'trend.png': 'png', 't.csv': 'a\n1\n', 'result.json': '{}', 'x.svg': '<svg/>' }) } })
    const run = await forecastRun(context)
    const id = run.run.run_id
    assert.equal((await context.runs.artifactFile('s1', id, 'trend.png')).contentType, 'image/png')
    assert.deepEqual({ ...await context.runs.artifactFile('s1', id, 't.csv'), path: undefined }, { path: undefined, contentType: 'text/csv; charset=utf-8', download: 't.csv' })
    for (const name of ['result.json', 'x.svg', '../record.json', '../code/main.py', '../../../manifests/orders.json', '', null]) {
      assert.equal(await context.runs.artifactFile('s1', id, name), undefined, String(name))
    }
    assert.equal(await context.runs.artifactFile('../s1', id, 'trend.png'), undefined)
    assert.equal(await context.runs.artifactFile('s1', '../x', 'trend.png'), undefined)
    assert.equal(await context.runs.artifactFile('s2', id, 'trend.png'), undefined)
  })

  test('the retention sweep deletes old runs, then sessions with nothing recent', async () => {
    const context = setup()
    const first = await forecastRun(context)
    const second = await context.tools.analysis_run_python({ code: 'print(1)', inputs: ['orders'] })
    const sessionDir = join(dataDir, 'sessions', 's1')
    const old = new Date('2026-09-01T00:00:00Z')
    await utimes(join(sessionDir, 'runs', first.run.run_id), old, old)
    // "now" is 2026-11-11 in this setup; real file times are later, so only the back-dated run is old.
    assert.deepEqual(await context.runs.sweep(30 * 86400000), { runs: 1, sessions: 0 })
    assert.deepEqual(await readdir(join(sessionDir, 'runs')), [second.run.run_id])
    await utimes(join(sessionDir, 'runs', second.run.run_id), old, old)
    await utimes(join(sessionDir, 'manifests', 'orders.json'), old, old)
    assert.deepEqual(await context.runs.sweep(30 * 86400000), { runs: 1, sessions: 1 })
    assert.deepEqual(await readdir(join(dataDir, 'sessions')), [])
    assert.deepEqual(await context.runs.sweep(30 * 86400000), { runs: 0, sessions: 0 })
  })

  test('session ids that are not directory-safe are hashed', () => {
    assert.equal(sessionKey('abc-123_X'), 'abc-123_X')
    assert.match(sessionKey('../../etc'), /^[0-9a-f]{40}$/)
    assert.throws(() => sessionKey(''), /session id required/)
  })
})

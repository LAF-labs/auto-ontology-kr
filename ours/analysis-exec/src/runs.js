/**
 * Runs and their records under one data directory:
 *
 *   <dataDir>/sessions/<session key>/inputs, manifests        (src/inputs.js)
 *   <dataDir>/sessions/<session key>/runs/<run id>/
 *       code/main.py      the script, mounted read-only at /code
 *       input/            this run's input files, mounted read-only at /input
 *       output/           the only writable mount, /output
 *       record.json       what ran: inputs with their analysis versions, code hash, image, limits, outcome
 *       presentation.json the evidence shown with the result, when presented
 *
 * A run sees only the inputs it names, and those can only come from
 * InputStore.prepare. The record is written by the host, so the evidence on a
 * result card (which analysis version, which parameters, when it was read,
 * which code ran) never depends on what the model says about it.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCsv } from './csv.js'
import { publicLimits } from './limits.js'

const RUN_ID_PATTERN = /^r[0-9a-f]{16}$/
const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
const FIGURE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
const PREVIEW_READ_BYTES = 4 * 1024 * 1024
const INLINE_JSON_BYTES = 16 * 1024
const MAX_PRESENTED_TABLES = 4
const MAX_PRESENTED_FIGURES = 4
const MAX_NUMBERS = 24
const MAX_HIGHLIGHTS = 4
export const RESULT_KINDS = Object.freeze(['forecast', 'segments', 'trend', 'other'])

function failure(code, message, details = null) {
  return { ok: false, error: { code, message, details } }
}

function extension(name) {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function artifactKind(name) {
  const ext = extension(name)
  if (ext === '.csv') return 'table'
  if (ext in FIGURE_TYPES) return 'figure'
  if (ext === '.json') return 'data'
  if (ext === '.txt' || ext === '.md') return 'text'
  return 'other'
}

/** @returns {string} directory-safe key of a session id. */
export function sessionKey(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('session id required')
  return SESSION_KEY_PATTERN.test(sessionId) ? sessionId : createHash('sha256').update(sessionId).digest('hex').slice(0, 40)
}

async function readHead(path, bytes) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Regular files of an output directory as artifacts; links and special files are left out. */
async function listArtifacts(outputDir) {
  const artifacts = []
  const skipped = []
  const pending = ['']
  while (pending.length > 0) {
    const relative = pending.pop()
    for (const entry of await readdir(join(outputDir, relative), { withFileTypes: true })) {
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) pending.push(name)
      else if (entry.isFile()) artifacts.push({ name, kind: artifactKind(name), bytes: (await lstat(join(outputDir, name))).size })
      else skipped.push(name)
    }
  }
  artifacts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return { artifacts, skipped }
}

async function tablePreview(path, bytes, maxRows) {
  const head = await readHead(path, PREVIEW_READ_BYTES)
  const partial = bytes > head.length
  let text = head.toString('utf8')
  if (partial) text = text.slice(0, text.lastIndexOf('\n') + 1)
  const parsed = parseCsv(text, { maxRows })
  return {
    columns: parsed.columns,
    rows: parsed.rows,
    // Unknown when only the head of a large file was read.
    row_count: partial ? null : parsed.rowCount,
    rows_shown: parsed.rows.length,
  }
}

function flattenNumbers(value, prefix = '', out = []) {
  if (out.length >= MAX_NUMBERS) return out
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) {
    if (prefix !== '') out.push({ name: prefix, value })
  } else if (!Array.isArray(value) && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) flattenNumbers(item, prefix === '' ? key : `${prefix}.${key}`, out)
  }
  return out
}

/** The analysis fields a result carries; the record keeps who verified it and their note. */
function shownAnalysis(analysis) {
  return { id: analysis.id, name: analysis.name, version: analysis.version, status: analysis.status, verified_at: analysis.verified_at }
}

export class AnalysisRuns {
  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {import('./runner.js').ContainerRunner} options.runner
   * @param {import('./inputs.js').InputStore} options.inputs
   * @param {object} options.limits - resolved limits.
   * @param {number} options.maxRows - table rows returned per artifact.
   * @param {() => Date} [options.now]
   */
  constructor({ dataDir, runner, inputs, limits, maxRows = 50, now = () => new Date() }) {
    this.dataDir = dataDir
    this.runner = runner
    this.inputs = inputs
    this.limits = limits
    this.maxRows = maxRows
    this.now = now
  }

  sessionDir(sessionId) {
    return join(this.dataDir, 'sessions', sessionKey(sessionId))
  }

  runDir(key, runId) {
    return join(this.dataDir, 'sessions', key, 'runs', runId)
  }

  /** The data directory holds company data; only the host user may enter it. */
  async ensureDataDir() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    await chmod(this.dataDir, 0o700)
  }

  /** See InputStore.prepare; the result is trimmed to what a caller needs to write code. */
  async prepareInput(sessionId, request, signal) {
    if (typeof sessionId !== 'string' || sessionId === '') return failure('no_session', 'inputs belong to a session; this call has none')
    await this.ensureDataDir()
    const result = await this.inputs.prepare(this.sessionDir(sessionId), request, signal)
    if (!result.ok) return result
    const { sql: _sql, sha256: _sha, columns_file: columnsFile, ...input } = result.input
    return { ok: true, input: { ...input, analysis: shownAnalysis(input.analysis), path: `/input/${input.file}`, columns_path: `/input/${columnsFile}` } }
  }

  async listInputs(sessionId) {
    return (await this.inputs.list(this.sessionDir(sessionId))).map(input => input.input)
  }

  /**
   * @param {string} sessionId
   * @param {{ code: string, inputs: string[] }} request
   * @param {AbortSignal} [signal]
   */
  async run(sessionId, { code, inputs: names }, signal) {
    if (typeof sessionId !== 'string' || sessionId === '') return failure('no_session', 'runs belong to a session; this call has none')
    if (typeof code !== 'string' || code.trim() === '') return failure('invalid_request', 'code must be a non-empty Python script')
    if (Buffer.byteLength(code) > this.limits.maxCodeBytes) return failure('invalid_request', `code is larger than ${this.limits.maxCodeBytes} bytes`)
    if (!Array.isArray(names) || names.length === 0 || names.some(name => typeof name !== 'string')) {
      return failure('invalid_request', 'inputs must name at least one prepared input', { available: await this.listInputs(sessionId) })
    }
    const sessionDir = this.sessionDir(sessionId)
    const manifests = []
    for (const name of [...new Set(names)]) {
      const manifest = await this.inputs.get(sessionDir, name)
      if (manifest === undefined) return failure('unknown_input', `no prepared input named "${name}"`, { available: await this.listInputs(sessionId) })
      manifests.push(manifest)
    }

    const probe = await this.runner.probe()
    if (!probe.ok) return failure(probe.code, probe.message)

    await this.ensureDataDir()
    const key = sessionKey(sessionId)
    const runId = `r${randomBytes(8).toString('hex')}`
    const dir = this.runDir(key, runId)
    const codeDir = join(dir, 'code')
    const inputDir = join(dir, 'input')
    const outputDir = join(dir, 'output')
    await mkdir(codeDir, { recursive: true, mode: 0o755 })
    await mkdir(inputDir, { mode: 0o755 })
    await mkdir(outputDir, { mode: 0o777 })
    // The container user is not the host user; mkdir's mode is cut by the umask.
    for (const path of [join(this.dataDir, 'sessions', key, 'runs'), dir, codeDir, inputDir]) await chmod(path, 0o755)
    await chmod(outputDir, 0o777)
    await writeFile(join(codeDir, 'main.py'), code, { mode: 0o644 })
    for (const manifest of manifests) {
      for (const file of [manifest.file, manifest.columns_file]) {
        const from = join(sessionDir, 'inputs', file)
        try { await link(from, join(inputDir, file)) } catch { await copyFile(from, join(inputDir, file)) }
      }
    }

    const startedAt = this.now().toISOString()
    const outcome = await this.runner.run({ name: `ae-${runId}`, codeDir, inputDir, outputDir, signal })
    await chmod(outputDir, 0o755)
    const { artifacts, skipped } = outcome.status === 'output_limit' ? { artifacts: [], skipped: [] } : await listArtifacts(outputDir)

    const record = {
      run_id: runId,
      session: key,
      started_at: startedAt,
      status: outcome.status,
      exit_code: outcome.exitCode,
      duration_ms: outcome.durationMs,
      message: outcome.message,
      image: { name: this.runner.image, id: probe.imageId },
      isolation: { network: 'none', root_filesystem: 'read-only', user: this.runner.user, writable: ['/output', '/tmp'] },
      limits: publicLimits(this.limits),
      code_sha256: createHash('sha256').update(code).digest('hex'),
      inputs: manifests,
      artifacts,
      skipped_outputs: skipped,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    }
    await writeFile(join(dir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })

    const described = []
    for (const artifact of artifacts) {
      const entry = { ...artifact }
      const path = join(outputDir, artifact.name)
      if (artifact.kind === 'table' && described.filter(item => item.columns).length < MAX_PRESENTED_TABLES) {
        Object.assign(entry, await tablePreview(path, artifact.bytes, this.maxRows))
      } else if (artifact.kind === 'data' && artifact.bytes <= INLINE_JSON_BYTES) {
        try { entry.content = JSON.parse(await readFile(path, 'utf8')) } catch { entry.content_error = 'not valid JSON' }
      }
      described.push(entry)
    }
    const run = {
      run_id: runId,
      status: outcome.status,
      exit_code: outcome.exitCode,
      duration_ms: outcome.durationMs,
      inputs: manifests.map(manifest => manifest.input),
      stdout: outcome.stdout.text,
      stdout_truncated: outcome.stdout.truncated,
      stderr: outcome.stderr.text,
      stderr_truncated: outcome.stderr.truncated,
      artifacts: described,
      ...skipped.length > 0 ? { skipped_outputs: skipped } : {},
      limits: record.limits,
    }
    return outcome.status === 'ok'
      ? { ok: true, run }
      : { ok: false, error: { code: outcome.status, message: outcome.message ?? outcome.status, details: null }, run }
  }

  async loadRecord(key, runId) {
    if (!SESSION_KEY_PATTERN.test(key ?? '') || !RUN_ID_PATTERN.test(runId ?? '')) return undefined
    try {
      return JSON.parse(await readFile(join(this.runDir(key, runId), 'record.json'), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Builds what the person sees for a finished run. Sources (which confirmed
   * analyses, with which conditions, read when), the code, the headline of a
   * forecast, the numbers and the tables are read from the record and the
   * output files. The caller supplies only words: the title, a plain summary,
   * a plain statement of uncertainty, the method and the assumptions.
   */
  async present(sessionId, request) {
    if (typeof sessionId !== 'string' || sessionId === '') return failure('no_session', 'results belong to a session; this call has none')
    const text = (value, name, min) => typeof value === 'string' && value.trim().length >= min ? null : `${name} must be text of at least ${min} characters`
    const problem = text(request.title, 'title', 1) ?? text(request.summary, 'summary', 10) ?? text(request.uncertainty, 'uncertainty', 10) ?? text(request.method, 'method', 10)
      ?? (RESULT_KINDS.includes(request.kind) ? null : `kind must be one of ${RESULT_KINDS.join(', ')}`)
      ?? (Array.isArray(request.assumptions) && request.assumptions.length > 0 && request.assumptions.every(item => typeof item === 'string' && item.trim() !== '') ? null : 'assumptions must list at least one assumption as text')
      ?? (request.unit === undefined || typeof request.unit === 'string' ? null : 'unit must be text')
    if (problem !== null) return failure('invalid_request', problem)

    const key = sessionKey(sessionId)
    const record = await this.loadRecord(key, request.run_id)
    if (record === undefined) return failure('unknown_run', `no run "${request.run_id}" in this session`)
    if (record.status !== 'ok') return failure('run_not_ok', `run ${record.run_id} ended as ${record.status}; only a run that succeeded can be presented`)
    const dir = this.runDir(key, record.run_id)
    const outputDir = join(dir, 'output')
    const byName = new Map(record.artifacts.map(artifact => [artifact.name, artifact]))
    const artifactNames = record.artifacts.map(artifact => artifact.name)

    // `tables` and `figures` items are a file name or { file, title }.
    const pick = (requested, kind, max) => {
      const items = Array.isArray(requested)
        ? requested.map(item => typeof item === 'string' ? { file: item, title: null } : { file: item?.file, title: typeof item?.title === 'string' && item.title.trim() !== '' ? item.title.trim() : null })
        : record.artifacts.filter(artifact => artifact.kind === kind).map(artifact => ({ file: artifact.name, title: null }))
      const missing = items.find(item => byName.get(item.file)?.kind !== kind)
      return missing === undefined ? { items: items.slice(0, max) } : { missing: String(missing.file) }
    }
    const tablePick = pick(request.tables, 'table', MAX_PRESENTED_TABLES)
    if (tablePick.missing !== undefined) return failure('unknown_artifact', `"${tablePick.missing}" is not a CSV table this run wrote`, { artifacts: artifactNames })
    const figurePick = pick(request.figures, 'figure', MAX_PRESENTED_FIGURES)
    if (figurePick.missing !== undefined) return failure('unknown_artifact', `"${figurePick.missing}" is not a PNG or JPEG figure this run wrote`, { artifacts: artifactNames })

    let headline = null
    if (request.kind === 'forecast' || request.interval !== undefined) {
      const spec = request.interval
      if (spec === null || typeof spec !== 'object' || [spec.table, spec.point, spec.lower, spec.upper].some(item => typeof item !== 'string' || item === '')) {
        return failure('interval_required', 'a forecast must name its interval: interval.table (a CSV this run wrote), interval.point, interval.lower and interval.upper (column names), interval.level (for example 0.8), and interval.label (what the first row forecasts, in the words of the person)')
      }
      if (typeof spec.label !== 'string' || spec.label.trim() === '') return failure('interval_required', 'interval.label must say what the first row of the table forecasts, in the words of the person (for example "11월 예측")')
      if (byName.get(spec.table)?.kind !== 'table') return failure('interval_invalid', `"${spec.table}" is not a CSV table this run wrote`, { artifacts: artifactNames })
      if (typeof spec.level !== 'number' || !(spec.level > 0 && spec.level < 1)) return failure('interval_invalid', 'interval.level must be a number between 0 and 1, the coverage the interval was built for')
      const table = await tablePreview(join(outputDir, spec.table), byName.get(spec.table).bytes, 100000)
      const columns = [spec.point, spec.lower, spec.upper].map(name => table.columns.indexOf(name))
      const absent = [spec.point, spec.lower, spec.upper][columns.findIndex(index => index < 0)]
      if (absent !== undefined) return failure('interval_invalid', `table ${spec.table} has no column "${absent}"`, { columns: table.columns })
      const rows = table.rows
        .filter(row => columns.every(index => row[index] !== undefined && row[index] !== '' && Number.isFinite(Number(row[index]))))
        .map(row => columns.map(index => Number(row[index])))
      if (rows.length === 0) return failure('interval_invalid', `table ${spec.table} has no row with numbers in "${spec.point}", "${spec.lower}" and "${spec.upper}"`)
      if (rows.some(([point, lower, upper]) => lower > upper || point < lower || point > upper)) return failure('interval_invalid', `table ${spec.table} has a row where the point is outside its bounds or the lower bound is above the upper`)
      // The headline is the first forecast row, read from the file: the person sees the run's number, not a typed one.
      headline = { label: spec.label.trim(), point: rows[0][0], lower: rows[0][1], upper: rows[0][2], level: spec.level, unit: request.unit?.trim() || null, periods: rows.length }
    }

    let numbers = []
    const numbersFile = byName.get('result.json')
    if (numbersFile !== undefined && numbersFile.bytes <= INLINE_JSON_BYTES) {
      try { numbers = flattenNumbers(JSON.parse(await readFile(join(outputDir, 'result.json'), 'utf8'))) } catch { numbers = [] }
    }
    // `highlights` items are a key of result.json or { key, unit }; the values come from the file.
    const highlights = []
    for (const item of Array.isArray(request.highlights) ? request.highlights.slice(0, MAX_HIGHLIGHTS) : []) {
      const name = typeof item === 'string' ? item : item?.key
      const found = numbers.find(entry => entry.name === name)
      if (found === undefined) return failure('unknown_highlight', `result.json has no value named "${name}"`, { names: numbers.map(entry => entry.name) })
      highlights.push({ label: found.name, value: found.value, unit: typeof item?.unit === 'string' && item.unit.trim() !== '' ? item.unit.trim() : null })
    }

    const tables = []
    for (const item of tablePick.items) tables.push({ name: item.file, title: item.title, ...await tablePreview(join(outputDir, item.file), byName.get(item.file).bytes, this.maxRows) })

    // One source per analysis version, with one entry per input file read from it.
    const sources = []
    for (const input of record.inputs) {
      let source = sources.find(item => item.name === input.analysis.name && item.version === input.analysis.version)
      if (source === undefined) {
        source = { name: input.analysis.name, status: input.analysis.status, version: input.analysis.version, data: input.source?.tables ?? [], files: [] }
        sources.push(source)
      }
      source.files.push({
        file: input.file,
        conditions: (input.conditions ?? Object.entries(input.params ?? {}).map(([name, value]) => ({ name, label: name, value }))).map(({ label, value }) => ({ label, value })),
        as_of: input.executed_at,
        rows: input.row_count,
      })
    }

    const artifactPath = name => `api/analysis-exec/artifact?session=${encodeURIComponent(key)}&run=${record.run_id}&name=${encodeURIComponent(name)}`
    const presentation = {
      title: request.title.trim(),
      kind: request.kind,
      run_id: record.run_id,
      headline,
      highlights,
      summary: request.summary.trim(),
      uncertainty: request.uncertainty.trim(),
      sources,
      figures: figurePick.items.map(item => ({ name: item.file, title: item.title, path: artifactPath(item.file) })),
      tables: tables.map(table => ({ ...table, path: artifactPath(table.name) })),
      numbers,
      method: request.method.trim(),
      assumptions: request.assumptions.map(item => item.trim()),
      run: { started_at: record.started_at, duration_ms: record.duration_ms, isolated: record.isolation?.network === 'none' },
      code: await readFile(join(dir, 'code', 'main.py'), 'utf8'),
    }
    await writeFile(join(dir, 'presentation.json'), `${JSON.stringify({ presented_at: this.now().toISOString(), code_sha256: record.code_sha256, image: record.image, limits: record.limits, ...presentation }, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, presentation }
  }

  /**
   * Deletes run directories older than `maxAgeMs`, and a session's directory
   * once it holds no run and no input newer than that. A card of a deleted
   * run keeps its numbers and tables (they are in the Session log); its
   * figures and CSV downloads are gone.
   * @returns {Promise<{ runs: number, sessions: number }>} what was deleted.
   */
  async sweep(maxAgeMs) {
    const cutoff = this.now().getTime() - maxAgeMs
    const sessionsDir = join(this.dataDir, 'sessions')
    const list = async (dir) => {
      try { return await readdir(dir) } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
    }
    const newest = async (dir) => {
      let latest = 0
      for (const name of await list(dir)) latest = Math.max(latest, (await lstat(join(dir, name))).mtimeMs)
      return latest
    }
    const removed = { runs: 0, sessions: 0 }
    for (const key of await list(sessionsDir)) {
      if (!SESSION_KEY_PATTERN.test(key)) continue
      const runsDir = join(sessionsDir, key, 'runs')
      let kept = 0
      for (const runId of await list(runsDir)) {
        if (!RUN_ID_PATTERN.test(runId)) continue
        if ((await lstat(join(runsDir, runId))).mtimeMs < cutoff) {
          await rm(join(runsDir, runId), { recursive: true, force: true })
          removed.runs += 1
        } else kept += 1
      }
      if (kept === 0 && await newest(join(sessionsDir, key, 'manifests')) < cutoff) {
        await rm(join(sessionsDir, key), { recursive: true, force: true })
        removed.sessions += 1
      }
    }
    return removed
  }

  /**
   * Resolves an artifact for the browser route: a figure or table that the
   * run's record lists, and nothing else under the data directory.
   * @returns {Promise<{ path: string, contentType: string, download: string | null } | undefined>}
   */
  async artifactFile(key, runId, name) {
    const record = await this.loadRecord(key, runId)
    const artifact = record?.artifacts.find(item => item.name === name)
    if (artifact === undefined || (artifact.kind !== 'figure' && artifact.kind !== 'table')) return undefined
    const path = join(this.runDir(key, runId), 'output', artifact.name)
    const stat = await lstat(path).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) return undefined
    return artifact.kind === 'figure'
      ? { path, contentType: FIGURE_TYPES[extension(artifact.name)], download: null }
      : { path, contentType: 'text/csv; charset=utf-8', download: artifact.name.split('/').pop() }
  }
}

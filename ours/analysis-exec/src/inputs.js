/**
 * Input preparation: the only way data reaches a run.
 *
 * The caller names a saved analysis and parameter values. The host reads the
 * version from Auto-ontology, refuses anything that is not verified, fetches
 * the result through an input source, and writes it as `<name>.csv` plus
 * `<name>.columns.json` in the session's input directory. There is no SQL
 * argument and no file argument, so an agent cannot feed a run with unsaved
 * SQL or with a file of its choosing.
 *
 * An input source hides where the rows come from:
 *
 *   source.fetch({ analysisId, version, params, maxAgeS }, { destFile, signal })
 *     -> { ok: true, meta } | { ok: false, error: { code, message, details } }
 *
 * `runApiSource` uses the run API, which caps rows at the version's
 * `row_limit` and refuses a cut result. `exportApiSource` uses the bulk export
 * API (Auto-ontology docs/saved-analyses.md §15), which has no such cap but a
 * daily quota. `autoSource` uses the run API and turns to an export only when
 * the result was cut, so small results do not spend the quota. All report the
 * same `meta`; `meta.format` (`csv` or `parquet`) names the file type.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { toCsv } from './csv.js'

export const INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
const DATA_FORMATS = ['csv', 'parquet']

function failure(code, message, details = null) {
  return { ok: false, error: { code, message, details } }
}

function fromConnector(result) {
  const { code, message, details } = result.error
  return failure(String(code), String(message ?? ''), details ?? null)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Input source over the saved-analysis run API (`POST …/run`).
 * @param {object} connector - object with the AoConnector `runAnalysis` method.
 */
export function runApiSource(connector) {
  return {
    kind: 'run',
    async fetch({ analysisId, version, params, maxAgeS }, { destFile, signal }) {
      const request = { version, params, ...maxAgeS === undefined ? {} : { max_age_s: maxAgeS } }
      const result = await connector.runAnalysis(analysisId, request, signal)
      if (!result.ok) return fromConnector(result)
      const data = result.data
      if (!Array.isArray(data?.columns) || !Array.isArray(data?.rows)) return failure('bad_response', 'run response has no columns or rows')
      if (data.status !== 'verified') {
        return failure('not_verified', `version ${data.version} of this analysis is ${data.status ?? 'not verified'}; only verified versions can be analysis inputs`, { version: data.version ?? null, status: data.status ?? null })
      }
      if (data.truncated === true) {
        return failure('input_truncated', `the result has more rows than this version returns (${data.row_count}); an input must be the whole result. Narrow the parameters so the result fits, or use an analysis that aggregates further.`, { row_count: data.row_count ?? null })
      }
      const csv = toCsv(data.columns.map(column => column.name), data.rows)
      await writeFile(destFile, csv, { mode: 0o644 })
      return {
        ok: true,
        meta: {
          via: 'run',
          format: 'csv',
          analysis_id: data.analysis_id ?? analysisId,
          name: data.name ?? null,
          version: data.version,
          status: data.status,
          params: data.params ?? {},
          executed_at: data.executed_at ?? null,
          cache_hit: data.cache?.hit === true,
          row_count: data.rows.length,
          columns: data.columns,
          source: data.source ?? null,
          sql: data.sql ?? null,
          bytes: Buffer.byteLength(csv),
          sha256: sha256(csv),
        },
      }
    },
  }
}

/**
 * Input source over the bulk export API: `POST /api/saved-analyses/{id}/export`,
 * then `GET /api/saved-analysis-exports/{export_id}/file` through the gateway.
 * The host holds the token (role analysis_exporter, `analysis:export`) and
 * copies the file into the session's inputs, so a run needs neither the token
 * nor the export directory, and the copy outlives the export's retention.
 *
 * @param {object} options
 * @param {string} options.baseUrl - gateway origin.
 * @param {() => Promise<string | undefined>} options.token
 * @param {'csv' | 'parquet'} [options.format] - parquet keeps column types (exact decimals, 64-bit integers).
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 */
export function exportApiSource({ baseUrl, token, format = 'csv', fetch: fetchImpl = globalThis.fetch, timeoutMs = 300000 }) {
  if (format !== 'csv' && format !== 'parquet') throw new TypeError('export format must be csv or parquet')
  const origin = new URL(baseUrl).origin
  async function call(method, path, body, signal) {
    const key = await token()
    if (!key) return failure('missing_token', 'no API token with analysis:export is configured')
    let response
    try {
      response = await fetchImpl(new URL(path, origin), {
        method,
        headers: { 'x-api-key': key, ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch (error) {
      return failure(signal?.aborted ? 'cancelled' : 'unreachable', `export request failed: ${error?.cause?.code ?? error?.message ?? String(error)}`)
    }
    if (response.ok) return { ok: true, response }
    let parsed
    try { parsed = JSON.parse(await response.text()) } catch { parsed = undefined }
    const error = parsed?.error
    return typeof error === 'object' && error !== null
      ? failure(String(error.code ?? 'gateway_error'), String(error.message ?? ''), error.details ?? null)
      : failure(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'gateway_error', `gateway answered ${response.status}`)
  }
  return {
    kind: 'export',
    async fetch({ analysisId, version, params }, { destFile, signal }) {
      const created = await call('POST', `/api/saved-analyses/${encodeURIComponent(analysisId)}/export`, { version, params: params ?? {}, format }, signal)
      if (!created.ok) return created
      let data
      try { data = (await created.response.json())?.data } catch { data = undefined }
      if (data?.state !== 'ready' || typeof data?.file?.download_path !== 'string') {
        return failure(data?.error?.code ?? 'export_failed', data?.error?.message ?? 'export did not produce a file', { export_id: data?.export_id ?? null, state: data?.state ?? null })
      }
      if (!data.file.download_path.startsWith('/api/saved-analysis-exports/')) return failure('bad_response', 'export answered with an unexpected download path')
      const file = await call('GET', data.file.download_path, undefined, signal)
      if (!file.ok) return file
      const hash = createHash('sha256')
      let bytes = 0
      try {
        await pipeline(
          Readable.fromWeb(file.response.body),
          async function* (source) { for await (const chunk of source) { hash.update(chunk); bytes += chunk.length; yield chunk } },
          createWriteStream(destFile, { mode: 0o644 }),
        )
      } catch (error) {
        return failure(signal?.aborted ? 'cancelled' : 'unreachable', `export download failed: ${error?.message ?? String(error)}`)
      }
      const digest = hash.digest('hex')
      if (typeof data.sha256 === 'string' && data.sha256 !== digest) return failure('bad_response', 'downloaded file does not match the export checksum', { export_id: data.export_id })
      return {
        ok: true,
        meta: {
          via: 'export',
          format,
          export_id: data.export_id,
          analysis_id: data.analysis_id ?? analysisId,
          name: data.name ?? null,
          version: data.version,
          // The export API writes verified versions only and refuses drafts (`not_verified`).
          status: 'verified',
          params: data.params ?? {},
          executed_at: data.finished_at ?? data.created_at ?? null,
          cache_hit: false,
          row_count: data.row_count,
          columns: data.columns ?? [],
          source: data.source ?? null,
          sql: data.sql ?? null,
          bytes,
          sha256: digest,
        },
      }
    },
  }
}

/**
 * Input source that reads through the run API and exports only a result the
 * run API cut at the version's row limit.
 * @param {{ fetch: Function }} runSource
 * @param {{ fetch: Function }} exportSource
 */
export function autoSource(runSource, exportSource) {
  return {
    kind: 'auto',
    async fetch(request, target) {
      const result = await runSource.fetch(request, target)
      return !result.ok && result.error.code === 'input_truncated' ? exportSource.fetch(request, target) : result
    },
  }
}

/**
 * Prepares and lists the inputs of sessions under one data directory.
 *
 * Layout of a session directory:
 *   inputs/<name>.csv|.parquet, inputs/<name>.columns.json   linked into runs
 *   manifests/<name>.json                                    host record, never mounted
 */
export class InputStore {
  /**
   * @param {object} options
   * @param {object} options.connector - object with the AoConnector `getAnalysis` method.
   * @param {{ kind: string, fetch: Function }} options.source
   * @param {number} options.maxInputs - inputs one session may hold.
   * @param {() => Date} [options.now]
   */
  constructor({ connector, source, maxInputs, now = () => new Date() }) {
    this.connector = connector
    this.source = source
    this.maxInputs = maxInputs
    this.now = now
  }

  /** @returns {Promise<object[]>} manifests of a session's inputs, by name. */
  async list(sessionDir) {
    let names
    try {
      names = await readdir(join(sessionDir, 'manifests'))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const manifests = []
    for (const file of names.filter(name => name.endsWith('.json')).sort()) {
      manifests.push(JSON.parse(await readFile(join(sessionDir, 'manifests', file), 'utf8')))
    }
    return manifests
  }

  /** @returns {Promise<object | undefined>} one manifest. */
  async get(sessionDir, name) {
    if (!INPUT_NAME_PATTERN.test(name ?? '')) return undefined
    try {
      return JSON.parse(await readFile(join(sessionDir, 'manifests', `${name}.json`), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * @param {string} sessionDir
   * @param {{ name: string, analysisId: string, version?: number, params?: object, maxAgeS?: number }} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ok: true, input: object } | { ok: false, error: object }>}
   */
  async prepare(sessionDir, { name, analysisId, version, params, maxAgeS }, signal) {
    if (!INPUT_NAME_PATTERN.test(name ?? '')) return failure('invalid_request', 'name must be a lowercase letter followed by up to 39 lowercase letters, digits or underscores')
    if (typeof analysisId !== 'string' || analysisId === '') return failure('invalid_request', 'analysis_id must be a non-empty string')
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) return failure('invalid_request', 'version must be a positive integer')
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return failure('invalid_request', 'params must be an object')

    const existing = await this.list(sessionDir)
    if (!existing.some(input => input.input === name) && existing.length >= this.maxInputs) {
      return failure('too_many_inputs', `this session already holds ${this.maxInputs} inputs; prepare under an existing name to replace one`, { inputs: existing.map(input => input.input) })
    }

    // Read the version first: an unverified version is refused before its SQL runs,
    // and the version is pinned so the run cannot move to a newer one in between.
    const described = await this.connector.getAnalysis(analysisId, { version }, signal)
    if (!described.ok) return fromConnector(described)
    const target = described.data?.version
    if (!Number.isInteger(target?.version)) return failure('bad_response', 'analysis has no readable version')
    if (target.status !== 'verified') {
      return failure('not_verified', `version ${target.version} of "${described.data.name}" is ${target.status}; only verified versions can be analysis inputs. A person verifies a version in the product.`, { version: target.version, status: target.status })
    }

    const inputsDir = join(sessionDir, 'inputs')
    const manifestsDir = join(sessionDir, 'manifests')
    await mkdir(inputsDir, { recursive: true, mode: 0o755 })
    await mkdir(manifestsDir, { recursive: true, mode: 0o700 })
    const partial = join(inputsDir, `.${name}.data.partial`)
    let fetched
    try {
      fetched = await this.source.fetch({ analysisId, version: target.version, params: params ?? {}, maxAgeS }, { destFile: partial, signal })
      if (fetched.ok && (fetched.meta.status !== 'verified' || fetched.meta.version !== target.version)) {
        fetched = failure('not_verified', 'the fetched result is not the verified version that was requested', { version: fetched.meta.version ?? null, status: fetched.meta.status ?? null })
      }
      if (fetched.ok && !DATA_FORMATS.includes(fetched.meta.format)) fetched = failure('bad_response', 'the input source returned an unknown file format')
      if (!fetched.ok) return fetched
      // Rename, never overwrite in place: earlier runs keep hard links to the previous file.
      await rename(partial, join(inputsDir, `${name}.${fetched.meta.format}`))
      for (const other of DATA_FORMATS) if (other !== fetched.meta.format) await rm(join(inputsDir, `${name}.${other}`), { force: true })
    } finally {
      await rm(partial, { force: true })
    }
    const meta = fetched.meta
    const columns = meta.columns.map(column => ({
      name: column.name, type: column.type ?? null, role: column.role ?? null, unit: column.unit ?? null, label: column.label ?? null,
    }))
    const columnsPartial = join(inputsDir, `.${name}.columns.json.partial`)
    await writeFile(columnsPartial, `${JSON.stringify({ analysis: meta.name, version: meta.version, params: meta.params, columns }, null, 2)}\n`, { mode: 0o644 })
    await rename(columnsPartial, join(inputsDir, `${name}.columns.json`))

    const manifest = {
      input: name,
      file: `${name}.${meta.format}`,
      format: meta.format,
      columns_file: `${name}.columns.json`,
      prepared_at: this.now().toISOString(),
      via: meta.via,
      ...meta.export_id ? { export_id: meta.export_id } : {},
      analysis: {
        id: meta.analysis_id,
        name: meta.name ?? described.data.name ?? null,
        version: meta.version,
        status: meta.status,
        verified_at: target.verified_at ?? null,
        verified_by: target.verified_by ?? null,
        verification_note: target.verification_note ?? null,
      },
      params: meta.params,
      executed_at: meta.executed_at,
      cache_hit: meta.cache_hit,
      row_count: meta.row_count,
      bytes: meta.bytes,
      sha256: meta.sha256,
      columns,
      source: meta.source,
      sql: meta.sql,
    }
    await writeFile(join(manifestsDir, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, input: manifest }
  }
}

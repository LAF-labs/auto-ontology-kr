/** Test doubles: a connector over in-memory analyses and a runner that runs a JS function instead of a container. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const COLUMNS = [
  { name: 'month', type: 'date', role: 'dimension', unit: null, label: 'Month' },
  { name: 'orders', type: 'integer', role: 'measure', unit: 'count', label: 'Orders' },
]

/**
 * Analyses by id: `a-ok` (v1 verified, v2 draft), `a-draft` (only a draft),
 * `a-big` (verified, result cut by the row limit), `a-flip` (the described
 * version is verified but the run answers as a draft).
 */
export function fakeConnector() {
  const calls = []
  const analyses = {
    'a-ok': { name: 'Monthly orders', versions: { 1: 'verified', 2: 'draft' }, latestVerified: 1 },
    'a-draft': { name: 'Unreviewed', versions: { 1: 'draft' }, latestVerified: null },
    'a-big': { name: 'Every order', versions: { 1: 'verified' }, latestVerified: 1, truncated: true },
    'a-flip': { name: 'Flip', versions: { 1: 'verified' }, latestVerified: 1, runStatus: 'draft' },
  }
  const notFound = { ok: false, error: { status: 404, code: 'not_found', message: 'no such analysis', details: null } }
  return {
    calls,
    async getAnalysis(id, { version } = {}) {
      calls.push(['get', id, version])
      const analysis = analyses[id]
      if (!analysis) return notFound
      const number = version ?? analysis.latestVerified ?? Math.max(...Object.keys(analysis.versions).map(Number))
      if (!analysis.versions[number]) return notFound
      const status = analysis.versions[number]
      return { ok: true, data: { id, name: analysis.name, version: { version: number, status, verified_at: status === 'verified' ? '2026-11-01T00:00:00Z' : null, verified_by: status === 'verified' ? 'reviewer' : null, verification_note: null } } }
    },
    async runAnalysis(id, request = {}) {
      calls.push(['run', id, request])
      const analysis = analyses[id]
      if (!analysis) return notFound
      const version = request.version ?? analysis.latestVerified
      const rows = [['2026-07-01', 100], ['2026-08-01', 110], ['2026-09-01', null], ['2026-10-01', 135]]
      return {
        ok: true,
        data: {
          analysis_id: id, name: analysis.name, version, status: analysis.runStatus ?? analysis.versions[version],
          params: { start: '2026-07-01', ...request.params }, columns: COLUMNS, rows, row_count: rows.length,
          truncated: analysis.truncated === true, executed_at: '2026-11-11T02:00:00.000000Z', duration_ms: 12,
          cache: { hit: false, shared: false, expires_at: null }, source: { database_name: 'shop', tables: ['shop.orders'] },
          sql: 'SELECT month, orders FROM monthly',
        },
      }
    },
  }
}

/**
 * Runner double. `script({ codeDir, inputDir, outputDir })` stands in for the
 * container: it may write files under outputDir and returns a partial outcome.
 */
export function fakeRunner(script = async () => ({})) {
  const runs = []
  return {
    image: 'test-image:1',
    user: '10001:10001',
    runs,
    available: { ok: true, imageId: 'sha256:test' },
    async probe() { return this.available },
    async run(request) {
      runs.push(request)
      const outcome = await script(request)
      return {
        status: 'ok', exitCode: 0, durationMs: 5, message: null,
        stdout: { text: '', bytes: 0, truncated: false }, stderr: { text: '', bytes: 0, truncated: false },
        output: { bytes: 0, files: 0 }, ...outcome,
      }
    },
  }
}

export async function writeOutput(outputDir, files) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(outputDir, name)), { recursive: true })
    await writeFile(join(outputDir, name), content)
  }
}

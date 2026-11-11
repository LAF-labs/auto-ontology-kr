/**
 * Browser route for run artifacts on the shared API channel (owner cookie
 * required):
 *
 *   GET /api/analysis-exec/artifact?session=&run=&name=
 *
 * Serves a figure (PNG or JPEG, inline) or a table (CSV, as a download) that
 * the run's record lists. Nothing else under the data directory is reachable.
 */
import { readFile } from 'node:fs/promises'

export const name = 'analysis-exec-http'
export const inject = ['connection', 'analysisExec']

export function apply(ctx) {
  const runs = ctx.analysisExec.runs
  const route = {
    path: '/api/analysis-exec/artifact',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url)
      const file = await runs.artifactFile(url.searchParams.get('session'), url.searchParams.get('run'), url.searchParams.get('name'))
        .catch(() => undefined)
      if (file === undefined) return Response.json({ error: { code: 'not_found', message: 'no such artifact' } }, { status: 404 })
      return new Response(await readFile(file.path), {
        headers: {
          'content-type': file.contentType,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          // A run's output never changes after the run.
          'cache-control': 'private, max-age=86400, immutable',
          ...file.download === null ? {} : { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.download)}` },
        },
      })
    },
  }
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(route)
    return () => dispose()
  }, `analysis-exec-http: ${route.path}`)
}

/**
 * Host half of the runtime spike.
 * a: exact `/` and `/index.html` routes that reuse frontend-static through readResource.
 * c: `connection/request` waterfall that logs /api URLs and refuses a configured pattern.
 * e: exact Fetch route `/api/spike/ping` for the fetch-only fallback.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'ours-spike'
export const inject = ['webServer', 'connection']

function log(line) {
  const home = process.env.DSH_HOME
  if (home) appendFileSync(join(home, 'spike.log'), `${new Date().toISOString()} ${line}\n`)
}

async function sendFetchResponse(res, response) {
  const headers = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  res.writeHead(response.status, headers)
  res.end(Buffer.from(await response.arrayBuffer()))
}

export function apply(ctx, config = {}) {
  const deny = config.denyApiPattern ? new RegExp(config.denyApiPattern) : undefined
  const indexHandler = async (req, res) => {
    const url = new URL(req.url, 'http://placeholder')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      log(`index: token exchange ${req.method}`)
      ctx.connection.authorizeIndex(req, res)
      return
    }
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      log(`index: rejected ${rejection}`)
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    const response = await ctx.webServer.readResource(
      new Request(new URL('/index.html', 'http://placeholder'), { method: req.method === 'HEAD' ? 'HEAD' : 'GET' }),
      ctx.connection.browserPeer,
    )
    log(`index: served via readResource status=${response.status}`)
    res.setHeader('x-ours-spike', 'index')
    await sendFetchResponse(res, response)
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: indexHandler }), 'ours-spike: /')
  // `/index.html` stays with the frontend-static fallback: readResource answers 404 for a path an exact handler owns.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/login',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('ours-spike login placeholder\n')
    },
  }), 'ours-spike: /login')

  ctx.on('connection/request', async (req, res, next) => {
    log(`api: ${req.method} ${req.url}`)
    if (deny !== undefined && deny.test(req.url ?? '')) {
      log(`api: DENIED ${req.url}`)
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'ours-spike: refused by connection/request' }))
      return
    }
    await next()
  })

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/spike/ping',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => Response.json({ ok: true, method: request.method, at: Date.now() }),
    })
    return () => dispose()
  }, 'ours-spike: /api/spike/ping')
  // e: answers the shared-channel RPC envelope for a hand-built Remote contribution (no Typert service).
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/oursSpike/hello',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const message = await request.json()
        log(`rpc: oursSpike/hello ${JSON.stringify(message.payload)}`)
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: `hello ${message.payload?.args?.name ?? '?'}` } })
      },
    })
    return () => dispose()
  }, 'ours-spike: /api/oursSpike/hello')
  log('host: applied')
}

/**
 * `connection/request` listener refusing denied /api path prefixes, matched
 * against the WHATWG-normalized pathname the API bridge also uses.
 * @param {string[]} prefixes - absolute prefixes under /api/.
 * @returns {(request, response, next) => Promise<void>}
 */
export function createRequestGuard(prefixes) {
  for (const prefix of prefixes) {
    if (!prefix.startsWith('/api/')) throw new Error(`request-guard: prefix ${JSON.stringify(prefix)} must start with /api/`)
  }
  return async (request, response, next) => {
    const pathname = new URL(request.url ?? '/', 'http://placeholder').pathname
    if (prefixes.some(prefix => pathname.startsWith(prefix))) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'forbidden_path', message: 'This API path is disabled in this product.' } }))
      return
    }
    await next()
  }
}
